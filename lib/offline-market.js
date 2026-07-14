// Offline deterministic price-series generator.
//
// IMPORTANT: This is NOT market data. It exists only so the momentum-coverage
// UI can be exercised and visualised in environments where live price sources
// (Yahoo Finance) are unreachable (e.g. sandboxes with a restricted network
// allowlist). Every series produced here is tagged `offline: true` and a
// human-readable `source` making clear it is a synthetic sample. It must never
// be used to inform investment decisions.

export const OFFLINE_PRICE_SOURCE =
  "Offline deterministic sample — NOT live market data";

// Small deterministic PRNG (mulberry32) seeded from the symbol string so the
// same symbol always yields the same series (stable across reloads/requests).
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rough, symbol-stable baseline so index symbols and stocks look sane.
function baseLevel(symbol) {
  const h = hashString(symbol);
  if (symbol.startsWith("^")) return 15000 + (h % 30000); // index-like
  return 200 + (h % 3800); // stock-like
}

// Slight symbol-stable drift/vol so different symbols behave differently and
// the regime classifier has real dispersion to work with.
function driftVol(symbol) {
  const rnd = mulberry32(hashString(symbol + "|params"));
  const isIndex = symbol.startsWith("^");
  // Center drift mildly positive; keep it in a plausible equity range.
  const annualDrift = 0.04 + (rnd() - 0.4) * 0.18; // ~ -3%..+13% annual
  const annualVol = isIndex
    ? 0.10 + rnd() * 0.06 // indices 10%..16%
    : 0.16 + rnd() * 0.12; // stocks 16%..28%
  return { annualDrift, annualVol };
}

/**
 * Build a deterministic ~1y (default 252 sessions) daily price series for a
 * symbol. Returns the same shape the live Yahoo path produces downstream.
 */
export function offlinePriceSeries(symbol, sessions = 252) {
  const rnd = mulberry32(hashString(symbol + "|walk"));
  const { annualDrift, annualVol } = driftVol(symbol);
  const dailyDrift = annualDrift / 252;
  const dailyVol = annualVol / Math.sqrt(252);

  let level = baseLevel(symbol);
  const points = [];
  const today = new Date();
  for (let i = sessions - 1; i >= 0; i -= 1) {
    // Box-Muller for a normal shock.
    const u1 = Math.max(rnd(), 1e-9);
    const u2 = rnd();
    const shock = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    level = level * (1 + dailyDrift + dailyVol * shock);
    if (!Number.isFinite(level) || level <= 0) level = baseLevel(symbol);
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    points.push({ date: d.toISOString().slice(0, 10), close: Number(level.toFixed(2)) });
  }
  return points;
}

/**
 * Offline replacement for the live fetchYahoo result. Tagged so callers and the
 * response payload can surface that the data is synthetic.
 */
export function offlineYahooResult(symbol) {
  const points = offlinePriceSeries(symbol);
  return {
    ok: true,
    offline: true,
    symbol,
    points,
    currency: "INR",
    exchange: "OFFLINE-SAMPLE",
    source: OFFLINE_PRICE_SOURCE,
    fetchedAt: new Date().toISOString()
  };
}
