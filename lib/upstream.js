const MFAPI_BASE = 'https://api.mfapi.in';
const AMFI_NAV_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const AMFI_HISTORY_URL = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx';
const CACHE_TTL = 15 * 60 * 1000;
const STALE_TTL = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 18000;

function cache() {
  globalThis.__ML_CACHE__ ??= new Map();
  return globalThis.__ML_CACHE__;
}

function inflight() {
  globalThis.__ML_INFLIGHT__ ??= new Map();
  return globalThis.__ML_INFLIGHT__;
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
          'user-agent': 'ManagerLens/2.1 live-nav-resolver'
        }
      });
      clearTimeout(timer);
      if ((response.status === 429 || response.status >= 500) && attempt < attempts - 1) {
        lastError = new Error(`Upstream returned ${response.status}`);
        await wait(400 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < attempts - 1) await wait(400 * (attempt + 1));
    }
  }
  throw lastError || new Error('Upstream request failed.');
}

function iso(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  match = text.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (match) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const month = months[match[2].toLowerCase()];
    if (month) return `${match[3]}-${month}-${match[1]}`;
  }
  const date = new Date(text);
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
    if (old && now - old.at < STALE_TTL) return { ...old.value, cache: 'stale', warning: errorText(error) };
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

async function historyRequest(code, startDate, endDate, timeoutMs = 14000, attempts = 2) {
  const params = new URLSearchParams();
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  const url = `${MFAPI_BASE}/mf/${code}${params.toString() ? `?${params}` : ''}`;
  const response = await fetchTimeout(url, timeoutMs, attempts);
  if (!response.ok) throw new Error(`MFapi history returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error('MFapi returned an invalid NAV history payload.');
  return body;
}

function dateAt(value) {
  const parsed = new Date(`${value || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function splitRanges(startDate, endDate, days = 540) {
  if (!startDate || !endDate) return [];
  const start = dateAt(startDate);
  const end = dateAt(endDate);
  if (end <= start) return [{ startDate, endDate }];
  const ranges = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + days * 86400000));
    ranges.push({ startDate: cursor.toISOString().slice(0, 10), endDate: chunkEnd.toISOString().slice(0, 10) });
    cursor = new Date(chunkEnd.getTime() + 86400000);
  }
  return ranges;
}

async function chunkedMfapiHistory(code, startDate, endDate) {
  const ranges = splitRanges(startDate, endDate, 540);
  if (ranges.length <= 1) return null;
  const rows = [];
  const warnings = [];
  for (let index = 0; index < ranges.length; index += 3) {
    const batch = ranges.slice(index, index + 3);
    const results = await Promise.allSettled(batch.map(range => historyRequest(code, range.startDate, range.endDate, 12000, 2)));
    results.forEach((result, offset) => {
      if (result.status === 'fulfilled') rows.push(...(result.value.data || []));
      else warnings.push(`${batch[offset].startDate}–${batch[offset].endDate}: ${errorText(result.reason)}`);
    });
  }
  const map = new Map();
  for (const item of rows) {
    const date = iso(item.date);
    const nav = Number(item.nav);
    if (date && Number.isFinite(nav) && nav > 0) map.set(date, item);
  }
  const data = [...map.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([, item]) => item);
  return data.length >= 3 ? { data, meta: {}, fallback: 'mfapi-chunked-range', warning: warnings.length ? warnings.join(' | ') : null } : null;
}

function amfiDate(value) {
  const date = dateAt(value);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(date.getUTCDate()).padStart(2, '0')}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function recentAmfiRange(startDate, endDate, days = 45) {
  const end = dateAt(endDate || new Date().toISOString().slice(0, 10));
  const requestedStart = startDate ? dateAt(startDate) : null;
  const recentStart = new Date(end.getTime() - days * 86400000);
  const start = requestedStart && requestedStart > recentStart ? requestedStart : recentStart;
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

async function amfiHistoryText(startDate, endDate) {
  const store = cache();
  const pending = inflight();
  const key = `amfi-history-text:${startDate}:${endDate}`;
  const old = store.get(key);
  const now = Date.now();
  if (old && now - old.at < CACHE_TTL) return { text: old.value, cache: 'fresh' };
  if (pending.has(key)) return pending.get(key);

  const task = (async () => {
    try {
      const params = new URLSearchParams({ frmdt: amfiDate(startDate), todt: amfiDate(endDate) });
      const response = await fetchTimeout(`${AMFI_HISTORY_URL}?${params}`, 52000, 1);
      if (!response.ok) throw new Error(`AMFI historical NAV returned ${response.status}`);
      const text = await response.text();
      if (!text.includes('Scheme Code;Scheme Name') || text.length < 1000) throw new Error('AMFI historical NAV returned an invalid payload.');
      store.set(key, { at: now, value: text });
      return { text, cache: 'fresh' };
    } catch (error) {
      if (old && now - old.at < STALE_TTL) return { text: old.value, cache: 'stale', warning: errorText(error) };
      throw error;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, task);
  return task;
}

async function amfiRecentHistory(code, startDate, endDate) {
  const range = recentAmfiRange(startDate, endDate, 45);
  const payload = await amfiHistoryText(range.startDate, range.endDate);
  const prefix = `${code};`;
  const data = [];
  let schemeName = null;
  for (const line of payload.text.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const parts = line.split(';');
    const nav = Number(parts[4]);
    const date = iso(parts[7]);
    if (!Number.isFinite(nav) || nav <= 0 || !date) continue;
    schemeName ||= parts[1];
    data.push({ date, nav: String(nav) });
  }
  data.sort((left, right) => right.date.localeCompare(left.date));
  if (data.length < 3) throw new Error(`AMFI historical NAV returned fewer than three observations for scheme ${code}.`);
  return {
    data,
    meta: { scheme_code: code, scheme_name: schemeName || `AMFI scheme ${code}` },
    fallback: 'amfi-official-recent-history',
    provider: 'AMFI historical NAV',
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    actualStartDate: range.startDate,
    actualEndDate: range.endDate,
    warning: payload.warning || 'MFapi history was unavailable; the chart uses the latest official AMFI historical NAV window.'
  };
}

async function history(code, startDate, endDate) {
  const store = cache();
  const rangeKey = `history:${code}:${startDate || ''}:${endDate || ''}`;
  const now = Date.now();
  const rangeOld = store.get(rangeKey);
  if (rangeOld && now - rangeOld.at < CACHE_TTL) return { ...rangeOld.value, cache: 'fresh' };

  let mfapiError = null;
  try {
    const ranges = splitRanges(startDate, endDate, 540);
    if (ranges.length > 1) {
      const chunked = await chunkedMfapiHistory(code, startDate, endDate);
      if (chunked?.data?.length) {
        store.set(rangeKey, { at: now, value: chunked });
        return chunked;
      }
    } else {
      const ranged = await historyRequest(code, startDate, endDate, 16000, 3);
      const data = filterHistory(ranged.data, startDate, endDate);
      if (data.length) {
        const value = { ...ranged, data, fallback: null, provider: 'MFapi.in' };
        store.set(rangeKey, { at: now, value });
        return value;
      }
    }
  } catch (error) {
    mfapiError = error;
  }

  try {
    const official = await amfiRecentHistory(code, startDate, endDate);
    if (mfapiError) official.warning = `${official.warning} MFapi detail: ${errorText(mfapiError)}`;
    store.set(rangeKey, { at: now, value: official });
    return official;
  } catch (officialError) {
    if (rangeOld && now - rangeOld.at < STALE_TTL) {
      return {
        ...rangeOld.value,
        fallback: 'stale-history-cache',
        warning: `${errorText(mfapiError || 'MFapi unavailable')} | ${errorText(officialError)}`,
        cache: 'stale'
      };
    }
    throw new Error(`${errorText(mfapiError || 'MFapi history unavailable')} AMFI fallback also failed: ${errorText(officialError)}`);
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
      meta: { ...(navHistory.meta || {}), scheme_name: navHistory.meta?.scheme_name || resolved.schemeName },
      data: navHistory.data,
      source: {
        primary: navHistory.provider || 'MFapi.in',
        validation: 'AMFI NAVAll',
        schemeCode: resolved.schemeCode,
        schemeName: navHistory.meta?.scheme_name || resolved.schemeName,
        resolvedBy: resolved.resolvedBy,
        matchedQuery: resolved.matchedQuery || null,
        amfiStatus: latest ? 'validated' : 'temporarily unavailable',
        amfiLatest: latest,
        historyFallback: navHistory.fallback || null,
        requestedStartDate: navHistory.requestedStartDate || startDate || null,
        requestedEndDate: navHistory.requestedEndDate || endDate || null,
        actualStartDate: navHistory.actualStartDate || startDate || null,
        actualEndDate: navHistory.actualEndDate || endDate || null,
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
    amfi: amfi.status === 'fulfilled' && amfi.value.ok ? 'online' : 'degraded',
    navHistoryFallback: 'AMFI official historical NAV enabled'
  };
}

export { codeOf, resolveByCode, history, liveSeries, health };
