import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = 'https://www.valueresearchonline.com/funds/';
const OUTPUT = path.resolve('data/vro-universe.generated.js');
const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 18000;
const MAX_RETRIES = 2;
const PAUSE_BETWEEN_REQUESTS_MS = 120;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&rsquo;|&#8217;/gi, '’')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return decodeHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/li>|<\/h\d>|<\/div>|<\/tr>|<\/td>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function links(html, base) {
  const out = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decodeHtml(match[1]), base).href;
      out.push({ url, text: stripHtml(match[2]) });
    } catch {}
  }
  return out;
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

function block(text, start, end) {
  const lower = text.toLowerCase();
  const from = lower.indexOf(start.toLowerCase());
  if (from < 0) return '';
  const after = from + start.length;
  const to = end ? lower.indexOf(end.toLowerCase(), after) : -1;
  return text.slice(after, to >= 0 ? to : undefined).trim();
}

function cleanManagerName(value) {
  const name = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .replace(/\s+(?:education|experience|funds managed).*$/i, '')
    .trim();
  if (name.length < 3 || name.length > 80) return null;
  if (/fund|scheme|plan|education|experience|interview|portfolio|benchmark|return/i.test(name)) return null;
  if (!/[A-Za-z]/.test(name)) return null;
  return name;
}

function parsePairs(value, limit = 10) {
  const items = String(value || '').split(/\n/).map(item => item.trim()).filter(Boolean);
  const out = [];
  for (let index = 1; index < items.length; index += 1) {
    const weight = Number(items[index].replace(/[%₹,]/g, ''));
    if (!Number.isFinite(weight)) continue;
    const name = items[index - 1];
    if (!name || /^[-+]?\d/.test(name) || /see more|show all|created with|highcharts|percentage/i.test(name)) continue;
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

function isoDate(value) {
  const match = String(value || '').match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return `${match[3]}-${months[match[2]] || '01'}-${match[1]}`;
}

function parsePage(html, url, fallbackName, fundHouse) {
  const text = stripHtml(html);
  const managerMap = new Map();

  const about = text.match(/currently managed by\s+(.+?)\.\s+The fund has/i);
  if (about) {
    for (const raw of about[1].split(/,|\band\b/i)) {
      const name = cleanManagerName(raw);
      if (name) managerMap.set(name.toLowerCase(), { name, startDate: null, startLabel: null });
    }
  }

  const managerSection = block(text, 'Fund Manager', 'Most Recent Dividends') || block(text, 'Fund Manager', 'FAQ for');
  for (const match of managerSection.matchAll(/([A-Z][A-Za-z.'’\- ]{2,70})\s+since\s+(\d{2}-[A-Za-z]{3}-\d{4})/g)) {
    const name = cleanManagerName(match[1]);
    if (name) managerMap.set(name.toLowerCase(), { name, startDate: isoDate(match[2]), startLabel: `Since ${match[2]}` });
  }

  const heading = stripHtml(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const fundName = heading || fallbackName || new URL(url).pathname.split('/').filter(Boolean).at(-1)?.replace(/-/g, ' ');
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
      rawCoverage: {
        managers: managerMap.size,
        holdings: holdings.length,
        assetAllocation: assetAllocation.length,
        marketCap: marketCap.length
      }
    }
  };
}

async function fetchPage(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,*/*',
        'user-agent': 'ManagerLens/0.7 public-fund-universe-sync'
      }
    });
    if (response.status === 429 || response.status >= 500) throw new Error(`retryable ${response.status}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return { ok: true, url: response.url, html: await response.text() };
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      await sleep(800 * Math.pow(2, attempt));
      return fetchPage(url, attempt + 1);
    }
    return { ok: false, url, html: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    await sleep(PAUSE_BETWEEN_REQUESTS_MS);
  }
}

async function previousUniverse() {
  try {
    const moduleUrl = `${pathToFileURL(OUTPUT).href}?t=${Date.now()}`;
    const previous = await import(moduleUrl);
    return previous.VRO_FUND_INTELLIGENCE || {};
  } catch {
    return {};
  }
}

async function discoverFunds() {
  const home = await fetchPage(HOME);
  if (!home.ok) throw new Error(`Value Research fund-house directory failed: ${home.error}`);
  const houses = [...new Map(links(home.html, home.url)
    .filter(item => /\/funds\/selector\/fund-house\/\d+\//i.test(item.url))
    .map(item => [item.url.split('?')[0], { url: item.url.split('?')[0], name: item.text }])).values()];

  const funds = new Map();
  let houseCount = 0;
  for (const house of houses) {
    const url = new URL(house.url);
    url.searchParams.set('end-type', '1');
    url.searchParams.set('exclude', 'fmps,suspended-plans');
    url.searchParams.set('plan-type', 'direct');
    const page = await fetchPage(url.href);
    if (!page.ok) {
      console.warn(`Fund house skipped: ${house.name || house.url}: ${page.error}`);
      continue;
    }
    houseCount += 1;
    for (const item of links(page.html, page.url)) {
      let pathname;
      try { pathname = new URL(item.url).pathname; } catch { continue; }
      if (!/\/funds\/\d+\/[^/]+\/$/i.test(pathname)) continue;
      const cleanUrl = item.url.split('?')[0];
      const name = item.text.replace(/\s+/g, ' ').trim();
      if (!name || /compare|add to/i.test(name)) continue;
      const existing = funds.get(cleanUrl);
      if (!existing || name.length > existing.name.length) funds.set(cleanUrl, { url: cleanUrl, name, fundHouse: house.name });
    }
  }
  return { houses: houseCount, funds: [...funds.values()] };
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

function mergeManagers(records) {
  const map = new Map();
  for (const fund of records) {
    for (const manager of fund.valueResearch.managers || []) {
      const key = `${slugify(manager.name)}::${canonical(fund.fundHouse)}`;
      const existing = map.get(key) || {
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
      existing.schemeAliases.push(fund.fundName);
      if (!existing.startDate && manager.startDate) {
        existing.startDate = manager.startDate;
        existing.startLabel = manager.startLabel;
      }
      map.set(key, existing);
    }
  }
  return [...map.values()].map(record => ({ ...record, schemeAliases: [...new Set(record.schemeAliases)] }));
}

async function main() {
  const oldUniverse = await previousUniverse();
  const discovery = await discoverFunds();
  console.log(`Discovered ${discovery.funds.length} direct-plan fund pages across ${discovery.houses} fund houses.`);

  let completed = 0;
  const parsed = await mapConcurrent(discovery.funds, CONCURRENCY, async fund => {
    const page = await fetchPage(fund.url);
    completed += 1;
    if (completed % 50 === 0) console.log(`Processed ${completed}/${discovery.funds.length}`);
    if (!page.ok) return null;
    const record = parsePage(page.html, page.url, fund.name, fund.fundHouse);
    if (!record.canonicalName || !record.valueResearch.managers.length && !record.valueResearch.holdings.length) return null;
    return record;
  });

  const records = parsed.filter(Boolean);
  const managers = mergeManagers(records);
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
    intelligence[record.canonicalName] = {
      current,
      previous: existing?.current || existing?.previous || null
    };
  }

  const meta = {
    generatedAt,
    fundHousesScanned: discovery.houses,
    fundPagesDiscovered: discovery.funds.length,
    fundsScanned: records.length,
    managers: managers.length,
    failedOrEmptyPages: discovery.funds.length - records.length,
    source: 'Public Value Research Online fund pages'
  };
  const output = `// Auto-generated by scripts/sync-vro-universe.mjs.\n// Public fund facts only; premium/locked content is not collected.\nexport const VRO_MANAGER_REGISTRY = ${JSON.stringify(managers, null, 2)};\n\nexport const VRO_FUND_INTELLIGENCE = ${JSON.stringify(intelligence, null, 2)};\n\nexport const VRO_UNIVERSE_META = ${JSON.stringify(meta, null, 2)};\n`;
  await fs.writeFile(OUTPUT, output, 'utf8');
  console.log(`Wrote ${managers.length} managers and ${records.length} fund records.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
