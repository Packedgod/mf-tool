import { NextResponse } from 'next/server';
import { getMarketUniverse } from '@/lib/universe';
import { managersForFund } from '@/lib/manager-registry';
import { resolveFundResearch } from '@/lib/fallback-sources';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 45;

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compactFund(fund) {
  return {
    id: fund.id,
    canonicalName: fund.canonicalName,
    displayName: fund.displayName,
    fundHouse: fund.fundHouse,
    category: fund.category,
    preferredSchemeCode: fund.preferredSchemeCode,
    preferredSchemeName: fund.preferredSchemeName,
    latestNav: fund.latestNav,
    navDate: fund.navDate,
    variants: fund.variants,
    managers: fund.managers,
    managerCoverage: fund.managerCoverage
  };
}

function publicManager(manager, fund) {
  return {
    id: manager.id || slugify(`${manager.name}-${fund.fundHouse}`),
    name: manager.name,
    aliases: manager.aliases || [],
    amc: manager.amc || fund.fundHouse,
    role: manager.role || 'Fund manager',
    startDate: manager.startDate || null,
    startLabel: manager.startLabel || null,
    // Scheme-level tenure parsed from AMC factsheets. This projection is a whitelist, so
    // without these two lines the dates reach the registry and then get dropped at the API
    // boundary, leaving manager stability permanently unrated.
    managingSince: manager.managingSince || null,
    managingSinceInception: Boolean(manager.managingSinceInception),
    style: manager.style || 'Scheme-level manager record resolved from a public fund source.',
    decisions: manager.decisions || ['Portfolio construction', 'Sector positioning', 'Entry and exit discipline', 'Risk control'],
    schemeAliases: [...new Set([...(manager.schemeAliases || []), fund.displayName, fund.preferredSchemeName].filter(Boolean))],
    assignmentStatus: manager.assignmentStatus || 'verified-fund-page',
    verified: manager.verified !== false,
    confidence: Number.isFinite(manager.confidence) ? manager.confidence : 0.85,
    source: manager.source || null,
    additionalSources: manager.additionalSources || [],
    sourceType: manager.sourceType || 'Public fund-page manager record',
    dynamic: true
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const schemeCode = searchParams.get('schemeCode');
  const fundId = searchParams.get('fundId');

  try {
    const universe = await getMarketUniverse();
    const fund = universe.families.find(item => item.id === fundId)
      || universe.families.find(item => item.variants?.some(variant => String(variant.schemeCode) === String(schemeCode)));

    if (!fund) {
      return NextResponse.json({ ok: false, error: 'Fund not found in the current AMFI universe.' }, { status: 404 });
    }

    let managers = managersForFund(fund).map(manager => publicManager(manager, fund));
    let research = null;

    if (!managers.length) {
      research = await resolveFundResearch(fund);
      managers = (research?.current?.managers || []).map(manager => publicManager({
        ...manager,
        amc: fund.fundHouse,
        confidence: 0.88,
        source: research.current.sources?.[0] ? {
          label: research.current.sources[0].name,
          url: research.current.sources[0].url,
          asOf: research.current.sources[0].asOf
        } : null,
        sourceType: 'Value Research Online / AdvisorKhoj fund-page record'
      }, fund));
    }

    const verifiedManagerCount = managers.length;
    if (!managers.length) {
      managers = [publicManager({
        id: `pending-manager-${fund.preferredSchemeCode}`,
        name: 'Manager verification pending',
        amc: fund.fundHouse,
        role: 'Fund remains available while manager sources are checked',
        style: 'No manager identity is inferred or copied from another scheme.',
        decisions: ['Manager identity pending', 'Official factsheet check', 'Value Research check', 'AdvisorKhoj check'],
        assignmentStatus: 'pending-source-resolution',
        verified: false,
        confidence: 0,
        sourceType: 'No verified manager source returned yet'
      }, fund)];
    }

    return NextResponse.json({
      ok: true,
      fund: compactFund(fund),
      managers,
      managerCoverage: verifiedManagerCount ? 'resolved' : 'pending-source-resolution',
      sources: research?.current?.sources || [],
      fetchedAt: new Date().toISOString()
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'The selected fund could not be bootstrapped into ManagerLens.',
      detail: error instanceof Error ? error.message : String(error)
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
