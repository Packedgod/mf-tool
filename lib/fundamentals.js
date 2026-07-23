import { fetchBseFundamentals } from '@/lib/bse-fundamentals';
import { fetchYahooFundamentals } from '@/lib/yahoo-fundamentals';

export { weightedFundamental } from '@/lib/fundamental-weighting';

// Provider order is deliberate. FMP is authoritative when a key is configured, BSE is the
// dependable unauthenticated source for Indian listings, and Yahoo only fills gaps because
// its crumb endpoint throttles server-side callers to the point of being unusable alone.
async function fetchFromFmp(symbols) {
  const key = process.env.FMP_API_KEY;
  if (!key || !symbols.length) return new Map();
  const out = new Map();
  const list = symbols.join(',');
  try {
    const [metricsResponse, ratiosResponse] = await Promise.all([
      fetch(`https://financialmodelingprep.com/api/v3/key-metrics-ttm/${encodeURIComponent(list)}?apikey=${encodeURIComponent(key)}`, { cache: 'no-store' }),
      fetch(`https://financialmodelingprep.com/api/v3/ratios-ttm/${encodeURIComponent(list)}?apikey=${encodeURIComponent(key)}`, { cache: 'no-store' })
    ]);
    if (!metricsResponse.ok || !ratiosResponse.ok) return out;
    const metrics = await metricsResponse.json();
    const ratios = await ratiosResponse.json();

    const bySymbol = new Map();
    for (const row of Array.isArray(metrics) ? metrics : []) bySymbol.set(row.symbol, { ...(bySymbol.get(row.symbol) || {}), ...row });
    for (const row of Array.isArray(ratios) ? ratios : []) bySymbol.set(row.symbol, { ...(bySymbol.get(row.symbol) || {}), ...row });

    for (const [symbol, row] of bySymbol) {
      const value = {
        symbol,
        trailingPe: Number(row.peRatioTTM) || undefined,
        priceToBook: Number(row.pbRatioTTM ?? row.priceToBookRatioTTM) || undefined,
        returnOnEquityPct: Number.isFinite(Number(row.roeTTM)) ? Number(row.roeTTM) * 100 : undefined,
        profitMarginPct: Number.isFinite(Number(row.netProfitMarginTTM)) ? Number(row.netProfitMarginTTM) * 100 : undefined,
        operatingMarginPct: Number.isFinite(Number(row.operatingProfitMarginTTM)) ? Number(row.operatingProfitMarginTTM) * 100 : undefined,
        debtToEquity: Number.isFinite(Number(row.debtToEquityTTM)) ? Number(row.debtToEquityTTM) * 100 : undefined,
        currentRatio: Number(row.currentRatioTTM) || undefined,
        source: 'Financial Modeling Prep TTM ratios'
      };
      const fields = [value.trailingPe, value.priceToBook, value.returnOnEquityPct, value.profitMarginPct, value.debtToEquity];
      value.completeness = fields.filter(Number.isFinite).length / fields.length * 100;
      value.ok = value.completeness > 0;
      if (value.ok) out.set(symbol, value);
    }
  } catch {
    return out;
  }
  return out;
}

// Later providers only add fields the earlier ones left undefined, so a fallback can raise
// coverage without overwriting a more trustworthy source's numbers.
function merge(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const merged = { ...primary };
  let added = false;
  for (const field of ['trailingPe', 'forwardPe', 'priceToBook', 'returnOnEquityPct', 'profitMarginPct', 'operatingMarginPct', 'earningsGrowthPct', 'revenueGrowthPct', 'debtToEquity', 'currentRatio', 'marketCapCr']) {
    if (!Number.isFinite(merged[field]) && Number.isFinite(secondary[field])) {
      merged[field] = secondary[field];
      added = true;
    }
  }
  if (added) merged.source = `${primary.source} + ${secondary.source}`;
  const fields = [merged.trailingPe, merged.priceToBook, merged.returnOnEquityPct, merged.profitMarginPct, merged.debtToEquity];
  merged.completeness = fields.filter(Number.isFinite).length / fields.length * 100;
  merged.ok = merged.completeness > 0;
  return merged;
}

// Accepts holding rows (or bare symbols) and returns a map keyed by the holding's symbol
// when it has one, falling back to its disclosed name.
export async function fetchFundamentals(holdings, concurrency = 6) {
  const rows = (holdings || [])
    .map(item => (typeof item === 'string' ? { symbol: item, name: item } : { symbol: item?.symbol || null, name: item?.name || null }))
    .filter(item => item.symbol || item.name);
  if (!rows.length) return new Map();

  const keyed = new Map();
  for (const row of rows) keyed.set(row.symbol || row.name, row);

  const out = new Map();
  const symbols = [...keyed.values()].map(row => row.symbol).filter(Boolean);

  for (const [symbol, value] of await fetchFromFmp(symbols)) {
    if (keyed.has(symbol)) out.set(symbol, value);
  }

  const needBse = [...keyed.entries()].filter(([id]) => !out.get(id)?.ok).map(([, row]) => row);
  const bse = await fetchBseFundamentals(needBse, concurrency);
  for (const [id, value] of bse) out.set(id, merge(out.get(id), value));

  // Yahoo is asked only for rows still missing gearing or liquidity, which BSE's quote
  // header never carries, and only when it is not already known to be throttled.
  const needYahoo = [...keyed.entries()]
    .filter(([id, row]) => row.symbol && (!out.get(id)?.ok || !Number.isFinite(out.get(id)?.debtToEquity)))
    .map(([id, row]) => ({ id, symbol: row.symbol }));
  if (needYahoo.length) {
    const yahoo = await fetchYahooFundamentals(needYahoo.map(row => row.symbol), 4);
    for (const { id, symbol } of needYahoo) {
      const value = yahoo.get(symbol);
      if (value?.ok) out.set(id, merge(out.get(id), value));
    }
  }

  for (const [id, value] of [...out]) if (!value?.ok) out.delete(id);
  return out;
}
