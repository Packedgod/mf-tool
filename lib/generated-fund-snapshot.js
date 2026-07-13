import { canonicalSchemeName, normaliseAmc } from '@/lib/manager-registry';
import { VRO_FUND_INTELLIGENCE } from '@/data/vro-universe.generated';

const INDEX = Object.entries(VRO_FUND_INTELLIGENCE || {}).map(([key, record]) => {
  const current = record?.current || {};
  const valueResearch = current.valueResearch || {};
  return {
    key,
    canonicalKey: canonicalSchemeName(key),
    fundName: valueResearch.fundName || key,
    fundHouse: valueResearch.fundHouse || current.fundHouse || '',
    record
  };
});

function tokens(value) {
  return canonicalSchemeName(value)
    .replace(/\b(fund|scheme|option|growth|direct|regular|plan|idcw|dividend|payout|reinvestment|income distribution cum capital withdrawal)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(token => token.length > 1);
}

function score(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  const containment = [...a].every(token => b.has(token)) || [...b].every(token => a.has(token));
  return intersection / Math.max(a.size, b.size) + (containment ? 0.15 : 0);
}

function candidateNames(fund) {
  return [...new Set([
    fund?.canonicalName,
    fund?.displayName,
    fund?.preferredSchemeName,
    ...(fund?.researchAliases || []),
    ...(fund?.variants || []).map(item => item.schemeName)
  ].filter(Boolean))];
}

function matchRecord(fund) {
  const names = candidateNames(fund);
  const canonical = names.map(canonicalSchemeName).filter(Boolean);
  for (const name of canonical) {
    if (VRO_FUND_INTELLIGENCE[name]) {
      return { key: name, record: VRO_FUND_INTELLIGENCE[name], score: 1, type: 'exact' };
    }
  }

  const targetAmc = normaliseAmc(fund?.fundHouse || '');
  let best = null;
  for (const item of INDEX) {
    const itemAmc = normaliseAmc(item.fundHouse || '');
    if (targetAmc && itemAmc && targetAmc !== itemAmc && !targetAmc.includes(itemAmc) && !itemAmc.includes(targetAmc)) continue;
    const itemScore = Math.max(0, ...names.map(name => Math.max(score(name, item.canonicalKey), score(name, item.fundName))));
    if (!best || itemScore > best.score) best = { key: item.key, record: item.record, score: itemScore, type: 'fuzzy' };
  }
  return best?.score >= 0.58 ? best : null;
}

function firstRows(...values) {
  return values.find(value => Array.isArray(value) && value.length) || [];
}

function normaliseHoldings(rows) {
  const map = new Map();
  for (const item of rows || []) {
    const name = String(item?.name || item?.company || '').replace(/\s+/g, ' ').trim();
    const weight = Number(item?.weight ?? item?.percentage ?? item?.allocation);
    if (!name || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const current = map.get(key);
    if (!current || weight > current.weight) {
      map.set(key, {
        ...item,
        name,
        weight: Number(weight.toFixed(4)),
        sector: item?.sector || item?.industry || null
      });
    }
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight).slice(0, 50);
}

function normaliseSectors(rows) {
  const map = new Map();
  for (const item of rows || []) {
    const sector = String(item?.sector || item?.name || '').replace(/\s+/g, ' ').trim();
    const weight = Number(item?.weight ?? item?.percentage ?? item?.allocation);
    if (!sector || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    map.set(sector, (map.get(sector) || 0) + weight);
  }
  return [...map.entries()]
    .map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)) }))
    .sort((a, b) => b.weight - a.weight);
}

function deriveSectors(holdings) {
  const grouped = new Map();
  for (const item of holdings || []) {
    const sector = String(item?.sector || '').trim();
    if (!sector) continue;
    grouped.set(sector, (grouped.get(sector) || 0) + Number(item.weight || 0));
  }
  const rows = [...grouped.entries()]
    .map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)) }))
    .filter(item => item.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  if (rows.length) return rows;
  const total = (holdings || []).reduce((sum, item) => sum + Number(item.weight || 0), 0);
  return total > 0 ? [{ sector: 'Sector classification pending', weight: Number(total.toFixed(4)), classificationPending: true }] : [];
}

function snapshotRows(snapshot) {
  if (!snapshot) return { holdings: [], sectors: [] };
  const valueResearch = snapshot.valueResearch || {};
  const advisorKhoj = snapshot.advisorKhoj || {};
  const holdings = normaliseHoldings(firstRows(snapshot.holdings, valueResearch.holdings, advisorKhoj.holdings));
  let sectors = normaliseSectors(firstRows(snapshot.sectors, advisorKhoj.sectors, valueResearch.sectors));
  if (!sectors.length) sectors = deriveSectors(holdings);
  return { holdings, sectors };
}

function holdingKey(value) {
  return String(value || '').toLowerCase().replace(/\b(limited|ltd|company|co)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function compareHoldings(current, previous) {
  if (!previous?.length) return { entries: [], exits: [] };
  const currentMap = new Map(current.map(item => [holdingKey(item.name), item]));
  const previousMap = new Map(previous.map(item => [holdingKey(item.name), item]));
  const entries = [];
  const exits = [];

  for (const [key, item] of currentMap) {
    const before = previousMap.get(key);
    const previousWeight = Number(before?.weight || 0);
    const currentWeight = Number(item.weight || 0);
    const changeWeightPct = currentWeight - previousWeight;
    if (!before || changeWeightPct >= 0.35) {
      entries.push({
        ...item,
        action: before ? 'increased' : 'new',
        previousWeight,
        currentWeight,
        changeWeightPct: Number(changeWeightPct.toFixed(4)),
        ok: false,
        error: 'Price-path enrichment is loading; portfolio change is sourced from dated disclosures.'
      });
    }
  }

  for (const [key, item] of previousMap) {
    const after = currentMap.get(key);
    const previousWeight = Number(item.weight || 0);
    const currentWeight = Number(after?.weight || 0);
    const changeWeightPct = currentWeight - previousWeight;
    if (!after || changeWeightPct <= -0.35) {
      exits.push({
        ...item,
        action: after ? 'reduced' : 'exited',
        previousWeight,
        currentWeight,
        changeWeightPct: Number(changeWeightPct.toFixed(4)),
        ok: false,
        error: 'Price-path enrichment is loading; portfolio change is sourced from dated disclosures.'
      });
    }
  }

  return { entries, exits };
}

function sourcesFor(current) {
  const rows = [...(current?.sources || [])];
  const valueResearch = current?.valueResearch;
  const advisorKhoj = current?.advisorKhoj;
  if (valueResearch?.url && !rows.some(item => item.url === valueResearch.url)) {
    rows.push({
      name: 'Value Research Online',
      type: 'Generated source-synchronised manager and portfolio snapshot',
      url: valueResearch.url,
      asOf: valueResearch.navDate || valueResearch.fetchedAt || null
    });
  }
  if (advisorKhoj?.url && !rows.some(item => item.url === advisorKhoj.url)) {
    rows.push({
      name: 'AdvisorKhoj',
      type: 'Generated source-synchronised fund and portfolio snapshot',
      url: advisorKhoj.url,
      asOf: advisorKhoj.navDate || advisorKhoj.fetchedAt || null
    });
  }
  return rows.filter(item => item?.name || item?.url);
}

export function generatedFundSnapshot(fund) {
  const match = matchRecord(fund);
  if (!match?.record) {
    return {
      ok: false,
      error: 'No generated Value Research or AdvisorKhoj snapshot matches this fund family.'
    };
  }

  const record = match.record;
  const current = record.current || {};
  const previous = record.previous || null;
  const currentRows = snapshotRows(current);
  const previousRows = snapshotRows(previous);
  const changes = compareHoldings(currentRows.holdings, previousRows.holdings);
  const managers = firstRows(current.managers, current.valueResearch?.managers, record.managers);
  const snapshotCount = previousRows.holdings.length ? 2 : currentRows.holdings.length ? 1 : 0;
  const resolvedPct = currentRows.holdings.length && currentRows.sectors.length ? 70 : currentRows.holdings.length ? 55 : 0;

  return {
    ok: Boolean(currentRows.holdings.length || currentRows.sectors.length),
    fund: {
      id: fund.id,
      displayName: fund.displayName,
      fundHouse: fund.fundHouse,
      category: fund.category,
      preferredSchemeCode: fund.preferredSchemeCode
    },
    managers,
    holdings: currentRows.holdings,
    sectors: currentRows.sectors,
    entries: changes.entries,
    exits: changes.exits,
    fundFacts: {
      turnoverPct: current.turnoverPct ?? current.valueResearch?.turnoverPct ?? current.advisorKhoj?.turnoverPct,
      benchmark: current.benchmark || current.valueResearch?.benchmark || current.advisorKhoj?.benchmark,
      expenseRatioPct: current.expenseRatioPct ?? current.valueResearch?.expenseRatioPct ?? current.advisorKhoj?.expenseRatioPct,
      aumCr: current.aumCr ?? current.valueResearch?.aumCr ?? current.advisorKhoj?.aumCr,
      riskMetrics: current.riskMetrics || current.advisorKhoj?.riskMetrics || null,
      assetAllocation: current.assetAllocation || current.valueResearch?.assetAllocation || [],
      marketCap: current.marketCap || current.valueResearch?.marketCap || []
    },
    snapshot: {
      holdings: currentRows.holdings,
      sectorWeights: currentRows.sectors,
      assetAllocation: current.assetAllocation || current.valueResearch?.assetAllocation || [],
      marketCap: current.marketCap || current.valueResearch?.marketCap || [],
      currentAsOf: current.portfolioAsOf || current.valueResearch?.navDate || current.advisorKhoj?.navDate || current.fetchedAt || null,
      previousAsOf: previous?.portfolioAsOf || previous?.valueResearch?.navDate || previous?.advisorKhoj?.navDate || previous?.fetchedAt || null,
      snapshotCount,
      comparisonMode: snapshotCount >= 2 ? 'generated-disclosure-comparison' : 'generated-current-baseline',
      sectorBasis: currentRows.sectors.some(item => item.classificationPending)
        ? 'Latest disclosed holdings are loaded; sector classification is pending source enrichment.'
        : 'Latest source-synchronised sector allocation snapshot.',
      factsheetLabel: 'Source-synchronised Value Research Online / AdvisorKhoj snapshot'
    },
    coverage: {
      requestedSymbols: currentRows.holdings.length + currentRows.sectors.length,
      resolvedSymbols: currentRows.holdings.length + currentRows.sectors.length,
      resolvedPct,
      sectorSeries: currentRows.sectors.length,
      entrySeries: changes.entries.length,
      exitSeries: changes.exits.length,
      baselineEstablished: snapshotCount === 1,
      snapshotCount,
      comparisonMode: snapshotCount >= 2 ? 'generated-disclosure-comparison' : 'generated-current-baseline'
    },
    sources: sourcesFor(current),
    sourceDiagnostics: {
      generatedSnapshot: true,
      registryMatch: { key: match.key, score: match.score, type: match.type },
      holdings: currentRows.holdings.length,
      sectors: currentRows.sectors.length,
      entries: changes.entries.length,
      exits: changes.exits.length
    },
    generatedAt: record.generatedAt || current.fetchedAt || null,
    engineVersion: '1.3.0-generated-snapshot'
  };
}
