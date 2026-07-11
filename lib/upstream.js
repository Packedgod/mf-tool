const MFAPI_BASE = 'https://api.mfapi.in';
const AMFI_NAV_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const CACHE_TTL = 15 * 60 * 1000;
const STALE_TTL = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 18000;

function cache() {
  globalThis.__ML_CACHE__ ??= new Map();
  return globalThis.__ML_CACHE__;
}

function codeOf(value) {
  const text = String(value ?? '').trim();
  return /^\d{4,9}$/.test(text) ? Number(text) : null;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTimeout(url, timeoutMs = REQUEST_TIMEOUT, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          accept: 'application/json,text/plain,*/*',
          'user-agent': 'ManagerLens/2.0 live-nav-resolver'
        }
      });
      clearTimeout(timer);
      if ((response.status === 429 || response.status >= 500) && attempt < attempts - 1) {
        lastError = new Error(`Upstream returned ${response.status}`);
        await wait(500 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < attempts - 1) await wait(500 * (attempt + 1));
    }
  }
  throw lastError || new Error('Upstream request failed.');
}

function iso(value) {
  const parts = String(value || '').split('-');
  if (parts.length === 3 && parts[0].length === 2) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function parseAmfi(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => /^\d+;/.test(line.trim()))
    .map(line => {
      const parts = line.trim().split(';');
      return {
        schemeCode: Number(parts[0]),
        schemeName: parts[3],
        nav: Number(parts[4]),
        date: parts[5]
      };
    })
    .filter(item => item.schemeCode && item.schemeName);
}

async function amfiRows() {
  const store = cache();
  const key = 'amfi:all';
  const now = Date.now();
  const old = store.get(key);
  if (old && now - old.at < CACHE_TTL) return { ...old.value, cache: 'fresh' };

  try {
    const response = await fetchTimeout(AMFI_NAV_URL, 16000, 3);
    if (!response.ok) throw new Error(`AMFI returned ${response.status}`);
    const rows = parseAmfi(await response.text());
    if (!rows.length) throw new Error('AMFI returned no schemes.');
    const value = { rows, fetchedAt: new Date().toISOString() };
    store.set(key, { at: now, value });
    return { ...value, cache: 'fresh' };
  } catch (error) {
    if (old && now - old.at < STALE_TTL) {
      return { ...old.value, cache: 'stale', warning: errorText(error) };
    }
    throw error;
  }
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function score(name, query) {
  const candidate = norm(name);
  const target = norm(query);
  const tokens = target.split(' ').filter(Boolean);
  let value = candidate === target ? 120 : candidate.includes(target) ? 60 : 0;
  for (const token of tokens) if (candidate.includes(token)) value += token.length > 5 ? 8 : 4;
  if (candidate.includes('direct')) value += 25;
  if (candidate.includes('growth')) value += 25;
  if (candidate.includes('regular')) value -= 45;
  if (candidate.includes('idcw') || candidate.includes('dividend')) value -= 35;
  return value - tokens.filter(token => !candidate.includes(token)).length * 8;
}

async function resolveByCode(raw) {
  const schemeCode = codeOf(raw);
  if (!schemeCode) throw new Error('AMFI scheme code must contain 4 to 9 digits.');

  let row = null;
  let meta = null;
  const warnings = [];
  const [amfiResult, metaResult] = await Promise.allSettled([
    amfiRows(),
    fetchTimeout(`${MFAPI_BASE}/mf/${schemeCode}/latest`, 12000, 2)
  ]);

  if (amfiResult.status === 'fulfilled') {
    row = amfiResult.value.rows.find(item => item.schemeCode === schemeCode) || null;
    if (amfiResult.value.warning) warnings.push(amfiResult.value.warning);
  } else warnings.push(errorText(amfiResult.reason));

  if (metaResult.status === 'fulfilled' && metaResult.value.ok) {
    try { meta = (await metaResult.value.json()).meta || null; } catch {}
  } else if (metaResult.status === 'rejected') warnings.push(errorText(metaResult.reason));

  // A syntactically valid AMFI code is allowed to proceed to the history endpoint
  // even when the two identity checks are temporarily unavailable. The history
  // payload performs the final existence check and prevents a transient outage
  // from blocking otherwise valid fund and proxy series.
  return {
    schemeCode,
    schemeName: row?.schemeName || meta?.scheme_name || `AMFI scheme ${schemeCode}`,
    resolvedBy: row ? 'Direct AMFI scheme code' : meta ? 'Direct MFapi scheme code' : 'Direct code; identity check temporarily unavailable',
    amfiRow: row,
    warnings
  };
}

async function searchMfapi(query) {
  const response = await fetchTimeout(`${MFAPI_BASE}/mf/search?q=${encodeURIComponent(query)}`, 12000, 2);
  if (!response.ok) throw new Error(`MFapi search returned ${response.status}`);
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}

async function resolveByQueries(queries) {
  const cleanQueries = [...new Set((queries || []).map(item => String(item).trim()).filter(Boolean))].slice(0, 6);
  if (!cleanQueries.length) throw new Error('No scheme query was provided.');

  const store = cache();
  const key = `resolve:${JSON.stringify(cleanQueries)}`;
  const old = store.get(key);
  if (old && Date.now() - old.at < STALE_TTL) return { ...old.value, cache: Date.now() - old.at < CACHE_TTL ? 'fresh' : 'stale' };

  const candidates = [];
  const searches = await Promise.allSettled(cleanQueries.map(query => searchMfapi(query)));
  searches.forEach(result => {
    if (result.status !== 'fulfilled') return;
    for (const item of result.value) {
      if (!candidates.some(existing => Number(existing.schemeCode) === Number(item.schemeCode))) candidates.push(item);
    }
  });

  if (!candidates.length) {
    try {
      const rows = (await amfiRows()).rows;
      for (const row of rows) candidates.push({ schemeCode: row.schemeCode, schemeName: row.schemeName });
    } catch {}
  }

  let best = null;
  for (const candidate of candidates) {
    for (const query of cleanQueries) {
      const candidateScore = score(candidate.schemeName, query);
      if (!best || candidateScore > best.score) best = { ...candidate, score: candidateScore, query };
    }
  }

  if (!best || best.score < 20) {
    if (old && Date.now() - old.at < STALE_TTL) return { ...old.value, cache: 'stale' };
    throw new Error(`No MFapi/AMFI match found for ${cleanQueries.join(' | ')}`);
  }

  const value = {
    schemeCode: Number(best.schemeCode),
    schemeName: best.schemeName,
    resolvedBy: 'Ranked MFapi/AMFI search',
    matchedQuery: best.query,
    matchScore: best.score
  };
  store.set(key, { at: Date.now(), value });
  return value;
}

function filterHistory(data, startDate, endDate) {
  return (Array.isArray(data) ? data : []).filter(item => {
    const date = iso(item.date);
    return date && (!startDate || date >= startDate) && (!endDate || date <= endDate);
  });
}

async function historyRequest(code, startDate, endDate) {
  const params = new URLSearchParams();
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  const url = `${MFAPI_BASE}/mf/${code}${params.toString() ? `?${params}` : ''}`;
  const response = await fetchTimeout(url, 20000, 3);
  if (!response.ok) throw new Error(`MFapi history returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error('MFapi returned an invalid NAV history payload.');
  return body;
}

async function history(code, startDate, endDate) {
  const store = cache();
  const rangeKey = `history:${code}:${startDate || ''}:${endDate || ''}`;
  const fullKey = `history:${code}:full`;
  const now = Date.now();
  const rangeOld = store.get(rangeKey);
  const fullOld = store.get(fullKey);
  if (rangeOld && now - rangeOld.at < CACHE_TTL) return { ...rangeOld.value, cache: 'fresh' };

  try {
    const ranged = await historyRequest(code, startDate, endDate);
    const data = filterHistory(ranged.data, startDate, endDate);
    if (data.length) {
      const value = { ...ranged, data, fallback: null };
      store.set(rangeKey, { at: now, value });
      return value;
    }
  } catch {}

  try {
    let full;
    if (fullOld && now - fullOld.at < CACHE_TTL) full = fullOld.value;
    else {
      full = await historyRequest(code);
      if (!full.data.length) throw new Error('MFapi returned no NAV history.');
      store.set(fullKey, { at: now, value: full });
    }
    const data = filterHistory(full.data, startDate, endDate);
    if (!data.length) throw new Error('No NAV observations exist in the selected date range.');
    const value = { ...full, data, fallback: 'full-history-local-filter' };
    store.set(rangeKey, { at: now, value });
    return value;
  } catch (error) {
    const stale = rangeOld || fullOld;
    if (stale && now - stale.at < STALE_TTL) {
      const source = stale.value;
      const data = filterHistory(source.data, startDate, endDate);
      if (data.length) return { ...source, data, fallback: 'stale-history-cache', warning: errorText(error), cache: 'stale' };
    }
    throw error;
  }
}

async function liveSeries({ queries = [], schemeCode, startDate, endDate }) {
  const direct = codeOf(schemeCode);
  const key = `series:${direct || JSON.stringify(queries)}:${startDate || ''}:${endDate || ''}`;
  const store = cache();
  const now = Date.now();
  const old = store.get(key);
  if (old && now - old.at < CACHE_TTL) return { ...old.value, cache: 'fresh' };

  try {
    const resolved = direct ? await resolveByCode(direct) : await resolveByQueries(queries);
    const navHistory = await history(resolved.schemeCode, startDate, endDate);
    let latest = resolved.amfiRow || null;
    try { latest ??= (await amfiRows()).rows.find(item => item.schemeCode === resolved.schemeCode) || null; } catch {}

    const value = {
      ok: true,
      meta: navHistory.meta || {},
      data: navHistory.data,
      source: {
        primary: 'MFapi.in',
        validation: 'AMFI NAVAll',
        schemeCode: resolved.schemeCode,
        schemeName: resolved.schemeName,
        resolvedBy: resolved.resolvedBy,
        matchedQuery: resolved.matchedQuery || null,
        amfiStatus: latest ? 'validated' : 'temporarily unavailable',
        amfiLatest: latest,
        historyFallback: navHistory.fallback || null,
        fetchedAt: new Date().toISOString(),
        stale: navHistory.cache === 'stale',
        warnings: [...(resolved.warnings || []), ...(navHistory.warning ? [navHistory.warning] : [])]
      }
    };
    store.set(key, { at: now, value });
    return value;
  } catch (error) {
    if (old && now - old.at < STALE_TTL) {
      return {
        ...old.value,
        cache: 'stale',
        source: { ...old.value.source, stale: true, warning: errorText(error) }
      };
    }
    throw error;
  }
}

async function health() {
  const [mfapi, amfi] = await Promise.allSettled([
    fetchTimeout(`${MFAPI_BASE}/mf/125497/latest`, 9000, 1),
    fetchTimeout(AMFI_NAV_URL, 9000, 1)
  ]);
  return {
    checkedAt: new Date().toISOString(),
    mfapi: mfapi.status === 'fulfilled' && mfapi.value.ok ? 'online' : 'degraded',
    amfi: amfi.status === 'fulfilled' && amfi.value.ok ? 'online' : 'degraded'
  };
}

export { codeOf, resolveByCode, history, liveSeries, health };
