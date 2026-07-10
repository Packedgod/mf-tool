import { canonicalSchemeName, normaliseAmc } from '@/lib/manager-registry';
import { SECTOR_MARKET_SYMBOLS } from '@/lib/momentum-data';
import { VRO_FUND_INTELLIGENCE } from '@/data/vro-universe.generated';

const VRO_HOME = 'https://www.valueresearchonline.com/funds/';
const AK_BASE = 'https://www.advisorkhoj.com/mutual-funds-research/';
const FRESH_MS = 6 * 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

function cache() {
  globalThis.__MANAGERLENS_FALLBACK_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_FALLBACK_CACHE__;
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

function lines(text) {
  return String(text || '').split(/\n/).map(item => item.trim()).filter(Boolean);
}

function links(html, base) {
  const out = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      out.push({ url: new URL(decodeHtml(match[1]), base).href, text: stripHtml(match[2]) });
    } catch {}
  }
  return out;
}

function tokenScore(left, right) {
  const clean = value => canonicalSchemeName(value)
    .replace(/\b(fund|direct|regular|plan|growth|option|scheme)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const a = new Set(clean(left).split(' ').filter(Boolean));
  const b = new Set(clean(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  return intersection / Math.max(a.size, b.size);
}

async function fetchText(url, timeoutMs = 15000) {
  const key = `text:${url}`;
  const store = cache();
  const now = Date.now();
  const cached = store.get(key);
  if (cached && now - cached.at < FRESH_MS) return { ...cached.value, cache: 'fresh' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        'user-agent': 'ManagerLens/0.7 public-fund-research-fallback'
      }
    });
    if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
    const value = { ok: true, url: response.url, html: await response.text(), fetchedAt: new Date().toISOString() };
    store.set(key, { at: now, value });
    return value;
  } catch (error) {
    if (cached && now - cached.at < STALE_MS) return { ...cached.value, cache: 'stale', warning: error.message };
    return { ok: false, url, html: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function block(text, start, end) {
  const lower = text.toLowerCase();
  const from = lower.indexOf(start.toLowerCase());
  if (from < 0) return '';
  const after = from + start.length;
  const to = end ? lower.indexOf(end.toLowerCase(), after) : -1;
  return text.slice(after, to >= 0 ? to : undefined).trim();
}

function parsePairs(value, limit = 20) {
  const items = lines(value);
  const out = [];
  for (let index = 1; index < items.length; index += 1) {
    const number = Number(items[index].replace(/[%₹,]/g, ''));
    if (!Number.isFinite(number)) continue;
    const name = items[index - 1];
    if (!name || /^[-+]?\d/.test(name) || /see more|show all|created with|highcharts|percentage/i.test(name)) continue;
    out.push({ name, weight: number });
    if (out.length >= limit) break;
  }
  return out;
}

function parseAllocation(text, heading, labels) {
  const section = block(text, heading, heading === 'Asset Allocation' ? 'Market Cap Weightage' : 'Portfolio Breakdown');
  const out = [];
  for (const label of labels) {
    const match = section.match(new RegExp(`([0-9]+(?:\\.[0-9]+)?)%\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
    if (match) out.push({ name: label, weight: Number(match[1]) });
  }
  return out;
}

function cleanManagerName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').replace(/^[,;\s]+|[,;\s]+$/g, '').trim();
  if (name.length < 3 || name.length > 80 || /fund|scheme|plan|education|experience|interview/i.test(name)) return null;
  return name;
}

export function parseValueResearch(html, url) {
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
    if (name) managerMap.set(name.toLowerCase(), { name, startDate: match[2], startLabel: `Since ${match[2]}` });
  }

  const turnover = text.match(/Turnover\s+([0-9]+(?:\.[0-9]+)?)%/i);
  const expense = text.match(/Base Expense Ratio[^0-9]{0,80}([0-9]+(?:\.[0-9]+)?)%/i);
  const aum = text.match(/Assets[^₹]{0,100}₹\s*([0-9,]+(?:\.[0-9]+)?)\s*Cr/i);
  const benchmark = text.match(/Benchmark\s+(.+?)\s+Riskometer/i);
  const nav = text.match(/latest declared NAV[^₹]*₹\s*([0-9]+(?:\.[0-9]+)?).*?as of\s+(\d{2}-[A-Za-z]{3}-\d{4})/i);
  const holdings = parsePairs(block(text, 'Company Percentage of Portfolio', 'See More'), 10);
  const assetAllocation = parseAllocation(text, 'Asset Allocation', ['Equity', 'Debt', 'Real Estate', 'Cash & Cash Eq.', 'Cash']);
  const marketCap = parseAllocation(text, 'Market Cap Weightage', ['Large', 'Mid', 'Small']);

  return {
    ok: true,
    provider: 'Value Research Online',
    url,
    fundName: (text.match(/#?\s*([^\n]+?)\s+Equity\s+•/i)?.[1] || '').trim(),
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
  };
}

export function parseAdvisorKhoj(html, url) {
  const text = stripHtml(html);
  const turnover = text.match(/Turn over:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const expense = text.match(/TER:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const aum = text.match(/Total Assets:\s*([0-9,]+(?:\.[0-9]+)?)\s*Cr/i);
  const benchmark = text.match(/Benchmark:\s*([^\n]+)/i);
  const nav = text.match(/NAV as on\s*([0-9\-]+)\s*([0-9]+(?:\.[0-9]+)?)/i);
  const alpha = text.match(/Alpha\s+(-?[0-9]+(?:\.[0-9]+)?)/i);
  const beta = text.match(/Beta\s+(-?[0-9]+(?:\.[0-9]+)?)/i);
  const sharpe = text.match(/Sharpe Ratio\s+(-?[0-9]+(?:\.[0-9]+)?)/i);
  const volatility = text.match(/Standard Deviation\s+(-?[0-9]+(?:\.[0-9]+)?)/i);
  const sectors = parsePairs(block(text, 'Top 10 Sectors in portfolio (%)', 'Top 10 Stocks in portfolio (%)'), 20)
    .map(item => ({ sector: item.name, weight: item.weight }));
  const holdings = parsePairs(block(text, 'Top 10 Stocks in portfolio (%)', 'Market Cap Distribution'), 20);
  const docs = links(html, url).filter(item => /\.pdf(?:$|\?)/i.test(item.url) || /fact\s*sheet|portfolio disclosure/i.test(item.text));

  return {
    ok: true,
    provider: 'AdvisorKhoj',
    url,
    turnoverPct: turnover ? Number(turnover[1]) : undefined,
    expenseRatioPct: expense ? Number(expense[1]) : undefined,
    aumCr: aum ? Number(aum[1].replace(/,/g, '')) : undefined,
    benchmark: benchmark?.[1]?.trim(),
    nav: nav ? Number(nav[2]) : undefined,
    navDate: nav?.[1],
    riskMetrics: {
      alpha: alpha ? Number(alpha[1]) : undefined,
      beta: beta ? Number(beta[1]) : undefined,
      sharpe: sharpe ? Number(sharpe[1]) : undefined,
      volatility: volatility ? Number(volatility[1]) : undefined
    },
    sectors,
    holdings,
    officialDocuments: docs.slice(0, 8)
  };
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
    .filter(item => /\/funds\/\d+\/[^/]+\/$/i.test(new URL(item.url).pathname))
    .map(item => ({ ...item, score: Math.max(tokenScore(item.text, fund.displayName), tokenScore(item.text, fund.canonicalName), tokenScore(new URL(item.url).pathname, fund.displayName)) }))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 0.45 ? candidates[0].url : null;
}

function advisorKhojSlugs(fund) {
  const names = [
    ...(fund.variants || []).map(item => item.schemeName),
    fund.preferredSchemeName,
    fund.displayName
  ].filter(Boolean);
  return [...new Set(names.map(name => String(name)
    .replace(/&/g, 'and')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')))].slice(0, 8);
}

async function fetchAdvisorKhoj(fund) {
  for (const slug of advisorKhojSlugs(fund)) {
    const result = await fetchText(`${AK_BASE}${slug}`);
    if (result.ok && /Fund House:|Category:|PERFORMANCE/i.test(result.html)) return parseAdvisorKhoj(result.html, result.url);
  }
  return null;
}

function generatedRecord(fund) {
  const key = canonicalSchemeName(fund.displayName || fund.canonicalName);
  return VRO_FUND_INTELLIGENCE[key] || null;
}

export async function resolveFundResearch(fund) {
  const key = `fund-research:${fund.id || canonicalSchemeName(fund.displayName)}`;
  const store = cache();
  const now = Date.now();
  const existing = store.get(key);
  if (existing && now - existing.at < FRESH_MS) return { ...existing.value, cache: 'fresh' };

  const generated = generatedRecord(fund);
  let valueResearch = generated?.current?.valueResearch || null;
  let advisorKhoj = generated?.current?.advisorKhoj || null;
  let previous = generated?.previous || null;

  if (!valueResearch) {
    const vroUrl = await discoverVroFundPage(fund);
    if (vroUrl) {
      const page = await fetchText(vroUrl, 20000);
      if (page.ok) valueResearch = parseValueResearch(page.html, page.url);
    }
  }
  if (!advisorKhoj) advisorKhoj = await fetchAdvisorKhoj(fund);

  const current = {
    fetchedAt: new Date().toISOString(),
    valueResearch,
    advisorKhoj,
    managers: valueResearch?.managers || [],
    turnoverPct: valueResearch?.turnoverPct ?? advisorKhoj?.turnoverPct,
    benchmark: valueResearch?.benchmark || advisorKhoj?.benchmark,
    holdings: valueResearch?.holdings?.length ? valueResearch.holdings : advisorKhoj?.holdings || [],
    sectors: advisorKhoj?.sectors || [],
    assetAllocation: valueResearch?.assetAllocation || [],
    marketCap: valueResearch?.marketCap || [],
    expenseRatioPct: valueResearch?.expenseRatioPct ?? advisorKhoj?.expenseRatioPct,
    aumCr: valueResearch?.aumCr ?? advisorKhoj?.aumCr,
    riskMetrics: advisorKhoj?.riskMetrics || null,
    sources: [
      valueResearch && { name: 'Value Research Online', type: 'Manager, holdings, turnover and fund facts', url: valueResearch.url, asOf: valueResearch.navDate || valueResearch.fetchedAt },
      advisorKhoj && { name: 'AdvisorKhoj', type: 'Fund facts, risk metrics, portfolio and official-document discovery', url: advisorKhoj.url, asOf: advisorKhoj.navDate || advisorKhoj.fetchedAt }
    ].filter(Boolean)
  };

  if (!previous && existing?.value?.current) previous = existing.value.current;
  const value = { ok: Boolean(valueResearch || advisorKhoj), current, previous, generated: Boolean(generated), fetchedAt: current.fetchedAt };
  store.set(key, { at: now, value });
  return value;
}

function sectorAlias(value) {
  const text = String(value || '').toLowerCase();
  if (/bank|financial|insurance|finance/.test(text)) return 'Financial Services';
  if (/software|technology|information/.test(text)) return 'Information Technology';
  if (/pharma|health|hospital|biotech/.test(text)) return 'Healthcare';
  if (/auto|automobile/.test(text)) return 'Automobile and Auto Components';
  if (/consumer staple|fmcg|food|tobacco/.test(text)) return 'Fast Moving Consumer Goods';
  if (/consumer cyclical|retail|consumer service/.test(text)) return 'Consumer Services';
  if (/energy|oil|gas|power|coal/.test(text)) return 'Energy';
  if (/metal|mining|steel/.test(text)) return 'Metals & Mining';
  if (/real estate|realty/.test(text)) return 'Realty';
  if (/telecom|communication/.test(text)) return 'Telecommunication';
  if (/industrial|capital goods|construction|infrastructure/.test(text)) return 'Capital Goods';
  if (/chemical/.test(text)) return 'Chemicals';
  return value || 'Other';
}

async function yahooSearch(name) {
  const result = await fetchText(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=8&newsCount=0&listsCount=0`, 9000);
  if (!result.ok) return null;
  try {
    const payload = JSON.parse(result.html);
    const quotes = (payload.quotes || []).filter(item => item.quoteType === 'EQUITY');
    const preferred = quotes.find(item => /NSE|BSE/i.test(`${item.exchange || ''} ${item.exchDisp || ''}`)) || quotes[0];
    return preferred ? { symbol: preferred.symbol, sector: sectorAlias(preferred.sector || preferred.industry), shortname: preferred.shortname } : null;
  } catch {
    return null;
  }
}

async function yahooChart(symbol) {
  const result = await fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includeAdjustedClose=true`, 9000);
  if (!result.ok) return null;
  try {
    const payload = JSON.parse(result.html);
    const chart = payload?.chart?.result?.[0];
    const timestamps = chart?.timestamp || [];
    const closes = chart?.indicators?.adjclose?.[0]?.adjclose || chart?.indicators?.quote?.[0]?.close || [];
    const points = timestamps.map((timestamp, index) => ({ date: new Date(timestamp * 1000).toISOString().slice(0, 10), close: Number(closes[index]) })).filter(item => Number.isFinite(item.close) && item.close > 0);
    return points.length ? points : null;
  } catch {
    return null;
  }
}

function returnAt(points, sessions) {
  if (!points?.length) return undefined;
  const end = points.at(-1)?.close;
  const start = points[Math.max(0, points.length - 1 - sessions)]?.close;
  return Number.isFinite(end) && Number.isFinite(start) && start > 0 ? (end / start - 1) * 100 : undefined;
}

function eventAnalysis(event, points, type) {
  if (!points?.length) return { ...event, ok: false, error: 'Yahoo price history unavailable' };
  const index = Math.max(0, points.length - 22);
  const eventPoint = points[index];
  const local = points.slice(Math.max(0, index - 45), Math.min(points.length, index + 46));
  const peak = Math.max(...local.map(item => item.close));
  const current = points.at(-1).close;
  const change = (current / eventPoint.close - 1) * 100;
  return {
    ...event,
    ok: true,
    eventPrice: eventPoint.close,
    eventPriceDate: eventPoint.date,
    currentPrice: current,
    peakProximityPct: eventPoint.close / peak * 100,
    returnSinceEventPct: change,
    postEventReturnPct: type === 'exit' ? change : undefined,
    source: 'Yahoo Finance'
  };
}

function classifyRegime(broadReturn, sectors) {
  const values = sectors.map(item => item.return3mPct).filter(Number.isFinite);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (values.length - 1) : 0;
  const dispersion = Math.sqrt(variance);
  if (Number.isFinite(broadReturn) && broadReturn > 5) return { id: 'riskOn', label: 'risk-on', explanation: 'Broad three-month momentum is positive.', dispersionPct: dispersion };
  if (Number.isFinite(broadReturn) && broadReturn < -5) return { id: 'riskOff', label: 'risk-off', explanation: 'Broad three-month momentum is negative.', dispersionPct: dispersion };
  if (dispersion > 6) return { id: 'rotation', label: 'sector-rotation', explanation: 'Cross-sector momentum dispersion is elevated.', dispersionPct: dispersion };
  return { id: 'neutral', label: 'neutral / mixed', explanation: 'No strong broad or sector regime is dominant.', dispersionPct: dispersion };
}

export async function buildFallbackMomentum(fund, research) {
  const current = research.current || {};
  const previous = research.previous || {};
  const rawHoldings = current.holdings || [];
  const enriched = [];
  for (const holding of rawHoldings.slice(0, 10)) {
    const search = await yahooSearch(holding.name);
    const points = search?.symbol ? await yahooChart(search.symbol) : null;
    enriched.push({
      ...holding,
      symbol: search?.symbol || null,
      sector: sectorAlias(search?.sector || 'Other'),
      ok: Boolean(points),
      return1mPct: returnAt(points, 21),
      return3mPct: returnAt(points, 63),
      return6mPct: returnAt(points, 126),
      points
    });
  }

  let sectorWeights = current.sectors?.length ? current.sectors : [];
  let sectorBasis = 'AdvisorKhoj portfolio-sector table';
  if (!sectorWeights.length) {
    const map = new Map();
    for (const item of enriched) map.set(item.sector, (map.get(item.sector) || 0) + (item.weight || 0));
    sectorWeights = [...map.entries()].map(([sector, weight]) => ({ sector, weight }));
    sectorBasis = 'Top-holdings sector proxy from Value Research holdings and Yahoo classifications';
  }

  const sectorStats = [];
  for (const item of sectorWeights) {
    const symbol = SECTOR_MARKET_SYMBOLS[item.sector];
    const points = symbol ? await yahooChart(symbol) : null;
    sectorStats.push({
      ...item,
      symbol: symbol || null,
      ok: Boolean(points),
      return1mPct: returnAt(points, 21),
      return3mPct: returnAt(points, 63),
      return6mPct: returnAt(points, 126)
    });
  }

  const previousNames = new Set((previous.holdings || []).map(item => canonicalSchemeName(item.name)));
  const currentNames = new Set(rawHoldings.map(item => canonicalSchemeName(item.name)));
  const entries = enriched.filter(item => !previousNames.has(canonicalSchemeName(item.name)) && previousNames.size)
    .map(item => eventAnalysis({ name: item.name, symbol: item.symbol, sector: item.sector, effectiveDate: current.fetchedAt?.slice(0, 10) }, item.points, 'entry'));
  const exits = (previous.holdings || []).filter(item => !currentNames.has(canonicalSchemeName(item.name)))
    .map(item => ({ ...item, search: null }));
  const resolvedExits = [];
  for (const item of exits.slice(0, 10)) {
    const search = await yahooSearch(item.name);
    const points = search?.symbol ? await yahooChart(search.symbol) : null;
    resolvedExits.push(eventAnalysis({ name: item.name, symbol: search?.symbol, sector: sectorAlias(search?.sector || 'Other'), effectiveDate: current.fetchedAt?.slice(0, 10) }, points, 'exit'));
  }

  const previousSectors = new Map((previous.sectors || []).map(item => [item.sector, item.weight]));
  const sectorHistory = sectorWeights.map(item => ({ sector: item.sector, values: previousSectors.has(item.sector) ? [previousSectors.get(item.sector), item.weight] : [item.weight] }));
  const broad = await yahooChart('^NSEI');
  const broad3m = returnAt(broad, 63);
  const regime = classifyRegime(broad3m, sectorStats);
  const resolvedHoldings = enriched.filter(item => item.ok).length;
  const resolvedSectors = sectorStats.filter(item => item.ok).length;
  const sourceCoverage = Math.min(100, (research.current?.managers?.length ? 20 : 0) + (rawHoldings.length ? 25 : 0) + (sectorWeights.length ? 20 : 0) + (Number.isFinite(current.turnoverPct) ? 15 : 0) + (previousNames.size ? 20 : 0));

  return {
    ok: true,
    schemeId: `fallback:${fund.preferredSchemeCode}`,
    asOf: current.fetchedAt?.slice(0, 10),
    snapshot: {
      turnover: { equityPct: current.turnoverPct, totalPct: current.turnoverPct, interpretation: 'Public turnover figure from Value Research or AdvisorKhoj' },
      sectorWeights,
      sectorHistory,
      coverageNote: `${sectorBasis}. ${previousNames.size ? 'A previous source snapshot is available for entry/exit comparison.' : 'The first source snapshot has been established; entry/exit attribution begins after the next refresh cycle.'}`,
      factsheetUrl: current.sources?.[0]?.url,
      factsheetLabel: current.sources?.map(item => item.name).join(' + ') || 'Public research fallback',
      assetAllocation: current.assetAllocation || [],
      marketCap: current.marketCap || [],
      sectorBasis
    },
    broadMarket: { ok: Boolean(broad), symbol: '^NSEI', return3mPct: broad3m },
    regime,
    sectors: sectorStats,
    holdings: enriched.map(({ points, ...item }) => item),
    entries,
    exits: resolvedExits,
    managers: current.managers || [],
    fundFacts: {
      benchmark: current.benchmark,
      expenseRatioPct: current.expenseRatioPct,
      aumCr: current.aumCr,
      riskMetrics: current.riskMetrics,
      assetAllocation: current.assetAllocation,
      marketCap: current.marketCap
    },
    coverage: {
      requestedSymbols: rawHoldings.length + sectorWeights.length + 1,
      resolvedSymbols: resolvedHoldings + resolvedSectors + (broad ? 1 : 0),
      resolvedPct: sourceCoverage,
      sectorSeries: resolvedSectors,
      entrySeries: entries.filter(item => item.ok).length,
      exitSeries: resolvedExits.filter(item => item.ok).length,
      baselineEstablished: !previousNames.size
    },
    sources: [
      ...(current.sources || []),
      { name: 'Yahoo Finance', type: 'Holding and sector price momentum', asOf: new Date().toISOString() },
      { name: 'AMFI / MFapi.in', type: 'Scheme identity and NAV history', asOf: 'live' }
    ],
    fetchedAt: new Date().toISOString()
  };
}
