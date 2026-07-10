import { managersForFund, canonicalSchemeName, managerRegistryStats } from "@/lib/manager-registry";

const AMFI_NAV_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

function getCache() {
  globalThis.__MANAGERLENS_UNIVERSE_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_UNIVERSE_CACHE__;
}

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "text/plain,*/*",
        "user-agent": "ManagerLens/0.6 all-fund-universe"
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function optionRank(name) {
  const text = String(name || "").toLowerCase();
  let score = 0;
  if (text.includes("direct")) score += 100;
  if (text.includes("growth")) score += 60;
  if (text.includes("regular")) score -= 25;
  if (text.includes("idcw") || text.includes("dividend")) score -= 40;
  if (text.includes("payout")) score -= 10;
  if (text.includes("reinvestment")) score -= 5;
  return score;
}

function planType(name) {
  const text = String(name || "").toLowerCase();
  return text.includes("direct") ? "Direct" : text.includes("regular") ? "Regular" : "Unspecified";
}

function optionType(name) {
  const text = String(name || "").toLowerCase();
  if (text.includes("growth")) return "Growth";
  if (text.includes("idcw") || text.includes("dividend")) return "IDCW";
  return "Other";
}

function parseAmfiUniverse(text) {
  const schemes = [];
  let fundHouse = "Unknown AMC";
  let category = "Unclassified";

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Scheme Code;/i.test(line)) continue;

    if (/^\d+;/.test(line)) {
      const parts = line.split(";");
      if (parts.length < 6) continue;
      const schemeCode = Number(parts[0]);
      const schemeName = parts[3]?.trim();
      const nav = Number(parts[4]);
      if (!schemeCode || !schemeName) continue;
      schemes.push({
        schemeCode,
        schemeName,
        isinDividend: parts[1] || null,
        isinGrowth: parts[2] || null,
        nav: Number.isFinite(nav) ? nav : null,
        navDate: parts[5] || null,
        fundHouse,
        category,
        canonicalName: canonicalSchemeName(schemeName),
        plan: planType(schemeName),
        option: optionType(schemeName)
      });
      continue;
    }

    if (/^(Open Ended|Close Ended|Interval Fund)/i.test(line)) {
      category = line;
    } else if (!line.includes(";") && !/^\(/.test(line)) {
      fundHouse = line;
      category = "Unclassified";
    }
  }

  return schemes;
}

function buildFamilies(schemes) {
  const groups = new Map();
  for (const scheme of schemes) {
    const key = `${scheme.fundHouse.toLowerCase()}::${scheme.canonicalName}`;
    const current = groups.get(key) || {
      id: key,
      canonicalName: scheme.canonicalName,
      displayName: scheme.schemeName,
      fundHouse: scheme.fundHouse,
      category: scheme.category,
      variants: [],
      managers: [],
      managerCoverage: "unverified"
    };
    current.variants.push(scheme);
    if (optionRank(scheme.schemeName) > optionRank(current.displayName)) current.displayName = scheme.schemeName;
    groups.set(key, current);
  }

  return [...groups.values()].map(group => {
    const variants = [...group.variants].sort((a, b) => optionRank(b.schemeName) - optionRank(a.schemeName));
    const preferred = variants[0];
    const managers = managersForFund({
      schemeName: preferred.schemeName,
      canonicalName: group.canonicalName,
      fundHouse: group.fundHouse
    }).map(manager => ({
      id: manager.id,
      name: manager.name,
      role: manager.role,
      amc: manager.amc,
      startDate: manager.startDate || null,
      startLabel: manager.startLabel || null,
      confidence: manager.confidence || 0,
      source: manager.source || null,
      sourceType: manager.sourceType || null
    }));

    return {
      ...group,
      variants,
      preferredSchemeCode: preferred.schemeCode,
      preferredSchemeName: preferred.schemeName,
      latestNav: preferred.nav,
      navDate: preferred.navDate,
      managers,
      managerCoverage: managers.length ? "verified" : "pending-official-factsheet"
    };
  }).sort((a, b) => a.fundHouse.localeCompare(b.fundHouse) || a.displayName.localeCompare(b.displayName));
}

export async function getMarketUniverse() {
  const cache = getCache();
  const key = "all-funds";
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return { ...cached.value, cache: "fresh" };

  try {
    const response = await fetchWithTimeout(AMFI_NAV_URL);
    if (!response.ok) throw new Error(`AMFI returned ${response.status}`);
    const text = await response.text();
    const schemes = parseAmfiUniverse(text);
    if (!schemes.length) throw new Error("AMFI returned no live scheme records");
    const families = buildFamilies(schemes);
    const value = {
      schemes,
      families,
      stats: {
        schemeVariants: schemes.length,
        fundFamilies: families.length,
        fundHouses: new Set(schemes.map(item => item.fundHouse)).size,
        verifiedFundFamilies: families.filter(item => item.managers.length).length,
        ...managerRegistryStats()
      },
      source: "AMFI NAVAll",
      fetchedAt: new Date().toISOString(),
      stale: false
    };
    cache.set(key, { at: now, value });
    return { ...value, cache: "network" };
  } catch (error) {
    if (cached && now - cached.at < STALE_TTL_MS) {
      return { ...cached.value, cache: "stale", stale: true, warning: error instanceof Error ? error.message : String(error) };
    }
    throw error;
  }
}

export function searchUniverse(universe, { query = "", fundHouse = "", managerOnly = false, limit = 100, offset = 0 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const house = String(fundHouse || "").trim().toLowerCase();
  const filtered = universe.families.filter(fund => {
    if (house && fund.fundHouse.toLowerCase() !== house) return false;
    if (managerOnly && !fund.managers.length) return false;
    if (!q) return true;
    return [
      fund.displayName,
      fund.canonicalName,
      fund.fundHouse,
      fund.category,
      ...fund.managers.flatMap(manager => [manager.name, manager.role])
    ].join(" ").toLowerCase().includes(q);
  });
  const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return {
    total: filtered.length,
    offset: safeOffset,
    limit: safeLimit,
    results: filtered.slice(safeOffset, safeOffset + safeLimit)
  };
}
