import { NextResponse } from 'next/server';
import { buildSyntheticProxy, computeMetrics, normaliseSeries } from '@/lib/analytics';
import { proxyProfileForFund } from '@/lib/dynamic-proxies';
import { getMarketUniverse } from '@/lib/universe';
import { liveSeries } from '@/lib/upstream';
import { membershipCoverage, coversWindow } from '@/lib/universe-history';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const PEER_LIMIT = 16;
const MIN_HISTORY_YEARS = 3;
const MIN_ALIGNED_OBSERVATIONS = 250;
const DISTRIBUTION_KEYS = [
  'alphaPct',
  'informationRatio',
  'alphaPersistenceScore',
  'downCapturePct',
  'maxDrawdownPct',
  'conditionalDrawdownAtRiskPct',
  'timeUnderWaterPct',
  'recoveryDays',
  'maxDrawdownRelativePct',
  'negativeMonthAlphaPct',
  'tailLossFrequencyPct',
  'sharpe',
  'activeReturnPct',
  'volatilityPct',
  'positiveMonthHitRatePct',
  'upCapturePct',
  'overallCapturePct',
  'beta',
  'trackingErrorPct',
  'cagrPct'
];

function cache() {
  globalThis.__MANAGERLENS_PEER_BENCHMARK_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_PEER_BENCHMARK_CACHE__;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function distribution(values) {
  const clean = values.filter(Number.isFinite);
  const centre = median(clean);
  if (!Number.isFinite(centre)) return { n: 0, median: null, mad: null };
  return {
    n: clean.length,
    median: centre,
    mad: median(clean.map(value => Math.abs(value - centre)))
  };
}

function passiveIdentity(fund) {
  return /\b(index|passive|etf|exchange traded|fund of funds?|fof)\b/i.test([
    fund?.displayName,
    fund?.preferredSchemeName,
    fund?.category
  ].join(' '));
}

function preferredDirectGrowth(fund) {
  return fund?.variants?.find(variant => variant.plan === 'Direct' && variant.option === 'Growth')
    || fund?.variants?.find(variant => variant.plan === 'Direct')
    || fund?.variants?.[0];
}

function comparablePeers(universe, selectedFund) {
  const selectedPassive = passiveIdentity(selectedFund);
  const candidates = universe.families
    .filter(fund => fund.id !== selectedFund.id)
    .filter(fund => fund.category === selectedFund.category)
    .filter(fund => passiveIdentity(fund) === selectedPassive)
    .map(fund => ({ fund, variant: preferredDirectGrowth(fund) }))
    .filter(item => item.variant?.schemeCode)
    .sort((left, right) => left.fund.fundHouse.localeCompare(right.fund.fundHouse) || left.fund.displayName.localeCompare(right.fund.displayName));

  const selected = [];
  const houses = new Set();
  for (const item of candidates) {
    if (houses.has(item.fund.fundHouse)) continue;
    selected.push(item);
    houses.add(item.fund.fundHouse);
    if (selected.length >= PEER_LIMIT) break;
  }
  if (selected.length < PEER_LIMIT) {
    for (const item of candidates) {
      if (selected.includes(item)) continue;
      selected.push(item);
      if (selected.length >= PEER_LIMIT) break;
    }
  }
  return selected;
}

// Name-similarity resolution sometimes lands on a dormant scheme that carries the right
// name but no NAV history. Each alternative query is retried independently and the
// longest usable series wins, so one bad match cannot blank the whole benchmark.
async function resolveComponentSeries(component, startDate, endDate) {
  const attempts = [component.queries, ...(component.queries || []).map(query => [query])];
  let best = null;
  for (const queries of attempts) {
    try {
      const result = await liveSeries({ queries, startDate, endDate });
      const rows = normaliseSeries(result.data);
      if (rows.length >= 3 && (!best || rows.length > best.rows.length)) best = { rows, source: result.source };
      if (best && best.rows.length >= 500) break;
    } catch {}
  }
  if (!best) throw new Error(`No candidate for "${component.queries?.[0] || 'proxy component'}" returned usable NAV history.`);
  return best;
}

async function proxySeriesFor(fund, startDate, endDate) {
  const proxy = proxyProfileForFund(fund).official;
  const settled = await Promise.allSettled((proxy.components || [])
    .map(component => resolveComponentSeries(component, startDate, endDate)));
  const usable = settled.map((result, index) => result.status === 'fulfilled'
    ? {
      rows: result.value.rows,
      weight: Number(proxy.components[index]?.weight) || 0,
      source: result.value.source
    }
    : null).filter(item => item?.rows?.length >= 3);
  if (!usable.length) {
    const why = settled.map((result, index) => result.status === 'rejected'
      ? `component ${index}: ${result.reason?.message || result.reason}`
      : `component ${index}: ${result.value.rows.length} rows`).join('; ');
    throw new Error(`The category-aligned comparison proxy returned no usable NAV history (${why}).`);
  }
  const total = usable.reduce((sum, item) => sum + item.weight, 0) || usable.length;
  return {
    proxy,
    rows: buildSyntheticProxy(usable.map(item => item.rows), usable.map(item => (item.weight || 1) / total)),
    sources: usable.map(item => item.source)
  };
}

async function mapConcurrent(rows, limit, mapper) {
  const results = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = { status: 'fulfilled', value: await mapper(rows[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, () => worker()));
  return results;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const schemeCode = String(searchParams.get('schemeCode') || '').trim();
  const startDate = searchParams.get('startDate') || `${new Date().getUTCFullYear() - 8}-01-01`;
  const endDate = searchParams.get('endDate') || new Date().toISOString().slice(0, 10);
  const riskFree = Number(searchParams.get('riskFree') || 6.5);
  if (!/^\d{4,9}$/.test(schemeCode)) {
    return NextResponse.json({ ok: false, error: 'A valid AMFI scheme code is required.' }, { status: 400 });
  }

  const key = `${schemeCode}:${startDate}:${endDate}:${riskFree}`;
  const old = cache().get(key);
  if (old && Date.now() - old.at < 6 * 60 * 60 * 1000) {
    return NextResponse.json({ ...old.value, cache: 'fresh' });
  }

  try {
    const universe = await getMarketUniverse();
    const selectedFund = universe.families.find(fund => fund.variants?.some(variant => String(variant.schemeCode) === schemeCode));
    if (!selectedFund) return NextResponse.json({ ok: false, error: 'The selected AMFI code was not found in the current universe.' }, { status: 404 });
    const candidates = comparablePeers(universe, selectedFund);
    const proxyBundle = await proxySeriesFor(selectedFund, startDate, endDate);
    // The comparison window is bounded by the proxy, not by the peer. Peers are required to
    // cover most of that shared window rather than an absolute observation count, so a
    // short-history proxy no longer disqualifies every long-history peer in the category.
    // Capped at the stated minimum track record: liquid and debt schemes publish NAV on
    // every calendar day while equity schemes publish only on trading days, so demanding
    // near-total overlap with a long daily-quoting proxy would reject every valid peer.
    const proxyObservations = Math.max(0, proxyBundle.rows.length - 1);
    const requiredOverlap = Math.max(
      MIN_ALIGNED_OBSERVATIONS,
      Math.min(Math.floor(proxyObservations * 0.85), MIN_HISTORY_YEARS * 252)
    );
    const settled = await mapConcurrent(candidates, 6, async ({ fund, variant }) => {
      const result = await liveSeries({ schemeCode: variant.schemeCode, startDate, endDate });
      const rows = normaliseSeries(result.data);
      const metrics = computeMetrics(rows, proxyBundle.rows, riskFree);
      if (!Number.isFinite(metrics.years) || metrics.years < MIN_HISTORY_YEARS || metrics.alignedObservations < requiredOverlap) {
        throw new Error(`Insufficient comparable history (rows=${rows.length}, years=${Number(metrics.years).toFixed(2)}, aligned=${metrics.alignedObservations}, required=${requiredOverlap}).`);
      }
      return {
        fundId: fund.id,
        name: fund.displayName,
        fundHouse: fund.fundHouse,
        schemeCode: variant.schemeCode,
        years: metrics.years,
        metrics
      };
    });
    const peers = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
    const distributions = Object.fromEntries(DISTRIBUTION_KEYS.map(metric => [
      metric,
      distribution(peers.map(peer => peer.metrics?.[metric]))
    ]));
    // The comparison window reaches back roughly proxyObservations trading days; the ledger
    // is only allowed to claim point-in-time membership if it started before that.
    const membership = await membershipCoverage();
    const windowStart = new Date(Date.now() - (proxyObservations / 252) * 365.25 * 86400000)
      .toISOString()
      .slice(0, 10);
    const membershipWindowCovered = await coversWindow(windowStart);

    const value = {
      ok: true,
      category: selectedFund.category,
      modelUniverse: passiveIdentity(selectedFund) ? 'passive' : 'active',
      plan: 'Direct',
      option: 'Growth',
      minimumHistoryYears: MIN_HISTORY_YEARS,
      comparisonWindow: {
        proxyObservations,
        requiredOverlap,
        effectiveYears: proxyObservations / 252
      },
      requestedPeers: candidates.length,
      peerCount: peers.length,
      peers: peers.map(({ metrics, ...peer }) => ({ ...peer, observations: metrics.observations, alignedObservations: metrics.alignedObservations })),
      distributions,
      proxy: {
        id: proxyBundle.proxy.id,
        label: proxyBundle.proxy.label,
        quality: proxyBundle.proxy.quality
      },
      comparability: {
        sameCurrentSebiCategory: true,
        activeLikeForLike: true,
        directGrowthLikeForLike: true,
        minimumTrackRecordApplied: true,
        // The local membership ledger only becomes usable once it spans the comparison
        // window; until then the peer set is still today's survivors and says so.
        pointInTime: membershipWindowCovered,
        membershipLedger: {
          observedDays: membership.observedDays,
          startedOn: membership.startedOn,
          trackedSchemes: membership.trackedSchemes,
          retiredSchemes: membership.retiredSchemes
        },
        note: membershipWindowCovered
          ? `Point-in-time category membership is reconstructed from ${membership.observedDays} days of locally banked AMFI universe snapshots, including ${membership.retiredSchemes} schemes since merged or closed.`
          : `Current category membership is used, so the peer set excludes funds that merged or closed and confidence is capped. A local membership ledger has been banking daily AMFI snapshots${membership.startedOn ? ` since ${membership.startedOn} (${membership.observedDays} days, ${membership.trackedSchemes} schemes)` : ''} and will supply point-in-time peer sets once it spans the ${Math.round(proxyObservations / 252 * 12)}-month comparison window.`
      },
      failures: settled.filter(item => item.status === 'rejected').length,
      failureReasons: settled
        .filter(item => item.status === 'rejected')
        .map(item => String(item.reason?.message || item.reason))
        .reduce((tally, reason) => ({ ...tally, [reason]: (tally[reason] || 0) + 1 }), {}),
      fetchedAt: new Date().toISOString()
    };
    cache().set(key, { at: Date.now(), value });
    return NextResponse.json(value, { headers: { 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'The category peer benchmark could not be built.',
      detail: error instanceof Error ? error.message : String(error)
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
