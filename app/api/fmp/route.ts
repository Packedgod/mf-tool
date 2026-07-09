import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RESOURCE_PATHS: Record<string, (symbol: string) => string> = {
  info: (symbol) => `/stable/etf/info?symbol=${encodeURIComponent(symbol)}`,
  holdings: (symbol) => `/stable/etf/holdings?symbol=${encodeURIComponent(symbol)}`,
  sector: (symbol) => `/stable/etf/sector-weightings?symbol=${encodeURIComponent(symbol)}`,
  country: (symbol) => `/stable/etf/country-weightings?symbol=${encodeURIComponent(symbol)}`,
  "asset-exposure": (symbol) => `/stable/etf/asset-exposure?symbol=${encodeURIComponent(symbol)}`,
  "disclosure-latest": (symbol) => `/stable/funds/disclosure-holders-latest?symbol=${encodeURIComponent(symbol)}`
};

export async function GET(request: NextRequest) {
  const apiKey = process.env.FMP_API_KEY;
  const resource = request.nextUrl.searchParams.get("resource") || "info";
  const symbol = request.nextUrl.searchParams.get("symbol") || "SPY";

  if (!apiKey) {
    return NextResponse.json({ error: "FMP_API_KEY is not configured.", setup: "Add FMP_API_KEY in Vercel Environment Variables or .env.local." }, { status: 400 });
  }

  let path: string;
  if (resource === "quotes") path = "/stable/batch-mutualfund-quotes";
  else {
    const builder = RESOURCE_PATHS[resource];
    if (!builder) return NextResponse.json({ error: `Unsupported FMP resource: ${resource}` }, { status: 400 });
    path = builder(symbol);
  }

  const separator = path.includes("?") ? "&" : "?";
  const url = `https://financialmodelingprep.com${path}${separator}apikey=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, { cache: "no-store", headers: { "user-agent": "mf-live-manager-analytics/0.2" } });
    if (!response.ok) return NextResponse.json({ error: "FMP request failed", status: response.status }, { status: 502 });
    const data = await response.json();
    return NextResponse.json({ source: "Financial Modeling Prep", fetchedAt: new Date().toISOString(), resource, symbol, data });
  } catch (error) {
    return NextResponse.json({ error: "Unable to fetch FMP data", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
