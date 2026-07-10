import { NextResponse } from "next/server";
import { fetchLiveSeries } from "@/lib/upstream";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request) {
  try {
    const body = await request.json();
    const queries = Array.isArray(body?.queries) ? body.queries.filter(Boolean).slice(0, 6) : [];
    const startDate = typeof body?.startDate === "string" ? body.startDate : undefined;
    const endDate = typeof body?.endDate === "string" ? body.endDate : undefined;

    if (!queries.length) {
      return NextResponse.json({ ok: false, error: "At least one scheme query is required." }, { status: 400 });
    }

    const result = await fetchLiveSeries({ queries, startDate, endDate });
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
