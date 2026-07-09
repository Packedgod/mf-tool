import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type AmfiNavRow = {
  schemeCode: string;
  isinDividendPayout?: string;
  isinGrowth?: string;
  schemeName: string;
  nav: number | null;
  date: string;
};

function parseAmfiNav(text: string): AmfiNavRow[] {
  const rows: AmfiNavRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/^\d+;/.test(line)) continue;
    const parts = line.split(";");
    if (parts.length < 6) continue;
    const nav = Number(parts[4]);
    rows.push({ schemeCode: parts[0], isinDividendPayout: parts[1] || undefined, isinGrowth: parts[2] || undefined, schemeName: parts[3], nav: Number.isFinite(nav) ? nav : null, date: parts[5] });
  }
  return rows;
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim().toLowerCase() || "";
  const limit = Number(request.nextUrl.searchParams.get("limit") || "25");

  try {
    const response = await fetch("https://portal.amfiindia.com/spages/NAVAll.txt", {
      cache: "no-store",
      headers: { "user-agent": "mf-live-manager-analytics/0.2" }
    });
    if (!response.ok) {
      return NextResponse.json({ error: "AMFI NAV feed request failed", status: response.status }, { status: 502 });
    }
    const text = await response.text();
    const allRows = parseAmfiNav(text);
    const filtered = q ? allRows.filter((row) => row.schemeName.toLowerCase().includes(q) || row.schemeCode.toLowerCase().includes(q)) : allRows;
    return NextResponse.json({ source: "AMFI NAVAll.txt", fetchedAt: new Date().toISOString(), query: q, count: filtered.length, results: filtered.slice(0, Number.isFinite(limit) ? limit : 25) });
  } catch (error) {
    return NextResponse.json({ error: "Unable to fetch AMFI NAV feed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
