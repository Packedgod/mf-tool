import { NextResponse } from "next/server";
import { getMarketUniverse, searchUniverse } from "@/lib/universe";
import {
  FULL_MANAGER_REGISTRY,
  fundsForManager,
  fundsForManagerAmc,
  managerRegistryStats
} from "@/lib/manager-registry";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function publicManager(manager) {
  return {
    id: manager.id,
    name: manager.name,
    aliases: manager.aliases || [],
    amc: manager.amc,
    role: manager.role,
    startDate: manager.startDate || null,
    startLabel: manager.startLabel || null,
    // Kept in step with the same projection in fund-bootstrap: this is a whitelist, so
    // factsheet tenure is lost here unless it is named explicitly.
    managingSince: manager.managingSince || null,
    managingSinceInception: Boolean(manager.managingSinceInception),
    style: manager.style || null,
    decisions: manager.decisions || [],
    schemeAliases: manager.schemeAliases || [],
    assignmentStatus: manager.assignmentStatus || (manager.schemeAliases?.length ? "verified" : "pending-official-factsheet"),
    verified: manager.verified !== false,
    confidence: manager.confidence || 0,
    source: manager.source || null,
    additionalSources: manager.additionalSources || [],
    sourceType: manager.sourceType || null,
    schemeId: manager.schemeId || null
  };
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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const view = searchParams.get("view") || "funds";

  try {
    const universe = await getMarketUniverse();

    if (view === "stats") {
      return NextResponse.json({
        ok: true,
        stats: universe.stats,
        source: universe.source,
        fetchedAt: universe.fetchedAt,
        stale: universe.stale || false
      }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
    }

    if (view === "managers") {
      const query = String(searchParams.get("q") || "").trim().toLowerCase();
      const managers = FULL_MANAGER_REGISTRY
        .map(publicManager)
        .filter(manager => !query || [
          manager.name,
          ...manager.aliases,
          manager.amc,
          manager.role,
          ...manager.schemeAliases
        ].join(" ").toLowerCase().includes(query));

      return NextResponse.json({
        ok: true,
        managers,
        stats: managerRegistryStats(),
        fetchedAt: universe.fetchedAt
      }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
    }

    if (view === "search") {
      const rawQuery = String(searchParams.get("q") || "").trim();
      const query = rawQuery.toLowerCase().replace(/^amfi(?:\s+scheme)?\s*[:#-]?\s*/i, "");
      if (!query) {
        return NextResponse.json({ ok: true, funds: [], managers: [], totalFunds: 0, totalManagers: 0, fetchedAt: universe.fetchedAt });
      }
      const fundResult = searchUniverse(universe, { query, limit: 10, offset: 0 });
      const managers = FULL_MANAGER_REGISTRY
        .map(publicManager)
        .filter(manager => [
          manager.name,
          ...manager.aliases,
          manager.amc,
          manager.role,
          ...manager.schemeAliases
        ].join(" ").toLowerCase().includes(query))
        .sort((a, b) => {
          const aName = a.name.toLowerCase();
          const bName = b.name.toLowerCase();
          const managerScore = name => name === query ? 3 : name.startsWith(query) ? 2 : 1;
          return managerScore(bName) - managerScore(aName) || a.name.localeCompare(b.name);
        });

      return NextResponse.json({
        ok: true,
        funds: fundResult.results.map(compactFund),
        managers: managers.slice(0, 8),
        totalFunds: fundResult.total,
        totalManagers: managers.length,
        source: universe.source,
        fetchedAt: universe.fetchedAt,
        stale: universe.stale || false
      }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
    }

    if (view === "managerFunds") {
      const managerId = searchParams.get("managerId");
      const manager = FULL_MANAGER_REGISTRY.find(item => item.id === managerId);
      if (!manager) return NextResponse.json({ ok: false, error: "Manager not found." }, { status: 404 });
      const exactFunds = fundsForManager(managerId, universe.families).map(compactFund);
      const amcFunds = fundsForManagerAmc(managerId, universe.families).map(compactFund);
      return NextResponse.json({
        ok: true,
        manager: publicManager(manager),
        exactFunds,
        amcFunds,
        exactCount: exactFunds.length,
        amcCount: amcFunds.length,
        fetchedAt: universe.fetchedAt
      }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
    }

    const result = searchUniverse(universe, {
      query: searchParams.get("q") || "",
      fundHouse: searchParams.get("fundHouse") || "",
      managerOnly: searchParams.get("managerOnly") === "true",
      limit: searchParams.get("limit") || 100,
      offset: searchParams.get("offset") || 0
    });

    return NextResponse.json({
      ok: true,
      ...result,
      stats: universe.stats,
      source: universe.source,
      fetchedAt: universe.fetchedAt,
      stale: universe.stale || false,
      warning: universe.warning || null
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: "The AMFI all-funds universe could not be loaded.",
      detail: error instanceof Error ? error.message : String(error)
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
