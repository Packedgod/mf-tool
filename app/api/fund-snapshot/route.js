import { NextResponse } from 'next/server';
import { getMarketUniverse } from '@/lib/universe';
import { generatedFundSnapshot } from '@/lib/generated-fund-snapshot';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 15;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const fundId = searchParams.get('fundId');
  const schemeCode = searchParams.get('schemeCode');

  try {
    const universe = await getMarketUniverse();
    const fund = universe.families.find(item => item.id === fundId)
      || universe.families.find(item => item.variants?.some(variant => String(variant.schemeCode) === String(schemeCode)));

    if (!fund) {
      return NextResponse.json({
        ok: false,
        error: 'Fund family not found in the AMFI universe.'
      }, {
        status: 404,
        headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' }
      });
    }

    const result = generatedFundSnapshot(fund);
    if (!result.ok) {
      return NextResponse.json(result, {
        status: 404,
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
