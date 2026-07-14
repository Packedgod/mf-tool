import { canonicalSchemeName } from '@/lib/manager-registry';
import { SECTOR_MARKET_SYMBOLS } from '@/lib/momentum-data';

const FRESH_MS = 30 * 60 * 1000;
const MIN_WEIGHT_CHANGE = 0.35;

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
      headers: { accept: 'application/json', 'user-agent': 'ManagerLens/0.9 market-price-enrichment' }
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
  if (/consumer cyclical|retail|consumer service|travel|aviation/.test(text)) return 'Consumer Services';
  if (/energy|oil|gas|power|coal/.test(text)) return 'Energy';
  if (/metal|mining|steel/.test(text)) return 'Metals & Mining';
  if (/real estate|realty/.test(text)) return 'Realty';
  if (/telecom|communication/.test(text)) return 'Telecommunication';
  if (/industrial|capital goods|construction|infrastructure/.test(text)) return 'Capital Goods';
  if (/chemical/.test(text)) return 'Chemicals';
  return value || 'Other';
}

const NSE_SYMBOL_OVERRIDES = [
  [/^infosys\b/i, 'INFY.NS'],
  [/^hdfc bank\b/i, 'HDFCBANK.NS'],
  [/^icici bank\b/i, 'ICICIBANK.NS'],
  [/^wipro\b/i, 'WIPRO.NS'],
  [/^dr reddy/i, 'DRREDDY.NS']
];

function pinnedIndianSymbol(name) {
  const normalized = canonicalSchemeName(name);
  return NSE_SYMBOL_OVERRIDES.find(([pattern]) => pattern.test(normalized))?.[1] || null;
}

async function searchSymbol(name) {
  const pinned = pinnedIndianSymbol(name);
  if (pinned) return { symbol: pinned, currency: 'INR' };
  const payload = await fetchJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=8&newsCount=0&listsCount=0`);
  const quotes = (payload?.quotes || []).filter(item => item.quoteType === 'EQUITY');
  const normalizedName = canonicalSchemeName(name);
  const result = quotes
    .filter(item => {
      const symbol = String(item.symbol || '');
      return /\.(NS|BO)$/i.test(symbol);
    })
    .map(item => {
      const symbol = String(item.symbol || '');
      const candidateName = canonicalSchemeName(item.longname || item.shortname || item.name || '');
      const queryTokens = new Set(normalizedName.split(' ').filter(token => token.length > 2));
      const candidateTokens = new Set(candidateName.split(' ').filter(token => token.length > 2));
      const overlap = [...queryTokens].filter(token => candidateTokens.has(token)).length;
      const score = (/\.NS$/i.test(symbol) ? 40 : /\.BO$/i.test(symbol) ? 35 : 0)
        + (item.currency === 'INR' ? 25 : 0)
        + overlap * 8;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.item;
  return result ? {
    symbol: result.symbol,
    sector: sectorAlias(result.sector || result.industry),
    currency: result.currency || 'INR'
  } : null;
}

function trustedIndianSymbol(symbol) {
  return /\.(NS|BO)$/i.test(String(symbol || ''));
}

async function chart(symbol) {
  if (!symbol) return null;
  const payload = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includeAdjustedClose=true`);
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

function nearestIndex(points, date) {
  if (!points?.length) return -1;
  if (!date) return Math.max(0, points.length - 22);
  const target = new Date(date).getTime();
  if (!Number.isFinite(target)) return Math.max(0, points.length - 22);
  let best = 0;
  let distance = Infinity;
  points.forEach((point, index) => {
    const current = Math.abs(new Date(point.date).getTime() - target);
    if (current < distance) {
      best = index;
      distance = current;
    }
  });
  return best;
}

function analyseEvent(event, points, type) {
  if (!points?.length) return { ...event, ok: false, error: 'Price history unavailable' };
  const eventIndex = nearestIndex(points, event.effectiveDate);
  const eventPoint = points[Math.max(0, eventIndex)];
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
    source: 'Yahoo Finance price history'
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
  const match = trustedIndianSymbol(holding.symbol)
    ? { symbol: holding.symbol, sector: holding.sector, currency: 'INR' }
    : await searchSymbol(holding.name);
  const points = await chart(match?.symbol);
  const reportedSector = holding.sector && !/^(other|unclassified|sector classification pending)$/i.test(holding.sector)
    ? holding.sector
    : null;
  return {
    ...holding,
    symbol: match?.symbol || holding.symbol || null,
    sector: sectorAlias(reportedSector || match?.sector || 'Sector classification pending'),
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

function comparableBooks(current, previous, mode) {
  const currentRows = [...(current || [])].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const previousRows = [...(previous || [])].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  if (mode === 'complete-portfolio') return { currentRows, previousRows };
  const count = Math.max(5, Math.min(10, currentRows.length || 10, previousRows.length || 10));
  return { currentRows: currentRows.slice(0, count), previousRows: previousRows.slice(0, count) };
}

function holdingMap(rows) {
  return new Map((rows || []).map(item => [canonicalSchemeName(item.name), item]));
}

function buildHoldingChanges(currentRows, previousRows, effectiveDate) {
  const currentMap = holdingMap(currentRows);
  const previousMap = holdingMap(previousRows);
  const entries = [];
  const exits = [];

  for (const current of currentRows) {
    const key = canonicalSchemeName(current.name);
    const previous = previousMap.get(key);
    const changeWeightPct = (current.weight || 0) - (previous?.weight || 0);
    if (!previous || changeWeightPct >= MIN_WEIGHT_CHANGE) {
      entries.push({
        name: current.name,
        sector: current.sector,
        symbol: current.symbol,
        effectiveDate,
        action: previous ? 'increased' : 'new',
        previousWeight: previous?.weight,
        currentWeight: current.weight,
        changeWeightPct
      });
    }
  }

  for (const previous of previousRows) {
    const key = canonicalSchemeName(previous.name);
    const current = currentMap.get(key);
    const changeWeightPct = (current?.weight || 0) - (previous.weight || 0);
    if (!current || changeWeightPct <= -MIN_WEIGHT_CHANGE) {
      exits.push({
        name: previous.name,
        sector: previous.sector,
        symbol: previous.symbol,
        effectiveDate,
        action: current ? 'reduced' : 'exited',
        previousWeight: previous.weight,
        currentWeight: current?.weight,
        changeWeightPct
      });
    }
  }

  return { entries, exits };
}

function oneMonthEarlier(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}

function buildReportedOneMonthChanges(currentRows, currentAsOf) {
  const effectiveDate = oneMonthEarlier(currentAsOf);
  const entries = [];
  const exits = [];
  for (const current of currentRows || []) {
    const changeWeightPct = Number(current.oneMonthWeightChange);
    if (!Number.isFinite(changeWeightPct) || Math.abs(changeWeightPct) < MIN_WEIGHT_CHANGE) continue;
    const previousWeight = Math.max(0, Number(current.weight || 0) - changeWeightPct);
    const item = {
      name: current.name,
      sector: current.sector,
      symbol: current.symbol,
      effectiveDate,
      currentAsOf,
      action: changeWeightPct > 0 ? (previousWeight <= 0.05 ? 'new' : 'increased') : 'reduced',
      previousWeight,
      currentWeight: current.weight,
      changeWeightPct,
      changeBasis: 'Moneycontrol reported one-month allocation change'
    };
    if (changeWeightPct > 0) entries.push(item);
    else exits.push(item);
  }
  return { entries, exits, effectiveDate };
}

export async function buildFallbackMomentumFast(fund, research) {
  const current = research.current || {};
  const previous = research.previous || {};
  const requestedComparisonMode = research.portfolioComparison?.mode || 'top-holdings-proxy';
  const eventDate = current.portfolioAsOf || current.fetchedAt?.slice(0, 10);
  const rawHoldings = (current.holdings || []).slice(0, 30);
  const enrichedTop = await Promise.all(rawHoldings.slice(0, 15).map(enrichHolding));
  const enrichedAll = [
    ...enrichedTop,
    ...rawHoldings.slice(15).map(item => ({
      ...item,
      sector: sectorAlias(item.sector || 'Sector classification pending'),
      ok: false,
      error: 'Market-price enrichment is limited to the 15 largest exposures.'
    }))
  ];

  let sectorWeights = current.sectors?.length ? current.sectors : [];
  let sectorBasis = current.lookThrough?.enabled
    ? `Moneycontrol look-through across ${current.lookThrough.coverage?.resolvedUnderlyingFunds || 0} AMFI-matched underlying fund portfolios`
    : current.officialPortfolio?.source
    ? `${current.officialPortfolio.source.name} sector allocation`
    : current.moneycontrol?.sectors?.length
      ? 'Moneycontrol ISIN-validated portfolio-sector table'
      : current.sectors?.some(item => item.allocationProxy)
        ? 'Moneycontrol ISIN-validated asset allocation (the source does not classify FoF holdings as stock sectors)'
      : 'AdvisorKhoj portfolio-sector table';
  if (!sectorWeights.length) {
    const grouped = new Map();
    for (const item of enrichedAll) grouped.set(item.sector, (grouped.get(item.sector) || 0) + (item.weight || 0));
    sectorWeights = [...grouped.entries()].map(([sector, weight]) => ({ sector, weight }));
    sectorBasis = 'Moneycontrol / Value Research top-holdings allocation with live market classifications';
  }
  const sectorStats = await Promise.all(sectorWeights.map(enrichSector));

  const comparablePrevious = Boolean(previous.holdings?.length) && !(current.lookThrough?.enabled && !previous.lookThrough?.enabled);
  const books = comparableBooks(rawHoldings, comparablePrevious ? previous.holdings || [] : [], requestedComparisonMode);
  const reportedChanges = comparablePrevious ? { entries: [], exits: [], effectiveDate: null } : buildReportedOneMonthChanges(rawHoldings, eventDate);
  const hasReportedChanges = Boolean(reportedChanges.entries.length || reportedChanges.exits.length);
  const comparisonMode = comparablePrevious
    ? requestedComparisonMode
    : hasReportedChanges
      ? 'reported-one-month-allocation-change'
      : 'current-holdings-baseline';
  const changes = comparablePrevious
    ? buildHoldingChanges(books.currentRows, books.previousRows, eventDate)
    : reportedChanges;
  const enrichedMap = new Map(enrichedAll.map(item => [canonicalSchemeName(item.name), item]));
  const entries = await Promise.all(changes.entries.slice(0, 15).map(async item => {
    const enriched = enrichedMap.get(canonicalSchemeName(item.name)) || await enrichHolding(item);
    return analyseEvent({ ...item, symbol: enriched.symbol, sector: enriched.sector }, enriched.points, 'entry');
  }));
  const exits = await Promise.all(changes.exits.slice(0, 15).map(async item => {
    const match = trustedIndianSymbol(item.symbol)
      ? { symbol: item.symbol, sector: item.sector, currency: 'INR' }
      : await searchSymbol(item.name);
    return analyseEvent({ ...item, symbol: match?.symbol, sector: sectorAlias(item.sector || match?.sector || 'Other') }, await chart(match?.symbol), 'exit');
  }));

  const reportedPreviousSectors = new Map();
  if (!comparablePrevious && hasReportedChanges) {
    for (const item of rawHoldings) {
      if (!Number.isFinite(item.oneMonthWeightChange)) continue;
      const sector = item.sector || 'Sector classification pending';
      const weight = Math.max(0, Number(item.weight || 0) - item.oneMonthWeightChange);
      reportedPreviousSectors.set(sector, (reportedPreviousSectors.get(sector) || 0) + weight);
    }
  }
  const previousSectors = comparablePrevious
    ? new Map((previous.sectors || []).map(item => [item.sector, item.weight]))
    : reportedPreviousSectors;
  const currentSectorMap = new Map(sectorWeights.map(item => [item.sector, item.weight]));
  const allSectorNames = [...new Set([...previousSectors.keys(), ...currentSectorMap.keys()])];
  const sectorHistory = allSectorNames.map(sector => ({
    sector,
    values: previousSectors.size ? [previousSectors.get(sector) || 0, currentSectorMap.get(sector) || 0] : [currentSectorMap.get(sector) || 0],
    changeWeightPct: previousSectors.size ? (currentSectorMap.get(sector) || 0) - (previousSectors.get(sector) || 0) : undefined
  }));

  const broad = await chart('^NSEI');
  const broad3m = returnAt(broad, 63);
  const resolvedHoldings = enrichedAll.filter(item => item.ok).length;
  const resolvedSectors = sectorStats.filter(item => item.ok).length;
  const hasPrevious = comparablePrevious;
  const sourceCoverage = Math.min(100,
    (current.managers?.length ? 15 : 0)
    + (rawHoldings.length ? 25 : 0)
    + (sectorWeights.length ? 20 : 0)
    + (Number.isFinite(current.turnoverPct) ? 10 : 0)
    + (hasPrevious ? 25 : hasReportedChanges ? 15 : 0)
    + (resolvedHoldings ? 5 : 0)
  );

  const portfolioSources = (current.sources || []).filter(item => /Moneycontrol|Value Research|AdvisorKhoj/i.test(item.name || item.type || ''));
  const priceSources = [
    { name: 'Yahoo Finance', type: 'Price history only for holdings and sector indices', asOf: new Date().toISOString() },
    { name: 'AMFI / MFapi.in', type: 'Fund identity and NAV history only', asOf: 'live' }
  ];

  return {
    ok: true,
    schemeId: `fallback:${fund.preferredSchemeCode}`,
    asOf: current.portfolioAsOf || current.fetchedAt?.slice(0, 10),
    snapshot: {
      turnover: { equityPct: current.turnoverPct, totalPct: current.turnoverPct, interpretation: 'Turnover from Moneycontrol, Value Research Online, or AdvisorKhoj' },
      sectorWeights,
      sectorHistory,
      coverageNote: hasPrevious
        ? `${comparisonMode === 'complete-portfolio' ? 'Complete portfolio' : 'Top-holdings'} comparison between ${previous.portfolioAsOf || previous.fetchedAt || 'the prior source snapshot'} and ${current.portfolioAsOf || current.fetchedAt || 'the current source snapshot'}.`
        : hasReportedChanges
          ? `Moneycontrol one-month allocation changes are compared with the current portfolio as of ${current.portfolioAsOf || current.fetchedAt || 'the latest disclosure'}. Exact execution prices are not claimed.`
        : 'The current Moneycontrol / Value Research snapshot is available; a second dated source snapshot was not returned for this fund.',
      factsheetUrl: portfolioSources[0]?.url || current.sources?.[0]?.url,
      factsheetLabel: portfolioSources.map(item => item.name).join(' + ') || 'Moneycontrol + Value Research Online',
      assetAllocation: current.assetAllocation || [],
      marketCap: current.marketCap || [],
      directHoldings: current.directHoldings || current.moneycontrol?.directHoldings || [],
      underlyingFunds: current.underlyingFunds || current.moneycontrol?.underlyingFunds || [],
      lookThrough: current.lookThrough || null,
      holdingBasis: current.lookThrough?.enabled
        ? 'Look-through stocks aggregated from the portfolios of the underlying funds held directly by this FoF.'
        : 'Direct securities reported by the selected fund.',
      sectorBasis,
      comparisonMode,
      currentAsOf: current.portfolioAsOf || current.fetchedAt,
      previousAsOf: hasPrevious
        ? previous.portfolioAsOf || previous.fetchedAt
        : hasReportedChanges
          ? reportedChanges.effectiveDate
          : null,
      snapshotCount: research.portfolioComparison?.snapshotCount || (hasPrevious ? 2 : 1)
    },
    broadMarket: { ok: Boolean(broad), symbol: '^NSEI', return3mPct: broad3m },
    regime: regime(broad3m, sectorStats),
    sectors: sectorStats,
    holdings: enrichedAll.map(({ points, ...item }) => item),
    entries,
    exits,
    managerChanges: {
      additions: entries,
      reductions: exits,
      noEntryChangesDetected: hasPrevious && !entries.length,
      noExitChangesDetected: hasPrevious && !exits.length,
      mode: comparisonMode,
      currentAsOf: current.portfolioAsOf || current.fetchedAt,
      previousAsOf: hasPrevious
        ? previous.portfolioAsOf || previous.fetchedAt
        : hasReportedChanges
          ? reportedChanges.effectiveDate
          : null,
      changeBasis: hasPrevious ? 'Dated source snapshot comparison' : hasReportedChanges ? 'Moneycontrol reported one-month allocation change' : null
    },
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
      requestedSymbols: enrichedAll.length + sectorWeights.length + 1,
      resolvedSymbols: resolvedHoldings + resolvedSectors + (broad ? 1 : 0),
      resolvedPct: sourceCoverage,
      sectorSeries: resolvedSectors,
      entrySeries: entries.filter(item => item.ok).length,
      exitSeries: exits.filter(item => item.ok).length,
      baselineEstablished: !hasPrevious,
      snapshotCount: hasPrevious ? 2 : 1,
      comparisonMode,
      changeEvidence: hasPrevious ? 'dated-snapshots' : hasReportedChanges ? 'reported-one-month-change' : 'baseline-only'
    },
    sources: [...portfolioSources, ...priceSources],
    fetchedAt: new Date().toISOString()
  };
}
