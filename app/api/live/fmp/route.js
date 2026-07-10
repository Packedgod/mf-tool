import { NextResponse } from "next/server";
import { fetchWithTimeout } from "@/lib/upstream";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RESOURCE_PATHS = {
  info: (symbol) => `/stable/etf/info?symbol=${encodeURIComponent(symbol)}`,
  holdings: (symbol) => `/stable/etf/holdings?symbol=${encodeURIComponent(symbol)}`,
  sector: (symbol) => `/stable/etf/sector-weightings?symbol=${encodeURIComponent(symbol)}`,
  country: (symbol) => `/stable/etf/country-weightings?symbol=${encodeURIComponent(symbol)}`
};

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const apiKey = process.env.FMP_API_KEY;
  const symbol = searchParams.get("symbol") || "SPY";
  const resource = searchParams.get("resource") || "info";

  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      configured: false,
      source: "Financial Modeling Prep",
      error: "FMP_API_KEY is not configured. Indian MF analysis continues through MFapi and AMFI."
    });
  }

  const builder = RESOURCE_PATHS[resource];
  if (!builder) return NextResponse.json({ ok: false, error: "Unsupported FMP resource." }, { status: 400 });

  try {
    const path = builder(symbol);
    const response = await fetchWithTimeout(
      `https://financialmodelingprep.com${path}&apikey=${encodeURIComponent(apiKey)}`,
      { cache: "no-store" },
      9000
    );
    if (!response.ok) throw new Error(`FMP returned ${response.status}`);
    const data = await response.json();
    return NextResponse.json({ ok: true, configured: true, source: "Financial Modeling Prep", fetchedAt: new Date().toISOString(), data });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      configured: true,
      source: "Financial Modeling Prep",
      error: "FMP validation is temporarily unavailable.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}
