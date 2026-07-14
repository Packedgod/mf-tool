const API_BASE = 'https://api.moneycontrol.com/swiftapi/v1/mutualfunds';
const SEARCH_URL = 'https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php';
const FRESH_MS = 30 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

function store() {
  globalThis.__MANAGERLENS_MONEYCONTROL_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_MONEYCONTROL_CACHE__;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function numberValue(value) {
  const text = String(value ?? '').replace(/[%,]/g, '').trim();
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function isinValue(value) {
  const isin = String(value || '').trim().toUpperCase();
  return /^INF[0-9A-Z]{9}$/.test(isin) ? isin : null;
}

function expandFundAbbreviations(value) {
  return cleanText(value)
    .replace(/\bPru\b/gi, 'Prudential')
    .replace(/\bFin\b/gi, 'Financial')
    .replace(/\bSvcs\b/gi, 'Services')
    .replace(/\bTech\b/gi, 'Technology')
    .replace(/\bDiag\b/gi, 'Diagnostics')
    .replace(/\bTrsptn\b/gi, 'Transportation')
    .replace(/\bOpps\b/gi, 'Opportunities')
    .replace(/\bDir\b/gi, 'Direct')
    .replace(/\bReg\b/gi, 'Regular')
    .replace(/\bGr\b/gi, 'Growth')
    .replace(/\bCum\b/gi, 'Cumulative');
}

function identityWords(value) {
  return expandFundAbbreviations(value)
    .toLowerCase()
    .replace(/\bfixed maturity plans?\b/g, ' fmp ')
    .replace(/\b(mutual|fund|scheme|direct|regular|plan|growth|idcw|dividend|option|payout|reinvestment|income distribution cum capital withdrawal)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(word => word.length > 1);
}

function holdingClassification(name, reportedSector) {
  const text = expandFundAbbreviations(name).toLowerCase();
  const sector = cleanText(reportedSector);
  if (/\b(treps?|triparty repo|net current assets?|cash|cash equivalents?|repo|money market)\b/i.test(text)) {
    return { holdingType: 'cash', sector: 'Cash & Equivalents', classificationBasis: 'security-name' };
  }
  if (/\b(gilt|government securit|sovereign|corporate bond|bond|debenture|ncd|treasury|t-bill|certificate of deposit)\b/i.test(text)) {
    return { holdingType: 'debt', sector: 'Fixed Income', classificationBasis: 'security-name' };
  }

  const looksLikeFund = /\b(direct|regular|growth|idcw|fund|scheme|fof|etf)\b/i.test(text)
    || /\b(icici prudential|hdfc|sbi|kotak|axis|nippon india|aditya birla|uti|dsp|mirae|motilal oswal)\b.*\b(dir|gr)\b/i.test(name);
  if (looksLikeFund) {
    let theme = 'Diversified / Multi-asset';
    if (/bank|financial|finance|insurance/.test(text)) theme = 'Financial Services';
    else if (/technology|information technology|digital/.test(text)) theme = 'Information Technology';
    else if (/pharma|health|diagnostic|biotech/.test(text)) theme = 'Healthcare';
    else if (/fmcg|consumption|consumer|rural/.test(text)) theme = 'Consumer';
    else if (/transport|logistic|industrial|infrastructure|capital goods/.test(text)) theme = 'Industrials';
    else if (/gilt|bond|savings|liquid|money market|short term|duration/.test(text)) theme = 'Fixed Income';
    else if (/gold|silver|commodity/.test(text)) theme = 'Commodities';
    return { holdingType: 'underlying-fund', sector: theme, classificationBasis: 'underlying-fund-mandate' };
  }

  return {
    holdingType: 'stock',
    sector: sector && !/^other$/i.test(sector) ? sector : 'Sector classification pending',
    classificationBasis: sector && !/^other$/i.test(sector) ? 'reported-sector' : 'market-enrichment-pending'
  };
}

function identityScore(left, right) {
  const a = new Set(identityWords(left));
  const b = new Set(identityWords(right));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter(word => b.has(word)).length;
  const containment = [...a].every(word => b.has(word)) || [...b].every(word => a.has(word));
  return overlap / Math.max(a.size, b.size) + (containment ? 0.12 : 0);
}

function distinctiveNumbersMatch(candidate, expected) {
  const candidateWords = new Set(identityWords(candidate));
  const expectedNumbers = identityWords(expected).filter(word => /\d/.test(word));
  return !expectedNumbers.length || expectedNumbers.every(word => candidateWords.has(word));
}

function expectedFundNames(fund) {
  return [...new Set([
    fund?.preferredSchemeName,
    fund?.displayName,
    fund?.canonicalName,
    ...(fund?.variants || []).map(item => item.schemeName)
  ].filter(Boolean))];
}

function planMatchScore(candidate, fund) {
  const expected = expectedFundNames(fund);
  let score = Math.max(0, ...expected.map(name => distinctiveNumbersMatch(candidate, name) ? identityScore(candidate, name) : 0));
  const target = `${fund?.preferredSchemeName || ''} ${fund?.displayName || ''}`;
  if (/direct/i.test(target)) score += /direct/i.test(candidate) ? 0.12 : -0.18;
  if (/growth/i.test(target)) score += /growth/i.test(candidate) ? 0.06 : -0.08;
  if (/idcw|dividend/i.test(candidate) && !/idcw|dividend/i.test(target)) score -= 0.12;
  return score;
}

async function fetchSearchResults(fund, timeoutMs = 12000) {
  const query = fund?.preferredSchemeName || fund?.displayName;
  if (!query) return { ok: false, error: 'The fund name was unavailable for Moneycontrol search.' };
  const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&type=2&format=json`;
  const cache = store();
  const cached = cache.get(url);
  const now = Date.now();
  if (cached && now - cached.at < FRESH_MS) return { ...cached.value, cache: 'fresh' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json,text/plain,*/*', 'user-agent': 'ManagerLens/1.6 Moneycontrol fund search' }
    });
    if (!response.ok) throw new Error(`Moneycontrol fund search returned ${response.status}`);
    const payload = await response.json();
    const candidates = (Array.isArray(payload) ? payload : [])
      .filter(item => /\/mutual-funds\/nav\//i.test(item?.link_src || ''))
      .map(item => ({
        name: cleanText(item?.name || item?.pdt_dis_nm),
        url: item?.link_src,
        score: planMatchScore(item?.name || item?.pdt_dis_nm, fund)
      }))
      .sort((a, b) => b.score - a.score);
    const value = { ok: true, url, candidates, fetchedAt: new Date().toISOString() };
    cache.set(url, { at: now, value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cached && now - cached.at < STALE_MS) return { ...cached.value, cache: 'stale', warning: message };
    return { ok: false, url, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPageOverview(url, timeoutMs = 22000) {
  const key = `moneycontrol-page:${url}`;
  const cache = store();
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < FRESH_MS) return { ...cached.value, cache: 'fresh' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'text/html,application/xhtml+xml,*/*', 'user-agent': 'ManagerLens/1.6 Moneycontrol fund identity resolver' }
    });
    if (!response.ok) throw new Error(`Moneycontrol fund page returned ${response.status}`);
    const html = await response.text();
    const json = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
    const overview = json ? JSON.parse(json)?.props?.pageProps?.data?.overview : null;
    if (!overview?.isin) throw new Error('Moneycontrol fund page did not expose its current fund identity.');
    const value = { ok: true, url: response.url, overview, fetchedAt: new Date().toISOString() };
    cache.set(key, { at: now, value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cached && now - cached.at < STALE_MS) return { ...cached.value, cache: 'stale', warning: message };
    return { ok: false, url, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function discoverMoneycontrolIsin(fund) {
  const search = await fetchSearchResults(fund);
  if (!search.ok) return { ok: false, error: search.error, search };
  const candidate = search.candidates.find(item => item.score >= 0.58);
  if (!candidate) {
    return { ok: false, error: 'Moneycontrol search did not return a sufficiently close fund match.', search: { ...search, candidates: search.candidates.slice(0, 5) } };
  }
  const page = await fetchPageOverview(candidate.url);
  if (!page.ok) return { ok: false, error: page.error, candidate, page };
  const isin = isinValue(page.overview?.isin);
  const returnedName = cleanText(page.overview?.schemeName);
  const score = Math.max(0, ...expectedFundNames(fund).map(name => distinctiveNumbersMatch(returnedName, name) ? identityScore(returnedName, name) : 0));
  if (!isin || score < 0.5) {
    return { ok: false, error: 'Moneycontrol fund-page identity did not match the requested fund closely enough.', candidate, page: { url: page.url }, returnedName, score };
  }
  return { ok: true, isin, url: page.url, returnedName, score, candidateScore: candidate.score };
}

function preferredVariant(fund) {
  const variants = fund?.variants || [];
  return variants.find(item => String(item.schemeCode) === String(fund?.preferredSchemeCode))
    || variants.find(item => /direct/i.test(item.schemeName || '') && /growth/i.test(item.schemeName || ''))
    || variants[0]
    || null;
}

export function moneycontrolIsinForFund(fund) {
  const preferred = preferredVariant(fund);
  const values = [
    fund?.preferredIsin,
    preferred?.isinGrowth,
    preferred?.isinDividend,
    ...(fund?.variants || []).flatMap(item => [item.isinGrowth, item.isinDividend])
  ];
  return values.map(isinValue).find(Boolean) || null;
}

async function fetchJson(endpoint, isin, timeoutMs = 12000) {
  const url = `${API_BASE}/${endpoint}?isin=${encodeURIComponent(isin)}&deviceType=W&responseType=json`;
  const cache = store();
  const cached = cache.get(url);
  const now = Date.now();
  if (cached && now - cached.at < FRESH_MS) return { ...cached.value, cache: 'fresh' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'ManagerLens/1.6 Moneycontrol public mutual-fund resolver'
      }
    });
    if (!response.ok) throw new Error(`Moneycontrol ${endpoint} returned ${response.status}`);
    const payload = await response.json();
    if (Number(payload?.success) !== 1 || !payload?.data) {
      throw new Error(`Moneycontrol ${endpoint} did not return fund data`);
    }
    const value = { ok: true, endpoint, url, payload, fetchedAt: new Date().toISOString() };
    cache.set(url, { at: now, value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cached && now - cached.at < STALE_MS) return { ...cached.value, cache: 'stale', warning: message };
    return { ok: false, endpoint, url, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function holdingRows(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  const seen = new Set();
  for (const item of value) {
    const name = cleanText(item?.name || item?.company || item?.stock || item?.schemeName);
    const weight = numberValue(item?.weighting ?? item?.weight ?? item?.percentage ?? item?.allocation ?? item?.value);
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!name || !/[A-Za-z]/.test(name) || !Number.isFinite(weight) || weight <= 0 || weight > 100 || seen.has(key)) continue;
    seen.add(key);
    const classification = holdingClassification(name, item?.sector || item?.industry);
    rows.push({
      name,
      weight: Number(weight.toFixed(4)),
      sector: classification.sector,
      holdingType: classification.holdingType,
      classificationBasis: classification.classificationBasis,
      oneMonthWeightChange: numberValue(item?.change1M ?? item?.change_1m ?? item?.oneMonthChange)
    });
  }
  return rows.sort((a, b) => b.weight - a.weight).slice(0, 80);
}

function mergeHoldings(primary, secondary) {
  const fallback = new Map((secondary || []).map(item => [item.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), item]));
  const merged = (primary?.length ? primary : secondary || []).map(item => {
    const other = fallback.get(item.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    return {
      ...other,
      ...item,
      sector: item.sector && item.sector !== 'Sector classification pending' ? item.sector : other?.sector || item.sector,
      holdingType: other?.holdingType || item.holdingType,
      classificationBasis: other?.classificationBasis || item.classificationBasis,
      oneMonthWeightChange: item.oneMonthWeightChange ?? other?.oneMonthWeightChange
    };
  });
  return merged.sort((a, b) => b.weight - a.weight);
}

function allocationLabel(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (/equity/.test(normalized)) return 'Equity';
  if (/bond|debt/.test(normalized)) return 'Debt';
  if (/cash|money market/.test(normalized)) return 'Cash';
  if (/derivative/.test(normalized)) return 'Derivatives';
  if (/large/.test(normalized)) return 'Large';
  if (/mid/.test(normalized)) return 'Mid';
  if (/small/.test(normalized)) return 'Small';
  if (/other/.test(normalized)) return 'Other';
  return cleanText(String(key || '').replace(/_/g, ' '));
}

function allocationRows(value) {
  if (!value) return [];
  const raw = Array.isArray(value)
    ? value.map(item => [item?.name || item?.label || item?.asset || item?.market_cap || item?.sector, item?.weighting ?? item?.weight ?? item?.percentage ?? item?.allocation ?? item?.value])
    : Object.entries(value);
  const map = new Map();
  for (const [rawName, rawWeight] of raw) {
    const name = allocationLabel(rawName);
    const weight = numberValue(rawWeight);
    if (!name || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    map.set(name, (map.get(name) || 0) + weight);
  }
  return [...map.entries()].map(([name, weight]) => ({ name, weight: Number(weight.toFixed(4)) })).sort((a, b) => b.weight - a.weight);
}

function sectorRows(value, holdings) {
  const source = Array.isArray(value) ? value : [];
  const map = new Map();
  for (const item of source) {
    const sector = cleanText(item?.sector || item?.name || item?.label);
    const weight = numberValue(item?.weighting ?? item?.weight ?? item?.percentage ?? item?.allocation ?? item?.value);
    if (!sector || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    map.set(sector, (map.get(sector) || 0) + weight);
  }
  if (!map.size) {
    for (const item of holdings || []) {
      if (!item.sector) continue;
      map.set(item.sector, (map.get(item.sector) || 0) + item.weight);
    }
  }
  return [...map.entries()].map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)) })).sort((a, b) => b.weight - a.weight);
}

function allPlans(overview) {
  return Object.values(overview?.planOptionMap || {}).flatMap(value => Array.isArray(value) ? value : []);
}

function sourceUrl(overview, isin) {
  return allPlans(overview).find(item => isinValue(item?.isin) === isin)?.schemeUrl
    || `${API_BASE}/overview?isin=${encodeURIComponent(isin)}&deviceType=W&responseType=json`;
}

function portfolioField(payload, field) {
  const rows = Array.isArray(payload?.data) ? payload.data : [payload?.data].filter(Boolean);
  return rows.find(item => item && Object.prototype.hasOwnProperty.call(item, field))?.[field];
}

export async function fetchMoneycontrolPortfolio(fund) {
  let isin = moneycontrolIsinForFund(fund);
  let discovery = null;
  if (!isin) {
    discovery = await discoverMoneycontrolIsin(fund);
    isin = discovery.ok ? discovery.isin : null;
  }
  if (!isin) {
    return { ok: false, error: discovery?.error || 'The AMFI fund record did not include a usable ISIN.', identity: { accepted: false, requestedIsin: null, basis: 'moneycontrol-name-resolution' }, discovery };
  }

  const [overviewResult, portfolioResult, holdingsResult] = await Promise.all([
    fetchJson('overview', isin),
    fetchJson('portfolio', isin),
    fetchJson('holdings', isin)
  ]);
  if (!overviewResult.ok) {
    return {
      ok: false,
      error: overviewResult.error,
      identity: { accepted: false, requestedIsin: isin },
      endpoints: { overview: overviewResult, portfolio: portfolioResult, holdings: holdingsResult }
    };
  }

  const overview = overviewResult.payload.data;
  const returnedIsin = isinValue(overview?.isin);
  if (returnedIsin !== isin) {
    return {
      ok: false,
      error: 'Moneycontrol returned a different fund identity than the requested AMFI ISIN.',
      identity: { accepted: false, requestedIsin: isin, returnedIsin },
      endpoints: { overview: overviewResult, portfolio: portfolioResult, holdings: holdingsResult }
    };
  }

  const portfolioHoldings = holdingRows(portfolioField(portfolioResult.payload, 'stock_holding'));
  const detailedHoldings = holdingRows(holdingsResult.payload?.data?.stock);
  const holdings = mergeHoldings(portfolioHoldings, detailedHoldings);
  const sectors = sectorRows(holdingsResult.payload?.data?.sector, holdings);
  const assetAllocation = allocationRows(
    portfolioField(portfolioResult.payload, 'asset_alloc') || overview?.assetAllocation
  );
  const marketCap = allocationRows(portfolioField(portfolioResult.payload, 'market_cap_weightage'));
  const fetchedAt = [overviewResult, portfolioResult, holdingsResult].find(item => item.ok)?.fetchedAt || new Date().toISOString();
  const riskMetrics = {
    sharpe: numberValue(overview?.sharpeRatio),
    volatility: numberValue(overview?.stadardDeviation),
    beta: numberValue(overview?.beta_3_year)
  };

  return {
    ok: true,
    provider: 'Moneycontrol',
    url: sourceUrl(overview, isin),
    fetchedAt,
    isin,
    fundName: cleanText(overview?.schemeName),
    fundHouse: cleanText(overview?.companyName),
    category: cleanText(overview?.subCategoryName || overview?.categoryName),
    holdings,
    sectors,
    assetAllocation,
    marketCap,
    turnoverPct: numberValue(overview?.turnoverRatio),
    expenseRatioPct: numberValue(overview?.expenseRatio),
    aumCr: numberValue(overview?.aum),
    nav: numberValue(overview?.latestNAV),
    navDate: cleanText(overview?.navDate) || null,
    riskMetrics: Object.values(riskMetrics).some(Number.isFinite) ? riskMetrics : null,
    identity: {
      accepted: true,
      requestedIsin: isin,
      returnedIsin,
      basis: discovery ? 'moneycontrol-name-resolution' : 'amfi-isin',
      returnedFundName: cleanText(overview?.schemeName),
      requestedFundName: fund?.preferredSchemeName || fund?.displayName || null
    },
    discovery: discovery ? { ok: true, url: discovery.url, score: discovery.score, candidateScore: discovery.candidateScore } : null,
    coverage: {
      holdings: holdings.length,
      sectors: sectors.length,
      assetAllocation: assetAllocation.length,
      marketCap: marketCap.length
    },
    endpoints: {
      overview: { ok: overviewResult.ok, url: overviewResult.url, cache: overviewResult.cache, warning: overviewResult.warning },
      portfolio: { ok: portfolioResult.ok, url: portfolioResult.url, cache: portfolioResult.cache, error: portfolioResult.error, warning: portfolioResult.warning },
      holdings: { ok: holdingsResult.ok, url: holdingsResult.url, cache: holdingsResult.cache, error: holdingsResult.error, warning: holdingsResult.warning }
    }
  };
}

function familyMatchScore(holdingName, family) {
  const names = [
    family?.displayName,
    family?.preferredSchemeName,
    ...(family?.variants || []).map(item => item.schemeName)
  ].filter(Boolean);
  return Math.max(0, ...names.map(name => distinctiveNumbersMatch(holdingName, name) ? identityScore(holdingName, name) : 0));
}

function resolveUnderlyingFamily(holding, families) {
  const ranked = (families || [])
    .map(family => ({ family, score: familyMatchScore(holding.name, family) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 0.46 ? ranked[0] : null;
}

function canonicalHolding(value) {
  return expandFundAbbreviations(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function previousWeight(current, change) {
  return Number.isFinite(change) ? Math.max(0, current - change) : undefined;
}

function mergeLookThroughStocks(rows) {
  const map = new Map();
  for (const item of rows) {
    const key = canonicalHolding(item.name);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...item, exposureSources: [item.exposureSource] });
      continue;
    }
    existing.weight += item.weight;
    if (Number.isFinite(item.oneMonthWeightChange)) {
      existing.oneMonthWeightChange = (existing.oneMonthWeightChange || 0) + item.oneMonthWeightChange;
    }
    if (!existing.sector || existing.sector === 'Sector classification pending') existing.sector = item.sector;
    existing.exposureSources.push(item.exposureSource);
  }
  return [...map.values()]
    .map(item => ({
      ...item,
      weight: Number(item.weight.toFixed(4)),
      oneMonthWeightChange: Number.isFinite(item.oneMonthWeightChange) ? Number(item.oneMonthWeightChange.toFixed(4)) : undefined,
      exposureSources: [...new Set(item.exposureSources.filter(Boolean))]
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 60);
}

function mergeLookThroughSectors(rows) {
  const map = new Map();
  for (const item of rows) {
    const sector = cleanText(item.sector || item.name);
    if (!sector || /^other$/i.test(sector) || !Number.isFinite(item.weight) || item.weight <= 0) continue;
    map.set(sector, (map.get(sector) || 0) + item.weight);
  }
  return [...map.entries()]
    .map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)), lookThrough: true }))
    .sort((a, b) => b.weight - a.weight);
}

function equityLookThroughCandidate(holding) {
  return holding.holdingType === 'underlying-fund'
    && !/fixed income|commodit/i.test(holding.sector || '')
    && !/gilt|bond|savings|liquid|money market|gold|silver/i.test(holding.name || '');
}

export async function enrichMoneycontrolLookThrough(fund, parent, families = []) {
  if (!parent?.ok || !parent.holdings?.length) return parent;
  const directFunds = parent.holdings.filter(item => item.holdingType === 'underlying-fund');
  const isFundOfFunds = /\bfof\b|fund of funds/i.test(`${fund?.category || ''} ${fund?.displayName || ''} ${parent.category || ''}`)
    || directFunds.length >= 2;
  if (!isFundOfFunds) return { ...parent, isFundOfFunds: false };

  const key = `moneycontrol-look-through:${parent.isin}:${parent.holdings.map(item => `${canonicalHolding(item.name)}:${item.weight}`).join('|')}`;
  const cached = store().get(key);
  const now = Date.now();
  if (cached && now - cached.at < FRESH_MS) return { ...cached.value, cache: 'fresh' };

  const candidates = parent.holdings.filter(equityLookThroughCandidate).slice(0, 7);
  const resolvedCandidates = candidates.map(holding => ({ holding, match: resolveUnderlyingFamily(holding, families) }));
  const results = await Promise.all(resolvedCandidates.map(async ({ holding, match }) => {
    if (!match) return { holding, match: null, portfolio: null };
    const portfolio = await fetchMoneycontrolPortfolio(match.family);
    return { holding, match, portfolio: portfolio?.ok ? portfolio : null };
  }));

  const resultMap = new Map(results.map(item => [canonicalHolding(item.holding.name), item]));
  const stockRows = [];
  const sectorRows = [];
  const underlyingFunds = parent.holdings.map(holding => {
    const result = resultMap.get(canonicalHolding(holding.name));
    const child = result?.portfolio;
    if (child) {
      for (const stock of child.holdings.filter(item => item.holdingType === 'stock')) {
        const weight = holding.weight * stock.weight / 100;
        const hasParentChange = Number.isFinite(holding.oneMonthWeightChange);
        const hasStockChange = Number.isFinite(stock.oneMonthWeightChange);
        const parentPrevious = hasParentChange ? previousWeight(holding.weight, holding.oneMonthWeightChange) : holding.weight;
        const stockPrevious = hasStockChange ? previousWeight(stock.weight, stock.oneMonthWeightChange) : stock.weight;
        const previousExposure = hasParentChange || hasStockChange ? parentPrevious * stockPrevious / 100 : undefined;
        stockRows.push({
          ...stock,
          weight,
          holdingType: 'look-through-stock',
          directWeight: holding.weight,
          underlyingWeight: stock.weight,
          exposureSource: holding.name,
          oneMonthWeightChange: Number.isFinite(previousExposure) ? weight - previousExposure : undefined
        });
      }
      for (const sector of child.sectors || []) {
        sectorRows.push({ sector: sector.sector, weight: holding.weight * sector.weight / 100 });
      }
    } else if (holding.sector && holding.sector !== 'Diversified / Multi-asset') {
      sectorRows.push({ sector: holding.sector, weight: holding.weight, mandateProxy: true });
    }
    return {
      ...holding,
      matchedFundName: result?.match?.family?.displayName || null,
      matchedSchemeCode: result?.match?.family?.preferredSchemeCode || null,
      matchScore: result?.match ? Number(result.match.score.toFixed(3)) : null,
      sourceUrl: child?.url || null,
      lookThroughHoldings: child?.holdings?.filter(item => item.holdingType === 'stock').length || 0,
      lookThroughSectors: child?.sectors?.length || 0,
      lookThroughStatus: child ? 'resolved' : equityLookThroughCandidate(holding) ? 'unresolved' : 'not-applicable'
    };
  });

  for (const holding of parent.holdings.filter(item => item.holdingType === 'debt' || item.holdingType === 'cash' || /fixed income|commodit/i.test(item.sector || ''))) {
    sectorRows.push({ sector: holding.sector, weight: holding.weight });
  }

  const lookThroughHoldings = mergeLookThroughStocks(stockRows);
  const lookThroughSectors = mergeLookThroughSectors(sectorRows);
  const resolvedFundWeight = results.filter(item => item.portfolio).reduce((sum, item) => sum + item.holding.weight, 0);
  const value = {
    ...parent,
    isFundOfFunds: true,
    directHoldings: parent.holdings,
    underlyingFunds,
    lookThroughHoldings,
    lookThroughSectors,
    holdings: lookThroughHoldings.length ? lookThroughHoldings : parent.holdings,
    sectors: lookThroughSectors.length ? lookThroughSectors : parent.sectors,
    lookThroughCoverage: {
      directHoldings: parent.holdings.length,
      candidateUnderlyingFunds: candidates.length,
      resolvedUnderlyingFunds: results.filter(item => item.portfolio).length,
      resolvedFundWeight: Number(resolvedFundWeight.toFixed(4)),
      stocks: lookThroughHoldings.length,
      sectors: lookThroughSectors.length
    }
  };
  store().set(key, { at: now, value });
  return value;
}
