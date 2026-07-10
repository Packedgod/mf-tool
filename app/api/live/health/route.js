import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/upstream";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const result = await checkHealth();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        mfapi: "degraded",
        amfi: "degraded",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
