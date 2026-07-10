import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SITEMAP_INDEX = 'https://www.valueresearchonline.com/site-map/index.xml';
const OUTPUT = path.resolve('data/vro-universe.generated.js');
const CONCURRENCY = 6;
const TIMEOUT_MS = 18000;
const MAX_SITEMAPS = 250;
const MAX_RETRIES = 2;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function decode(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&rsquo;|&#8217;/gi, '’')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function textOf(html) {
  return decode(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/li>|<\/h\d>|<\/div>|<\/tr>|<\/td>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function canonical(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(direct|regular)\s*(plan)?\b/g, ' ')
    .replace(/\b(growth|idcw|dividend|bonus|payout|reinvestment|weekly|monthly|quarterly|annual)\b/g, ' ')
    .replace(/\b(option|plan|dir|reg)\b/g, ' ')
    .replace(/\bpru\b/g, 'prudential')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function locs(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(match => decode(match[1].trim()));
}

function block(text, start, end) {
  const lower = text.toLowerCase();
  const from = lower.indexOf(start.toLowerCase());
  if (from < 0) return '';
  const after = from + start.length;
  const to = end ? lower.indexOf(end.toLowerCase(), after) : -1;
  return text.slice(after, to >= 0 ? to : undefined).trim();
}

function cleanManager(value) {
  const name = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .replace(/\s+(?:education|experience|funds managed).*$/i, '')
    .trim();
  if (name.length < 3 || name.length > 80) return null;
  if (/fund|scheme|plan|education|experience|interview|portfolio|benchmark|return/i.test(name)) return null;
  return /[A-Za-z]/.test(name) ? name : null;
}

function isoDate(value) {
  const match = String(value || '').match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return `${match[3]}-${months[match[2]] || '01'}-${match[1]}`;
}

function parsePairs(value, limit = 10) {
  const rows = String(value || '').split(/\n/).map(item => item.trim()).filter(Boolean);
  const out = [];
  for (let index = 1; index < rows.length; index += 1) {
    const weight = Number(rows[index].replace(/[%₹,]/g, ''));
    const name = rows[index - 1];
    if (!Number.isFinite(weight) || !name || /^[-+]?\d/.test(name) || /see more|show all|highcharts|percentage/i.test(name)) continue;
    out.push({ name, weight });
    if (out.length >= limit) break;
  }
  return out;
}

function parseAllocation(text, heading, labels) {
  const section = block(text, heading, heading === 'Asset Allocation' ? 'Market Cap Weightage' : 'Portfolio Breakdown');
  return labels.map(label => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = section.match(new RegExp(`([0-9]+(?:\\.[0-9]+)?)%\\s*${escaped}`, 'i'));
    return match ? { name: label, weight: Number(match[1]) } : null;
  }).filter(Boolean);
}

async function fetchPage(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml,text/xml,*/*',
        'user-agent': 'ManagerLens/0.8 public-fund-universe-sync'
      }
    });
    if (response.status === 429 || response.status >= 500) throw new Error(`retryable ${response.status}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return { ok: true, url: response.url, body: await response.text() };
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      await sleep(700 * Math.pow(2, attempt));
      return fetchPage(url, attempt + 1);
    }
    return { ok: false, url, body: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function sitemapAllowed(url) {
  const lower = url.toLowerCase();
  if (!lower.endsWith('.xml') && !lower.includes('.xml?')) return false;
  return !/news|stock|stories|article|video|nps|ipo|author|tag|category/.test(lower);
}

async function discoverFundUrls() {
  const queue = [SITEMAP_INDEX];
  const visited = new Set();
  const fundUrls = new Set();

  while (queue.length && visited.size < MAX_SITEMAPS) {
    const sitemap = queue.shift();
    if (visited.has(sitemap)) continue;
    visited.add(sitemap);
    const result = await fetchPage(sitemap);
    if (!result.ok) continue;
    for (const url of locs(result.body)) {
      let pathname = '';
      try { pathname = new URL(url).pathname; } catch { continue; }
      if (/\/funds\/\d+\/[^/]+\/$/i.test(pathname)) {
        if (/direct-plan|direct-growth|direct-option|direct$/i.test(pathname) || pathname.includes('-direct-')) fundUrls.add(url.split('?')[0]);
        continue;
      }
      if (sitemapAllowed(url) && !visited.has(url)) queue.push(url);
    }
  }

  return { urls: [...fundUrls], sitemapsScanned: visited.size };
}

function parseFundPage(html, url) {
  const text = textOf(html);
  const heading = textOf(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const fundName = heading || new URL(url).pathname.split('/').filter(Boolean).at(-1).replace(/-/g, ' ');
  const fundHouse = text.match(/mutual fund scheme of\s+(.+? Mutual Fund)\./i)?.[1]?.trim()
    || text.match(/Fund House\s+([^\n]+? Mutual Fund)(?:\s+Launch Date|\n|$)/i)?.[1]?.trim()
    || text.match(/AMC\s+([^\n]+?Asset Management[^\n]*)/i)?.[1]?.trim();
  if (!fundHouse) return null;

  const managerMap = new Map();
  const about = text.match(/currently managed by\s+(.+?)\.\s+The fund has/i);
  if (about) {
    for (const raw of about[1].split(/,|\band\b/i)) {
      const name = cleanManager(raw);
      if (name) managerMap.set(name.toLowerCase(), { name, startDate: null, startLabel: null });
    }
  }
  const managerSection = block(text, 'Fund Manager', 'FAQ for') || block(text, 'Fund Manager', 'Most Recent Dividends');
  for (const match of managerSection.matchAll(/([A-Z][A-Za-z.'’\- ]{2,70})\s+since\s+(\d{2}-[A-Za-z]{3}-\d{4})/g)) {
    const name = cleanManager(match[1]);
    if (name) managerMap.set(name.toLowerCase(), { name, startDate: isoDate(match[2]), startLabel: `Since ${match[2]}` });
  }

  const turnover = text.match(/Turnover\s+([0-9]+(?:\.[0-9]+)?)%/i);
  const expense = text.match(/Base Expense Ratio[^0-9]{0,100}([0-9]+(?:\.[0-9]+)?)%/i);
  const aum = text.match(/Assets[^₹]{0,120}₹\s*([0-9,]+(?:\.[0-9]+)?)\s*Cr/i);
  const benchmark = text.match(/Benchmark\s+(.+?)\s+Riskometer/i);
  const nav = text.match(/latest declared NAV[^₹]*₹\s*([0-9]+(?:\.[0-9]+)?).*?as of\s+(\d{2}-[A-Za-z]{3}-\d{4})/i);
  const holdings = parsePairs(block(text, 'Company Percentage of Portfolio', 'See More'), 10);
  const assetAllocation = parseAllocation(text, 'Asset Allocation', ['Equity', 'Debt', 'Real Estate', 'Cash & Cash Eq.', 'Cash']);
  const marketCap = parseAllocation(text, 'Market Cap Weightage', ['Large', 'Mid', 'Small']);

  return {
    fundName,
    canonicalName: canonical(fundName),
    fundHouse,
    valueResearch: {
      ok: true,
      provider: 'Value Research Online',
      url,
      fundName,
      fundHouse,
      managers: [...managerMap.values()],
      turnoverPct: turnover ? Number(turnover[1]) : undefined,
      expenseRatioPct: expense ? Number(expense[1]) : undefined,
      aumCr: aum ? Number(aum[1].replace(/,/g, '')) : undefined,
      benchmark: benchmark?.[1]?.trim(),
      nav: nav ? Number(nav[1]) : undefined,
      navDate: nav?.[2],
      holdings,
      assetAllocation,
      marketCap,
      rawCoverage: { managers: managerMap.size, holdings: holdings.length, assetAllocation: assetAllocation.length, marketCap: marketCap.length }
    }
  };
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error: error instanceof Error ? error.message : String(error) }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

async function previousUniverse() {
  try {
    const previous = await import(`${pathToFileURL(OUTPUT).href}?t=${Date.now()}`);
    return previous.VRO_FUND_INTELLIGENCE || {};
  } catch {
    return {};
  }
}

function managerRegistry(records) {
  const map = new Map();
  for (const fund of records) {
    for (const manager of fund.valueResearch.managers || []) {
      const key = `${slugify(manager.name)}::${canonical(fund.fundHouse)}`;
      const record = map.get(key) || {
        id: slugify(`${manager.name}-${fund.fundHouse}`),
        name: manager.name,
        amc: fund.fundHouse,
        role: 'Fund manager',
        style: 'Scheme-level public manager record from Value Research Online.',
        decisions: ['Fund allocation', 'Portfolio construction', 'Sector positioning', 'Entry and exit discipline'],
        aliases: [],
        schemeAliases: [],
        confidence: 0.9,
        verified: true,
        sourceType: 'Value Research Online public fund page',
        source: { label: 'Value Research Online fund page', url: fund.valueResearch.url, asOf: fund.valueResearch.navDate || new Date().toISOString().slice(0, 10) }
      };
      record.schemeAliases.push(fund.fundName);
      if (!record.startDate && manager.startDate) {
        record.startDate = manager.startDate;
        record.startLabel = manager.startLabel;
      }
      map.set(key, record);
    }
  }
  return [...map.values()].map(item => ({ ...item, schemeAliases: [...new Set(item.schemeAliases)] }));
}

async function main() {
  const oldUniverse = await previousUniverse();
  const discovery = await discoverFundUrls();
  if (!discovery.urls.length) throw new Error('Value Research sitemap discovery returned no direct-plan fund pages.');
  console.log(`Discovered ${discovery.urls.length} direct-plan fund pages from ${discovery.sitemapsScanned} sitemaps.`);

  let completed = 0;
  const parsed = await mapConcurrent(discovery.urls, CONCURRENCY, async url => {
    const page = await fetchPage(url);
    completed += 1;
    if (completed % 100 === 0) console.log(`Processed ${completed}/${discovery.urls.length}`);
    if (!page.ok) return null;
    const record = parseFundPage(page.body, page.url);
    return record?.canonicalName && (record.valueResearch.managers.length || record.valueResearch.holdings.length) ? record : null;
  });

  const records = parsed.filter(Boolean);
  const managers = managerRegistry(records);
  const generatedAt = new Date().toISOString();
  const intelligence = {};
  for (const record of records) {
    const existing = oldUniverse[record.canonicalName];
    const current = {
      fetchedAt: generatedAt,
      valueResearch: record.valueResearch,
      advisorKhoj: existing?.current?.advisorKhoj || null,
      managers: record.valueResearch.managers,
      turnoverPct: record.valueResearch.turnoverPct,
      benchmark: record.valueResearch.benchmark,
      holdings: record.valueResearch.holdings,
      sectors: existing?.current?.sectors || [],
      assetAllocation: record.valueResearch.assetAllocation,
      marketCap: record.valueResearch.marketCap,
      expenseRatioPct: record.valueResearch.expenseRatioPct,
      aumCr: record.valueResearch.aumCr,
      riskMetrics: existing?.current?.riskMetrics || null,
      sources: [{ name: 'Value Research Online', type: 'Manager, holdings, turnover and fund facts', url: record.valueResearch.url, asOf: record.valueResearch.navDate || generatedAt }]
    };
    intelligence[record.canonicalName] = { current, previous: existing?.current || existing?.previous || null };
  }

  const meta = {
    generatedAt,
    sitemapsScanned: discovery.sitemapsScanned,
    fundPagesDiscovered: discovery.urls.length,
    fundHousesResolvedFromFundPages: new Set(records.map(item => item.fundHouse)).size,
    fundsScanned: records.length,
    managers: managers.length,
    failedOrEmptyPages: discovery.urls.length - records.length,
    source: 'Public Value Research Online fund pages discovered through the allowed sitemap'
  };
  const output = `// Auto-generated by scripts/sync-vro-sitemap-universe.mjs.\n// Public fund facts only; premium/locked content is not collected.\nexport const VRO_MANAGER_REGISTRY = ${JSON.stringify(managers, null, 2)};\n\nexport const VRO_FUND_INTELLIGENCE = ${JSON.stringify(intelligence, null, 2)};\n\nexport const VRO_UNIVERSE_META = ${JSON.stringify(meta, null, 2)};\n`;
  await fs.writeFile(OUTPUT, output, 'utf8');
  console.log(`Wrote ${managers.length} managers and ${records.length} funds across ${meta.fundHousesResolvedFromFundPages} fund houses.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
