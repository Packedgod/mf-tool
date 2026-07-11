import { NextResponse } from 'next/server';
import { health } from '@/lib/upstream';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PORTFOLIO_TABS_BUILD = '2026-07-11-resilient-portfolio-v2';

export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      portfolioTabsBuild: PORTFOLIO_TABS_BUILD,
      deploymentHost: process.env.VERCEL_URL || null,
      ...await health()
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      portfolioTabsBuild: PORTFOLIO_TABS_BUILD,
      deploymentHost: process.env.VERCEL_URL || null,
      mfapi: 'degraded',
      amfi: 'degraded',
      detail: error instanceof Error ? error.message : String(error)
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }
}
