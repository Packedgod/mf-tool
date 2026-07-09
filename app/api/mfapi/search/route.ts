import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "Missing q search parameter." }, { status: 400 });

  try {
    const response = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`, {
      cache: "no-store",
      headers: { "user-agent": "mf-live-manager-analytics/0.2" }
    });
    if (!response.ok) {
      return NextResponse.json({ error: "MFapi search failed", status: response.status }, { status: 502 });
    }
    const data = await response.json();
    return NextResponse.json({ source: "MFapi.in", fetchedAt: new Date().toISOString(), query: q, results: Array.isArray(data) ? data : [] });
  } catch (error) {
    return NextResponse.json({ error: "Unable to fetch MFapi search", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
