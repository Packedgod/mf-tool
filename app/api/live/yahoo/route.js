import { NextResponse } from "next/server";
import { fetchWithTimeout } from "@/lib/upstream";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol")?.trim();
  const range = searchParams.get("range") || "1y";
  const interval = searchParams.get("interval") || "1d";

  if (!symbol) {
    return NextResponse.json({ ok: false, error: "Missing Yahoo Finance symbol." }, { status: 400 });
  }

  try {
    const response = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includeAdjustedClose=true`,
      { cache: "no-store" },
      9000
    );
    if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`);
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("Yahoo Finance returned no chart data");

    return NextResponse.json({
      ok: true,
      source: "Yahoo Finance",
      fetchedAt: new Date().toISOString(),
      symbol,
      meta: result.meta,
      timestamps: result.timestamp || [],
      quote: result.indicators?.quote?.[0] || {},
      adjustedClose: result.indicators?.adjclose?.[0]?.adjclose || []
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        source: "Yahoo Finance",
        error: "Yahoo Finance validation is temporarily unavailable.",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 200 }
    );
  }
}
