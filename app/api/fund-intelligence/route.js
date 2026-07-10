import { NextResponse } from 'next/server';
import { getMarketUniverse } from '@/lib/universe';
import { resolveFundResearch } from '@/lib/fallback-sources';
import { buildFallbackMomentumFast } from '@/lib/fallback-momentum-fast';

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

    const research = await resolveFundResearch(fund);
    if (!research.ok) {
      return NextResponse.json({
        ok: false,
        error: 'No public fallback research page could be resolved for this fund.',
        sourcesAttempted: ['Value Research Online', 'AdvisorKhoj']
      }, { status: 404 });
    }

    const intelligence = await buildFallbackMomentumFast(fund, research);
    return NextResponse.json({
      ...intelligence,
      fund: {
        id: fund.id,
        displayName: fund.displayName,
        fundHouse: fund.fundHouse,
        category: fund.category,
        preferredSchemeCode: fund.preferredSchemeCode
      }
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'The public research fallback could not be loaded.',
      detail: error instanceof Error ? error.message : String(error)
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
