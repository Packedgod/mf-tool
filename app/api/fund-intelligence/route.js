import { NextResponse } from 'next/server';
import { getMarketUniverse } from '@/lib/universe';
import { resolveFundResearch } from '@/lib/fallback-sources';
import { buildFallbackMomentumFast } from '@/lib/fallback-momentum-fast';
import { enrichResearchWithOfficialPortfolio } from '@/lib/official-portfolio';
import { normalizeResearchHistory } from '@/lib/normalize-research-history';
import { resolveAdvisorKhojDocuments } from '@/lib/resolve-research-documents';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const ENGINE_VERSION = '1.0.0-live-portfolios';

function preferPortfolioDocuments(research) {
  const current = research?.current || {};
  const documents = current.advisorKhoj?.officialDocuments || [];
  if (!documents.length) return research;
  const preferred = documents.filter(item =>
    /\.xlsx?(?:$|\?)/i.test(item.url || '')
    || /monthly\s+portfolio|portfolio\s+disclosure|excel|spreadsheet/i.test(`${item.text || ''} ${item.type || ''}`)
  );
  return {
    ...research,
    current: {
      ...current,
      advisorKhoj: current.advisorKhoj ? {
        ...current.advisorKhoj,
        officialDocuments: preferred.length ? preferred : documents
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

    const publicResearch = await resolveFundResearch(fund);
    if (!publicResearch.ok) {
      return NextResponse.json({
        ok: false,
        error: 'No Value Research Online or AdvisorKhoj fund record could be resolved.',
        sourcesAttempted: ['Value Research Online', 'AdvisorKhoj'],
        diagnostics: publicResearch.diagnostics,
        engineVersion: ENGINE_VERSION
      }, { status: 404 });
    }

    const resolvedDocuments = await resolveAdvisorKhojDocuments(publicResearch);
    const sourceResearch = preferPortfolioDocuments(resolvedDocuments);
    const enriched = await enrichResearchWithOfficialPortfolio(sourceResearch, fund.displayName);
    const research = normalizeResearchHistory(enriched);
    const intelligence = await buildFallbackMomentumFast(fund, research);

    const holdingCount = intelligence.holdings?.length || 0;
    const sectorCount = intelligence.sectors?.length || 0;
    if (!holdingCount && !sectorCount) {
      return NextResponse.json({
        ok: false,
        error: 'The selected fund matched the research universe, but its current holdings payload was empty. The UI will not render an empty sector or timing panel.',
        detail: 'Value Research Online and AdvisorKhoj were resolved, but neither returned a parseable holdings or sector table for this refresh.',
        fund: {
          id: fund.id,
          displayName: fund.displayName,
          fundHouse: fund.fundHouse,
          preferredSchemeCode: fund.preferredSchemeCode
        },
        diagnostics: {
          ...publicResearch.diagnostics,
          registryMatch: publicResearch.registryMatch,
          documentResolution: resolvedDocuments.documentResolution,
          officialPortfolioFailures: research.officialPortfolioFailures || []
        },
        engineVersion: ENGINE_VERSION
      }, { status: 424, headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' } });
    }

    return NextResponse.json({
      ...intelligence,
      fund: {
        id: fund.id,
        displayName: fund.displayName,
        fundHouse: fund.fundHouse,
        category: fund.category,
        preferredSchemeCode: fund.preferredSchemeCode
      },
      researchPolicy: {
        managerAndPortfolio: ['Value Research Online', 'AdvisorKhoj'],
        navAndPriceEnrichment: ['AMFI', 'MFapi.in', 'Yahoo Finance']
      },
      sourceDiagnostics: {
        registryMatch: publicResearch.registryMatch,
        research: publicResearch.diagnostics,
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
