import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol")?.trim();
  const modules = request.nextUrl.searchParams.get("modules") || "summaryDetail,fundProfile,topHoldings,defaultKeyStatistics,assetProfile";
  if (!symbol) return NextResponse.json({ error: "Missing symbol parameter." }, { status: 400 });

  try {
    const response = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}`, {
      cache: "no-store",
      headers: { "user-agent": "Mozilla/5.0 mf-manager-analytics" }
    });
    if (!response.ok) return NextResponse.json({ error: "Yahoo summary failed", status: response.status }, { status: 502 });
    const data = await response.json();
    return NextResponse.json({ source: "Yahoo Finance", fetchedAt: new Date().toISOString(), symbol, data });
  } catch (error) {
    return NextResponse.json({ error: "Unable to fetch Yahoo summary", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
