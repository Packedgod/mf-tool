import { canonicalSchemeName, normaliseAmc } from '@/lib/manager-registry';
import { VRO_FUND_INTELLIGENCE } from '@/data/vro-universe.generated';

const VRO_HOME = 'https://www.valueresearchonline.com/funds/';
const AK_BASE = 'https://www.advisorkhoj.com/mutual-funds-research/';
const FRESH_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

function cache() {
  globalThis.__MANAGERLENS_RESEARCH_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_RESEARCH_CACHE__;
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
    .replace(/<\/p>|<\/li>|<\/h\d>|<\/div>|<\/tr>|<\/td>|<\/th>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function links(html, base) {
  const result = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      result.push({ url: new URL(decodeHtml(match[1]), base).href, text: stripHtml(match[2]) });
    } catch {}
  }
  return result;
}

function cleanName(value) {
  return String(value || '')
    .replace(/^[•·\-–—\s]+/, '')
    .replace(/[|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function schemeTokens(value) {
  return canonicalSchemeName(value)
    .replace(/\b(fund|scheme|option|portfolio|growth|direct|regular|plan)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(token => token.length > 1);
}

function tokenScore(left, right) {
  const a = new Set(schemeTokens(left));
  const b = new Set(schemeTokens(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  const containment = [...a].every(token => b.has(token)) || [...b].every(token => a.has(token));
  return intersection / Math.max(a.size, b.size) + (containment ? 0.15 : 0);
}

async function fetchText(url, timeoutMs = 16000, force = false) {
  const key = `text:${url}`;
  const store = cache();
  const now = Date.now();
  const cached = store.get(key);
  if (!force && cached && now - cached.at < FRESH_MS) return { ...cached.value, cache: 'fresh' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        'user-agent': 'ManagerLens/1.0 ValueResearch-AdvisorKhoj live resolver'
      }
    });
    if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
    const value = { ok: true, url: response.url, html: await response.text(), fetchedAt: new Date().toISOString() };
    store.set(key, { at: now, value });
    return value;
  } catch (error) {
    if (cached && now - cached.at < STALE_MS) return { ...cached.value, cache: 'stale', warning: error instanceof Error ? error.message : String(error) };
    return { ok: false, url, html: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function block(text, starts, ends) {
  const startList = Array.isArray(starts) ? starts : [starts];
  const endList = Array.isArray(ends) ? ends : [ends];
  const lower = String(text || '').toLowerCase();
  let from = -1;
  let startLength = 0;
  for (const start of startList.filter(Boolean)) {
    const index = lower.indexOf(String(start).toLowerCase());
    if (index >= 0 && (from < 0 || index < from)) {
      from = index;
      startLength = String(start).length;
    }
  }
  if (from < 0) return '';
  const after = from + startLength;
  let to = -1;
  for (const end of endList.filter(Boolean)) {
    const index = lower.indexOf(String(end).toLowerCase(), after);
    if (index >= 0 && (to < 0 || index < to)) to = index;
  }
  return String(text || '').slice(after, to >= 0 ? to : undefined).trim();
}

function validPortfolioName(value) {
  const name = cleanName(value);
  if (name.length < 2 || name.length > 140) return false;
  if (/^(total|see more|show all|company|sector|portfolio|percentage|asset allocation|market cap|riskometer)/i.test(name)) return false;
  if (/return|expense|turnover|benchmark|rating|nav|assets|standard deviation|sharpe|alpha|beta/i.test(name)) return false;
  return /[A-Za-z]/.test(name);
}

function parseWeightedPairs(section, limit = 30) {
  const text = String(section || '');
  const result = [];
  const seen = new Set();
  const push = (nameValue, weightValue) => {
    const name = cleanName(nameValue).replace(/\s+(?:Ltd\.?|Limited)$/i, match => match.trim());
    const weight = Number(String(weightValue).replace(/[%₹,]/g, ''));
    const key = name.toLowerCase();
    if (!validPortfolioName(name) || !Number.isFinite(weight) || weight <= 0 || weight > 100 || seen.has(key)) return;
    seen.add(key);
    result.push({ name, weight });
  };

  for (const match of text.matchAll(/(?:^|\n)\s*([^\n]{2,140}?)\s+(\d{1,3}(?:\.\d{1,4})?)\s*%?(?=\s*(?:\n|$))/g)) {
    push(match[1], match[2]);
    if (result.length >= limit) return result;
  }

  const rows = text.split(/\n/).map(cleanName).filter(Boolean);
  for (let index = 1; index < rows.length; index += 1) {
    if (/^-?\d{1,3}(?:\.\d{1,4})?%?$/.test(rows[index])) push(rows[index - 1], rows[index]);
    if (result.length >= limit) break;
  }
  return result;
}

function parseAllocation(text, heading, labels, endHeading) {
  const section = block(text, heading, endHeading);
  const result = [];
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`([0-9]+(?:\\.[0-9]+)?)%?\\s*${escaped}`, 'i'),
      new RegExp(`${escaped}\\s*([0-9]+(?:\\.[0-9]+)?)%?`, 'i')
    ];
    const match = patterns.map(pattern => section.match(pattern)).find(Boolean);
    if (match) result.push({ name: label, weight: Number(match[1]) });
  }
  return result;
}

function cleanManagerName(value) {
  const name = cleanName(value).replace(/\s+(?:since|education|experience).*$/i, '').trim();
  if (name.length < 3 || name.length > 80 || /fund|scheme|plan|education|experience|interview/i.test(name)) return null;
  return name;
}

function mergeRows(primary, fallback) {
  return primary?.length ? primary : fallback || [];
}

function mergeValueResearch(live, stored) {
  if (!live) return stored || null;
  if (!stored) return live;
  return {
    ...stored,
    ...live,
    managers: mergeRows(live.managers, stored.managers),
    holdings: mergeRows(live.holdings, stored.holdings),
    assetAllocation: mergeRows(live.assetAllocation, stored.assetAllocation),
    marketCap: mergeRows(live.marketCap, stored.marketCap),
    turnoverPct: live.turnoverPct ?? stored.turnoverPct,
    expenseRatioPct: live.expenseRatioPct ?? stored.expenseRatioPct,
    aumCr: live.aumCr ?? stored.aumCr,
    benchmark: live.benchmark || stored.benchmark,
    nav: live.nav ?? stored.nav,
    navDate: live.navDate || stored.navDate,
    url: live.url || stored.url
  };
}

function mergeAdvisorKhoj(live, stored) {
  if (!live) return stored || null;
  if (!stored) return live;
  return {
    ...stored,
    ...live,
    sectors: mergeRows(live.sectors, stored.sectors),
    holdings: mergeRows(live.holdings, stored.holdings),
    officialDocuments: [...new Map([...(live.officialDocuments || []), ...(stored.officialDocuments || [])].map(item => [item.url, item])).values()],
    riskMetrics: { ...(stored.riskMetrics || {}), ...(live.riskMetrics || {}) },
    turnoverPct: live.turnoverPct ?? stored.turnoverPct,
    expenseRatioPct: live.expenseRatioPct ?? stored.expenseRatioPct,
    aumCr: live.aumCr ?? stored.aumCr,
    benchmark: live.benchmark || stored.benchmark,
    nav: live.nav ?? stored.nav,
    navDate: live.navDate || stored.navDate,
    url: live.url || stored.url
  };
}

export function parseValueResearch(html, url) {
  const text = stripHtml(html);
  const managerMap = new Map();
  const about = text.match(/currently managed by\s+(.+?)\.\s+(?:The fund has|It has|The scheme)/i);
  if (about) {
    for (const raw of about[1].split(/,|\band\b/i)) {
      const name = cleanManagerName(raw);
      if (name) managerMap.set(name.toLowerCase(), { name, startDate: null, startLabel: null });
    }
  }
  const managerSection = block(text, ['Fund Manager', 'Fund Managers'], ['Most Recent Dividends', 'FAQ for', 'Investment Strategy']);
  for (const match of managerSection.matchAll(/([A-Z][A-Za-z.'’\- ]{2,70})\s+since\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/g)) {
    const name = cleanManagerName(match[1]);
    if (name) managerMap.set(name.toLowerCase(), { name, startDate: match[2], startLabel: `Since ${match[2]}` });
  }

  const portfolioSection = block(text,
    ['Company Percentage of Portfolio', 'Portfolio Breakdown', 'Top Holdings', 'Company % of Portfolio'],
    ['Asset Allocation', 'Market Cap Weightage', 'Fund Manager', 'Sector Percentage of Portfolio', 'See More']);
  const holdings = parseWeightedPairs(portfolioSection, 25);
  const turnover = text.match(/Turnover\s+(?:Ratio\s+)?([0-9]+(?:\.[0-9]+)?)%/i);
  const expense = text.match(/Base Expense Ratio[^0-9]{0,100}([0-9]+(?:\.[0-9]+)?)%/i);
  const aum = text.match(/Assets[^₹]{0,120}₹\s*([0-9,]+(?:\.[0-9]+)?)\s*Cr/i);
  const benchmark = text.match(/Benchmark\s+(.+?)\s+(?:Riskometer|Risk-o-meter|Fund Risk)/i);
  const nav = text.match(/latest declared NAV[^₹]*₹\s*([0-9]+(?:\.[0-9]+)?).*?as of\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i);
  const heading = stripHtml(String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');

  return {
    ok: true,
    provider: 'Value Research Online',
    url,
    fetchedAt: new Date().toISOString(),
    fundName: heading || text.match(/^([^\n]{3,120})/)?.[1] || '',
    managers: [...managerMap.values()],
    turnoverPct: turnover ? Number(turnover[1]) : undefined,
    expenseRatioPct: expense ? Number(expense[1]) : undefined,
    aumCr: aum ? Number(aum[1].replace(/,/g, '')) : undefined,
    benchmark: benchmark?.[1]?.trim(),
    nav: nav ? Number(nav[1]) : undefined,
    navDate: nav?.[2],
    holdings,
    assetAllocation: parseAllocation(text, 'Asset Allocation', ['Equity', 'Debt', 'Real Estate', 'Cash & Cash Eq.', 'Cash'], 'Market Cap Weightage'),
    marketCap: parseAllocation(text, 'Market Cap Weightage', ['Large', 'Mid', 'Small'], 'Portfolio Breakdown'),
    rawCoverage: { managers: managerMap.size, holdings: holdings.length }
  };
}

export function parseAdvisorKhoj(html, url) {
  const text = stripHtml(html);
  const sectorSection = block(text, ['Top 10 Sectors in portfolio (%)', 'Top Sectors', 'Sector Allocation'], ['Top 10 Stocks in portfolio (%)', 'Top Stocks', 'Market Cap Distribution']);
  const holdingSection = block(text, ['Top 10 Stocks in portfolio (%)', 'Top Stocks', 'Top Holdings'], ['Market Cap Distribution', 'Portfolio Analysis', 'Scheme Documents']);
  const allLinks = links(html, url);
  const documents = allLinks.filter(item =>
    /\.(?:xlsx?|csv|pdf)(?:$|\?)/i.test(item.url)
    || /monthly\s+portfolio|portfolio\s+disclosure|fact\s*sheet|factsheet|scheme\s+document/i.test(`${item.text} ${item.url}`)
  ).map(item => ({
    ...item,
    type: /\.xlsx?(?:$|\?)/i.test(item.url) ? 'spreadsheet'
      : /\.pdf(?:$|\?)/i.test(item.url) ? 'pdf'
        : 'landing-page'
  }));

  const turnover = text.match(/Turn\s*over:?\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const expense = text.match(/TER:?\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const aum = text.match(/Total Assets:?\s*([0-9,]+(?:\.[0-9]+)?)\s*Cr/i);
  const benchmark = text.match(/Benchmark:?\s*([^\n]+)/i);
  const nav = text.match(/NAV as on\s*([0-9\-/]+)\s*([0-9]+(?:\.[0-9]+)?)/i);
  const metric = label => text.match(new RegExp(`${label}\\s+(-?[0-9]+(?:\\.[0-9]+)?)`, 'i'));

  return {
    ok: true,
    provider: 'AdvisorKhoj',
    url,
    fetchedAt: new Date().toISOString(),
    turnoverPct: turnover ? Number(turnover[1]) : undefined,
    expenseRatioPct: expense ? Number(expense[1]) : undefined,
    aumCr: aum ? Number(aum[1].replace(/,/g, '')) : undefined,
    benchmark: benchmark?.[1]?.trim(),
    nav: nav ? Number(nav[2]) : undefined,
    navDate: nav?.[1],
    riskMetrics: {
      alpha: metric('Alpha') ? Number(metric('Alpha')[1]) : undefined,
      beta: metric('Beta') ? Number(metric('Beta')[1]) : undefined,
      sharpe: metric('Sharpe Ratio') ? Number(metric('Sharpe Ratio')[1]) : undefined,
      volatility: metric('Standard Deviation') ? Number(metric('Standard Deviation')[1]) : undefined
    },
    sectors: parseWeightedPairs(sectorSection, 25).map(item => ({ sector: item.name, weight: item.weight })),
    holdings: parseWeightedPairs(holdingSection, 25),
    officialDocuments: [...new Map(documents.map(item => [item.url, item])).values()].slice(0, 20)
  };
}

const GENERATED_INDEX = Object.entries(VRO_FUND_INTELLIGENCE || {}).map(([key, record]) => {
  const current = record?.current || {};
  const vro = current.valueResearch || {};
  return {
    key,
    canonicalKey: canonicalSchemeName(key),
    record,
    fundName: vro.fundName || key,
    fundHouse: vro.fundHouse || current.fundHouse || ''
  };
});

function generatedRecord(fund) {
  const candidates = [...new Set([
    fund.canonicalName,
    fund.displayName,
    fund.preferredSchemeName,
    ...(fund.variants || []).map(item => item.schemeName)
  ].map(canonicalSchemeName).filter(Boolean))];

  for (const candidate of candidates) {
    if (VRO_FUND_INTELLIGENCE[candidate]) return { key: candidate, record: VRO_FUND_INTELLIGENCE[candidate], score: 1, match: 'exact' };
  }

  const targetAmc = normaliseAmc(fund.fundHouse);
  let best = null;
  for (const item of GENERATED_INDEX) {
    const recordAmc = normaliseAmc(item.fundHouse);
    if (targetAmc && recordAmc && targetAmc !== recordAmc && !targetAmc.includes(recordAmc) && !recordAmc.includes(targetAmc)) continue;
    const score = Math.max(...candidates.map(candidate => Math.max(tokenScore(candidate, item.canonicalKey), tokenScore(candidate, item.fundName))));
    if (!best || score > best.score) best = { key: item.key, record: item.record, score, match: 'fuzzy' };
  }
  return best?.score >= 0.58 ? best : null;
}

async function discoverVroFundPage(fund) {
  const home = await fetchText(VRO_HOME);
  if (!home.ok) return null;
  const targetAmc = normaliseAmc(fund.fundHouse);
  const houses = links(home.html, home.url)
    .filter(item => /\/funds\/selector\/fund-house\/\d+\//i.test(item.url))
    .map(item => ({ ...item, score: tokenScore(item.text, fund.fundHouse) + (normaliseAmc(item.text) === targetAmc ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  const house = houses[0];
  if (!house || house.score < 0.25) return null;
  const selectorUrl = new URL(house.url);
  selectorUrl.searchParams.set('end-type', '1');
  selectorUrl.searchParams.set('exclude', 'fmps,suspended-plans');
  selectorUrl.searchParams.set('plan-type', 'direct');
  const selector = await fetchText(selectorUrl.href, 20000);
  if (!selector.ok) return null;
  const candidates = links(selector.html, selector.url)
    .filter(item => {
      try { return /\/funds\/\d+\/[^/]+\/$/i.test(new URL(item.url).pathname); } catch { return false; }
    })
    .map(item => ({ ...item, score: Math.max(tokenScore(item.text, fund.displayName), tokenScore(new URL(item.url).pathname, fund.displayName)) }))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 0.45 ? candidates[0].url : null;
}

function advisorKhojSlugs(fund) {
  const rawNames = [...new Set([
    fund.preferredSchemeName,
    fund.displayName,
    ...(fund.variants || []).map(item => item.schemeName)
  ].filter(Boolean))];
  const bases = rawNames.map(name => String(name)
    .replace(/\bDirect\s*(Plan)?\b|\bRegular\s*(Plan)?\b|\bGrowth\s*(Option)?\b|\bIDCW\b|\bDividend\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim());
  const names = [...rawNames, ...bases.flatMap(base => [
    base,
    `${base} Growth Option Direct Plan`,
    `${base} Growth Option Regular Plan`,
    `${base} Direct Plan Growth Option`
  ])];
  return [...new Set(names.map(name => name
    .replace(/&/g, 'and')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')))].filter(Boolean).slice(0, 24);
}

async function fetchAdvisorKhoj(fund, knownUrl) {
  const urls = [knownUrl, ...advisorKhojSlugs(fund).map(slug => `${AK_BASE}${slug}`)].filter(Boolean);
  for (const url of [...new Set(urls)]) {
    const result = await fetchText(url, 18000, Boolean(knownUrl && url === knownUrl));
    if (result.ok && /Fund House:|Category:|PERFORMANCE|Scheme Documents|Top 10 Stocks/i.test(result.html)) return parseAdvisorKhoj(result.html, result.url);
  }
  return null;
}

export async function resolveFundResearch(fund) {
  const key = `fund-research:${fund.id || canonicalSchemeName(fund.displayName)}`;
  const store = cache();
  const now = Date.now();
  const cached = store.get(key);
  if (cached && now - cached.at < FRESH_MS) return { ...cached.value, cache: 'fresh' };

  const generatedMatch = generatedRecord(fund);
  const generated = generatedMatch?.record || null;
  const storedVro = generated?.current?.valueResearch || null;
  const storedAdvisor = generated?.current?.advisorKhoj || null;
  let previous = generated?.previous || null;

  let vroUrl = storedVro?.url || null;
  if (!vroUrl) vroUrl = await discoverVroFundPage(fund);
  const [vroPage, liveAdvisor] = await Promise.all([
    vroUrl ? fetchText(vroUrl, 20000, true) : Promise.resolve(null),
    fetchAdvisorKhoj(fund, storedAdvisor?.url)
  ]);
  const liveVro = vroPage?.ok ? parseValueResearch(vroPage.html, vroPage.url) : null;
  const valueResearch = mergeValueResearch(liveVro, storedVro);
  const advisorKhoj = mergeAdvisorKhoj(liveAdvisor, storedAdvisor);

  const current = {
    fetchedAt: new Date().toISOString(),
    portfolioAsOf: valueResearch?.navDate || advisorKhoj?.navDate || null,
    valueResearch,
    advisorKhoj,
    managers: mergeRows(valueResearch?.managers, generated?.current?.managers),
    turnoverPct: valueResearch?.turnoverPct ?? advisorKhoj?.turnoverPct ?? generated?.current?.turnoverPct,
    benchmark: valueResearch?.benchmark || advisorKhoj?.benchmark || generated?.current?.benchmark,
    holdings: valueResearch?.holdings?.length ? valueResearch.holdings : advisorKhoj?.holdings?.length ? advisorKhoj.holdings : generated?.current?.holdings || [],
    sectors: advisorKhoj?.sectors?.length ? advisorKhoj.sectors : generated?.current?.sectors || [],
    assetAllocation: mergeRows(valueResearch?.assetAllocation, generated?.current?.assetAllocation),
    marketCap: mergeRows(valueResearch?.marketCap, generated?.current?.marketCap),
    expenseRatioPct: valueResearch?.expenseRatioPct ?? advisorKhoj?.expenseRatioPct ?? generated?.current?.expenseRatioPct,
    aumCr: valueResearch?.aumCr ?? advisorKhoj?.aumCr ?? generated?.current?.aumCr,
    riskMetrics: advisorKhoj?.riskMetrics || generated?.current?.riskMetrics || null,
    sources: [
      valueResearch && { name: 'Value Research Online', type: 'Live manager, holdings, turnover and fund facts', url: valueResearch.url, asOf: valueResearch.navDate || valueResearch.fetchedAt },
      advisorKhoj && { name: 'AdvisorKhoj', type: 'Live fund facts, risk metrics and portfolio-document discovery', url: advisorKhoj.url, asOf: advisorKhoj.navDate || advisorKhoj.fetchedAt }
    ].filter(Boolean)
  };

  if (!previous && cached?.value?.current && cached.value.current.holdings?.length) previous = cached.value.current;
  const value = {
    ok: Boolean(valueResearch || advisorKhoj),
    current,
    previous,
    generated: Boolean(generated),
    registryMatch: generatedMatch ? { key: generatedMatch.key, score: generatedMatch.score, type: generatedMatch.match } : null,
    diagnostics: {
      liveValueResearch: Boolean(liveVro),
      liveAdvisorKhoj: Boolean(liveAdvisor),
      holdings: current.holdings.length,
      sectors: current.sectors.length,
      documents: advisorKhoj?.officialDocuments?.length || 0,
      valueResearchError: vroPage && !vroPage.ok ? vroPage.error : null
    },
    fetchedAt: current.fetchedAt
  };
  store.set(key, { at: now, value });
  return value;
}
