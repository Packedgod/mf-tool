import { NextResponse } from 'next/server';
import { getMarketUniverse } from '@/lib/universe';
import { resolveFundResearch } from '@/lib/fallback-sources';
import { buildFallbackMomentumFast } from '@/lib/fallback-momentum-fast';
import { enrichResearchWithOfficialPortfolio } from '@/lib/official-portfolio';
import { normalizeResearchHistory } from '@/lib/normalize-research-history';
import { resolveAdvisorKhojDocuments } from '@/lib/resolve-research-documents';
import { refreshValueResearchPortfolio } from '@/lib/value-research-live-portfolio';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const ENGINE_VERSION = '1.1.0-exact-vro-portfolios';

function canonicalHolding(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(limited|ltd|inc|corporation|corp|company|co)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validHoldingName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 120 || !/[A-Za-z]/.test(name)) return false;
  return !/^(total|portfolio|company|sector|asset allocation|market cap|see more|show all|fund manager|riskometer|very high|min\.|created with)/i.test(name)
    && !/highcharts|benchmark|turnover|expense ratio|standard deviation|sharpe|alpha|beta|latest nav|returns?|withdrawal|cheques/i.test(name);
}

function sanitiseHoldings(rows) {
  const map = new Map();
  for (const item of rows || []) {
    const weight = Number(item?.weight);
    const name = String(item?.name || '').replace(/\s+/g, ' ').trim();
    if (!validHoldingName(name) || !Number.isFinite(weight) || weight <= 0 || weight > 25) continue;
    const key = canonicalHolding(name);
    const existing = map.get(key);
    if (!existing || weight > existing.weight) map.set(key, { ...item, name, weight });
  }
  const sorted = [...map.values()].sort((a, b) => b.weight - a.weight);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 101.5) return sorted;
  const bounded = [];
  let cumulative = 0;
  for (const item of sorted) {
    if (cumulative + item.weight > 101.5) continue;
    bounded.push(item);
    cumulative += item.weight;
  }
  return bounded;
}

function sanitiseSectors(rows) {
  const map = new Map();
  for (const item of rows || []) {
    const sector = String(item?.sector || item?.name || '').replace(/\s+/g, ' ').trim();
    const weight = Number(item?.weight);
    if (!sector || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    map.set(sector, (map.get(sector) || 0) + weight);
  }
  const sorted = [...map.entries()].map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)) })).sort((a, b) => b.weight - a.weight);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  return total <= 102 ? sorted : [];
}

function sanitiseResearch(research) {
  if (!research?.ok) return research;
  const cleanSnapshot = snapshot => snapshot ? {
    ...snapshot,
    holdings: sanitiseHoldings(snapshot.holdings),
    sectors: sanitiseSectors(snapshot.sectors)
  } : snapshot;
  const current = cleanSnapshot(research.current || {});
  return {
    ...research,
    current: {
      ...current,
      valueResearch: current.valueResearch ? { ...current.valueResearch, holdings: sanitiseHoldings(current.valueResearch.holdings) } : current.valueResearch,
      advisorKhoj: current.advisorKhoj ? {
        ...current.advisorKhoj,
        holdings: sanitiseHoldings(current.advisorKhoj.holdings),
        sectors: sanitiseSectors(current.advisorKhoj.sectors)
      } : current.advisorKhoj
    },
    previous: cleanSnapshot(research.previous),
    portfolioHistory: (research.portfolioHistory || []).map(cleanSnapshot)
  };
}

function useBestPortfolioDocument(research) {
  const current = research?.current || {};
  const documents = current.advisorKhoj?.officialDocuments || [];
  if (!documents.length) return research;
  const best = documents[0];
  return {
    ...research,
    current: {
      ...current,
      advisorKhoj: current.advisorKhoj ? {
        ...current.advisorKhoj,
        officialDocuments: best ? [best] : []
      } : current.advisorKhoj
    }
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const fundId = searchParams.get('fundId');
  const schemeCode = searchParams.get('schemeCode');

  try {
    const universe = await getMarketUniverse();
    const fund = universe.families.find(item => item.id === fundId)
      || universe.families.find(item => item.variants?.some(variant => String(variant.schemeCode) === String(schemeCode)));

    if (!fund) {
      return NextResponse.json({ ok: false, error: 'Fund family not found in the live AMFI universe.', engineVersion: ENGINE_VERSION }, { status: 404 });
    }

    const resolvedResearch = await resolveFundResearch(fund);
    const exactResearch = await refreshValueResearchPortfolio(resolvedResearch);
    const publicResearch = sanitiseResearch(exactResearch);
    if (!publicResearch.ok) {
      return NextResponse.json({
        ok: false,
        error: 'No Value Research Online or AdvisorKhoj fund record could be resolved.',
        sourcesAttempted: ['Value Research Online', 'AdvisorKhoj'],
        diagnostics: publicResearch.diagnostics,
        engineVersion: ENGINE_VERSION
      }, { status: 404 });
    }

    const resolvedDocuments = await resolveAdvisorKhojDocuments(publicResearch, fund.displayName);
    const sourceResearch = useBestPortfolioDocument(resolvedDocuments);
    const enriched = sanitiseResearch(await enrichResearchWithOfficialPortfolio(sourceResearch, fund.displayName));
    const research = sanitiseResearch(normalizeResearchHistory(enriched));
    const intelligence = await buildFallbackMomentumFast(fund, research);

    const holdingCount = intelligence.holdings?.length || 0;
    const sectorCount = intelligence.sectors?.length || 0;
    if (!holdingCount && !sectorCount) {
      return NextResponse.json({
        ok: false,
        error: 'The selected fund matched the research universe, but its current holdings payload was empty. The UI will not render an empty sector or timing panel.',
        detail: 'Value Research Online and AdvisorKhoj were resolved, but neither returned a validated holdings or sector table for this refresh.',
        fund: { id: fund.id, displayName: fund.displayName, fundHouse: fund.fundHouse, preferredSchemeCode: fund.preferredSchemeCode },
        diagnostics: {
          ...publicResearch.diagnostics,
          exactValueResearchPortfolio: publicResearch.exactValueResearchPortfolio,
          registryMatch: publicResearch.registryMatch,
          documentResolution: resolvedDocuments.documentResolution,
          officialPortfolioFailures: research.officialPortfolioFailures || []
        },
        engineVersion: ENGINE_VERSION
      }, { status: 424, headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' } });
    }

    return NextResponse.json({
      ...intelligence,
      fund: { id: fund.id, displayName: fund.displayName, fundHouse: fund.fundHouse, category: fund.category, preferredSchemeCode: fund.preferredSchemeCode },
      researchPolicy: {
        managerAndPortfolio: ['Value Research Online', 'AdvisorKhoj'],
        navAndPriceEnrichment: ['AMFI', 'MFapi.in', 'Yahoo Finance']
      },
      sourceDiagnostics: {
        registryMatch: publicResearch.registryMatch,
        research: publicResearch.diagnostics,
        exactValueResearchPortfolio: publicResearch.exactValueResearchPortfolio,
        documents: resolvedDocuments.documentResolution,
        holdings: holdingCount,
        sectors: sectorCount,
        entries: intelligence.entries?.length || 0,
        exits: intelligence.exits?.length || 0
      },
      engineVersion: ENGINE_VERSION,
      officialPortfolioFailures: research.officialPortfolioFailures || []
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'Value Research Online and AdvisorKhoj intelligence could not be loaded.',
      detail: error instanceof Error ? error.message : String(error),
      engineVersion: ENGINE_VERSION
    }, { status: 503, headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' } });
  }
}
