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

function identityWords(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\bfixed maturity plans?\b/g, ' fmp ')
    .replace(/\b(mutual|fund|scheme|direct|regular|plan|growth|idcw|dividend|option|payout|reinvestment|income distribution cum capital withdrawal)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(word => word.length > 1);
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
    rows.push({
      name,
      weight: Number(weight.toFixed(4)),
      sector: cleanText(item?.sector || item?.industry) || null,
      oneMonthWeightChange: numberValue(item?.change1M)
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
      sector: item.sector || other?.sector || null,
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
