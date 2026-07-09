import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "Missing q parameter." }, { status: 400 });

  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`, {
      cache: "no-store",
      headers: { "user-agent": "Mozilla/5.0 mf-manager-analytics" }
    });
    if (!response.ok) return NextResponse.json({ error: "Yahoo search failed", status: response.status }, { status: 502 });
    const data = await response.json();
    return NextResponse.json({ source: "Yahoo Finance", fetchedAt: new Date().toISOString(), data });
  } catch (error) {
    return NextResponse.json({ error: "Unable to fetch Yahoo search", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
