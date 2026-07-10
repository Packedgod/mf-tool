import { canonicalSchemeName } from '@/lib/manager-registry';
import { SECTOR_MARKET_SYMBOLS } from '@/lib/momentum-data';

const FRESH_MS = 30 * 60 * 1000;

function store() {
  globalThis.__MANAGERLENS_YAHOO_FALLBACK_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_YAHOO_FALLBACK_CACHE__;
}

async function fetchJson(url, timeoutMs = 8000) {
  const cached = store().get(url);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'ManagerLens/0.7 market-momentum' }
    });
    if (!response.ok) return null;
    const value = await response.json();
    store().set(url, { at: Date.now(), value });
    return value;
  } catch {
    return cached?.value || null;
  } finally {
    clearTimeout(timer);
  }
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

async function searchSymbol(name) {
  const payload = await fetchJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=8&newsCount=0&listsCount=0`);
  const quotes = (payload?.quotes || []).filter(item => item.quoteType === 'EQUITY');
  const result = quotes.find(item => /NSE|BSE/i.test(`${item.exchange || ''} ${item.exchDisp || ''}`)) || quotes[0];
  return result ? { symbol: result.symbol, sector: sectorAlias(result.sector || result.industry) } : null;
}

async function chart(symbol) {
  if (!symbol) return null;
  const payload = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includeAdjustedClose=true`);
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.adjclose?.[0]?.adjclose || result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    close: Number(closes[index])
  })).filter(item => Number.isFinite(item.close) && item.close > 0);
  return points.length ? points : null;
}

function returnAt(points, sessions) {
  if (!points?.length) return undefined;
  const start = points[Math.max(0, points.length - 1 - sessions)]?.close;
  const end = points.at(-1)?.close;
  return Number.isFinite(start) && start > 0 && Number.isFinite(end) ? (end / start - 1) * 100 : undefined;
}

function analyseEvent(event, points, type) {
  if (!points?.length) return { ...event, ok: false, error: 'Price history unavailable' };
  const eventIndex = Math.max(0, points.length - 22);
  const eventPoint = points[eventIndex];
  const local = points.slice(Math.max(0, eventIndex - 45), Math.min(points.length, eventIndex + 46));
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

function regime(broadReturn, sectors) {
  const values = sectors.map(item => item.return3mPct).filter(Number.isFinite);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (values.length - 1) : 0;
  const dispersion = Math.sqrt(variance);
  if (Number.isFinite(broadReturn) && broadReturn > 5) return { id: 'riskOn', label: 'risk-on', explanation: 'Broad three-month momentum is positive.', dispersionPct: dispersion };
  if (Number.isFinite(broadReturn) && broadReturn < -5) return { id: 'riskOff', label: 'risk-off', explanation: 'Broad three-month momentum is negative.', dispersionPct: dispersion };
  if (dispersion > 6) return { id: 'rotation', label: 'sector-rotation', explanation: 'Cross-sector momentum dispersion is elevated.', dispersionPct: dispersion };
  return { id: 'neutral', label: 'neutral / mixed', explanation: 'No strong broad or sector regime is dominant.', dispersionPct: dispersion };
}

async function enrichHolding(holding) {
  const match = await searchSymbol(holding.name);
  const points = await chart(match?.symbol);
  return {
    ...holding,
    symbol: match?.symbol || null,
    sector: sectorAlias(match?.sector || 'Other'),
    ok: Boolean(points),
    return1mPct: returnAt(points, 21),
    return3mPct: returnAt(points, 63),
    return6mPct: returnAt(points, 126),
    points
  };
}

async function enrichSector(item) {
  const symbol = SECTOR_MARKET_SYMBOLS[item.sector];
  const points = await chart(symbol);
  return {
    ...item,
    symbol: symbol || null,
    ok: Boolean(points),
    return1mPct: returnAt(points, 21),
    return3mPct: returnAt(points, 63),
    return6mPct: returnAt(points, 126)
  };
}

export async function buildFallbackMomentumFast(fund, research) {
  const current = research.current || {};
  const previous = research.previous || {};
  const rawHoldings = (current.holdings || []).slice(0, 10);
  const enriched = await Promise.all(rawHoldings.map(enrichHolding));

  let sectorWeights = current.sectors?.length ? current.sectors : [];
  let sectorBasis = 'AdvisorKhoj portfolio-sector table';
  if (!sectorWeights.length) {
    const grouped = new Map();
    for (const item of enriched) grouped.set(item.sector, (grouped.get(item.sector) || 0) + (item.weight || 0));
    sectorWeights = [...grouped.entries()].map(([sector, weight]) => ({ sector, weight }));
    sectorBasis = 'Top-holdings sector proxy from Value Research holdings and Yahoo classifications';
  }
  const sectorStats = await Promise.all(sectorWeights.map(enrichSector));

  const previousNames = new Set((previous.holdings || []).map(item => canonicalSchemeName(item.name)));
  const currentNames = new Set(rawHoldings.map(item => canonicalSchemeName(item.name)));
  const entries = enriched
    .filter(item => previousNames.size && !previousNames.has(canonicalSchemeName(item.name)))
    .map(item => analyseEvent({ name: item.name, symbol: item.symbol, sector: item.sector, effectiveDate: current.fetchedAt?.slice(0, 10) }, item.points, 'entry'));

  const exitCandidates = (previous.holdings || []).filter(item => !currentNames.has(canonicalSchemeName(item.name))).slice(0, 10);
  const exits = await Promise.all(exitCandidates.map(async item => {
    const match = await searchSymbol(item.name);
    return analyseEvent({ name: item.name, symbol: match?.symbol, sector: sectorAlias(match?.sector || 'Other'), effectiveDate: current.fetchedAt?.slice(0, 10) }, await chart(match?.symbol), 'exit');
  }));

  const previousSectors = new Map((previous.sectors || []).map(item => [item.sector, item.weight]));
  const sectorHistory = sectorWeights.map(item => ({
    sector: item.sector,
    values: previousSectors.has(item.sector) ? [previousSectors.get(item.sector), item.weight] : [item.weight]
  }));
  const broad = await chart('^NSEI');
  const broad3m = returnAt(broad, 63);
  const resolvedHoldings = enriched.filter(item => item.ok).length;
  const resolvedSectors = sectorStats.filter(item => item.ok).length;
  const sourceCoverage = Math.min(100,
    (current.managers?.length ? 20 : 0)
    + (rawHoldings.length ? 25 : 0)
    + (sectorWeights.length ? 20 : 0)
    + (Number.isFinite(current.turnoverPct) ? 15 : 0)
    + (previousNames.size ? 20 : 0)
  );

  return {
    ok: true,
    schemeId: `fallback:${fund.preferredSchemeCode}`,
    asOf: current.fetchedAt?.slice(0, 10),
    snapshot: {
      turnover: { equityPct: current.turnoverPct, totalPct: current.turnoverPct, interpretation: 'Public turnover figure from Value Research or AdvisorKhoj' },
      sectorWeights,
      sectorHistory,
      coverageNote: `${sectorBasis}. ${previousNames.size ? 'A previous source snapshot is available for entry/exit comparison.' : 'The first source snapshot has been established; entry/exit attribution begins after the next distinct refresh.'}`,
      factsheetUrl: current.sources?.[0]?.url,
      factsheetLabel: current.sources?.map(item => item.name).join(' + ') || 'Public research fallback',
      assetAllocation: current.assetAllocation || [],
      marketCap: current.marketCap || [],
      sectorBasis
    },
    broadMarket: { ok: Boolean(broad), symbol: '^NSEI', return3mPct: broad3m },
    regime: regime(broad3m, sectorStats),
    sectors: sectorStats,
    holdings: enriched.map(({ points, ...item }) => item),
    entries,
    exits,
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
      exitSeries: exits.filter(item => item.ok).length,
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
