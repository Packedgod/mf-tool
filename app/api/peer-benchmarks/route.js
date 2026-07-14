import { NextResponse } from 'next/server';
import { buildSyntheticProxy, computeMetrics, normaliseSeries } from '@/lib/analytics';
import { proxyProfileForFund } from '@/lib/dynamic-proxies';
import { getMarketUniverse } from '@/lib/universe';
import { liveSeries } from '@/lib/upstream';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const PEER_LIMIT = 12;
const MIN_HISTORY_YEARS = 3;
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
  'volatilityPct'
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

async function proxySeriesFor(fund, startDate, endDate) {
  const proxy = proxyProfileForFund(fund).official;
  const settled = await Promise.allSettled((proxy.components || []).map(component => liveSeries({
    queries: component.queries,
    startDate,
    endDate
  })));
  const usable = settled.map((result, index) => result.status === 'fulfilled'
    ? {
      rows: normaliseSeries(result.value.data),
      weight: Number(proxy.components[index]?.weight) || 0,
      source: result.value.source
    }
    : null).filter(item => item?.rows?.length >= 3);
  if (!usable.length) throw new Error('The category-aligned comparison proxy returned no usable NAV history.');
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
    const settled = await mapConcurrent(candidates, 6, async ({ fund, variant }) => {
      const result = await liveSeries({ schemeCode: variant.schemeCode, startDate, endDate });
      const rows = normaliseSeries(result.data);
      const metrics = computeMetrics(rows, proxyBundle.rows, riskFree);
      if (!Number.isFinite(metrics.years) || metrics.years < MIN_HISTORY_YEARS || metrics.alignedObservations < 500) {
        throw new Error('Insufficient comparable history.');
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
    const value = {
      ok: true,
      category: selectedFund.category,
      modelUniverse: passiveIdentity(selectedFund) ? 'passive' : 'active',
      plan: 'Direct',
      option: 'Growth',
      minimumHistoryYears: MIN_HISTORY_YEARS,
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
        pointInTime: false,
        note: 'Current category membership is used. Historical point-in-time membership and dead/merged fund coverage are not yet available, so confidence is capped.'
      },
      failures: settled.filter(item => item.status === 'rejected').length,
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
