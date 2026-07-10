import { NextResponse } from "next/server";
import { MANAGERS, SCHEME_LIST } from "@/lib/manager-data";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    sourceType: "Verified official AMC factsheet registry",
    managers: MANAGERS,
    schemes: SCHEME_LIST,
    generatedAt: new Date().toISOString()
  });
}
