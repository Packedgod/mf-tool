import { NextResponse } from "next/server";
import { fetchLiveSeries, normaliseSchemeCode } from "@/lib/upstream";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request) {
  try {
    const body = await request.json();
    const queries = Array.isArray(body?.queries) ? body.queries.filter(Boolean).slice(0, 6) : [];
    const schemeCode = normaliseSchemeCode(body?.schemeCode);
    const startDate = typeof body?.startDate === "string" ? body.startDate : undefined;
    const endDate = typeof body?.endDate === "string" ? body.endDate : undefined;

    if (!schemeCode && !queries.length) {
      return NextResponse.json(
        { ok: false, error: "Provide either a valid AMFI scheme code or at least one scheme query." },
        { status: 400 }
      );
    }

    if (body?.schemeCode && !schemeCode) {
      return NextResponse.json(
        { ok: false, error: "AMFI scheme code must contain 4 to 9 digits." },
        { status: 400 }
      );
    }

    const result = await fetchLiveSeries({ queries, schemeCode, startDate, endDate });
    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "private, no-store, max-age=0" }
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "Live fund data could not be loaded from MFapi/AMFI.",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 503 }
    );
  }
}
