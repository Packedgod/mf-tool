import { MANAGERS, SCHEME_LIST } from "@/lib/manager-data";
import { GENERATED_MANAGER_REGISTRY, GENERATED_REGISTRY_META } from "@/data/manager-registry.generated";

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
    .replace(/\b(option|plan)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseAmc(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/asset management company|asset management|mutual fund|amc|limited|ltd|private|pvt/g, " ")
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

function dedupeRegistry(records) {
  const map = new Map();
  for (const record of records) {
    const key = `${slugify(record.name)}::${normaliseAmc(record.amc)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...record,
        id: record.id || slugify(`${record.name}-${record.amc}`),
        schemeAliases: [...new Set(record.schemeAliases || record.schemeNames || [])]
      });
      continue;
    }
    map.set(key, {
      ...existing,
      ...record,
      schemeAliases: [...new Set([...(existing.schemeAliases || []), ...(record.schemeAliases || record.schemeNames || [])])],
      confidence: Math.max(existing.confidence || 0, record.confidence || 0),
      verified: Boolean(existing.verified || record.verified)
    });
  }
  return [...map.values()];
}

export const FULL_MANAGER_REGISTRY = dedupeRegistry([
  ...SEED_RECORDS,
  ...(GENERATED_MANAGER_REGISTRY || []).filter(record => (record.confidence || 0) >= 0.8 && record.source?.url)
]);

export function managersForFund({ schemeName, canonicalName, fundHouse }) {
  const target = canonicalName || canonicalSchemeName(schemeName);
  const targetAmc = normaliseAmc(fundHouse);
  return FULL_MANAGER_REGISTRY.filter(manager => {
    const managerAmc = normaliseAmc(manager.amc);
    if (targetAmc && managerAmc && !targetAmc.includes(managerAmc) && !managerAmc.includes(targetAmc)) return false;
    return (manager.schemeAliases || []).some(alias => {
      const candidate = canonicalSchemeName(alias);
      return candidate === target || candidate.includes(target) || target.includes(candidate);
    });
  });
}

export function fundsForManager(managerId, fundFamilies) {
  const manager = FULL_MANAGER_REGISTRY.find(item => item.id === managerId);
  if (!manager) return [];
  return (fundFamilies || []).filter(fund => managersForFund(fund).some(item => item.id === managerId));
}

export function managerRegistryStats() {
  return {
    totalManagers: FULL_MANAGER_REGISTRY.length,
    seedManagers: SEED_RECORDS.length,
    generatedManagers: Math.max(0, FULL_MANAGER_REGISTRY.length - SEED_RECORDS.length),
    generatedMeta: GENERATED_REGISTRY_META
  };
}
