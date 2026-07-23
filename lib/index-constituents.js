import { scripMaster } from '@/lib/bse-fundamentals';

// Active Share and Brinson attribution both need benchmark *weights*, not just membership.
// NSE publishes constituent lists free but not their weights, and the weight files behind
// niftyindices.com are not openly reachable. Weights are therefore reconstructed from
// constituent market capitalisation.
//
// This is an approximation: NSE indices weight by *free-float* market cap, so promoter- and
// government-heavy companies come out overweighted here. Everything derived from these
// weights is labelled approximate and carries a confidence haircut rather than being
// presented as the published index weighting.
const ARCHIVE = 'https://nsearchives.nseindia.com/content/indices';
const TTL_MS = 24 * 60 * 60 * 1000;

// Below this share of disclosed portfolio weight, Active Share is dominated by what the
// source omitted rather than by the manager's actual positioning.
const MIN_DISCLOSED_WEIGHT_PCT = 70;

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept: 'text/csv,*/*'
};

export const INDEX_FILES = {
  'nifty-50': { file: 'ind_nifty50list.csv', label: 'NIFTY 50' },
  'nifty-100': { file: 'ind_nifty100list.csv', label: 'NIFTY 100' },
  'nifty-200': { file: 'ind_nifty200list.csv', label: 'NIFTY 200' },
  'nifty-500': { file: 'ind_nifty500list.csv', label: 'NIFTY 500' },
  'nifty-midcap-150': { file: 'ind_niftymidcap150list.csv', label: 'NIFTY Midcap 150' },
  'nifty-smallcap-250': { file: 'ind_niftysmallcap250list.csv', label: 'NIFTY Smallcap 250' },
  'nifty-next-50': { file: 'ind_niftynext50list.csv', label: 'NIFTY Next 50' }
};

function cache() {
  globalThis.__MANAGERLENS_INDEX_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_INDEX_CACHE__;
}

// The archive files are plain comma-separated with quoted company names.
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  const header = splitRow(lines[0]).map(cell => cell.toLowerCase().trim());
  const nameAt = header.findIndex(cell => cell.includes('company'));
  const industryAt = header.findIndex(cell => cell.includes('industry'));
  const symbolAt = header.findIndex(cell => cell === 'symbol');
  const isinAt = header.findIndex(cell => cell.includes('isin'));
  if (symbolAt < 0 || isinAt < 0) return [];

  return lines.slice(1).map(line => {
    const cells = splitRow(line);
    return {
      name: (cells[nameAt] || '').trim(),
      industry: (cells[industryAt] || '').trim() || 'Unclassified',
      symbol: (cells[symbolAt] || '').trim(),
      isin: (cells[isinAt] || '').trim()
    };
  }).filter(row => row.symbol && row.isin);
}

function splitRow(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

export function indexIdForBenchmark(text) {
  const value = String(text || '').toLowerCase();
  if (/smallcap|small cap/.test(value)) return 'nifty-smallcap-250';
  if (/midcap|mid cap/.test(value)) return 'nifty-midcap-150';
  if (/next\s*50/.test(value)) return 'nifty-next-50';
  if (/\b500\b/.test(value)) return 'nifty-500';
  if (/\b200\b/.test(value)) return 'nifty-200';
  if (/\b100\b/.test(value)) return 'nifty-100';
  if (/nifty\s*50|sensex|large\s*cap|largecap/.test(value)) return 'nifty-50';
  return 'nifty-500';
}

// Returns constituents with approximate weights, plus the share of the index by count that
// could be priced — callers use it to decide whether the weighting is trustworthy enough.
export async function indexConstituents(indexId = 'nifty-500') {
  const spec = INDEX_FILES[indexId] || INDEX_FILES['nifty-500'];
  const store = cache();
  const cached = store.get(indexId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  try {
    const response = await fetch(`${ARCHIVE}/${spec.file}`, { headers: HEADERS, cache: 'no-store' });
    if (!response.ok) throw new Error(`NSE index archive responded ${response.status}.`);
    const rows = parseCsv(await response.text());
    if (!rows.length) throw new Error('NSE index archive returned no constituents.');

    const master = await scripMaster();
    const members = rows.map(row => {
      const entry = master?.byIsin?.get(row.isin) || null;
      return { ...row, marketCapCr: entry?.marketCapCr };
    });

    const priced = members.filter(row => Number.isFinite(row.marketCapCr) && row.marketCapCr > 0);
    const totalCap = priced.reduce((sum, row) => sum + row.marketCapCr, 0);
    for (const row of members) {
      row.weightPct = totalCap && Number.isFinite(row.marketCapCr) ? row.marketCapCr / totalCap * 100 : undefined;
    }

    const value = {
      id: indexId,
      label: spec.label,
      members,
      coverage: {
        constituents: members.length,
        priced: priced.length,
        pricedPct: members.length ? priced.length / members.length * 100 : 0
      },
      basis: 'NSE published constituents weighted by BSE full market capitalisation (approximates the index free-float weighting)',
      approximate: true,
      fetchedAt: new Date().toISOString()
    };
    store.set(indexId, { at: Date.now(), value });
    return value;
  } catch (error) {
    const value = { id: indexId, label: spec.label, members: [], coverage: { constituents: 0, priced: 0, pricedPct: 0 }, error: error instanceof Error ? error.message : String(error) };
    store.set(indexId, { at: Date.now() - TTL_MS + 5 * 60 * 1000, value });
    return value;
  }
}

// SEBI defines large/mid/small by market-capitalisation rank (top 100, next 150, the rest),
// which is exactly what the NIFTY 100 and Midcap 150 constituent lists encode. Classifying
// the disclosed book against them yields a real market-cap split for funds whose source
// publishes none — including sectoral and thematic schemes, which have no mandated split to
// fall back on and were therefore left unscored entirely.
export async function marketCapSplit(holdings) {
  const rows = (holdings || [])
    .map(item => ({ weight: Number(item.weight), item }))
    .filter(row => Number.isFinite(row.weight) && row.weight > 0);
  if (!rows.length) return null;

  const [large, mid] = await Promise.all([
    indexConstituents('nifty-100'),
    indexConstituents('nifty-midcap-150')
  ]);
  if (!large.members?.length && !mid.members?.length) return null;

  const key = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const indexOf = members => {
    const byIsin = new Map();
    const byTicker = new Map();
    const byName = new Map();
    for (const m of members || []) {
      if (m.isin) byIsin.set(m.isin, m);
      if (m.symbol) byTicker.set(key(m.symbol), m);
      if (m.name) byName.set(key(m.name.replace(/\b(ltd|limited|india|the)\b/gi, '')), m);
    }
    return { byIsin, byTicker, byName };
  };
  const L = indexOf(large.members);
  const M = indexOf(mid.members);

  const lookup = (idx, item) => {
    const isin = item.fundamentals?.isin || item.isin;
    return (isin && idx.byIsin.get(isin))
      || idx.byTicker.get(key(String(item.symbol || '').replace(/\.(NS|BO)$/i, '')))
      || idx.byName.get(key(String(item.name || '').replace(/\b(ltd|limited|india|the)\b/gi, '')));
  };

  let largeW = 0, midW = 0, smallW = 0, classified = 0;
  for (const { weight, item } of rows) {
    if (lookup(L, item)) { largeW += weight; classified += weight; }
    else if (lookup(M, item)) { midW += weight; classified += weight; }
    else if (item.fundamentals?.marketCapCr) {
      // Priced but outside both indices: genuinely small-cap by rank.
      smallW += weight;
      classified += weight;
    }
  }

  const total = largeW + midW + smallW;
  if (!total) return null;
  const disclosed = rows.reduce((sum, row) => sum + row.weight, 0);
  return {
    largePct: largeW / total * 100,
    midPct: midW / total * 100,
    smallPct: smallW / total * 100,
    classifiedWeightPct: disclosed ? classified / disclosed * 100 : 0,
    basis: 'holdings classified against NSE index membership (NIFTY 100 = large, Midcap 150 = mid, remainder small)'
  };
}

export async function benchmarkSectorWeights(indexId) {
  const index = await indexConstituents(indexId);
  const totals = new Map();
  for (const row of index.members) {
    if (!Number.isFinite(row.weightPct)) continue;
    totals.set(row.industry, (totals.get(row.industry) || 0) + row.weightPct);
  }
  return { index, weights: totals };
}

// Active Share is half the sum of absolute active weights. A fund holding is matched to the
// benchmark by ISIN first, then ticker, then normalised name.
//
// Disclosed portfolios are usually truncated to the top holdings, so the fund's own weights
// are renormalised over what is disclosed, and `disclosedWeightPct` reports how much of the
// portfolio the figure actually rests on.
export function activeShare(holdings, index) {
  if (!index?.members?.length) return null;

  const byIsin = new Map();
  const byTicker = new Map();
  const byName = new Map();
  const key = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  for (const member of index.members) {
    if (!Number.isFinite(member.weightPct)) continue;
    if (member.isin) byIsin.set(member.isin, member);
    if (member.symbol) byTicker.set(key(member.symbol), member);
    if (member.name) byName.set(key(member.name.replace(/\b(ltd|limited|india|the)\b/gi, '')), member);
  }

  const rows = (holdings || [])
    .map(item => ({ weight: Number(item.weight), item }))
    .filter(row => Number.isFinite(row.weight) && row.weight > 0);
  if (!rows.length) return null;

  const disclosedWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (disclosedWeight <= 0) return null;

  const matchedBenchmark = new Set();
  let activeSum = 0;
  let matchedCount = 0;

  for (const { weight, item } of rows) {
    const isin = item.fundamentals?.isin || item.isin;
    const member =
      (isin && byIsin.get(isin)) ||
      byTicker.get(key(String(item.symbol || '').replace(/\.(NS|BO)$/i, ''))) ||
      byName.get(key(String(item.name || '').replace(/\b(ltd|limited|india|the)\b/gi, '')));

    const fundWeight = weight / disclosedWeight * 100;
    const benchWeight = member ? member.weightPct : 0;
    if (member) {
      matchedBenchmark.add(member.isin);
      matchedCount += 1;
    }
    activeSum += Math.abs(fundWeight - benchWeight);
  }

  // Benchmark constituents the fund does not hold at all also contribute active weight.
  for (const member of index.members) {
    if (!Number.isFinite(member.weightPct) || matchedBenchmark.has(member.isin)) continue;
    activeSum += member.weightPct;
  }

  // Active Share is only meaningful against a substantially complete portfolio. When a
  // source discloses just the top handful of names, the fund's weights are renormalised
  // upward and every undisclosed benchmark constituent counts as a full underweight, both
  // of which push the number toward 100% regardless of how active the manager really is.
  const sufficientDisclosure = disclosedWeight >= MIN_DISCLOSED_WEIGHT_PCT;

  return {
    activeSharePct: Math.min(100, activeSum / 2),
    matchedHoldings: matchedCount,
    holdingsConsidered: rows.length,
    disclosedWeightPct: disclosedWeight,
    sufficientDisclosure,
    insufficientReason: sufficientDisclosure
      ? null
      : `Only ${disclosedWeight.toFixed(0)}% of portfolio weight is disclosed by the available source; Active Share needs at least ${MIN_DISCLOSED_WEIGHT_PCT}%.`,
    approximate: true,
    basis: index.basis
  };
}
