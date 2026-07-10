import { CYCLE_PROFILES, MOMENTUM_WEIGHTS } from "@/lib/momentum-data";
import { EXTENDED_CYCLE_PROFILES } from "@/lib/extended-momentum-data";

const ALL_CYCLE_PROFILES = { ...CYCLE_PROFILES, ...EXTENDED_CYCLE_PROFILES };
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const average = values => {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : undefined;
};
const weightedAverage = rows => {
  const clean = rows.filter(row => Number.isFinite(row.value) && Number.isFinite(row.weight) && row.weight > 0);
  const total = clean.reduce((sum, row) => sum + row.weight, 0);
  return total ? clean.reduce((sum, row) => sum + row.value * row.weight, 0) / total : undefined;
};

function scoreSectorBias(snapshot, market) {
  const sectorMap = new Map((market?.sectors || []).map(item => [item.sector, item]));
  const rows = (snapshot?.sectorWeights || []).map(item => {
    const live = sectorMap.get(item.sector);
    return { value: live?.return3mPct, weight: item.weight };
  });
  const weightedMomentum = weightedAverage(rows);
  if (!Number.isFinite(weightedMomentum)) return { score: 50, available: false, value: undefined };
  const topThree = [...(snapshot.sectorWeights || [])].sort((a, b) => b.weight - a.weight).slice(0, 3).reduce((sum, item) => sum + item.weight, 0);
  const concentrationPenalty = Math.max(0, topThree - 55) * 0.45;
  return {
    score: clamp(50 + weightedMomentum * 2.5 - concentrationPenalty),
    available: true,
    value: weightedMomentum,
    detail: `Weighted 3-month sector momentum ${weightedMomentum.toFixed(2)}%; top-three sector concentration ${topThree.toFixed(1)}%.`
  };
}

function scoreSectorMovement(snapshot, market) {
  const sectorMap = new Map((market?.sectors || []).map(item => [item.sector, item]));
  const history = snapshot?.sectorHistory || [];
  const usableHistory = history.filter(item => (item.values || []).length >= 2);
  if (!usableHistory.length) {
    const bias = scoreSectorBias(snapshot, market);
    return {
      score: bias.available ? clamp(bias.score * 0.92 + 4) : 50,
      available: false,
      value: bias.value,
      detail: "A current sector book is available, but two distinct allocation snapshots are required before sector-movement timing is scored as observed evidence."
    };
  }

  const timingRows = usableHistory.map(item => {
    const values = item.values || [];
    const change = values.at(-1) - values.at(-2);
    const momentum = sectorMap.get(item.sector)?.return3mPct;
    return { sector: item.sector, change, momentum, contribution: Number.isFinite(momentum) ? change * momentum : undefined };
  });
  const contribution = average(timingRows.map(item => item.contribution));
  return {
    score: Number.isFinite(contribution) ? clamp(50 + contribution * 3.2) : 50,
    available: Number.isFinite(contribution),
    value: contribution,
    rows: timingRows,
    detail: Number.isFinite(contribution)
      ? `Recent sector-weight changes produced an average timing contribution of ${contribution.toFixed(2)}.`
      : "Sector movement could not be aligned with live market data."
  };
}

function scoreEntries(market) {
  const resolved = (market?.entries || []).filter(item => item.ok && Number.isFinite(item.returnSinceEventPct));
  if (!resolved.length) return { score: 50, available: false, rows: market?.entries || [], detail: "No price-resolved stock entries are available for this disclosure period." };
  const raw = average(resolved.map(item => clamp(50 + item.returnSinceEventPct * 2 + (item.peakProximityPct - 80) * 0.5)));
  return {
    score: clamp(raw),
    available: true,
    rows: market.entries,
    detail: `${resolved.length} entry decisions were matched to live Yahoo Finance price histories.`
  };
}

function scoreExits(market) {
  const resolved = (market?.exits || []).filter(item => item.ok && Number.isFinite(item.postEventReturnPct));
  if (!resolved.length) return { score: 50, available: false, rows: market?.exits || [], detail: "No price-resolved stock exits are available for this disclosure period." };
  const raw = average(resolved.map(item => clamp(50 - item.postEventReturnPct * 2.2)));
  return {
    score: clamp(raw),
    available: true,
    rows: market.exits,
    detail: `${resolved.length} exits were checked against price movement after the approximate disclosure date.`
  };
}

function scoreExitPeak(market) {
  const resolved = (market?.exits || []).filter(item => item.ok && Number.isFinite(item.peakProximityPct));
  if (!resolved.length) return { score: 50, available: false, rows: market?.exits || [], detail: "Peak proximity requires a resolvable stock symbol and a confirmed exit period." };
  const score = average(resolved.map(item => clamp(item.peakProximityPct)));
  return {
    score: clamp(score),
    available: true,
    rows: market.exits,
    detail: `Average exit price was ${score.toFixed(1)}% of the local ±45 trading-day peak.`
  };
}

function turnoverBand(schemeId) {
  if (schemeId === "icici-baf") return [120, 340];
  if (schemeId === "icici-multi-asset") return [80, 260];
  if (schemeId === "icici-business-cycle") return [55, 170];
  if (schemeId === "icici-india-opportunities") return [35, 120];
  if (schemeId === "sbi-small") return [5, 55];
  if (schemeId === "ppfas-flexi") return [5, 45];
  return [5, 80];
}

function scoreTurnover(snapshot, traditional, schemeId) {
  const turnover = snapshot?.turnover?.equityPct;
  if (!Number.isFinite(turnover)) return { score: 50, available: false, value: undefined, detail: "Turnover is not available from the current source snapshot." };
  const [low, high] = turnoverBand(schemeId);
  let discipline;
  if (turnover >= low && turnover <= high) discipline = 85;
  else if (turnover < low) discipline = clamp(85 - (low - turnover) * 1.6);
  else discipline = clamp(85 - (turnover - high) * 0.35);
  const active = traditional?.activeReturnPct;
  const efficiencyAdjustment = Number.isFinite(active) ? clamp(active * 2.5, -20, 20) : 0;
  return {
    score: clamp(discipline + efficiencyAdjustment),
    available: true,
    value: turnover,
    detail: `${turnover.toFixed(2)}% equity turnover versus a style-aware ${low}–${high}% operating band; active-return adjustment ${efficiencyAdjustment.toFixed(1)} points.`
  };
}

function scoreCycleFit(schemeId, market) {
  const profile = ALL_CYCLE_PROFILES[schemeId];
  const regime = market?.regime?.id || "neutral";
  const score = profile?.[regime] ?? profile?.neutral ?? 50;
  return {
    score,
    available: Boolean(market?.regime),
    value: regime,
    label: profile?.label || "Unclassified runner",
    detail: `${profile?.label || "Manager style"} evaluated for the current ${market?.regime?.label || "neutral"} market regime.`
  };
}

function traditionalFactors(metrics) {
  const alpha = Number.isFinite(metrics?.alphaPct) ? clamp(50 + metrics.alphaPct * 5) : 50;
  const information = Number.isFinite(metrics?.informationRatio) ? clamp(50 + metrics.informationRatio * 28) : 50;
  const alphaInformationRatio = average([alpha, information]) ?? 50;

  const sharpe = Number.isFinite(metrics?.sharpe) ? clamp(45 + metrics.sharpe * 25) : 50;
  const downside = Number.isFinite(metrics?.downCapturePct) ? clamp(120 - metrics.downCapturePct) : 50;
  const sharpeDownside = average([sharpe, downside]) ?? 50;

  const drawdownControl = Number.isFinite(metrics?.maxDrawdownPct) ? clamp(100 + metrics.maxDrawdownPct * 2) : 50;
  const persistence = Number.isFinite(metrics?.alphaPersistenceScore) ? clamp(metrics.alphaPersistenceScore) : 50;
  const valueAddPct = Number.isFinite(metrics?.managerValueAddNav) && Number.isFinite(metrics?.startNav) && metrics.startNav !== 0
    ? metrics.managerValueAddNav / metrics.startNav * 100
    : undefined;
  const managerValueAdd = Number.isFinite(valueAddPct) ? clamp(50 + valueAddPct * 4) : 50;

  return {
    alphaInformationRatio: { score: alphaInformationRatio, available: Number.isFinite(metrics?.alphaPct) || Number.isFinite(metrics?.informationRatio) },
    sharpeDownside: { score: sharpeDownside, available: Number.isFinite(metrics?.sharpe) || Number.isFinite(metrics?.downCapturePct) },
    drawdownControl: { score: drawdownControl, available: Number.isFinite(metrics?.maxDrawdownPct) },
    persistence: { score: persistence, available: Number.isFinite(metrics?.alphaPersistenceScore) },
    managerValueAdd: { score: managerValueAdd, available: Number.isFinite(valueAddPct), value: valueAddPct }
  };
}

function horseSignal(overall, momentum, cycleFit, coverage) {
  const effective = overall * (0.75 + coverage * 0.25);
  if (effective >= 78 && cycleFit >= 75) return { label: "Strong track fit", action: "Front of the field", tone: "strong" };
  if (effective >= 66) return { label: "Selective track fit", action: "Back only in a matching cycle", tone: "positive" };
  if (effective >= 54) return { label: "Watch the track", action: "Wait for better sector confirmation", tone: "watch" };
  return { label: "Poor track fit", action: "Stay on the sidelines", tone: "risk" };
}

export function calculateManagerScore({ schemeId, snapshot, market, traditional }) {
  const factors = {
    sectorBias: scoreSectorBias(snapshot, market),
    sectorMomentum: scoreSectorMovement(snapshot, market),
    entryTiming: scoreEntries(market),
    exitTiming: scoreExits(market),
    exitPeakProximity: scoreExitPeak(market),
    turnoverEfficiency: scoreTurnover(snapshot, traditional, schemeId),
    cycleFit: scoreCycleFit(schemeId, market),
    ...traditionalFactors(traditional)
  };

  const entries = Object.entries(MOMENTUM_WEIGHTS).map(([key, weight]) => ({ key, weight, factor: factors[key] || { score: 50, available: false } }));
  const overall = entries.reduce((sum, item) => sum + clamp(item.factor.score) * item.weight / 100, 0);
  const momentumKeys = ["sectorBias", "sectorMomentum", "entryTiming", "exitTiming", "exitPeakProximity", "turnoverEfficiency", "cycleFit"];
  const traditionalKeys = ["alphaInformationRatio", "sharpeDownside", "drawdownControl", "persistence", "managerValueAdd"];
  const momentumScore = entries.filter(item => momentumKeys.includes(item.key)).reduce((sum, item) => sum + clamp(item.factor.score) * item.weight / 75, 0);
  const traditionalScore = entries.filter(item => traditionalKeys.includes(item.key)).reduce((sum, item) => sum + clamp(item.factor.score) * item.weight / 25, 0);
  const availableWeight = entries.filter(item => item.factor.available).reduce((sum, item) => sum + item.weight, 0);
  const coverage = availableWeight / 100;
  const horse = horseSignal(overall, momentumScore, factors.cycleFit.score, coverage);

  const insights = [
    Number.isFinite(factors.sectorBias.value)
      ? `Current sector book has a ${factors.sectorBias.value.toFixed(2)}% weighted three-month momentum reading.`
      : "Sector-market alignment is waiting for live market data.",
    factors.sectorMomentum.detail,
    factors.turnoverEfficiency.detail,
    factors.exitPeakProximity.detail,
    `Momentum/timing contributes 75% of the final score; traditional alpha and risk metrics contribute 25%.`
  ];

  return {
    overall: clamp(overall),
    momentumScore: clamp(momentumScore),
    traditionalScore: clamp(traditionalScore),
    coveragePct: coverage * 100,
    weights: MOMENTUM_WEIGHTS,
    factors,
    horse,
    insights
  };
}
