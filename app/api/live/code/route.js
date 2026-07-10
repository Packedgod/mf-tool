import { NextResponse } from "next/server";
import { fetchHistoryByCode, normaliseSchemeCode, resolveSchemeByCode } from "@/lib/upstream";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = normaliseSchemeCode(searchParams.get("code"));

  if (!code) {
    return NextResponse.json({ ok: false, error: "Enter a valid 4 to 9 digit AMFI scheme code." }, { status: 400 });
  }

  try {
    const resolved = await resolveSchemeByCode(code);
    const history = await fetchHistoryByCode(code);
    const observations = Array.isArray(history?.data) ? history.data.length : 0;
    const latest = observations ? history.data[0] : null;

    return NextResponse.json({
      ok: true,
      schemeCode: code,
      schemeName: resolved.schemeName,
      resolvedBy: resolved.resolvedBy,
      amfiStatus: resolved.amfiStatus,
      observations,
      latest,
      meta: history.meta || {}
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      schemeCode: code,
      error: error instanceof Error ? error.message : String(error)
    }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
