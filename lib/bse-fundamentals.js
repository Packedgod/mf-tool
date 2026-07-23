import { readJournal, writeJournal, appendObservation, observationNearAge } from '@/lib/snapshot-store';

// BSE publishes per-scrip valuation and profitability on an unauthenticated endpoint and
// is the primary fundamentals source. Yahoo's crumb-gated API throttles server-side
// callers hard enough that it can only be a fallback.
const API = 'https://api.bseindia.com/BseIndiaAPI/api';
const SCRIP_MASTER_TTL_MS = 24 * 60 * 60 * 1000;
const FUNDAMENTAL_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const EPS_JOURNAL = 'bse-eps-history';

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  referer: 'https://www.bseindia.com/',
  origin: 'https://www.bseindia.com',
  accept: 'application/json'
};

function cache() {
  globalThis.__MANAGERLENS_BSE_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_BSE_CACHE__;
}

function masterState() {
  globalThis.__MANAGERLENS_BSE_MASTER__ ??= { at: 0, byTicker: null, byName: null, pending: null };
  return globalThis.__MANAGERLENS_BSE_MASTER__;
}

const number = value => {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : undefined;
};

// Yahoo-style tickers ("RELIANCE.NS") and BSE scrip ids ("RELIANCE") differ only by suffix.
function tickerKey(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/\.(NS|BO|BSE|NSE)$/i, '') || null;
}

// Company names arrive from several scrapers with inconsistent suffixes and punctuation,
// so both sides of the lookup are reduced to the same skeleton before matching.
function nameKey(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/&AMP;/g, '&')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(LIMITED|LTD|COMPANY|CO|CORPORATION|CORP|INDIA|INDIAN|THE|AND)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

async function loadScripMaster() {
  const state = masterState();
  if (state.byTicker && Date.now() - state.at < SCRIP_MASTER_TTL_MS) return state;
  if (state.pending) return state.pending;

  state.pending = (async () => {
    try {
      const url = `${API}/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active`;
      const response = await fetch(url, { headers: HEADERS, cache: 'no-store' });
      if (!response.ok) throw new Error(`BSE scrip master responded ${response.status}.`);
      const rows = await response.json();
      if (!Array.isArray(rows) || !rows.length) throw new Error('BSE scrip master returned no rows.');

      const byTicker = new Map();
      const byName = new Map();
      const byIsin = new Map();
      for (const row of rows) {
        const code = String(row.SCRIP_CD || '').trim();
        if (!code) continue;
        const entry = {
          code,
          isin: String(row.ISIN_NUMBER || '').trim() || null,
          name: String(row.Scrip_Name || '').trim(),
          marketCapCr: number(row.Mktcap)
        };
        const ticker = tickerKey(row.scrip_id);
        if (ticker && !byTicker.has(ticker)) byTicker.set(ticker, entry);
        if (entry.isin && !byIsin.has(entry.isin)) byIsin.set(entry.isin, entry);
        for (const candidate of [nameKey(row.Scrip_Name), nameKey(row.Issuer_Name)]) {
          if (candidate && !byName.has(candidate)) byName.set(candidate, entry);
        }
      }
      state.byTicker = byTicker;
      state.byName = byName;
      state.byIsin = byIsin;
      state.at = Date.now();
      return state;
    } catch {
      // Keep any previously loaded master rather than blanking every holding on one
      // failed refresh; only a cold start is left unresolved.
      state.at = Date.now() - SCRIP_MASTER_TTL_MS + 60_000;
      return state;
    } finally {
      state.pending = null;
    }
  })();
  return state.pending;
}

async function resolveScrip({ symbol, name }) {
  const state = await loadScripMaster();
  if (!state.byTicker) return null;
  const ticker = tickerKey(symbol);
  if (ticker && state.byTicker.has(ticker)) return state.byTicker.get(ticker);
  const key = nameKey(name);
  if (key && state.byName.has(key)) return state.byName.get(key);
  return null;
}

// Diversified groups report most of their economics through subsidiaries, so consolidated
// figures are preferred and standalone is only used when consolidated is absent.
function shape(entry, header, growth) {
  const trailingPe = number(header.ConPE) ?? number(header.PE);
  const eps = number(header.ConEPS) ?? number(header.EPS);
  const priceToBook = number(header.PB);
  const returnOnEquityPct = number(header.ROE);
  const profitMarginPct = number(header.NPM);
  const operatingMarginPct = number(header.OPM);

  const fields = [trailingPe, priceToBook, returnOnEquityPct, profitMarginPct, operatingMarginPct];
  const completeness = fields.filter(Number.isFinite).length / fields.length * 100;

  return {
    symbol: entry.name,
    scripCode: entry.code,
    isin: entry.isin,
    trailingPe,
    forwardPe: undefined,
    priceToBook,
    returnOnEquityPct,
    profitMarginPct,
    operatingMarginPct,
    earningsGrowthPct: growth?.earningsGrowthPct,
    revenueGrowthPct: undefined,
    // BSE's quote header carries no balance-sheet gearing or liquidity ratios; these stay
    // undefined so the factors that need them report reduced coverage instead of guessing.
    debtToEquity: undefined,
    currentRatio: undefined,
    eps,
    marketCapCr: entry.marketCapCr,
    sector: String(header.Sector || '').trim() || undefined,
    industry: String(header.IndustryNew || header.Industry || '').trim() || undefined,
    completeness,
    ok: completeness > 0,
    growthBasis: growth?.basis,
    source: 'BSE India quote header',
    fetchedAt: new Date().toISOString()
  };
}

async function fetchHeader(entry) {
  const url = `${API}/ComHeadernew/w?quotetype=EQ&scripcode=${encodeURIComponent(entry.code)}&seriesid=`;
  const response = await fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!response.ok) throw new Error(`BSE quote header responded ${response.status}.`);
  const header = await response.json();
  if (!header || typeof header !== 'object') throw new Error('BSE returned no quote header.');
  return header;
}

// BSE exposes trailing EPS but no growth rate, and its results endpoints are not public.
// Banking EPS on every refresh makes year-on-year growth computable once the journal spans
// a year; until then earnings momentum honestly reports itself as unavailable.
async function updateEpsJournal(entries) {
  const journal = await readJournal(EPS_JOURNAL, {});
  const today = new Date().toISOString().slice(0, 10);
  const growth = new Map();
  let changed = false;

  for (const { entry, eps } of entries) {
    const key = entry.isin || `BSE:${entry.code}`;
    const series = journal[key] || [];
    if (Number.isFinite(eps)) {
      const next = appendObservation(series, { date: today, eps });
      if (next !== series) {
        journal[key] = next;
        changed = true;
      }
    }

    const history = journal[key] || [];
    const yearAgo = observationNearAge(history, 365, 75);
    if (yearAgo && Number.isFinite(eps) && Number.isFinite(yearAgo.eps) && yearAgo.eps > 0) {
      growth.set(entry.code, {
        earningsGrowthPct: (eps - yearAgo.eps) / yearAgo.eps * 100,
        basis: `BSE EPS journal, ${yearAgo.date} to ${today}`
      });
    }
  }

  if (changed) await writeJournal(EPS_JOURNAL, journal);
  return growth;
}

// Accepts the holding rows the portfolio pipeline already produces, so both the ticker and
// the disclosed company name are available for resolution.
export async function fetchBseFundamentals(holdings, concurrency = 6) {
  const wanted = (holdings || [])
    .map(item => (typeof item === 'string' ? { symbol: item, name: item } : { symbol: item?.symbol, name: item?.name }))
    .filter(item => item.symbol || item.name);
  if (!wanted.length) return new Map();

  const store = cache();
  const out = new Map();
  const pendingJournal = [];
  const queue = [];

  for (const item of wanted) {
    const id = item.symbol || item.name;
    const cached = store.get(id);
    if (cached && Date.now() - cached.at < (cached.value.ok ? FUNDAMENTAL_TTL_MS : FAILURE_TTL_MS)) {
      if (cached.value.ok) out.set(id, cached.value);
      continue;
    }
    queue.push({ id, item });
  }

  let cursor = 0;
  const resolved = [];
  async function worker() {
    while (cursor < queue.length) {
      const { id, item } = queue[cursor];
      cursor += 1;
      try {
        const entry = await resolveScrip(item);
        if (!entry) throw new Error('No BSE listing matched this holding.');
        const header = await fetchHeader(entry);
        resolved.push({ id, entry, header });
      } catch (error) {
        store.set(id, {
          at: Date.now(),
          value: { ok: false, completeness: 0, error: error instanceof Error ? error.message : String(error), source: 'BSE India quote header' }
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  for (const row of resolved) {
    pendingJournal.push({ entry: row.entry, eps: number(row.header.ConEPS) ?? number(row.header.EPS) });
  }
  const growth = await updateEpsJournal(pendingJournal);

  for (const { id, entry, header } of resolved) {
    const value = shape(entry, header, growth.get(entry.code));
    store.set(id, { at: Date.now(), value });
    if (value.ok) out.set(id, value);
  }
  return out;
}

// Exposes the scrip master's market-cap and identifier maps so index weights can be
// derived without a second download of the same 1.7MB file.
export async function scripMaster() {
  const state = await loadScripMaster();
  return state.byTicker ? { byTicker: state.byTicker, byName: state.byName, byIsin: state.byIsin } : null;
}

export const __testing = { tickerKey, nameKey };
