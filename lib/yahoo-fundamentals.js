const CRUMB_TTL_MS = 30 * 60 * 1000;
const FUNDAMENTAL_TTL_MS = 12 * 60 * 60 * 1000;
// Failures are usually throttling rather than a missing security, so they expire fast
// instead of blanking the factor for the rest of the day.
const FAILURE_TTL_MS = 4 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MODULES = 'defaultKeyStatistics,financialData,summaryDetail';

function cache() {
  globalThis.__MANAGERLENS_FUNDAMENTALS_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_FUNDAMENTALS_CACHE__;
}

function session() {
  globalThis.__MANAGERLENS_YAHOO_SESSION__ ??= { crumb: null, cookie: null, at: 0 };
  return globalThis.__MANAGERLENS_YAHOO_SESSION__;
}

const num = value => {
  const raw = value && typeof value === 'object' ? value.raw : value;
  return Number.isFinite(Number(raw)) ? Number(raw) : undefined;
};

async function establishSession() {
  const active = session();
  if (active.crumb && Date.now() - active.at < CRUMB_TTL_MS) return active;
  // Without this, every symbol in a batch independently retries a failing handshake
  // and deepens the throttling that caused it.
  if (active.failedAt && Date.now() - active.failedAt < FAILURE_TTL_MS) {
    throw new Error('Yahoo fundamentals handshake is throttled; skipping until it recovers.');
  }
  active.pending ??= null;
  if (active.pending) return active.pending;
  active.pending = handshake(active).finally(() => { active.pending = null; });
  return active.pending;
}

async function handshake(active) {
  try {
    const seed = await fetch('https://fc.yahoo.com', {
      headers: { 'user-agent': USER_AGENT },
      cache: 'no-store'
    }).catch(() => null);

    const cookie = (seed?.headers?.getSetCookie?.() || [])
      .map(entry => entry.split(';')[0])
      .join('; ');
    if (!cookie) throw new Error('Yahoo did not issue a session cookie.');

    const response = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'user-agent': USER_AGENT, cookie },
      cache: 'no-store'
    });
    const crumb = (await response.text()).trim();
    // A real crumb is a short opaque token. Yahoo returns prose ("Too Many Requests",
    // "Invalid Cookie") with a 200 when it throttles, so anything with whitespace or
    // punctuation is a rejection rather than a credential.
    if (!crumb || crumb.length > 24 || !/^[A-Za-z0-9._/=+-]+$/.test(crumb)) {
      throw new Error(`Yahoo did not issue a usable crumb (received "${crumb.slice(0, 40)}").`);
    }

    active.crumb = crumb;
    active.cookie = cookie;
    active.at = Date.now();
    active.failedAt = 0;
    return active;
  } catch (error) {
    active.crumb = null;
    active.failedAt = Date.now();
    throw error;
  }
}

function shape(symbol, result) {
  const stats = result?.defaultKeyStatistics || {};
  const financial = result?.financialData || {};
  const summary = result?.summaryDetail || {};

  const trailingPe = num(summary.trailingPE);
  const forwardPe = num(summary.forwardPE) ?? num(stats.forwardPE);
  const priceToBook = num(stats.priceToBook);
  const returnOnEquityPct = num(financial.returnOnEquity) === undefined ? undefined : num(financial.returnOnEquity) * 100;
  const profitMarginPct = num(stats.profitMargins) === undefined ? undefined : num(stats.profitMargins) * 100;
  const earningsGrowthPct = num(financial.earningsGrowth) === undefined ? undefined : num(financial.earningsGrowth) * 100;
  const revenueGrowthPct = num(financial.revenueGrowth) === undefined ? undefined : num(financial.revenueGrowth) * 100;
  const debtToEquity = num(financial.debtToEquity);
  const marketCapCr = num(summary.marketCap) === undefined ? undefined : num(summary.marketCap) / 1e7;

  const fields = [trailingPe, priceToBook, returnOnEquityPct, earningsGrowthPct, debtToEquity];
  const completeness = fields.filter(value => Number.isFinite(value)).length / fields.length * 100;

  return {
    symbol,
    trailingPe,
    forwardPe,
    priceToBook,
    returnOnEquityPct,
    profitMarginPct,
    earningsGrowthPct,
    revenueGrowthPct,
    debtToEquity,
    marketCapCr,
    currentRatio: num(financial.currentRatio),
    completeness,
    ok: completeness > 0,
    source: 'Yahoo Finance quoteSummary',
    fetchedAt: new Date().toISOString()
  };
}

async function fetchOne(symbol) {
  const store = cache();
  const cached = store.get(symbol);
  if (cached && Date.now() - cached.at < (cached.value.ok ? FUNDAMENTAL_TTL_MS : FAILURE_TTL_MS)) return cached.value;

  try {
    const { crumb, cookie } = await establishSession();
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
      + `?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`;
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, cookie },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Yahoo fundamentals responded ${response.status}.`);
    const payload = await response.json();
    const result = payload?.quoteSummary?.result?.[0];
    if (!result) throw new Error('Yahoo returned no fundamentals for this symbol.');
    const value = shape(symbol, result);
    store.set(symbol, { at: Date.now(), value });
    return value;
  } catch (error) {
    const value = {
      symbol,
      ok: false,
      completeness: 0,
      error: error instanceof Error ? error.message : String(error),
      source: 'Yahoo Finance quoteSummary'
    };
    store.set(symbol, { at: Date.now(), value });
    return value;
  }
}

export async function fetchYahooFundamentals(symbols, concurrency = 4) {
  const unique = [...new Set((symbols || []).filter(Boolean))];
  if (!unique.length) return new Map();

  const out = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const symbol = unique[cursor];
      cursor += 1;
      out.set(symbol, await fetchOne(symbol));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  return out;
}
