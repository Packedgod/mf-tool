import { NextResponse } from "next/server";
import { getMomentumSnapshot, SECTOR_MARKET_SYMBOLS } from "@/lib/momentum-data";
import { getExtendedMomentumSnapshot } from "@/lib/extended-momentum-data";
import { offlineYahooResult, OFFLINE_PRICE_SOURCE } from "@/lib/offline-market";
import { logUpstreamError } from "@/lib/upstream-log";

// Deterministic samples are available only for explicitly requested local
// demos. Production must never silently substitute generated market prices.
const OFFLINE_PRICES_ENABLED = process.env.MANAGERLENS_OFFLINE_PRICES === "1";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FRESH_MS = 15 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;

function getCache() {
  globalThis.__MANAGERLENS_MOMENTUM_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_MOMENTUM_CACHE__;
}

async function fetchWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "ManagerLens/0.8 momentum-research"
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahoo(symbol) {
  const cache = getCache();
  const key = `yahoo:${symbol}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < FRESH_MS) return { ...cached.value, cache: "fresh" };

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includeAdjustedClose=true&events=div%2Csplits`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`);
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    if (!result) throw new Error("Yahoo Finance returned no chart result");
    const timestamps = result.timestamp || [];
    const adjusted = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close || [];
    const points = timestamps.map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: Number(adjusted[index])
    })).filter(point => Number.isFinite(point.close) && point.close > 0);
    if (points.length < 20) throw new Error("Yahoo Finance returned insufficient price history");
    const value = { ok: true, symbol, points, currency: result.meta?.currency, exchange: result.meta?.exchangeName, fetchedAt: new Date().toISOString() };
    cache.set(key, { at: now, value });
    return value;
  } catch (error) {
    if (cached && now - cached.at < STALE_MS) {
      return { ...cached.value, cache: "stale", warning: error instanceof Error ? error.message : String(error) };
    }
    const message = error instanceof Error ? error.message : String(error);
    logUpstreamError("momentum:yahoo", error, { symbol });
    if (OFFLINE_PRICES_ENABLED) {
      // Live prices are unreachable in this environment. Serve a deterministic,
      // clearly-labelled offline sample so the coverage UI remains functional.
      return { ...offlineYahooResult(symbol), warning: message };
    }
    return { ok: false, symbol, error: message, points: [] };
  }
}

function returnAt(points, sessionsBack) {
  if (!points.length) return undefined;
  const end = points.at(-1)?.close;
  const start = points[Math.max(0, points.length - 1 - sessionsBack)]?.close;
  return Number.isFinite(end) && Number.isFinite(start) && start > 0 ? (end / start - 1) * 100 : undefined;
}

function annualVolatility(points, sessions = 63) {
  const slice = points.slice(-Math.min(points.length, sessions + 1));
  const returns = [];
  for (let index = 1; index < slice.length; index += 1) returns.push(slice[index].close / slice[index - 1].close - 1);
  if (returns.length < 2) return undefined;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function maxDrawdown(points) {
  let peak = -Infinity;
  let worst = 0;
  for (const point of points) {
    peak = Math.max(peak, point.close);
    worst = Math.min(worst, point.close / peak - 1);
  }
  return worst * 100;
}

function marketStats(result) {
  if (!result?.ok) return { ok: false, symbol: result?.symbol, error: result?.error };
  const points = result.points;
  return {
    ok: true,
    symbol: result.symbol,
    offline: result.offline || false,
    priceSource: result.source || null,
    current: points.at(-1)?.close,
    return1mPct: returnAt(points, 21),
    return3mPct: returnAt(points, 63),
    return6mPct: returnAt(points, 126),
    return12mPct: returnAt(points, 252),
    volatility3mPct: annualVolatility(points, 63),
    maxDrawdown1yPct: maxDrawdown(points),
    fetchedAt: result.fetchedAt,
    cache: result.cache,
    points
  };
}

function nearestIndex(points, date) {
  if (!points.length) return -1;
  const target = new Date(date).getTime();
  let bestIndex = 0;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = Math.abs(new Date(point.date).getTime() - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function analyseEvent(event, stats, type) {
  if (!event.symbol) return { ...event, ok: false, error: "No verified Yahoo symbol mapping" };
  if (!stats?.ok || !stats.points?.length) return { ...event, ok: false, error: stats?.error || "Price history unavailable" };
  const index = nearestIndex(stats.points, event.effectiveDate);
  const point = stats.points[index];
  const start = Math.max(0, index - 45);
  const end = Math.min(stats.points.length - 1, index + 45);
  const window = stats.points.slice(start, end + 1);
  const peak = Math.max(...window.map(item => item.close));
  const current = stats.points.at(-1).close;
  const peakProximityPct = peak > 0 ? point.close / peak * 100 : undefined;
  const returnSinceEventPct = point.close > 0 ? (current / point.close - 1) * 100 : undefined;
  return {
    ...event,
    ok: true,
    eventPrice: point.close,
    eventPriceDate: point.date,
    currentPrice: current,
    localPeak: peak,
    peakProximityPct,
    returnSinceEventPct,
    postEventReturnPct: type === "exit" ? returnSinceEventPct : undefined,
    source: "Yahoo Finance"
  };
}

function standardDeviation(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return 0;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  return Math.sqrt(clean.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (clean.length - 1));
}

function classifyRegime(broad, sectors) {
  const three = broad?.return3mPct;
  const six = broad?.return6mPct;
  const dispersion = standardDeviation(sectors.map(item => item.return3mPct));
  if (Number.isFinite(three) && Number.isFinite(six) && three > 5 && six > 8) {
    return { id: "riskOn", label: "risk-on", explanation: "Broad-market three- and six-month momentum are both positive and strong.", dispersionPct: dispersion };
  }
  if ((Number.isFinite(three) && three < -5) || (Number.isFinite(six) && six < -8)) {
    return { id: "riskOff", label: "risk-off", explanation: "Broad-market momentum is materially negative.", dispersionPct: dispersion };
  }
  if (dispersion > 7 && (!Number.isFinite(three) || Math.abs(three) < 7)) {
    return { id: "rotation", label: "sector-rotation", explanation: "Broad momentum is mixed while sector-return dispersion is elevated.", dispersionPct: dispersion };
  }
  return { id: "neutral", label: "neutral / mixed", explanation: "Broad and sector momentum do not meet a strong directional threshold.", dispersionPct: dispersion };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const schemeId = searchParams.get("schemeId")?.trim();
  const snapshot = getMomentumSnapshot(schemeId) || getExtendedMomentumSnapshot(schemeId);
  if (!snapshot) return NextResponse.json({ ok: false, error: "Momentum snapshot is not configured for this scheme." }, { status: 404 });

  const sectorRequests = snapshot.sectorWeights.map(item => ({ sector: item.sector, weight: item.weight, symbol: SECTOR_MARKET_SYMBOLS[item.sector] })).filter(item => item.symbol);
  const uniqueSymbols = [...new Set([
    "^NSEI",
    ...sectorRequests.map(item => item.symbol),
    ...snapshot.holdings.slice(0, 10).map(item => item.symbol),
    ...snapshot.entries.map(item => item.symbol),
    ...snapshot.exits.map(item => item.symbol)
  ].filter(Boolean))];

  const results = await Promise.all(uniqueSymbols.map(async symbol => [symbol, marketStats(await fetchYahoo(symbol))]));
  const statsMap = new Map(results);
  const sectors = sectorRequests.map(item => ({ ...item, ...statsMap.get(item.symbol), points: undefined }));
  const holdings = snapshot.holdings.slice(0, 10).map(item => ({ ...item, ...statsMap.get(item.symbol), points: undefined }));
  const entries = snapshot.entries.map(event => analyseEvent(event, statsMap.get(event.symbol), "entry"));
  const exits = snapshot.exits.map(event => analyseEvent(event, statsMap.get(event.symbol), "exit"));
  const broadStats = statsMap.get("^NSEI");
  const regime = classifyRegime(broadStats, sectors.filter(item => item.ok));
  const resolved = results.filter(([, item]) => item.ok).length;
  const offlineCount = results.filter(([, item]) => item.ok && item.offline).length;
  const priceDataMode = offlineCount === 0
    ? "live"
    : offlineCount === resolved
      ? "offline-sample"
      : "mixed";
  const priceWarning = offlineCount > 0
    ? "Live market prices are not reachable from this environment, so price-derived momentum factors use a deterministic OFFLINE SAMPLE series. These figures are for interface validation only and must not be used for advice."
    : null;

  return NextResponse.json({
    ok: true,
    schemeId,
    asOf: snapshot.asOf,
    snapshot: {
      turnover: snapshot.turnover,
      sectorWeights: snapshot.sectorWeights,
      sectorHistory: snapshot.sectorHistory,
      coverageNote: snapshot.coverageNote,
      netEquityPct: snapshot.netEquityPct,
      grossEquityPct: snapshot.grossEquityPct,
      assetAllocation: snapshot.assetAllocation || [],
      marketCap: snapshot.marketCap || [],
      sectorBasis: "Official AMC factsheet sector and portfolio disclosure",
      factsheetUrl: snapshot.factsheetUrl,
      factsheetLabel: snapshot.factsheetLabel
    },
    priceDataMode,
    priceWarning,
    broadMarket: broadStats ? { ...broadStats, points: undefined } : null,
    regime,
    sectors,
    holdings,
    entries,
    exits,
    coverage: {
      requestedSymbols: uniqueSymbols.length,
      resolvedSymbols: resolved,
      resolvedPct: uniqueSymbols.length ? resolved / uniqueSymbols.length * 100 : 0,
      sectorSeries: sectors.filter(item => item.ok).length,
      entrySeries: entries.filter(item => item.ok).length,
      exitSeries: exits.filter(item => item.ok).length,
      baselineEstablished: !snapshot.entries.length && !snapshot.exits.length
    },
    sources: [
      { name: snapshot.factsheetLabel, type: "Official AMC factsheet", url: snapshot.factsheetUrl, asOf: snapshot.asOf },
      priceDataMode === "live"
        ? { name: "Yahoo Finance", type: "Live stock and sector price histories", asOf: new Date().toISOString() }
        : { name: OFFLINE_PRICE_SOURCE, type: "Deterministic offline price sample (live market data unreachable)", asOf: new Date().toISOString() },
      { name: "MFapi.in / AMFI", type: "Fund and comparison-proxy NAV data", asOf: "live" }
    ],
    fetchedAt: new Date().toISOString()
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
