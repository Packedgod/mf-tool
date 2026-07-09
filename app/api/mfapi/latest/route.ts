import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim();
  if (!code) return NextResponse.json({ error: "Missing code parameter." }, { status: 400 });

  try {
    const response = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(code)}/latest`, {
      cache: "no-store",
      headers: { "user-agent": "mf-live-manager-analytics/0.2" }
    });
    if (!response.ok) {
      return NextResponse.json({ error: "MFapi latest NAV failed", status: response.status }, { status: 502 });
    }
    const data = await response.json();
    return NextResponse.json({ source: "MFapi.in", fetchedAt: new Date().toISOString(), ...data });
  } catch (error) {
    return NextResponse.json({ error: "Unable to fetch MFapi latest NAV", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
