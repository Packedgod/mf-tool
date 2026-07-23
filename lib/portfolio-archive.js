import { readJournal, writeJournal } from '@/lib/snapshot-store';

// SEBI requires every AMC to publish a month-end scheme portfolio, and the existing
// document pipeline already parses those workbooks. Until now each snapshot was fetched
// per request and thrown away, so the app almost never had two *dated* portfolios for the
// same scheme — which is exactly what turnover, entry/exit attribution and trading-execution
// scoring depend on.
//
// This archive keeps one row per scheme per disclosure month. History therefore accumulates
// from first use, and cannot be backfilled from any free source, so archiving starts as
// early in the pipeline as possible.
const INDEX = 'portfolio-archive-index';
const MAX_MONTHS_PER_SCHEME = 24;
const MAX_HOLDINGS_PER_SNAPSHOT = 120;

function journalFor(schemeCode) {
  return `portfolio-${String(schemeCode).replace(/[^0-9a-z]/gi, '')}`;
}

// Disclosures are month-end documents, so the month is the natural key: two files from the
// same month are the same observation, however they were discovered.
function monthKey(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : null;
}

// Only the fields the scoring engine actually consumes are stored, so a scheme's archive
// stays small enough to keep many months of history.
function compactHolding(item) {
  const row = {
    n: item.name,
    w: Number(item.weight)
  };
  if (item.isin) row.i = item.isin;
  if (item.sector && item.sector !== 'Unclassified') row.s = item.sector;
  if (item.rating) row.r = item.rating;
  if (Number.isFinite(item.ytmPct)) row.y = item.ytmPct;
  if (Number.isFinite(item.quantity)) row.q = item.quantity;
  return row;
}

function expandHolding(row) {
  return {
    name: row.n,
    weight: row.w,
    isin: row.i || null,
    sector: row.s || 'Unclassified',
    rating: row.r || null,
    ytmPct: Number.isFinite(row.y) ? row.y : undefined,
    quantity: Number.isFinite(row.q) ? row.q : undefined
  };
}

export async function archiveSnapshot(schemeCode, snapshot) {
  const month = monthKey(snapshot?.asOf);
  const holdings = (snapshot?.holdings || []).filter(item => item?.name && Number.isFinite(Number(item.weight)));
  if (!schemeCode || !month || !holdings.length) return null;

  const name = journalFor(schemeCode);
  const archive = await readJournal(name, { schemeCode: String(schemeCode), months: {} });
  const existing = archive.months[month];

  // A richer disclosure supersedes a thinner one for the same month; otherwise the first
  // observation is kept so archives stay stable.
  //
  // Quality is judged on the share of portfolio weight covered, not the number of rows. A
  // sixty-line book covering half the portfolio is worse evidence than a twelve-line book
  // covering all of it, because every downstream concentration and Active Share test is
  // gated on disclosed weight. Row count only breaks ties.
  const quality = (weight, rows, hasIsin) => weight * 1000 + rows + (hasIsin ? 100_000 : 0);
  const incomingWeight = holdings.reduce((sum, item) => sum + Number(item.weight), 0);
  const incomingQuality = quality(incomingWeight, holdings.length, holdings.some(item => item.isin));
  const existingQuality = existing
    ? quality(existing.h.reduce((sum, row) => sum + Number(row.w), 0), existing.h.length, existing.h.some(row => row.i))
    : -1;
  if (existing && existingQuality >= incomingQuality) return archive;

  archive.schemeCode = String(schemeCode);
  archive.months[month] = {
    asOf: snapshot.asOf,
    source: snapshot.source || snapshot.provider || null,
    url: snapshot.url || null,
    archivedAt: new Date().toISOString(),
    h: holdings
      .slice()
      .sort((a, b) => Number(b.weight) - Number(a.weight))
      .slice(0, MAX_HOLDINGS_PER_SNAPSHOT)
      .map(compactHolding)
  };

  for (const stale of Object.keys(archive.months).sort().slice(0, -MAX_MONTHS_PER_SCHEME)) {
    delete archive.months[stale];
  }

  await writeJournal(name, archive);
  await touchIndex(String(schemeCode), Object.keys(archive.months).length);
  return archive;
}

async function touchIndex(schemeCode, months) {
  const index = await readJournal(INDEX, { schemes: {} });
  index.schemes[schemeCode] = { months, updatedAt: new Date().toISOString() };
  await writeJournal(INDEX, index);
}

// The most complete book the archive holds for this scheme, newest month first. Upstream
// sources degrade unpredictably — a throttled request returns a top-5 summary instead of the
// full portfolio — so the archive is the app's memory of the best disclosure it has seen.
export async function bestRecentSnapshot(schemeCode, { withinMonths = 4 } = {}) {
  if (!schemeCode) return null;
  const archive = await readJournal(journalFor(schemeCode), { months: {} });
  const months = Object.keys(archive.months || {}).sort().reverse();
  if (!months.length) return null;

  const now = new Date();
  const cutoff = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  for (const month of months) {
    if (monthsBetween(month, cutoff) > withinMonths) break;
    const entry = archive.months[month];
    const weight = entry.h.reduce((sum, row) => sum + (Number(row.w) || 0), 0);
    return {
      month,
      asOf: entry.asOf,
      source: entry.source,
      url: entry.url,
      weight,
      holdings: entry.h.map(expandHolding)
    };
  }
  return null;
}

export async function archivedMonths(schemeCode) {
  if (!schemeCode) return [];
  const archive = await readJournal(journalFor(schemeCode), { months: {} });
  return Object.keys(archive.months || {}).sort();
}

// The most recent archived snapshot strictly older than `beforeMonth`, with `minGapMonths`
// of separation so a comparison is not made against a near-identical adjacent disclosure.
export async function previousSnapshot(schemeCode, beforeAsOf, { minGapMonths = 1 } = {}) {
  if (!schemeCode) return null;
  const archive = await readJournal(journalFor(schemeCode), { months: {} });
  const current = monthKey(beforeAsOf);
  const months = Object.keys(archive.months || {}).sort();
  if (!months.length) return null;

  const candidates = current
    ? months.filter(month => monthsBetween(month, current) >= minGapMonths)
    : months.slice(0, -1);
  const chosen = candidates[candidates.length - 1];
  if (!chosen) return null;

  const entry = archive.months[chosen];
  return {
    month: chosen,
    asOf: entry.asOf,
    source: entry.source,
    url: entry.url,
    holdings: entry.h.map(expandHolding)
  };
}

function monthsBetween(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export async function archiveCoverage() {
  const index = await readJournal(INDEX, { schemes: {} });
  const entries = Object.entries(index.schemes || {});
  return {
    schemes: entries.length,
    schemesWithHistory: entries.filter(([, item]) => item.months > 1).length,
    totalSnapshots: entries.reduce((sum, [, item]) => sum + (item.months || 0), 0)
  };
}
