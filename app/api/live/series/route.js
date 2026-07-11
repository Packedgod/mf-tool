import { NextResponse } from 'next/server';
import { codeOf, liveSeries } from '@/lib/upstream';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function POST(request) {
  try {
    const body = await request.json();
    const schemeCode = codeOf(body?.schemeCode);
    const queries = Array.isArray(body?.queries) ? body.queries.filter(Boolean).slice(0, 6) : [];
    if (body?.schemeCode && !schemeCode) {
      return NextResponse.json({ ok: false, error: 'AMFI scheme code must contain 4 to 9 digits.' }, { status: 400 });
    }
    if (!schemeCode && !queries.length) {
      return NextResponse.json({ ok: false, error: 'Provide a valid AMFI code or scheme query.' }, { status: 400 });
    }
    const result = await liveSeries({
      schemeCode,
      queries,
      startDate: body?.startDate,
      endDate: body?.endDate
    });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' }
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'Live MF data could not be loaded.',
      detail: error instanceof Error ? error.message : String(error)
    }, {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' }
    });
  }
}
