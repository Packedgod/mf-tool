import { MANAGERS, SCHEME_LIST } from "@/lib/manager-data";
import { GENERATED_MANAGER_REGISTRY, GENERATED_REGISTRY_META } from "@/data/manager-registry.generated";
import { PRIORITY_MANAGER_REGISTRY } from "@/data/priority-managers";
import { VRO_MANAGER_REGISTRY, VRO_UNIVERSE_META } from "@/data/vro-universe.generated";

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function canonicalSchemeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(direct|regular)\s*(plan)?\b/g, " ")
    .replace(/\b(growth|idcw|dividend|bonus|payout|reinvestment|weekly|monthly|quarterly|annual)\b/g, " ")
    .replace(/\b(option|plan|dir|reg)\b/g, " ")
    .replace(/\bpru\b/g, "prudential")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseAmc(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/asset management company|asset management|mutual fund|amc|limited|ltd|private|pvt/g, " ")
    .replace(/\bpru\b/g, "prudential")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SCHEME_BY_ID = Object.fromEntries(SCHEME_LIST.map(item => [item.id, item]));

const SEED_RECORDS = MANAGERS.map(manager => {
  const scheme = SCHEME_BY_ID[manager.schemeId];
  return {
    ...manager,
    id: manager.id || slugify(manager.name),
    schemeAliases: scheme ? [scheme.name, ...(scheme.schemeQueries || [])] : [],
    sourceType: "Official AMC factsheet — manually verified",
    confidence: 1,
    verified: true
  };
});

function nameSet(record) {
  return new Set([record.name, ...(record.aliases || [])].map(slugify).filter(Boolean));
}

function sameManager(left, right) {
  const leftAmc = normaliseAmc(left.amc);
  const rightAmc = normaliseAmc(right.amc);
  if (leftAmc && rightAmc && leftAmc !== rightAmc && !leftAmc.includes(rightAmc) && !rightAmc.includes(leftAmc)) return false;
  const leftNames = nameSet(left);
  const rightNames = nameSet(right);
  return [...leftNames].some(name => rightNames.has(name));
}

function mergeSources(existing, incoming) {
  const list = [
    existing?.source,
    ...(existing?.additionalSources || []),
    incoming?.source,
    ...(incoming?.additionalSources || [])
  ].filter(item => item?.url);
  const byUrl = new Map(list.map(item => [item.url, item]));
  const values = [...byUrl.values()];
  return { source: values[0] || null, additionalSources: values.slice(1) };
}

function dedupeRegistry(records) {
  const merged = [];
  for (const record of records) {
    if (!record?.name || !record?.amc) continue;
    const index = merged.findIndex(existing => sameManager(existing, record));
    if (index < 0) {
      merged.push({
        ...record,
        id: record.id || slugify(`${record.name}-${record.amc}`),
        aliases: [...new Set(record.aliases || [])],
        schemeAliases: [...new Set(record.schemeAliases || record.schemeNames || [])]
      });
      continue;
    }
    const existing = merged[index];
    const sources = mergeSources(existing, record);
    merged[index] = {
      ...existing,
      ...record,
      ...sources,
      id: existing.id || record.id,
      aliases: [...new Set([existing.name, ...(existing.aliases || []), ...(record.aliases || [])].filter(name => name !== record.name))],
      schemeAliases: [...new Set([...(existing.schemeAliases || []), ...(record.schemeAliases || record.schemeNames || [])])],
      confidence: Math.max(existing.confidence || 0, record.confidence || 0),
      verified: Boolean(existing.verified || record.verified)
    };
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export const FULL_MANAGER_REGISTRY = dedupeRegistry([
  ...SEED_RECORDS,
  ...PRIORITY_MANAGER_REGISTRY,
  ...(VRO_MANAGER_REGISTRY || []).filter(record => (record.confidence || 0) >= 0.75 && record.source?.url),
  ...(GENERATED_MANAGER_REGISTRY || []).filter(record => (record.confidence || 0) >= 0.8 && record.source?.url)
]);

function aliasMatchesTarget(alias, target) {
  const candidate = canonicalSchemeName(alias);
  if (!candidate || !target) return false;
  return candidate === target || candidate.includes(target) || target.includes(candidate);
}

export function managersForFund({ schemeName, canonicalName, fundHouse }) {
  const target = canonicalName || canonicalSchemeName(schemeName);
  const targetAmc = normaliseAmc(fundHouse);
  return FULL_MANAGER_REGISTRY.filter(manager => {
    const managerAmc = normaliseAmc(manager.amc);
    if (targetAmc && managerAmc && !targetAmc.includes(managerAmc) && !managerAmc.includes(targetAmc)) return false;
    return (manager.schemeAliases || []).some(alias => aliasMatchesTarget(alias, target));
  });
}

export function fundsForManager(managerId, fundFamilies) {
  const manager = FULL_MANAGER_REGISTRY.find(item => item.id === managerId);
  if (!manager) return [];
  return (fundFamilies || []).filter(fund => managersForFund(fund).some(item => item.id === managerId));
}

export function fundsForManagerAmc(managerId, fundFamilies) {
  const manager = FULL_MANAGER_REGISTRY.find(item => item.id === managerId);
  if (!manager) return [];
  const targetAmc = normaliseAmc(manager.amc);
  return (fundFamilies || []).filter(fund => {
    const fundAmc = normaliseAmc(fund.fundHouse);
    return fundAmc.includes(targetAmc) || targetAmc.includes(fundAmc);
  });
}

export function managerRegistryStats() {
  return {
    totalManagers: FULL_MANAGER_REGISTRY.length,
    seedManagers: SEED_RECORDS.length,
    priorityManagers: PRIORITY_MANAGER_REGISTRY.length,
    valueResearchManagers: VRO_MANAGER_REGISTRY?.length || 0,
    generatedManagers: Math.max(0, FULL_MANAGER_REGISTRY.length - SEED_RECORDS.length - PRIORITY_MANAGER_REGISTRY.length),
    exactSchemeMappedManagers: FULL_MANAGER_REGISTRY.filter(item => item.schemeAliases?.length).length,
    generatedMeta: GENERATED_REGISTRY_META,
    valueResearchMeta: VRO_UNIVERSE_META
  };
}
