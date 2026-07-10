import { NextResponse } from 'next/server';
import { getMarketUniverse } from '@/lib/universe';
import { resolveFundResearch } from '@/lib/fallback-sources';
import { buildFallbackMomentumFast } from '@/lib/fallback-momentum-fast';
import { enrichResearchWithOfficialPortfolio } from '@/lib/official-portfolio';
import { normalizeResearchHistory } from '@/lib/normalize-research-history';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const fundId = searchParams.get('fundId');
  const schemeCode = searchParams.get('schemeCode');

  try {
    const universe = await getMarketUniverse();
    const fund = universe.families.find(item => item.id === fundId)
      || universe.families.find(item => item.variants?.some(variant => String(variant.schemeCode) === String(schemeCode)));

    if (!fund) {
      return NextResponse.json({ ok: false, error: 'Fund family not found in the live AMFI universe.' }, { status: 404 });
    }

    const publicResearch = await resolveFundResearch(fund);
    if (!publicResearch.ok) {
      return NextResponse.json({
        ok: false,
        error: 'No Value Research Online or AdvisorKhoj fund record could be resolved.',
        sourcesAttempted: ['Value Research Online', 'AdvisorKhoj']
      }, { status: 404 });
    }

    const enriched = await enrichResearchWithOfficialPortfolio(publicResearch, fund.displayName);
    const research = normalizeResearchHistory(enriched);
    const intelligence = await buildFallbackMomentumFast(fund, research);
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
      officialPortfolioFailures: research.officialPortfolioFailures || []
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'Value Research Online and AdvisorKhoj intelligence could not be loaded.',
      detail: error instanceof Error ? error.message : String(error)
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
