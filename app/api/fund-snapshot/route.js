import { NextResponse } from 'next/server';
import { getMarketUniverse } from '@/lib/universe';
import { generatedFundSnapshot } from '@/lib/generated-fund-snapshot';
import { resolveFundResearch } from '@/lib/fallback-sources';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 40;

function suppliedFund(searchParams) {
  const id = searchParams.get('fundId');
  const displayName = searchParams.get('displayName');
  const fundHouse = searchParams.get('fundHouse');
  const preferredSchemeName = searchParams.get('preferredSchemeName') || displayName;
  const preferredSchemeCode = searchParams.get('schemeCode');
  if (!id || !displayName || !fundHouse) return null;
  return {
    id,
    displayName,
    fundHouse,
    category: searchParams.get('category') || '',
    preferredSchemeName,
    preferredSchemeCode: preferredSchemeCode ? Number(preferredSchemeCode) : null,
    canonicalName: searchParams.get('canonicalName') || displayName,
    variants: preferredSchemeName ? [{ schemeName: preferredSchemeName, schemeCode: preferredSchemeCode }] : []
  };
}

function firstRows(...values) {
  return values.find(value => Array.isArray(value) && value.length) || [];
}

function normaliseHoldings(rows) {
  const map = new Map();
  for (const item of rows || []) {
    const name = String(item?.name || item?.company || '').replace(/\s+/g, ' ').trim();
    const weight = Number(item?.weight ?? item?.percentage ?? item?.allocation);
    if (!name || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const existing = map.get(key);
    if (!existing || weight > existing.weight) {
      map.set(key, {
        ...item,
        name,
        weight: Number(weight.toFixed(4)),
        sector: item?.sector || item?.industry || null
      });
    }
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight).slice(0, 50);
}

function normaliseSectors(rows, holdings) {
  const map = new Map();
  for (const item of rows || []) {
    const sector = String(item?.sector || item?.name || '').replace(/\s+/g, ' ').trim();
    const weight = Number(item?.weight ?? item?.percentage ?? item?.allocation);
    if (!sector || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    map.set(sector, (map.get(sector) || 0) + weight);
  }
  if (!map.size) {
    for (const item of holdings || []) {
      const sector = String(item?.sector || '').trim();
      if (!sector) continue;
      map.set(sector, (map.get(sector) || 0) + Number(item.weight || 0));
    }
  }
  if (!map.size) {
    const total = (holdings || []).reduce((sum, item) => sum + Number(item.weight || 0), 0);
    if (total > 0) map.set('Sector classification pending', total);
  }
  return [...map.entries()]
    .map(([sector, weight]) => ({
      sector,
      weight: Number(weight.toFixed(4)),
      classificationPending: sector === 'Sector classification pending'
    }))
    .sort((a, b) => b.weight - a.weight);
}

function liveSnapshot(fund, research) {
  const current = research?.current || {};
  const previous = research?.previous || null;
  const holdings = normaliseHoldings(firstRows(
    current.holdings,
    current.valueResearch?.holdings,
    current.advisorKhoj?.holdings
  ));
  const sectors = normaliseSectors(firstRows(
    current.sectors,
    current.advisorKhoj?.sectors,
    current.valueResearch?.sectors
  ), holdings);
  const previousHoldings = normaliseHoldings(firstRows(
    previous?.holdings,
    previous?.valueResearch?.holdings,
    previous?.advisorKhoj?.holdings
  ));
  const snapshotCount = previousHoldings.length ? 2 : holdings.length ? 1 : 0;
  const managers = firstRows(current.managers, current.valueResearch?.managers);
  const resolvedPct = holdings.length && sectors.length ? 70 : holdings.length || sectors.length ? 55 : 0;

  return {
    ok: Boolean(holdings.length || sectors.length),
    fund: {
      id: fund.id,
      displayName: fund.displayName,
      fundHouse: fund.fundHouse,
      category: fund.category,
      preferredSchemeCode: fund.preferredSchemeCode
    },
    managers,
    holdings,
    sectors,
    entries: [],
    exits: [],
    fundFacts: {
      turnoverPct: current.turnoverPct ?? current.valueResearch?.turnoverPct ?? current.advisorKhoj?.turnoverPct,
      benchmark: current.benchmark || current.valueResearch?.benchmark || current.advisorKhoj?.benchmark,
      expenseRatioPct: current.expenseRatioPct ?? current.valueResearch?.expenseRatioPct ?? current.advisorKhoj?.expenseRatioPct,
      aumCr: current.aumCr ?? current.valueResearch?.aumCr ?? current.advisorKhoj?.aumCr,
      riskMetrics: current.riskMetrics || current.advisorKhoj?.riskMetrics || null,
      assetAllocation: current.assetAllocation || current.valueResearch?.assetAllocation || [],
      marketCap: current.marketCap || current.valueResearch?.marketCap || []
    },
    snapshot: {
      holdings,
      sectorWeights: sectors,
      assetAllocation: current.assetAllocation || current.valueResearch?.assetAllocation || [],
      marketCap: current.marketCap || current.valueResearch?.marketCap || [],
      currentAsOf: current.portfolioAsOf || current.valueResearch?.navDate || current.advisorKhoj?.navDate || current.fetchedAt || null,
      previousAsOf: previous?.portfolioAsOf || previous?.valueResearch?.navDate || previous?.advisorKhoj?.navDate || previous?.fetchedAt || null,
      snapshotCount,
      comparisonMode: snapshotCount >= 2 ? 'live-research-disclosure-comparison' : 'live-research-current-baseline',
      sectorBasis: sectors.some(item => item.classificationPending)
        ? 'Latest disclosed holdings loaded; sector classification is awaiting source enrichment.'
        : 'Current Value Research Online / AdvisorKhoj sector snapshot.',
      factsheetLabel: 'Bounded Value Research Online / AdvisorKhoj portfolio snapshot'
    },
    coverage: {
      requestedSymbols: holdings.length + sectors.length,
      resolvedSymbols: holdings.length + sectors.length,
      resolvedPct,
      sectorSeries: sectors.length,
      entrySeries: 0,
      exitSeries: 0,
      baselineEstablished: snapshotCount === 1,
      snapshotCount,
      comparisonMode: snapshotCount >= 2 ? 'live-research-disclosure-comparison' : 'live-research-current-baseline'
    },
    sources: current.sources || [],
    sourceDiagnostics: {
      boundedLiveSnapshot: true,
      holdings: holdings.length,
      sectors: sectors.length,
      researchDiagnostics: research?.diagnostics || null,
      registryMatch: research?.registryMatch || null
    },
    engineVersion: '1.4.0-bounded-live-snapshot'
  };
}

function timeoutAfter(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Snapshot source resolution timed out after ${Math.round(ms / 1000)} seconds.`)), ms);
  });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const fundId = searchParams.get('fundId');
  const schemeCode = searchParams.get('schemeCode');

  try {
    let fund = suppliedFund(searchParams);
    if (!fund) {
      const universe = await getMarketUniverse();
      fund = universe.families.find(item => item.id === fundId)
        || universe.families.find(item => item.variants?.some(variant => String(variant.schemeCode) === String(schemeCode)));
    }

    if (!fund) {
      return NextResponse.json({
        ok: false,
        error: 'Fund family not found in the AMFI universe.'
      }, {
        status: 404,
        headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' }
      });
    }

    const generated = generatedFundSnapshot(fund);
    if (generated.ok) {
      return NextResponse.json(generated, {
        headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' }
      });
    }

    const research = await Promise.race([
      resolveFundResearch(fund),
      timeoutAfter(26000)
    ]);
    const result = liveSnapshot(fund, research);
    if (!result.ok) {
      return NextResponse.json({
        ...result,
        error: 'The selected fund resolved, but no validated holdings or sector snapshot was available.'
      }, {
        status: 424,
        headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' }
      });
    }

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' }
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'The source-synchronised portfolio snapshot could not be loaded.',
      detail: error instanceof Error ? error.message : String(error)
    }, {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' }
    });
  }
}
