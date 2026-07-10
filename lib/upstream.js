const MFAPI_BASE = "https://api.mfapi.in";
const AMFI_NAV_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";

const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

function getCache() {
  if (!globalThis.__MF_MANAGER_CACHE__) globalThis.__MF_MANAGER_CACHE__ = new Map();
  return globalThis.__MF_MANAGER_CACHE__;
}

function normaliseName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bplan\b/g, " ")
    .replace(/\bfund\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseSchemeCode(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4,9}$/.test(text)) return null;
  const code = Number(text);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}

function navDateToIso(value) {
  const text = String(value || "").trim();
  const parts = text.split("-");
  if (parts.length === 3 && parts[0].length === 2) {
    const [dd, mm, yyyy] = parts.map(Number);
    if (yyyy && mm && dd) {
      return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "mf-manager-decision-intelligence/1.1",
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function scoreSchemeCandidate(candidateName, query) {
  const candidate = normaliseName(candidateName);
  const target = normaliseName(query);
  const tokens = target.split(" ").filter(Boolean);
  let score = 0;

  if (candidate === target) score += 120;
  if (candidate.includes(target)) score += 60;
  for (const token of tokens) {
    if (candidate.includes(token)) score += token.length > 5 ? 8 : 4;
  }

  if (candidate.includes("direct")) score += 28;
  if (candidate.includes("growth")) score += 26;
  if (candidate.includes("regular")) score -= 45;
  if (candidate.includes("idcw") || candidate.includes("dividend")) score -= 35;
  if (candidate.includes("monthly") || candidate.includes("weekly")) score -= 12;

  const missing = tokens.filter((token) => !candidate.includes(token)).length;
  score -= missing * 8;
  return score;
}

function chooseBestCandidate(results, queries) {
  const candidates = Array.isArray(results) ? results : [];
  let best = null;
  for (const result of candidates) {
    for (const query of queries) {
      const score = scoreSchemeCandidate(result.schemeName, query);
      if (!best || score > best.score) best = { ...result, score, matchedQuery: query };
    }
  }
  return best && best.score > 20 ? best : null;
}

function parseAmfiNav(text) {
  const rows = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\d+;/.test(line)) continue;
    const parts = line.split(";");
    if (parts.length < 6) continue;
    const nav = Number(parts[4]);
    rows.push({
      schemeCode: Number(parts[0]),
      schemeName: parts[3],
      nav: Number.isFinite(nav) ? nav : null,
      date: parts[5]
    });
  }
  return rows;
}

async function getAmfiRows({ allowStale = true } = {}) {
  const cache = getCache();
  const key = "amfi-nav-all";
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.createdAt < CACHE_TTL_MS) return { ...cached.value, cache: "fresh" };

  try {
    const response = await fetchWithTimeout(AMFI_NAV_URL, { cache: "no-store" }, 10000);
    if (!response.ok) throw new Error(`AMFI returned ${response.status}`);
    const text = await response.text();
    const rows = parseAmfiNav(text);
    if (!rows.length) throw new Error("AMFI returned no NAV rows");
    const value = { rows, fetchedAt: new Date().toISOString(), source: "AMFI NAVAll" };
    cache.set(key, { createdAt: now, value });
    return { ...value, cache: "network" };
  } catch (error) {
    if (allowStale && cached && now - cached.createdAt < STALE_TTL_MS) {
      return { ...cached.value, cache: "stale", warning: error instanceof Error ? error.message : String(error) };
    }
    throw error;
  }
}

async function searchMfapi(queries) {
  const allResults = [];
  const attempts = [];
  for (const query of queries) {
    try {
      const response = await fetchWithTimeout(`${MFAPI_BASE}/mf/search?q=${encodeURIComponent(query)}`, { cache: "no-store" }, 8000);
      if (!response.ok) throw new Error(`MFapi search returned ${response.status}`);
      const data = await response.json();
      attempts.push({ query, ok: true, count: Array.isArray(data) ? data.length : 0 });
      for (const item of Array.isArray(data) ? data : []) {
        if (!allResults.some((existing) => existing.schemeCode === item.schemeCode)) allResults.push(item);
      }
      if (allResults.length >= 15) break;
    } catch (error) {
      attempts.push({ query, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results: allResults, attempts };
}

async function resolveScheme(queries) {
  const queryList = Array.isArray(queries) ? queries.filter(Boolean) : [];
  if (!queryList.length) throw new Error("No scheme queries supplied");

  const mfapi = await searchMfapi(queryList);
  const bestMfapi = chooseBestCandidate(mfapi.results, queryList);
  if (bestMfapi) {
    return {
      schemeCode: Number(bestMfapi.schemeCode),
      schemeName: bestMfapi.schemeName,
      resolvedBy: "MFapi search",
      matchedQuery: bestMfapi.matchedQuery,
      score: bestMfapi.score,
      attempts: mfapi.attempts
    };
  }

  const amfi = await getAmfiRows();
  const amfiCandidates = amfi.rows.map((row) => ({ schemeCode: row.schemeCode, schemeName: row.schemeName }));
  const bestAmfi = chooseBestCandidate(amfiCandidates, queryList);
  if (bestAmfi) {
    return {
      schemeCode: Number(bestAmfi.schemeCode),
      schemeName: bestAmfi.schemeName,
      resolvedBy: "AMFI NAVAll fallback",
      matchedQuery: bestAmfi.matchedQuery,
      score: bestAmfi.score,
      attempts: mfapi.attempts
    };
  }

  throw new Error(`No valid MFapi/AMFI scheme match found for: ${queryList.join(" | ")}`);
}

async function resolveSchemeByCode(inputCode) {
  const schemeCode = normaliseSchemeCode(inputCode);
  if (!schemeCode) throw new Error("AMFI scheme code must contain 4 to 9 digits.");

  let amfiRow = null;
  let amfiStatus = "unavailable";
  try {
    const amfi = await getAmfiRows();
    amfiRow = amfi.rows.find((row) => row.schemeCode === schemeCode) || null;
    amfiStatus = amfiRow ? "validated" : "scheme-not-found";
  } catch {
    amfiStatus = "degraded";
  }

  let latestMeta = null;
  try {
    const response = await fetchWithTimeout(`${MFAPI_BASE}/mf/${schemeCode}/latest`, { cache: "no-store" }, 9000);
    if (response.ok) {
      const latest = await response.json();
      latestMeta = latest?.meta || null;
    }
  } catch {
    latestMeta = null;
  }

  if (!amfiRow && !latestMeta) {
    throw new Error(`Scheme code ${schemeCode} was not found in AMFI or MFapi.`);
  }

  return {
    schemeCode,
    schemeName: amfiRow?.schemeName || latestMeta?.scheme_name || `Scheme ${schemeCode}`,
    resolvedBy: amfiRow ? "Direct AMFI scheme code" : "Direct MFapi scheme code",
    matchedQuery: String(schemeCode),
    amfiStatus,
    amfiRow
  };
}

function filterHistoryByDate(data, startDate, endDate) {
  if (!startDate && !endDate) return data;
  return (Array.isArray(data) ? data : []).filter((row) => {
    const iso = navDateToIso(row?.date);
    if (!iso) return false;
    if (startDate && iso < startDate) return false;
    if (endDate && iso > endDate) return false;
    return true;
  });
}

async function fetchHistoryRequest(schemeCode, startDate, endDate) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetchWithTimeout(`${MFAPI_BASE}/mf/${encodeURIComponent(schemeCode)}${suffix}`, { cache: "no-store" }, 12000);
  if (!response.ok) throw new Error(`MFapi history returned ${response.status}`);
  return response.json();
}

async function fetchHistoryByCode(inputCode, startDate, endDate) {
  const schemeCode = normaliseSchemeCode(inputCode);
  if (!schemeCode) throw new Error("Invalid AMFI scheme code.");

  let rangedError = null;
  try {
    const ranged = await fetchHistoryRequest(schemeCode, startDate, endDate);
    if (Array.isArray(ranged?.data) && ranged.data.length) return ranged;
    rangedError = new Error("MFapi ranged request returned no NAV history");
  } catch (error) {
    rangedError = error;
  }

  const full = await fetchHistoryRequest(schemeCode);
  if (!Array.isArray(full?.data) || !full.data.length) {
    throw rangedError || new Error("MFapi returned no NAV history");
  }

  const filtered = filterHistoryByDate(full.data, startDate, endDate);
  if (!filtered.length) {
    throw new Error(`Scheme ${schemeCode} has no NAV observations in the selected date range.`);
  }

  return {
    ...full,
    data: filtered,
    fallback: "full-history-local-date-filter"
  };
}

async function fetchLiveSeries({ queries, schemeCode, startDate, endDate }) {
  const directCode = normaliseSchemeCode(schemeCode);
  const key = `series:${directCode || JSON.stringify(queries || [])}:${startDate || ""}:${endDate || ""}`;
  const cache = getCache();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.createdAt < CACHE_TTL_MS) return { ...cached.value, cache: "fresh" };

  try {
    const resolved = directCode ? await resolveSchemeByCode(directCode) : await resolveScheme(queries);
    const history = await fetchHistoryByCode(resolved.schemeCode, startDate, endDate);
    let amfiLatest = resolved.amfiRow || null;
    let amfiStatus = resolved.amfiStatus || "unavailable";

    if (!directCode || !resolved.amfiRow) {
      try {
        const amfi = await getAmfiRows();
        const latest = amfi.rows.find((row) => row.schemeCode === resolved.schemeCode);
        if (latest) {
          amfiLatest = latest;
          amfiStatus = "validated";
        } else if (amfiStatus !== "degraded") {
          amfiStatus = "scheme-not-found";
        }
      } catch {
        amfiStatus = "degraded";
      }
    }

    const value = {
      ok: true,
      meta: history.meta || {},
      data: history.data,
      source: {
        primary: "MFapi.in",
        validation: "AMFI NAVAll",
        amfiStatus,
        amfiLatest,
        schemeCode: resolved.schemeCode,
        schemeName: resolved.schemeName,
        resolvedBy: resolved.resolvedBy,
        matchedQuery: resolved.matchedQuery,
        historyFallback: history.fallback || null,
        fetchedAt: new Date().toISOString(),
        stale: false
      }
    };
    cache.set(key, { createdAt: now, value });
    return { ...value, cache: "network" };
  } catch (error) {
    if (cached && now - cached.createdAt < STALE_TTL_MS) {
      return {
        ...cached.value,
        cache: "stale",
        source: {
          ...cached.value.source,
          stale: true,
          warning: error instanceof Error ? error.message : String(error)
        }
      };
    }
    throw error;
  }
}

async function checkHealth() {
  const checkedAt = new Date().toISOString();
  const [mfapiResult, amfiResult] = await Promise.allSettled([
    fetchWithTimeout(`${MFAPI_BASE}/mf/125497/latest`, { cache: "no-store" }, 7000),
    fetchWithTimeout(AMFI_NAV_URL, { cache: "no-store" }, 7000)
  ]);

  const mfapi = mfapiResult.status === "fulfilled" && mfapiResult.value.ok ? "online" : "degraded";
  const amfi = amfiResult.status === "fulfilled" && amfiResult.value.ok ? "online" : "degraded";
  return { checkedAt, mfapi, amfi };
}

export {
  MFAPI_BASE,
  AMFI_NAV_URL,
  fetchWithTimeout,
  normaliseName,
  normaliseSchemeCode,
  navDateToIso,
  scoreSchemeCandidate,
  chooseBestCandidate,
  parseAmfiNav,
  getAmfiRows,
  resolveScheme,
  resolveSchemeByCode,
  fetchHistoryByCode,
  fetchLiveSeries,
  checkHealth
};
