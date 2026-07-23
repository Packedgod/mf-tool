import { calculateManagerScore as calculatePrototypeDiagnostics } from '@/lib/momentum-engine';
import { weightedFundamental } from '@/lib/fundamental-weighting';

const CONFIDENCE_WEIGHTS = {
  dataCompleteness: 30,
  historyLength: 25,
  benchmarkQuality: 20,
  inferenceQuality: 15,
  modelStability: 10
};

const EQUITY_QUALITY_PILLARS = [
  ['riskAdjustedAlpha', 'Risk-adjusted manager alpha', 18],
  ['skillPersistence', 'Skill persistence', 12],
  ['downsideProtection', 'Downside protection', 12],
  ['stockSelection', 'Stock-selection skill', 10],
  ['sectorAllocation', 'Sector and factor allocation skill', 8],
  ['tradingExecution', 'Trading and execution skill', 8],
  ['portfolioConstruction', 'Portfolio construction quality', 8],
  ['costEfficiency', 'Cost efficiency', 7],
  ['liquidityCapacity', 'Liquidity and capacity', 5],
  ['managerStability', 'Manager and process stability', 5],
  ['holdingsQuality', 'Current holdings quality', 4],
  ['regimeResilience', 'Regime resilience', 3]
];

const DEBT_QUALITY_PILLARS = [
  ['durationManagement', 'Duration-management skill', 15],
  ['creditSelection', 'Credit-selection skill', 15],
  ['yieldCarryEfficiency', 'Yield and carry efficiency', 12],
  ['rollDownCapture', 'Roll-down capture', 8],
  ['creditEventControl', 'Credit downgrade/default control', 12],
  ['liquidityRisk', 'Liquidity risk management', 10],
  ['issuerConcentration', 'Issuer concentration control', 8],
  ['ytmRealisation', 'Portfolio YTM versus realised return', 8],
  ['costEfficiency', 'Expense and implementation efficiency', 7],
  ['stressBehaviour', 'Stress-period behaviour', 5]
];

const HYBRID_QUALITY_PILLARS = [
  ['equitySleeve', 'Equity sleeve quality', 18],
  ['debtSleeve', 'Debt sleeve quality', 16],
  ['assetAllocation', 'Asset-allocation skill', 18],
  ['rebalancing', 'Rebalancing discipline', 12],
  ['derivativeUse', 'Derivative usage and hedge quality', 8],
  ['downsideProtection', 'Downside protection', 12],
  ['sleeveInteraction', 'Equity/debt interaction', 8],
  ['taxCostEfficiency', 'Tax and cost efficiency', 8]
];

const OPPORTUNITY_FACTORS = [
  ['holdingsValuation', 'Holdings valuation versus history and sector', 20],
  ['earningsMomentum', 'Earnings and fundamental momentum', 20],
  ['portfolioQuality', 'Portfolio quality and balance-sheet strength', 15],
  ['factorAlignment', 'Current factor/style alignment', 15],
  ['sectorOpportunity', 'Sector opportunity', 10],
  ['crowdingRisk', 'Crowding and ownership risk', 10],
  ['liquidityFlowRisk', 'Liquidity and flow vulnerability', 10]
];

const INVESTOR_FIT_FACTORS = [
  ['riskTolerance', 'Risk-tolerance match', 25],
  ['timeHorizon', 'Investment-horizon match', 20],
  ['goalSuitability', 'Goal suitability', 15],
  ['portfolioOverlap', 'Existing portfolio overlap', 15],
  ['drawdownTolerance', 'Drawdown-tolerance match', 10],
  ['liquidityRequirement', 'Liquidity requirement', 5],
  ['taxSuitability', 'Tax suitability', 5],
  ['investmentMode', 'SIP/lump-sum suitability', 5]
];

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value)));
const finite = value => Number.isFinite(value);
const mean = values => {
  const clean = values.filter(finite).map(Number);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
};

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function robustPeerScore(value, distribution, direction = 1) {
  if (!finite(value) || !distribution || Number(distribution.n) < 6) return null;
  const median = Number(distribution.median);
  const mad = Number(distribution.mad);
  if (!finite(median) || !finite(mad) || mad <= 0) return null;
  const z = clamp(((Number(value) - median) / (1.4826 * mad)) * direction, -3, 3);
  return { score: 100 * normalCdf(z), z, median, mad, n: Number(distribution.n) };
}

// Piecewise-linear map from a raw measurement to a 0-100 score, used where no peer
// distribution exists and the sensible reference is an absolute band instead.
function bandScore(value, anchors) {
  if (!finite(value)) return null;
  const points = [...anchors].sort((left, right) => left[0] - right[0]);
  if (value <= points[0][0]) return points[0][1];
  if (value >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    if (value <= x1) return y0 + (value - x0) / (x1 - x0) * (y1 - y0);
  }
  return null;
}

// Weighted blend of sub-metrics that tolerates missing inputs and reports how much
// of the intended metric weight was actually available.
function combine(parts) {
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  const usable = parts.filter(part => finite(part.score));
  const covered = usable.reduce((sum, part) => sum + part.weight, 0);
  return {
    raw: covered ? usable.reduce((sum, part) => sum + part.score * part.weight, 0) / covered : null,
    coveragePct: total ? covered / total * 100 : 0,
    evidence: Object.fromEntries(parts.map(part => [part.key, { weight: part.weight, score: part.score, value: part.value }]))
  };
}

function qualityModelFor(fund) {
  const text = [fund?.category, fund?.displayName, fund?.preferredSchemeName].join(' ').toLowerCase();
  if (/debt scheme|liquid|overnight|duration|gilt|credit risk|corporate bond|money market|banking and psu|floater/.test(text)) {
    return { id: 'debt', label: 'Debt-fund model', pillars: DEBT_QUALITY_PILLARS };
  }
  if (/hybrid scheme|balanced advantage|dynamic asset allocation|aggressive hybrid|equity savings|multi asset|arbitrage/.test(text)) {
    return { id: 'hybrid', label: 'Hybrid-fund model', pillars: HYBRID_QUALITY_PILLARS };
  }
  return { id: 'equity', label: 'Equity-fund model', pillars: EQUITY_QUALITY_PILLARS };
}

function benchmarkQualityScore(proxy) {
  const quality = String(proxy?.quality || '').toLowerCase();
  if (quality === 'high') return 95;
  if (quality === 'medium-high') return 82;
  if (quality === 'medium') return 65;
  return 35;
}

function historyConfidence(years) {
  if (!finite(years)) return 0;
  if (years >= 8) return 100;
  if (years >= 5) return 82;
  if (years >= 3) return 65;
  if (years >= 1.5) return 40;
  return 20;
}

function inferenceConfidence(momentum) {
  const snapshots = Number(momentum?.coverage?.snapshotCount || momentum?.snapshot?.snapshotCount || 0);
  const mode = momentum?.coverage?.comparisonMode || momentum?.snapshot?.comparisonMode;
  if (snapshots >= 3 && mode === 'complete-portfolio') return 90;
  if (snapshots >= 2 && mode === 'complete-portfolio') return 78;
  if (snapshots >= 2) return 65;
  if (mode === 'reported-one-month-allocation-change') return 45;
  if (momentum?.holdings?.length) return 30;
  return 0;
}

function confidenceScore(components) {
  const score = Object.entries(CONFIDENCE_WEIGHTS).reduce((sum, [key, weight]) => {
    return sum + clamp(components[key] || 0) * weight / 100;
  }, 0);
  return clamp(score);
}

function notRated(key, label, weight, reason, confidence = 0) {
  return {
    key,
    label,
    weight,
    score: null,
    rawScore: null,
    confidence: clamp(confidence),
    coveragePct: 0,
    status: 'not-rated',
    available: false,
    detail: reason
  };
}

function rated({ key, label, weight, rawScores, confidence, coveragePct = 100, detail, evidence }) {
  const rawScore = mean(rawScores);
  if (!finite(rawScore)) return notRated(key, label, weight, detail || 'A valid point-in-time peer distribution is unavailable.', confidence);
  const adjusted = 50 + (clamp(confidence) / 100) * (rawScore - 50);
  return {
    key,
    label,
    weight,
    score: clamp(adjusted),
    rawScore: clamp(rawScore),
    confidence: clamp(confidence),
    coveragePct: clamp(coveragePct),
    status: 'rated',
    available: true,
    detail,
    evidence
  };
}

// Builds a pillar from a set of sub-metrics, publishing only when enough of the
// intended metric weight resolved.
function buildPillar({ key, label, weight, parts, confidence, minimumCoverage = 60, detail, unavailableDetail }) {
  const { raw, coveragePct, evidence } = combine(parts);
  if (coveragePct < minimumCoverage || !finite(raw)) {
    return {
      // Allow a callback so a pillar can explain *why* its inputs were unavailable, which
      // is often more useful than a generic coverage shortfall.
      ...notRated(key, label, weight, (typeof unavailableDetail === 'function' ? unavailableDetail({ coveragePct }) : unavailableDetail)
        || `Not Rated — only ${Math.round(coveragePct)}% of the required metric weight for this pillar resolved; at least ${minimumCoverage}% is required.`, confidence),
      coveragePct
    };
  }
  return rated({
    key,
    label,
    weight,
    rawScores: [raw],
    confidence,
    coveragePct,
    detail: typeof detail === 'function' ? detail({ coveragePct, evidence }) : detail,
    evidence
  });
}

// Peer membership is current-category rather than point-in-time; that is penalised
// through confidence rather than by refusing to score at all.
function metricScore(metrics, peers, key, direction = 1) {
  return robustPeerScore(metrics?.[key], peers?.distributions?.[key], direction);
}

// Benchmark-relative metrics only exist over the fund/proxy overlap, so history
// confidence is taken from that window rather than the fund's full NAV history.
function effectiveYears(metrics) {
  const aligned = Number(metrics?.alignedObservations);
  if (finite(aligned) && aligned > 0) return Math.min(Number(metrics?.years) || Infinity, aligned / 252);
  return metrics?.years;
}

function navPillarConfidence({ metrics, peerData, selectedProxy, completeness = 100 }) {
  const modelStability = peerData?.peerCount >= 15 ? 90 : peerData?.peerCount >= 10 ? 75 : peerData?.peerCount >= 6 ? 55 : 0;
  const pointInTimePenalty = peerData?.comparability?.pointInTime === true ? 0 : 15;
  return confidenceScore({
    dataCompleteness: completeness,
    historyLength: historyConfidence(effectiveYears(metrics)),
    benchmarkQuality: benchmarkQualityScore(selectedProxy),
    inferenceQuality: 100,
    modelStability: Math.max(0, modelStability - pointInTimePenalty)
  });
}

function portfolioConfidence({ momentum, completeness = 100, metrics, selectedProxy }) {
  return confidenceScore({
    dataCompleteness: completeness,
    historyLength: historyConfidence(effectiveYears(metrics)),
    benchmarkQuality: benchmarkQualityScore(selectedProxy),
    inferenceQuality: inferenceConfidence(momentum),
    modelStability: Number(momentum?.coverage?.resolvedPct || 0)
  });
}

// Minimum share of portfolio weight a disclosure must cover before concentration
// statistics computed from it mean anything.
const MIN_CONCENTRATION_DISCLOSURE_PCT = 70;

function holdingStats(momentum) {
  const holdings = (momentum?.holdings || []).filter(item => finite(Number(item.weight)) && Number(item.weight) > 0);
  const totalWeight = holdings.reduce((sum, item) => sum + Number(item.weight), 0);
  const sorted = [...holdings].sort((left, right) => Number(right.weight) - Number(left.weight));
  const herfindahl = totalWeight
    ? holdings.reduce((sum, item) => sum + Math.pow(Number(item.weight) / totalWeight * 100, 2), 0)
    : null;
  // Concentration is only measurable against a substantially complete book. Several
  // sources publish just the top handful of names; renormalising those to 100% makes any
  // fund look extremely concentrated ("100% in the top ten", 5 effective positions) when
  // the truncation, not the manager, produced the number. Below the threshold these are
  // withheld so the pillars that use them report reduced coverage instead of a wrong score.
  const sufficientDisclosure = totalWeight >= MIN_CONCENTRATION_DISCLOSURE_PCT;

  return {
    holdings,
    count: holdings.length,
    totalWeight,
    sufficientDisclosure,
    top10WeightPct: sufficientDisclosure && totalWeight
      ? sorted.slice(0, 10).reduce((sum, item) => sum + Number(item.weight), 0) / totalWeight * 100
      : null,
    herfindahl,
    effectiveHoldings: sufficientDisclosure && herfindahl ? 10000 / herfindahl : null
  };
}

// SEBI category definitions bound the market-cap mix a scheme may hold, so the
// mandate is a usable stand-in when the source omits the reported split.
const MANDATE_TILTS = [
  [/small cap/i, { largePct: 10, midPct: 25, smallPct: 65 }],
  [/mid cap/i, { largePct: 15, midPct: 65, smallPct: 20 }],
  [/large (and|&) mid|large.?mid/i, { largePct: 45, midPct: 45, smallPct: 10 }],
  [/large cap|index|nifty|sensex|bluechip/i, { largePct: 85, midPct: 12, smallPct: 3 }],
  [/multi cap/i, { largePct: 40, midPct: 30, smallPct: 30 }],
  [/flexi cap|focused|value|contra|dividend yield|elss|tax saver/i, { largePct: 60, midPct: 25, smallPct: 15 }]
];

function marketCapTilt(momentum, fund) {
  const rows = momentum?.fundFacts?.marketCap || momentum?.snapshot?.marketCap || [];
  const bucket = pattern => rows
    .filter(row => pattern.test(String(row.name || '')))
    .reduce((sum, row) => sum + (Number(row.weight) || 0), 0);
  const large = bucket(/large|giant/i);
  const mid = bucket(/\bmid\b/i);
  const small = bucket(/small|micro/i);
  const total = large + mid + small;
  if (total) {
    return {
      largePct: large / total * 100,
      midPct: mid / total * 100,
      smallPct: small / total * 100,
      // 0 = entirely large-cap, 100 = entirely small-cap
      riskTilt: (mid * 0.5 + small) / total * 100,
      basis: 'reported'
    };
  }

  const text = [fund?.category, fund?.displayName, fund?.preferredSchemeName].join(' ');
  const mandate = MANDATE_TILTS.find(([pattern]) => pattern.test(text))?.[1];
  if (!mandate) return null;
  return {
    ...mandate,
    riskTilt: mandate.midPct * 0.5 + mandate.smallPct,
    basis: 'sebi-mandate'
  };
}

function equityQualityPillars({ metrics, peerData, selectedProxy, momentum, manager, fund }) {
  const byKey = Object.fromEntries(EQUITY_QUALITY_PILLARS.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    'Not Rated — the required peer-relative, point-in-time evidence is not yet available.'
  )]));

  const navConfidence = completeness => navPillarConfidence({ metrics, peerData, selectedProxy, completeness });
  const stats = holdingStats(momentum);
  const tilt = marketCapTilt(momentum, fund);
  const facts = momentum?.fundFacts || {};
  const fundamentalsWeight = Number(momentum?.coverage?.fundamentalsWeightPct || 0);

  byKey.riskAdjustedAlpha = buildPillar({
    key: 'riskAdjustedAlpha',
    label: 'Risk-adjusted manager alpha',
    weight: 18,
    minimumCoverage: 60,
    parts: [
      { key: 'alphaPct', weight: 45, value: metrics?.alphaPct, score: metricScore(metrics, peerData, 'alphaPct', 1)?.score },
      { key: 'informationRatio', weight: 35, value: metrics?.informationRatio, score: metricScore(metrics, peerData, 'informationRatio', 1)?.score },
      { key: 'activeReturnPct', weight: 20, value: metrics?.activeReturnPct, score: metricScore(metrics, peerData, 'activeReturnPct', 1)?.score }
    ],
    confidence: navConfidence(100),
    detail: ({ coveragePct }) => `Peer-relative Jensen-style alpha, information ratio and active return against ${peerData?.peerCount || 0} category peers on the same Direct-Growth basis. ${Math.round(coveragePct)}% of pillar metric weight resolved. Alpha is NAV-derived and single-factor; a multi-factor net-of-fee decomposition is not available from public sources.`,
    unavailableDetail: 'Not Rated — a usable category peer distribution for alpha, information ratio and active return is unavailable.'
  });

  byKey.skillPersistence = buildPillar({
    key: 'skillPersistence',
    label: 'Skill persistence',
    weight: 12,
    minimumCoverage: 55,
    parts: [
      { key: 'alphaPersistenceScore', weight: 60, value: metrics?.alphaPersistenceScore, score: metricScore(metrics, peerData, 'alphaPersistenceScore', 1)?.score },
      { key: 'positiveMonthHitRatePct', weight: 40, value: metrics?.positiveMonthHitRatePct, score: metricScore(metrics, peerData, 'positiveMonthHitRatePct', 1)?.score }
    ],
    confidence: navConfidence(Math.min(100, historyConfidence(effectiveYears(metrics)))),
    detail: ({ coveragePct }) => `Four-window active-return consistency and monthly hit rate, standardised against category peers. ${Math.round(coveragePct)}% of pillar metric weight resolved over ${metrics?.years ? metrics.years.toFixed(1) : '—'} years. Windows are overlapping, so this measures consistency rather than formally independent persistence.`,
    unavailableDetail: 'Not Rated — at least 120 aligned observations and a peer persistence distribution are required.'
  });

  const downsideDefinitions = [
    ['downCapturePct', 20, -1],
    ['conditionalDrawdownAtRiskPct', 15, 1],
    ['maxDrawdownRelativePct', 15, 1],
    ['timeUnderWaterPct', 15, -1],
    ['recoveryDays', 10, -1],
    ['negativeMonthAlphaPct', 10, 1],
    ['tailLossFrequencyPct', 10, -1]
  ];
  const downsideEvidence = downsideDefinitions.map(([key, weight, direction]) => ({
    key,
    weight,
    result: metricScore(metrics, peerData, key, direction)
  }));
  const availableDownside = downsideEvidence.filter(item => finite(item.result?.score));
  const downsideCoverage = availableDownside.reduce((sum, item) => sum + item.weight, 0);
  const downsideRaw = downsideCoverage
    ? availableDownside.reduce((sum, item) => sum + item.result.score * item.weight, 0) / downsideCoverage
    : null;
  const downsideConfidence = navConfidence(downsideCoverage);
  byKey.downsideProtection = downsideCoverage >= 70 && finite(downsideRaw)
    ? rated({
      key: 'downsideProtection',
      label: 'Downside protection',
      weight: 12,
      rawScores: [downsideRaw],
      confidence: downsideConfidence,
      coveragePct: downsideCoverage,
      detail: `Peer-relative downside capture, conditional drawdown, relative maximum drawdown, time under water, recovery speed, negative-month alpha and tail-loss evidence. ${downsideCoverage}% of the pillar metric weight is available; liquidity stress remains unscored.`,
      evidence: Object.fromEntries(downsideEvidence.map(item => [item.key, item.result]))
    })
    : {
      ...notRated('downsideProtection', 'Downside protection', 12, `Not Rated — only ${downsideCoverage}% of the required downside metric weight is available; at least 70% is required.`, downsideConfidence),
      coveragePct: downsideCoverage
    };

  const resolvedHoldings = stats.holdings.filter(item => finite(item.return3mPct) || finite(item.return6mPct));
  const resolvedWeight = resolvedHoldings.reduce((sum, item) => sum + Number(item.weight), 0);
  const weightedHoldingReturn = horizon => {
    const rows = stats.holdings.filter(item => finite(item[horizon]));
    const denominator = rows.reduce((sum, item) => sum + Number(item.weight), 0);
    return denominator ? rows.reduce((sum, item) => sum + item[horizon] * Number(item.weight), 0) / denominator : undefined;
  };
  const broadReturn = Number(momentum?.broadMarket?.return3mPct);
  const holdings3m = weightedHoldingReturn('return3mPct');
  const holdings6m = weightedHoldingReturn('return6mPct');
  const selectionExcess3m = finite(holdings3m) && finite(broadReturn) ? holdings3m - broadReturn : undefined;
  const selectionExcess6m = finite(holdings6m) && finite(broadReturn) ? holdings6m - broadReturn * 2 : undefined;
  const selectionCoverage = stats.totalWeight ? resolvedWeight / stats.totalWeight * 100 : 0;

  byKey.stockSelection = buildPillar({
    key: 'stockSelection',
    label: 'Stock-selection skill',
    weight: 10,
    minimumCoverage: 50,
    parts: [
      { key: 'selectionExcess3m', weight: 60, value: selectionExcess3m, score: bandScore(selectionExcess3m, [[-12, 5], [-6, 22], [-2, 40], [0, 50], [2, 60], [6, 78], [12, 95]]) },
      { key: 'selectionExcess6m', weight: 40, value: selectionExcess6m, score: bandScore(selectionExcess6m, [[-20, 5], [-10, 22], [-3, 40], [0, 50], [3, 60], [10, 78], [20, 95]]) }
    ],
    confidence: Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness: selectionCoverage }) * 0.75),
    detail: ({ coveragePct }) => `Weight-adjusted three- and six-month return of the disclosed book versus the broad market, covering ${Math.round(selectionCoverage)}% of portfolio weight (${Math.round(coveragePct)}% of pillar metric weight). This is a holdings-return attribution on the latest disclosed portfolio, not a factor-adjusted forward-return study, so confidence is capped.`,
    unavailableDetail: 'Not Rated — priced holdings covering at least half of the disclosed portfolio weight are required.'
  });

  const sectorRows = (momentum?.sectors || []).filter(item => finite(item.weight) && finite(item.return3mPct));
  const sectorWeightTotal = sectorRows.reduce((sum, item) => sum + Number(item.weight), 0);
  const portfolioSectorReturn = sectorWeightTotal
    ? sectorRows.reduce((sum, item) => sum + item.return3mPct * Number(item.weight), 0) / sectorWeightTotal
    : undefined;
  // With benchmark sector weights available, the neutral leg becomes the benchmark's own
  // sector mix — a genuine Brinson allocation effect. Where they are missing the previous
  // equal-weight basket is still used, and the detail text says which one applied.
  const benchmark = momentum?.benchmark || null;
  const benchmarkSectorWeights = new Map(
    (benchmark?.sectorWeights || []).map(item => [item.sector, Number(item.weight)])
  );
  const benchmarkNeutralReturn = (() => {
    if (!benchmarkSectorWeights.size) return undefined;
    const usable = sectorRows.filter(item => finite(benchmarkSectorWeights.get(item.sector)));
    const total = usable.reduce((sum, item) => sum + benchmarkSectorWeights.get(item.sector), 0);
    if (!total) return undefined;
    return usable.reduce((sum, item) => sum + item.return3mPct * benchmarkSectorWeights.get(item.sector), 0) / total;
  })();
  const equalWeightNeutralReturn = mean(sectorRows.map(item => item.return3mPct));
  const neutralSectorReturn = finite(benchmarkNeutralReturn) ? benchmarkNeutralReturn : equalWeightNeutralReturn;
  const allocationIsBenchmarkRelative = finite(benchmarkNeutralReturn);
  const allocationEffect = finite(portfolioSectorReturn) && finite(neutralSectorReturn)
    ? portfolioSectorReturn - neutralSectorReturn
    : undefined;
  const sectorCount = sectorRows.length;

  // Withheld unless the disclosure is substantially complete — see lib/index-constituents.
  const activeSharePct = benchmark?.activeShare?.sufficientDisclosure
    ? Number(benchmark.activeShare.activeSharePct)
    : undefined;
  const activeShareApproximate = Boolean(benchmark?.activeShare?.approximate);

  byKey.sectorAllocation = buildPillar({
    key: 'sectorAllocation',
    label: 'Sector and factor allocation skill',
    weight: 8,
    minimumCoverage: 50,
    parts: [
      { key: 'allocationEffect3m', weight: 100, value: allocationEffect, score: bandScore(allocationEffect, [[-8, 8], [-4, 25], [-1, 42], [0, 50], [1, 58], [4, 75], [8, 92]]) }
    ],
    confidence: Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness: sectorCount >= 6 ? 100 : sectorCount * 16 }) * (allocationIsBenchmarkRelative ? 0.8 : 0.7)),
    detail: () => allocationIsBenchmarkRelative
      ? `Allocation effect of ${finite(allocationEffect) ? allocationEffect.toFixed(2) : '—'}pp: the fund's sector-weighted three-month return versus the same sectors weighted as in ${benchmark?.label || 'the benchmark'}, across ${sectorCount} sectors. Benchmark sector weights are derived from NSE constituents at full market capitalisation, so they approximate rather than reproduce the published free-float weights, and the attribution uses current — not point-in-time — sector membership.`
      : `Allocation effect of ${finite(allocationEffect) ? allocationEffect.toFixed(2) : '—'}pp: the fund's sector-weighted three-month return versus an equal-weight basket of the same ${sectorCount} sectors. Benchmark sector weights could not be resolved for this fund, so an equal-weight neutral is used in place of a Brinson attribution.`,
    unavailableDetail: 'Not Rated — priced sector exposures for at least three sectors are required.'
  });

  const entries = (momentum?.entries || []).filter(item => finite(item.returnSinceEventPct));
  const exits = (momentum?.exits || []).filter(item => finite(item.postEventReturnPct));
  const entryQuality = mean(entries.map(item => item.returnSinceEventPct));
  const exitQuality = mean(exits.map(item => item.postEventReturnPct));
  const turnoverPct = Number(momentum?.snapshot?.turnover?.equityPct);

  byKey.tradingExecution = buildPillar({
    key: 'tradingExecution',
    label: 'Trading and execution skill',
    weight: 8,
    minimumCoverage: 45,
    parts: [
      { key: 'entryForwardReturn', weight: 35, value: entryQuality, score: bandScore(entryQuality, [[-20, 8], [-8, 28], [-2, 44], [0, 50], [2, 56], [8, 74], [20, 92]]) },
      { key: 'exitAvoidedReturn', weight: 35, value: exitQuality, score: bandScore(exitQuality, [[-20, 92], [-8, 74], [-2, 56], [0, 50], [2, 44], [8, 28], [20, 8]]) },
      { key: 'turnoverDiscipline', weight: 30, value: turnoverPct, score: bandScore(turnoverPct, [[0, 55], [20, 78], [50, 82], [100, 70], [175, 52], [250, 34], [400, 15]]) }
    ],
    confidence: Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness: 100 }) * 0.65),
    detail: ({ coveragePct }) => `Forward price behaviour of ${entries.length} additions and ${exits.length} reductions plus reported ${finite(turnoverPct) ? `${turnoverPct.toFixed(0)}%` : '—'} equity turnover, compared ${momentum?.snapshot?.comparisonMode === 'complete-portfolio' ? 'across complete portfolios' : `using the ${momentum?.snapshot?.comparisonMode || 'available'} basis`}${momentum?.snapshot?.previousAsOf ? ` against the ${momentum.snapshot.previousAsOf} disclosure` : ''}. ${Math.round(coveragePct)}% of pillar metric weight resolved. Trades are inferred from successive disclosures and are not factor-adjusted or net of actual dealing costs.`,
    unavailableDetail: 'Not Rated — a second dated portfolio disclosure or a reported turnover figure is required.'
  });

  byKey.portfolioConstruction = buildPillar({
    key: 'portfolioConstruction',
    label: 'Portfolio construction quality',
    weight: 8,
    minimumCoverage: 60,
    parts: [
      { key: 'effectiveHoldings', weight: 30, value: stats.effectiveHoldings, score: bandScore(stats.effectiveHoldings, [[5, 18], [12, 42], [20, 60], [30, 72], [45, 78], [70, 68], [100, 55]]) },
      { key: 'top10WeightPct', weight: 25, value: stats.top10WeightPct, score: bandScore(stats.top10WeightPct, [[15, 60], [30, 76], [42, 70], [55, 52], [70, 32], [85, 15]]) },
      { key: 'trackingErrorPct', weight: 20, value: metrics?.trackingErrorPct, score: bandScore(metrics?.trackingErrorPct, [[0.5, 20], [2, 48], [4, 68], [6, 72], [9, 55], [14, 30]]) },
      // Very low active share is closet indexing at active fees; very high is concentration
      // risk. The peak sits in the genuinely-active middle.
      { key: 'activeSharePct', weight: 25, value: activeSharePct, score: bandScore(activeSharePct, [[20, 12], [40, 38], [55, 62], [70, 80], [85, 72], [95, 55]]) }
    ],
    confidence: Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness: stats.count >= 20 ? 100 : stats.count * 5 }) * (activeShareApproximate ? 0.7 : 0.8)),
    detail: () => stats.sufficientDisclosure
      ? `${stats.count} disclosed holdings covering ${stats.totalWeight.toFixed(0)}% of the portfolio, ${finite(stats.effectiveHoldings) ? stats.effectiveHoldings.toFixed(0) : '—'} effective positions (inverse Herfindahl), ${finite(stats.top10WeightPct) ? `${stats.top10WeightPct.toFixed(1)}%` : '—'} in the top ten and ${finite(metrics?.trackingErrorPct) ? `${metrics.trackingErrorPct.toFixed(2)}%` : '—'} tracking error. ${finite(activeSharePct) ? `Active Share of ${activeSharePct.toFixed(1)}% against ${benchmark?.label || 'the benchmark'}, approximated from NSE constituents weighted by full market capitalisation rather than published free-float weights.` : benchmark?.activeShare?.insufficientReason || 'Active Share could not be measured for this benchmark.'}`
      : `Only ${stats.count} holdings covering ${stats.totalWeight.toFixed(0)}% of portfolio weight are disclosed by the available source, so concentration and Active Share are withheld — measuring them here would describe the truncated disclosure rather than the portfolio. Tracking error of ${finite(metrics?.trackingErrorPct) ? `${metrics.trackingErrorPct.toFixed(2)}%` : '—'} is NAV-derived and unaffected.`,
    unavailableDetail: () => stats.count && !stats.sufficientDisclosure
      ? `Not Rated — the available source discloses only ${stats.count} holdings covering ${stats.totalWeight.toFixed(0)}% of portfolio weight. Concentration and Active Share need at least ${MIN_CONCENTRATION_DISCLOSURE_PCT}% or they describe the truncation rather than the portfolio. A complete month-end disclosure resolves this.`
      : 'Not Rated — a disclosed holdings book is required to measure concentration.'
  });

  byKey.costEfficiency = buildPillar({
    key: 'costEfficiency',
    label: 'Cost efficiency',
    weight: 7,
    minimumCoverage: 60,
    parts: [
      { key: 'expenseRatioPct', weight: 70, value: facts.expenseRatioPct, score: bandScore(facts.expenseRatioPct, [[0.15, 97], [0.4, 90], [0.7, 80], [1, 67], [1.3, 52], [1.7, 34], [2.1, 18], [2.5, 6]]) },
      { key: 'turnoverCostDrag', weight: 30, value: turnoverPct, score: bandScore(turnoverPct, [[0, 88], [25, 82], [60, 72], [120, 58], [200, 40], [320, 20]]) }
    ],
    confidence: Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness: 100 }) * 0.85),
    detail: () => `Reported expense ratio of ${finite(facts.expenseRatioPct) ? `${facts.expenseRatioPct.toFixed(2)}%` : '—'} scored against Indian equity-scheme cost bands, plus an implementation-cost proxy from ${finite(turnoverPct) ? `${turnoverPct.toFixed(0)}%` : '—'} turnover. Scored on absolute cost bands because per-peer expense ratios are not available in bulk from free sources.`,
    unavailableDetail: 'Not Rated — a reported expense ratio is required from the portfolio sources.'
  });

  const aumCr = Number(facts.aumCr);
  const capacityStress = finite(aumCr) && tilt ? aumCr * (tilt.riskTilt / 100) : undefined;

  byKey.liquidityCapacity = buildPillar({
    key: 'liquidityCapacity',
    label: 'Liquidity and capacity',
    weight: 5,
    minimumCoverage: 50,
    parts: [
      { key: 'assetsUnderManagementCr', weight: 45, value: aumCr, score: bandScore(aumCr, [[50, 42], [500, 72], [3000, 80], [12000, 72], [30000, 58], [60000, 42], [100000, 28]]) },
      { key: 'capacityStress', weight: 35, value: capacityStress, score: bandScore(capacityStress, [[0, 85], [1000, 78], [5000, 62], [15000, 42], [35000, 24], [60000, 12]]) },
      { key: 'effectiveHoldings', weight: 20, value: stats.effectiveHoldings, score: bandScore(stats.effectiveHoldings, [[6, 30], [15, 55], [30, 72], [50, 78], [80, 70]]) }
    ],
    confidence: Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness: 100 }) * 0.6),
    detail: () => `${finite(aumCr) ? `₹${Math.round(aumCr).toLocaleString('en-IN')} crore` : 'Unreported'} in assets against a ${tilt ? `${tilt.riskTilt.toFixed(0)}/100 mid-and-small-cap tilt` : 'an unreported market-cap tilt'}${finite(stats.effectiveHoldings) ? ` and ${stats.effectiveHoldings.toFixed(0)} effective positions` : ', with effective position count withheld because the disclosed book covers too little of the portfolio'}. Holding-level traded volume and market-impact modelling are not available from free sources, so this is a capacity-pressure proxy.`,
    unavailableDetail: 'Not Rated — reported assets under management are required.'
  });

  // Scheme-level tenure from the factsheet registry is preferred over a firm-level start
  // date, and a manager who has run the fund since launch inherits the fund's own inception.
  const tenureSource = (() => {
    if (manager?.managingSince) return { date: manager.managingSince, basis: 'factsheet tenure disclosure' };
    if (manager?.managingSinceInception && momentum?.fundFacts?.inceptionDate) {
      return { date: momentum.fundFacts.inceptionDate, basis: 'managing since scheme inception' };
    }
    if (manager?.startDate) return { date: manager.startDate, basis: 'registry start date' };
    return null;
  })();
  const tenureYears = (() => {
    if (!tenureSource) return undefined;
    const start = new Date(tenureSource.date);
    if (!finite(start.getTime())) return undefined;
    const years = (Date.now() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    return years >= 0 && years < 60 ? years : undefined;
  })();
  const managerCount = (momentum?.managers || []).length || undefined;

  byKey.managerStability = buildPillar({
    key: 'managerStability',
    label: 'Manager and process stability',
    weight: 5,
    minimumCoverage: 50,
    parts: [
      { key: 'tenureYears', weight: 70, value: tenureYears, score: bandScore(tenureYears, [[0, 12], [1, 32], [2, 48], [3, 62], [5, 76], [8, 88], [12, 94]]) },
      { key: 'managementTeamSize', weight: 30, value: managerCount, score: bandScore(managerCount, [[1, 55], [2, 72], [3, 78], [5, 70], [8, 52]]) }
    ],
    confidence: Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness: 100 }) * 0.7),
    detail: () => `${finite(tenureYears) ? `${tenureYears.toFixed(1)} years` : 'Unknown'} of lead-manager tenure across a ${managerCount || '—'}-person named team${tenureSource ? `, from the ${tenureSource.basis}` : ''}. Mandate drift and governance history are not tracked point-in-time.`,
    unavailableDetail: 'Not Rated — a verified manager start date is required from the registry.'
  });

  const roe = weightedFundamental(stats.holdings, 'returnOnEquityPct');
  const margin = weightedFundamental(stats.holdings, 'profitMarginPct');
  const leverage = weightedFundamental(stats.holdings, 'debtToEquity');

  byKey.holdingsQuality = buildPillar({
    key: 'holdingsQuality',
    label: 'Current holdings quality',
    weight: 4,
    minimumCoverage: 55,
    parts: [
      { key: 'returnOnEquityPct', weight: 45, value: roe.value, score: bandScore(roe.value, [[0, 10], [8, 32], [13, 50], [18, 66], [25, 82], [35, 94]]) },
      { key: 'profitMarginPct', weight: 30, value: margin.value, score: bandScore(margin.value, [[0, 12], [4, 34], [8, 50], [14, 68], [22, 84], [32, 94]]) },
      { key: 'debtToEquity', weight: 25, value: leverage.value, score: bandScore(leverage.value, [[0, 92], [25, 80], [55, 64], [90, 48], [150, 30], [250, 12]]) }
    ],
    confidence: Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness: fundamentalsWeight }) * 0.8),
    detail: ({ coveragePct }) => `Weight-averaged return on equity of ${finite(roe.value) ? `${roe.value.toFixed(1)}%` : '—'}, profit margin of ${finite(margin.value) ? `${margin.value.toFixed(1)}%` : '—'} and debt/equity of ${finite(leverage.value) ? leverage.value.toFixed(0) : '—'} across ${Math.round(fundamentalsWeight)}% of disclosed portfolio weight (${Math.round(coveragePct)}% of pillar metric weight).`,
    unavailableDetail: 'Not Rated — security-level fundamentals could not be resolved for enough of the disclosed portfolio.'
  });

  byKey.regimeResilience = buildPillar({
    key: 'regimeResilience',
    label: 'Regime resilience',
    weight: 3,
    minimumCoverage: 55,
    parts: [
      { key: 'overallCapturePct', weight: 45, value: metrics?.overallCapturePct, score: metricScore(metrics, peerData, 'overallCapturePct', 1)?.score },
      { key: 'upCapturePct', weight: 30, value: metrics?.upCapturePct, score: metricScore(metrics, peerData, 'upCapturePct', 1)?.score },
      { key: 'downCapturePct', weight: 25, value: metrics?.downCapturePct, score: metricScore(metrics, peerData, 'downCapturePct', -1)?.score }
    ],
    confidence: Math.round(navConfidence(100) * 0.85),
    detail: () => `Peer-relative up/down capture asymmetry of ${finite(metrics?.overallCapturePct) ? metrics.overallCapturePct.toFixed(0) : '—'} (up ${finite(metrics?.upCapturePct) ? metrics.upCapturePct.toFixed(0) : '—'}, down ${finite(metrics?.downCapturePct) ? metrics.downCapturePct.toFixed(0) : '—'}) observed in the current ${momentum?.regime?.label || 'unclassified'} regime. Capture is measured across the whole history rather than by formally dated regime windows.`,
    unavailableDetail: 'Not Rated — a peer capture distribution is required.'
  });

  return byKey;
}

function debtQualityPillars({ metrics, peerData, selectedProxy, momentum, manager }) {
  const byKey = Object.fromEntries(DEBT_QUALITY_PILLARS.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    'Not Rated — the required debt-scheme evidence is not available from public sources.'
  )]));
  const navConfidence = completeness => navPillarConfidence({ metrics, peerData, selectedProxy, completeness });
  const facts = momentum?.fundFacts || {};
  const turnoverPct = Number(momentum?.snapshot?.turnover?.equityPct);

  byKey.durationManagement = buildPillar({
    key: 'durationManagement',
    label: 'Duration-management skill',
    weight: 15,
    minimumCoverage: 55,
    parts: [
      { key: 'activeReturnPct', weight: 55, value: metrics?.activeReturnPct, score: metricScore(metrics, peerData, 'activeReturnPct', 1)?.score },
      { key: 'volatilityPct', weight: 45, value: metrics?.volatilityPct, score: metricScore(metrics, peerData, 'volatilityPct', -1)?.score }
    ],
    confidence: Math.round(navConfidence(100) * 0.7),
    detail: () => 'Peer-relative active return and NAV volatility, used as an observable proxy for duration positioning. Portfolio modified duration is not published in a machine-readable free feed, so true duration attribution is unmeasured.',
    unavailableDetail: 'Not Rated — a debt peer distribution for active return and volatility is required.'
  });

  byKey.creditEventControl = buildPillar({
    key: 'creditEventControl',
    label: 'Credit downgrade/default control',
    weight: 12,
    minimumCoverage: 60,
    parts: [
      { key: 'maxDrawdownPct', weight: 50, value: metrics?.maxDrawdownPct, score: metricScore(metrics, peerData, 'maxDrawdownPct', 1)?.score },
      { key: 'tailLossFrequencyPct', weight: 50, value: metrics?.tailLossFrequencyPct, score: metricScore(metrics, peerData, 'tailLossFrequencyPct', -1)?.score }
    ],
    confidence: Math.round(navConfidence(100) * 0.75),
    detail: () => 'Peer-relative maximum drawdown and tail-loss frequency. In debt schemes a sharp NAV fall is the observable signature of a credit event, but issuer-level rating migration data is not available free of charge.',
    unavailableDetail: 'Not Rated — a debt peer drawdown distribution is required.'
  });

  byKey.yieldCarryEfficiency = buildPillar({
    key: 'yieldCarryEfficiency',
    label: 'Yield and carry efficiency',
    weight: 12,
    minimumCoverage: 55,
    parts: [
      { key: 'sharpe', weight: 55, value: metrics?.sharpe, score: metricScore(metrics, peerData, 'sharpe', 1)?.score },
      { key: 'cagrPct', weight: 45, value: metrics?.cagrPct, score: metricScore(metrics, peerData, 'cagrPct', 1)?.score }
    ],
    confidence: Math.round(navConfidence(100) * 0.8),
    detail: () => 'Peer-relative risk-adjusted and absolute realised return, standing in for portfolio carry. Portfolio YTM is not published in a free machine-readable feed.',
    unavailableDetail: 'Not Rated — a debt peer return distribution is required.'
  });

  byKey.liquidityRisk = buildPillar({
    key: 'liquidityRisk',
    label: 'Liquidity risk management',
    weight: 10,
    minimumCoverage: 50,
    parts: [
      { key: 'recoveryDays', weight: 45, value: metrics?.recoveryDays, score: metricScore(metrics, peerData, 'recoveryDays', -1)?.score },
      { key: 'assetsUnderManagementCr', weight: 55, value: Number(facts.aumCr), score: bandScore(Number(facts.aumCr), [[50, 40], [500, 66], [3000, 78], [20000, 76], [60000, 62], [120000, 48]]) }
    ],
    confidence: Math.round(navConfidence(100) * 0.6),
    detail: () => `Recovery speed after drawdowns alongside ${finite(Number(facts.aumCr)) ? `₹${Math.round(Number(facts.aumCr)).toLocaleString('en-IN')} crore` : 'unreported'} in assets. Instrument-level liquidity buckets are not published free of charge.`,
    unavailableDetail: 'Not Rated — recovery evidence and reported assets are required.'
  });

  byKey.stressBehaviour = buildPillar({
    key: 'stressBehaviour',
    label: 'Stress-period behaviour',
    weight: 5,
    minimumCoverage: 55,
    parts: [
      { key: 'conditionalDrawdownAtRiskPct', weight: 55, value: metrics?.conditionalDrawdownAtRiskPct, score: metricScore(metrics, peerData, 'conditionalDrawdownAtRiskPct', 1)?.score },
      { key: 'timeUnderWaterPct', weight: 45, value: metrics?.timeUnderWaterPct, score: metricScore(metrics, peerData, 'timeUnderWaterPct', -1)?.score }
    ],
    confidence: Math.round(navConfidence(100) * 0.8),
    detail: () => 'Peer-relative conditional drawdown-at-risk and time spent below the prior NAV peak.',
    unavailableDetail: 'Not Rated — a debt peer stress distribution is required.'
  });

  byKey.costEfficiency = buildPillar({
    key: 'costEfficiency',
    label: 'Expense and implementation efficiency',
    weight: 7,
    minimumCoverage: 60,
    parts: [
      { key: 'expenseRatioPct', weight: 100, value: facts.expenseRatioPct, score: bandScore(facts.expenseRatioPct, [[0.08, 97], [0.2, 90], [0.35, 80], [0.6, 66], [0.9, 48], [1.3, 28], [1.8, 10]]) }
    ],
    confidence: Math.round(navConfidence(100) * 0.85),
    detail: () => `Reported expense ratio of ${finite(facts.expenseRatioPct) ? `${facts.expenseRatioPct.toFixed(2)}%` : '—'} scored against Indian debt-scheme cost bands, where costs consume a far larger share of return than in equity.`,
    unavailableDetail: 'Not Rated — a reported expense ratio is required.'
  });

  // SEBI-mandated month-end disclosures carry issuer, credit rating and YTM per instrument.
  // Where the archive has parsed them, three of the four debt pillars become measurable.
  const debtRows = (momentum?.holdings || []).filter(item => finite(Number(item.weight)) && Number(item.weight) > 0);
  const ratedRows = debtRows.filter(item => item.rating);
  const ratedWeight = ratedRows.reduce((sum, item) => sum + Number(item.weight), 0);
  const totalWeight = debtRows.reduce((sum, item) => sum + Number(item.weight), 0);
  const ratedCoverage = totalWeight ? ratedWeight / totalWeight * 100 : 0;

  // Sovereign and AAA carry negligible credit risk; each notch below is progressively
  // riskier, so the book is scored as a weighted average of per-notch quality.
  const RATING_QUALITY = {
    SOVEREIGN: 100, AAA: 95, 'AA+': 86, AA: 80, 'AA-': 74, 'A+': 66, A: 60, 'A-': 54,
    'BBB+': 44, BBB: 38, 'BBB-': 32, BB: 20, B: 12, C: 6, D: 0,
    'A1+': 92, A1: 86, 'A2+': 74, A2: 68, A3: 50, A4: 30, UNRATED: 25
  };
  const creditQuality = ratedWeight
    ? ratedRows.reduce((sum, item) => sum + (RATING_QUALITY[item.rating] ?? 40) * Number(item.weight), 0) / ratedWeight
    : undefined;
  const subInvestmentGradeWeightPct = ratedWeight
    ? ratedRows.filter(item => /^(BB|B|C|D)/.test(item.rating)).reduce((sum, item) => sum + Number(item.weight), 0) / totalWeight * 100
    : undefined;

  if (finite(creditQuality) && ratedCoverage >= 50) {
    byKey.creditSelection = rated({
      key: 'creditSelection',
      label: byKey.creditSelection.label,
      weight: byKey.creditSelection.weight,
      rawScores: [creditQuality],
      confidence: Math.round(Math.min(80, ratedCoverage) * 0.8),
      coveragePct: ratedCoverage,
      detail: `Weighted credit quality of ${creditQuality.toFixed(0)}/100 across ${Math.round(ratedCoverage)}% of the disclosed book by weight, with ${finite(subInvestmentGradeWeightPct) ? subInvestmentGradeWeightPct.toFixed(1) : '—'}% below investment grade. Ratings come from the archived month-end disclosure; rating-migration history is not tracked, so this measures the current book rather than demonstrated credit skill.`
    });
  } else {
    byKey.creditSelection.detail = `Not Rated — instrument ratings covering at least half the book are required; ${Math.round(ratedCoverage)}% is currently parsed from archived disclosures.`;
  }

  // Issuer concentration uses the disclosed issuer names as a proxy for issuer groups;
  // true group aggregation would need a parent-issuer mapping that is not published free.
  // Debt instruments are disclosed as "7.15% HDFC Bank Ltd 2028", so the coupon, maturity
  // and instrument-type wrapper must all come off before two lines from the same issuer
  // will aggregate. Without this, every coupon looks like a separate issuer and
  // concentration is badly understated.
  const isSovereign = item =>
    item.rating === 'SOVEREIGN' || /\b(GOI|G-?SEC|SDL|TREASURY BILL|T-?BILL|GOVT? OF INDIA|GOVERNMENT OF INDIA)\b/i.test(item.name || '');

  const issuerKey = value => String(value || '')
    .toUpperCase()
    .replace(/^\s*\d+(\.\d+)?\s*%\s*/, '')
    .replace(/\b(19|20)\d{2}\b.*$/, '')
    .replace(/\b(SR|SERIES|TRANCHE|OPTION)\b[\s.\-]*[IVXLC\d]*/g, ' ')
    .replace(/\b(NCD|NCDS|BOND|BONDS|DEBENTURE[S]?|ZCB|MLD|CP|CD|STRIPS?)\b/g, ' ')
    .replace(/\b(LTD|LIMITED|PVT|PRIVATE|INDIA|THE)\b/g, ' ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Issuer-concentration risk is a credit concept, so sovereign paper is excluded from both
  // sides of the ratio. Leaving it only in the denominator would make any gilt-heavy fund
  // look well diversified across corporate issuers it does not actually hold.
  const corporateRows = debtRows.filter(item => !isSovereign(item));
  const corporateWeight = corporateRows.reduce((sum, item) => sum + Number(item.weight), 0);
  const sovereignWeightPct = totalWeight ? (totalWeight - corporateWeight) / totalWeight * 100 : 0;

  const issuerWeights = new Map();
  for (const item of corporateRows) {
    const issuer = issuerKey(item.name);
    if (issuer) issuerWeights.set(issuer, (issuerWeights.get(issuer) || 0) + Number(item.weight));
  }
  const topIssuerPct = issuerWeights.size && corporateWeight
    ? Math.max(...issuerWeights.values()) / corporateWeight * 100
    : undefined;
  const herfindahl = corporateWeight
    ? [...issuerWeights.values()].reduce((sum, weight) => sum + (weight / corporateWeight) ** 2, 0)
    : undefined;

  // A near-pure gilt fund has almost no corporate book to concentrate; rating it on a
  // handful of residual names would be noise, so it stays unrated.
  if (finite(topIssuerPct) && issuerWeights.size >= 5 && corporateWeight >= 20) {
    byKey.issuerConcentration = rated({
      key: 'issuerConcentration',
      label: byKey.issuerConcentration.label,
      weight: byKey.issuerConcentration.weight,
      rawScores: [bandScore(topIssuerPct, [[2, 92], [5, 84], [8, 72], [12, 56], [18, 36], [25, 18], [35, 6]])],
      confidence: Math.round(Math.min(75, corporateWeight) * 0.7),
      coveragePct: Math.min(100, corporateWeight),
      detail: `Largest single disclosed issuer at ${topIssuerPct.toFixed(1)}% of non-sovereign holdings across ${issuerWeights.size} issuers (inverse Herfindahl ${finite(herfindahl) && herfindahl > 0 ? (1 / herfindahl).toFixed(0) : '—'} effective issuers). Sovereign paper, ${sovereignWeightPct.toFixed(0)}% of the book, is excluded because it carries no issuer credit risk. Issuers are matched on disclosed instrument names and not aggregated into parent groups, so true group exposure may be higher.`
    });
  } else {
    byKey.issuerConcentration.detail = 'Not Rated — a disclosed instrument-level book covering at least five issuers is required.';
  }

  const ytmRows = debtRows.filter(item => finite(Number(item.ytmPct)));
  const ytmWeight = ytmRows.reduce((sum, item) => sum + Number(item.weight), 0);
  const portfolioYtm = ytmWeight
    ? ytmRows.reduce((sum, item) => sum + Number(item.ytmPct) * Number(item.weight), 0) / ytmWeight
    : undefined;
  const ytmCoverage = totalWeight ? ytmWeight / totalWeight * 100 : 0;

  if (finite(portfolioYtm) && ytmCoverage >= 40 && finite(facts.expenseRatioPct)) {
    const netCarry = portfolioYtm - facts.expenseRatioPct;
    byKey.ytmRealisation = rated({
      key: 'ytmRealisation',
      label: byKey.ytmRealisation.label,
      weight: byKey.ytmRealisation.weight,
      rawScores: [bandScore(netCarry, [[3, 12], [4.5, 32], [5.5, 48], [6.5, 62], [7.5, 76], [8.5, 88]])],
      confidence: Math.round(Math.min(70, ytmCoverage) * 0.75),
      coveragePct: ytmCoverage,
      detail: `Disclosed portfolio YTM of ${portfolioYtm.toFixed(2)}% less a ${facts.expenseRatioPct.toFixed(2)}% expense ratio leaves ${netCarry.toFixed(2)}% of gross carry, across ${Math.round(ytmCoverage)}% of the book. This is the yield currently on offer, not yield actually realised over a holding period.`
    });
  } else {
    byKey.ytmRealisation.detail = `Not Rated — a disclosed instrument-level YTM covering at least 40% of the book and a reported expense ratio are required; ${Math.round(ytmCoverage)}% of the book carries a parsed YTM.`;
  }

  byKey.rollDownCapture.detail = 'Not Rated — a point-in-time maturity ladder and yield-curve history are required. Residual maturity is disclosed monthly but the historical curve needed to score roll-down capture is not available free of charge.';
  if (finite(turnoverPct)) byKey.rollDownCapture.confidence = 15;
  return byKey;
}

function hybridQualityPillars({ metrics, peerData, selectedProxy, momentum, manager }) {
  const byKey = Object.fromEntries(HYBRID_QUALITY_PILLARS.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    'Not Rated — the required hybrid-scheme evidence is not available.'
  )]));
  const navConfidence = completeness => navPillarConfidence({ metrics, peerData, selectedProxy, completeness });
  const facts = momentum?.fundFacts || {};
  const allocation = facts.assetAllocation || momentum?.snapshot?.assetAllocation || [];
  const bucket = pattern => allocation
    .filter(row => pattern.test(String(row.name || '')))
    .reduce((sum, row) => sum + (Number(row.weight) || 0), 0);
  const equityPct = bucket(/equity|stock/i);
  const debtPct = bucket(/debt|bond|g-?sec|money market/i);
  const stats = holdingStats(momentum);

  byKey.equitySleeve = buildPillar({
    key: 'equitySleeve',
    label: 'Equity sleeve quality',
    weight: 18,
    minimumCoverage: 55,
    parts: [
      { key: 'alphaPct', weight: 55, value: metrics?.alphaPct, score: metricScore(metrics, peerData, 'alphaPct', 1)?.score },
      { key: 'informationRatio', weight: 45, value: metrics?.informationRatio, score: metricScore(metrics, peerData, 'informationRatio', 1)?.score }
    ],
    confidence: Math.round(navConfidence(100) * 0.75),
    detail: () => 'Peer-relative alpha and information ratio at the total-fund level. The equity sleeve is not separately priced by public sources, so blended fund performance stands in for it.',
    unavailableDetail: 'Not Rated — a hybrid peer alpha distribution is required.'
  });

  byKey.downsideProtection = buildPillar({
    key: 'downsideProtection',
    label: 'Downside protection',
    weight: 12,
    minimumCoverage: 60,
    parts: [
      { key: 'downCapturePct', weight: 40, value: metrics?.downCapturePct, score: metricScore(metrics, peerData, 'downCapturePct', -1)?.score },
      { key: 'maxDrawdownRelativePct', weight: 35, value: metrics?.maxDrawdownRelativePct, score: metricScore(metrics, peerData, 'maxDrawdownRelativePct', 1)?.score },
      { key: 'conditionalDrawdownAtRiskPct', weight: 25, value: metrics?.conditionalDrawdownAtRiskPct, score: metricScore(metrics, peerData, 'conditionalDrawdownAtRiskPct', 1)?.score }
    ],
    confidence: Math.round(navConfidence(100) * 0.85),
    detail: () => 'Peer-relative downside capture, relative maximum drawdown and conditional drawdown-at-risk — the core reason most investors hold a hybrid scheme.',
    unavailableDetail: 'Not Rated — a hybrid peer downside distribution is required.'
  });

  byKey.assetAllocation = buildPillar({
    key: 'assetAllocation',
    label: 'Asset-allocation skill',
    weight: 18,
    minimumCoverage: 50,
    parts: [
      { key: 'overallCapturePct', weight: 60, value: metrics?.overallCapturePct, score: metricScore(metrics, peerData, 'overallCapturePct', 1)?.score },
      { key: 'equityAllocationPct', weight: 40, value: equityPct || undefined, score: bandScore(equityPct || undefined, [[10, 45], [35, 62], [55, 72], [70, 68], [85, 55]]) }
    ],
    confidence: Math.round(navConfidence(100) * 0.7),
    detail: () => `Up/down capture asymmetry alongside a reported ${equityPct ? `${equityPct.toFixed(0)}%` : '—'} equity and ${debtPct ? `${debtPct.toFixed(0)}%` : '—'} debt split. Dated allocation history is required before allocation timing can be attributed rather than observed.`,
    unavailableDetail: 'Not Rated — capture evidence or a reported asset-allocation split is required.'
  });

  byKey.taxCostEfficiency = buildPillar({
    key: 'taxCostEfficiency',
    label: 'Tax and cost efficiency',
    weight: 8,
    minimumCoverage: 55,
    parts: [
      { key: 'expenseRatioPct', weight: 60, value: facts.expenseRatioPct, score: bandScore(facts.expenseRatioPct, [[0.2, 95], [0.5, 86], [0.9, 72], [1.3, 55], [1.8, 34], [2.3, 14]]) },
      { key: 'equityTaxationHeadroom', weight: 40, value: equityPct || undefined, score: bandScore(equityPct || undefined, [[30, 20], [55, 42], [64, 58], [66, 88], [80, 92]]) }
    ],
    confidence: Math.round(navConfidence(100) * 0.7),
    detail: () => `Expense ratio of ${finite(facts.expenseRatioPct) ? `${facts.expenseRatioPct.toFixed(2)}%` : '—'} together with the 65% gross-equity threshold that determines whether the scheme is taxed as equity. A reported ${equityPct ? `${equityPct.toFixed(0)}%` : '—'} equity allocation is used; derivative-adjusted gross equity is not separately published.`,
    unavailableDetail: 'Not Rated — a reported expense ratio or asset-allocation split is required.'
  });

  byKey.debtSleeve.detail = 'Not Rated — the debt sleeve is not separately priced or rated by free public sources.';
  byKey.rebalancing.detail = 'Not Rated — dated asset-allocation snapshots across at least two periods are required.';
  byKey.derivativeUse.detail = 'Not Rated — derivative and hedge positions are not published in a machine-readable free feed.';
  byKey.sleeveInteraction.detail = 'Not Rated — separate sleeve-level return series are required.';
  if (stats.count) byKey.sleeveInteraction.confidence = 15;
  return byKey;
}

function aggregateHeadline({ key, label, factors, minimumCoverage = 70, mandatory = [] }) {
  const rows = Object.values(factors);
  const totalWeight = rows.reduce((sum, item) => sum + item.weight, 0) || 100;
  const ratedRows = rows.filter(item => finite(item.score));
  const availableWeight = ratedRows.reduce((sum, item) => sum + item.weight, 0);
  const coveragePct = availableWeight / totalWeight * 100;
  const missingMandatory = mandatory.filter(required => !finite(factors[required]?.score));
  const confidence = ratedRows.length
    ? ratedRows.reduce((sum, item) => sum + item.confidence * item.weight, 0) / availableWeight
    : 0;
  if (coveragePct < minimumCoverage || missingMandatory.length) {
    const missingLabels = missingMandatory.map(required => factors[required]?.label || required).join(', ');
    return {
      key,
      label,
      score: null,
      confidence: clamp(confidence),
      coveragePct,
      status: 'not-rated',
      range: null,
      detail: missingMandatory.length
        ? `Not Rated — mandatory evidence is missing (${missingLabels}). ${Math.round(coveragePct)}% of factor weight is otherwise available.`
        : `Not Rated — ${Math.round(coveragePct)}% of required factor weight is available; publication requires at least ${minimumCoverage}%.`
    };
  }
  const score = ratedRows.reduce((sum, item) => sum + item.score * item.weight, 0) / availableWeight;
  const halfRange = Math.max(3, Math.round((100 - confidence) / 5));
  return {
    key,
    label,
    score: clamp(score),
    confidence: clamp(confidence),
    coveragePct,
    status: coveragePct >= 90 ? 'full' : coveragePct >= 75 ? 'moderate' : 'provisional',
    range: [clamp(score - halfRange), clamp(score + halfRange)],
    detail: `${coveragePct >= 90 ? 'Full' : coveragePct >= 75 ? 'Moderate-confidence' : 'Provisional'} rating from ${Math.round(coveragePct)}% available factor weight.`
  };
}

function opportunityFactors({ momentum, metrics, peerData, selectedProxy, fund }) {
  const byKey = Object.fromEntries(OPPORTUNITY_FACTORS.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    'Not Rated — point-in-time valuation, earnings, ownership, factor and liquidity evidence is required.'
  )]));

  const stats = holdingStats(momentum);
  const tilt = marketCapTilt(momentum, fund);
  const facts = momentum?.fundFacts || {};
  const fundamentalsWeight = Number(momentum?.coverage?.fundamentalsWeightPct || 0);
  const baseConfidence = completeness => Math.round(portfolioConfidence({ momentum, metrics, selectedProxy, completeness }) * 0.75);

  const trailingPe = weightedFundamental(stats.holdings, 'trailingPe');
  const forwardPe = weightedFundamental(stats.holdings, 'forwardPe');
  const priceToBook = weightedFundamental(stats.holdings, 'priceToBook');

  byKey.holdingsValuation = buildPillar({
    key: 'holdingsValuation',
    label: 'Holdings valuation versus history and sector',
    weight: 20,
    minimumCoverage: 55,
    parts: [
      { key: 'trailingPe', weight: 40, value: trailingPe.value, score: bandScore(trailingPe.value, [[10, 92], [16, 76], [22, 58], [28, 45], [36, 28], [50, 12]]) },
      { key: 'forwardPe', weight: 35, value: forwardPe.value, score: bandScore(forwardPe.value, [[8, 92], [14, 78], [19, 60], [25, 45], [32, 28], [45, 12]]) },
      { key: 'priceToBook', weight: 25, value: priceToBook.value, score: bandScore(priceToBook.value, [[0.8, 92], [1.8, 76], [3, 58], [4.5, 44], [7, 26], [11, 10]]) }
    ],
    confidence: baseConfidence(fundamentalsWeight),
    detail: ({ coveragePct }) => `Weight-averaged trailing P/E of ${finite(trailingPe.value) ? trailingPe.value.toFixed(1) : '—'}, forward P/E of ${finite(forwardPe.value) ? forwardPe.value.toFixed(1) : '—'} and price/book of ${finite(priceToBook.value) ? priceToBook.value.toFixed(1) : '—'} across ${Math.round(fundamentalsWeight)}% of portfolio weight (${Math.round(coveragePct)}% of factor metric weight). Scored against absolute Indian-equity valuation bands; a full history-and-sector-relative percentile needs licensed long-run fundamentals.`,
    unavailableDetail: 'Not Rated — security-level valuation multiples could not be resolved for enough of the portfolio.'
  });

  const earningsGrowth = weightedFundamental(stats.holdings, 'earningsGrowthPct');
  const revenueGrowth = weightedFundamental(stats.holdings, 'revenueGrowthPct');

  byKey.earningsMomentum = buildPillar({
    key: 'earningsMomentum',
    label: 'Earnings and fundamental momentum',
    weight: 20,
    minimumCoverage: 50,
    parts: [
      { key: 'earningsGrowthPct', weight: 60, value: earningsGrowth.value, score: bandScore(earningsGrowth.value, [[-30, 8], [-10, 28], [0, 45], [8, 58], [18, 74], [32, 88], [50, 95]]) },
      { key: 'revenueGrowthPct', weight: 40, value: revenueGrowth.value, score: bandScore(revenueGrowth.value, [[-20, 10], [-5, 32], [3, 48], [10, 62], [20, 78], [35, 92]]) }
    ],
    confidence: baseConfidence(fundamentalsWeight),
    detail: ({ coveragePct }) => `Weight-averaged earnings growth of ${finite(earningsGrowth.value) ? `${earningsGrowth.value.toFixed(1)}%` : '—'} and revenue growth of ${finite(revenueGrowth.value) ? `${revenueGrowth.value.toFixed(1)}%` : '—'} across ${Math.round(coveragePct)}% of factor metric weight. Growth is trailing and reported; forward analyst revision breadth is not available from free sources.`,
    unavailableDetail: 'Not Rated — security-level growth data could not be resolved for enough of the portfolio.'
  });

  const roe = weightedFundamental(stats.holdings, 'returnOnEquityPct');
  const margin = weightedFundamental(stats.holdings, 'profitMarginPct');
  const leverage = weightedFundamental(stats.holdings, 'debtToEquity');
  const currentRatio = weightedFundamental(stats.holdings, 'currentRatio');

  byKey.portfolioQuality = buildPillar({
    key: 'portfolioQuality',
    label: 'Portfolio quality and balance-sheet strength',
    weight: 15,
    minimumCoverage: 55,
    parts: [
      { key: 'returnOnEquityPct', weight: 35, value: roe.value, score: bandScore(roe.value, [[0, 10], [8, 32], [13, 50], [18, 66], [25, 82], [35, 94]]) },
      { key: 'profitMarginPct', weight: 25, value: margin.value, score: bandScore(margin.value, [[0, 12], [4, 34], [8, 50], [14, 68], [22, 84], [32, 94]]) },
      { key: 'debtToEquity', weight: 25, value: leverage.value, score: bandScore(leverage.value, [[0, 92], [25, 80], [55, 64], [90, 48], [150, 30], [250, 12]]) },
      { key: 'currentRatio', weight: 15, value: currentRatio.value, score: bandScore(currentRatio.value, [[0.5, 18], [1, 42], [1.5, 62], [2.2, 76], [3.5, 72]]) }
    ],
    confidence: baseConfidence(fundamentalsWeight),
    detail: ({ coveragePct }) => `Balance-sheet and profitability quality of the disclosed book: ROE ${finite(roe.value) ? `${roe.value.toFixed(1)}%` : '—'}, margin ${finite(margin.value) ? `${margin.value.toFixed(1)}%` : '—'}, debt/equity ${finite(leverage.value) ? leverage.value.toFixed(0) : '—'}, current ratio ${finite(currentRatio.value) ? currentRatio.value.toFixed(2) : '—'}. ${Math.round(coveragePct)}% of factor metric weight resolved.`,
    unavailableDetail: 'Not Rated — security-level quality fundamentals could not be resolved for enough of the portfolio.'
  });

  const regimeId = momentum?.regime?.id;
  const factorAlignmentScore = (() => {
    if (!tilt) return null;
    if (regimeId === 'riskOn') return bandScore(tilt.riskTilt, [[0, 40], [25, 55], [50, 70], [75, 82], [100, 86]]);
    if (regimeId === 'riskOff') return bandScore(tilt.riskTilt, [[0, 86], [25, 76], [50, 58], [75, 36], [100, 22]]);
    if (regimeId === 'rotation') return bandScore(tilt.riskTilt, [[0, 52], [30, 64], [55, 70], [80, 60], [100, 48]]);
    return bandScore(tilt.riskTilt, [[0, 58], [30, 62], [55, 60], [80, 52], [100, 45]]);
  })();

  byKey.factorAlignment = buildPillar({
    key: 'factorAlignment',
    label: 'Current factor/style alignment',
    weight: 15,
    minimumCoverage: 50,
    parts: [
      { key: 'marketCapTiltVersusRegime', weight: 65, value: tilt?.riskTilt, score: factorAlignmentScore },
      { key: 'betaVersusRegime', weight: 35, value: metrics?.beta, score: regimeId === 'riskOff'
        ? bandScore(metrics?.beta, [[0.6, 88], [0.85, 70], [1, 52], [1.15, 34], [1.4, 18]])
        : bandScore(metrics?.beta, [[0.6, 38], [0.85, 52], [1, 62], [1.15, 72], [1.4, 66]]) }
    ],
    confidence: baseConfidence(tilt ? 100 : 40),
    detail: () => `A ${tilt ? `${tilt.largePct.toFixed(0)}/${tilt.midPct.toFixed(0)}/${tilt.smallPct.toFixed(0)} large/mid/small` : 'an unreported market-cap'} profile and ${finite(metrics?.beta) ? metrics.beta.toFixed(2) : '—'} beta assessed against the observed ${momentum?.regime?.label || 'unclassified'} regime. ${tilt?.basis === 'sebi-mandate' ? 'The market-cap split is inferred from the SEBI category mandate because the source did not report one.' : 'The market-cap split is the reported portfolio breakdown.'} Regime classification is momentum-based and descriptive, not a forecast.`,
    unavailableDetail: 'Not Rated — a reported market-cap split or a usable beta is required.'
  });

  const sectorRows = (momentum?.sectors || []).filter(item => finite(item.weight));
  const sectorWeightTotal = sectorRows.reduce((sum, item) => sum + Number(item.weight), 0);
  const weightedSectorReturn = horizon => {
    const rows = sectorRows.filter(item => finite(item[horizon]));
    const denominator = rows.reduce((sum, item) => sum + Number(item.weight), 0);
    return denominator ? rows.reduce((sum, item) => sum + item[horizon] * Number(item.weight), 0) / denominator : undefined;
  };
  const sector6m = weightedSectorReturn('return6mPct');
  const sector1m = weightedSectorReturn('return1mPct');

  byKey.sectorOpportunity = buildPillar({
    key: 'sectorOpportunity',
    label: 'Sector opportunity',
    weight: 10,
    minimumCoverage: 50,
    parts: [
      // A sector basket that has already run hard is a weaker forward opportunity.
      { key: 'sectorSixMonthRun', weight: 60, value: sector6m, score: bandScore(sector6m, [[-30, 88], [-12, 74], [0, 60], [12, 48], [28, 32], [50, 16]]) },
      { key: 'sectorOneMonthRun', weight: 40, value: sector1m, score: bandScore(sector1m, [[-15, 78], [-5, 66], [0, 56], [5, 48], [12, 36], [25, 22]]) }
    ],
    confidence: Math.round(baseConfidence(sectorRows.length >= 6 ? 100 : sectorRows.length * 16) * 0.7),
    detail: () => `The fund's sector basket has returned ${finite(sector6m) ? `${sector6m.toFixed(1)}%` : '—'} over six months and ${finite(sector1m) ? `${sector1m.toFixed(1)}%` : '—'} over one month across ${sectorRows.length} sectors. Scored mean-reversion-style: an already-extended basket scores lower on forward opportunity. Sector valuation levels are not available free of charge.`,
    unavailableDetail: 'Not Rated — priced sector exposures are required.'
  });

  const aumCr = Number(facts.aumCr);
  byKey.crowdingRisk = buildPillar({
    key: 'crowdingRisk',
    label: 'Crowding and ownership risk',
    weight: 10,
    minimumCoverage: 50,
    parts: [
      { key: 'concentrationCrowding', weight: 45, value: stats.top10WeightPct, score: bandScore(stats.top10WeightPct, [[15, 80], [30, 70], [45, 55], [60, 38], [78, 20]]) },
      { key: 'scaleCrowding', weight: 35, value: aumCr, score: bandScore(aumCr, [[100, 82], [1500, 72], [8000, 60], [25000, 45], [55000, 30], [100000, 18]]) },
      { key: 'sectorConcentration', weight: 20, value: sectorWeightTotal ? Math.max(...sectorRows.map(item => Number(item.weight) / sectorWeightTotal * 100)) : undefined, score: bandScore(sectorWeightTotal ? Math.max(...sectorRows.map(item => Number(item.weight) / sectorWeightTotal * 100)) : undefined, [[12, 80], [22, 68], [32, 52], [45, 34], [60, 18]]) }
    ],
    confidence: Math.round(baseConfidence(100) * 0.6),
    detail: () => `Concentration and scale as crowding proxies: ${finite(stats.top10WeightPct) ? `${stats.top10WeightPct.toFixed(0)}%` : '—'} in the top ten across ${finite(aumCr) ? `₹${Math.round(aumCr).toLocaleString('en-IN')} crore` : 'unreported assets'}. True crowding needs cross-fund ownership data, which is not available free of charge, so this is a structural proxy only.`,
    unavailableDetail: 'Not Rated — a disclosed holdings book or reported assets are required.'
  });

  byKey.liquidityFlowRisk = buildPillar({
    key: 'liquidityFlowRisk',
    label: 'Liquidity and flow vulnerability',
    weight: 10,
    minimumCoverage: 50,
    parts: [
      { key: 'smallCapExposure', weight: 45, value: tilt?.smallPct, score: bandScore(tilt?.smallPct, [[0, 85], [10, 76], [25, 62], [45, 44], [70, 26], [100, 14]]) },
      { key: 'scaleVersusTilt', weight: 35, value: finite(aumCr) && tilt ? aumCr * (tilt.riskTilt / 100) : undefined, score: bandScore(finite(aumCr) && tilt ? aumCr * (tilt.riskTilt / 100) : undefined, [[0, 86], [1500, 74], [6000, 60], [18000, 42], [40000, 24], [70000, 12]]) },
      { key: 'drawdownRecovery', weight: 20, value: metrics?.recoveryDays, score: bandScore(metrics?.recoveryDays, [[5, 82], [20, 70], [45, 56], [90, 38], [180, 20]]) }
    ],
    confidence: Math.round(baseConfidence(100) * 0.6),
    detail: () => `${tilt ? `${tilt.smallPct.toFixed(0)}% small-cap exposure` : 'An unreported market-cap split'} against ${finite(aumCr) ? `₹${Math.round(aumCr).toLocaleString('en-IN')} crore` : 'unreported assets'}, with ${finite(metrics?.recoveryDays) ? `${Math.round(metrics.recoveryDays)}-day` : 'unmeasured'} average drawdown recovery. Actual redemption flows are not disclosed publicly.`,
    unavailableDetail: 'Not Rated — a reported market-cap split or assets under management are required.'
  });

  return byKey;
}

const HORIZON_YEARS = { short: 1.5, medium: 4, long: 8 };
const RISK_APPETITE = { conservative: 1, moderate: 2, aggressive: 3 };

function categoryProfile(fund) {
  const text = [fund?.category, fund?.displayName, fund?.preferredSchemeName].join(' ').toLowerCase();
  if (/overnight|liquid/.test(text)) return { risk: 1, horizonYears: 0.25, taxEquity: false, lockInYears: 0, goals: ['emergency', 'income'] };
  if (/money market|ultra short|low duration/.test(text)) return { risk: 1, horizonYears: 0.75, taxEquity: false, lockInYears: 0, goals: ['emergency', 'income'] };
  if (/short duration|banking and psu|corporate bond|floater/.test(text)) return { risk: 1, horizonYears: 2, taxEquity: false, lockInYears: 0, goals: ['income', 'preservation'] };
  if (/gilt|medium duration|long duration|dynamic bond/.test(text)) return { risk: 2, horizonYears: 4, taxEquity: false, lockInYears: 0, goals: ['income', 'preservation'] };
  if (/credit risk/.test(text)) return { risk: 3, horizonYears: 3.5, taxEquity: false, lockInYears: 0, goals: ['income'] };
  if (/arbitrage/.test(text)) return { risk: 1, horizonYears: 1, taxEquity: true, lockInYears: 0, goals: ['emergency', 'preservation'] };
  if (/equity savings/.test(text)) return { risk: 2, horizonYears: 3, taxEquity: true, lockInYears: 0, goals: ['income', 'preservation'] };
  if (/conservative hybrid/.test(text)) return { risk: 2, horizonYears: 3, taxEquity: false, lockInYears: 0, goals: ['income', 'preservation'] };
  if (/balanced advantage|dynamic asset allocation|multi asset/.test(text)) return { risk: 2, horizonYears: 4, taxEquity: true, lockInYears: 0, goals: ['growth', 'preservation'] };
  if (/aggressive hybrid/.test(text)) return { risk: 3, horizonYears: 5, taxEquity: true, lockInYears: 0, goals: ['growth'] };
  if (/elss|tax saver/.test(text)) return { risk: 3, horizonYears: 5, taxEquity: true, lockInYears: 3, goals: ['tax', 'growth'] };
  if (/small cap/.test(text)) return { risk: 4, horizonYears: 8, taxEquity: true, lockInYears: 0, goals: ['growth'] };
  if (/mid cap/.test(text)) return { risk: 4, horizonYears: 7, taxEquity: true, lockInYears: 0, goals: ['growth'] };
  if (/sectoral|thematic/.test(text)) return { risk: 4, horizonYears: 7, taxEquity: true, lockInYears: 0, goals: ['growth'] };
  if (/large cap|index|nifty|sensex/.test(text)) return { risk: 3, horizonYears: 5, taxEquity: true, lockInYears: 0, goals: ['growth', 'retirement'] };
  return { risk: 3, horizonYears: 6, taxEquity: true, lockInYears: 0, goals: ['growth', 'retirement'] };
}

function investorFitFactors({ fund, metrics, momentum, investorProfile }) {
  const byKey = Object.fromEntries(INVESTOR_FIT_FACTORS.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    'Not Rated — set an investor profile to score suitability for a specific investor.'
  )]));
  if (!investorProfile) return byKey;

  const profile = categoryProfile(fund);
  const confidence = 78;
  const appetite = RISK_APPETITE[investorProfile.riskTolerance] || 2;
  const horizonYears = HORIZON_YEARS[investorProfile.horizon] || 4;

  // A scheme materially riskier than the investor's appetite is penalised much harder
  // than one that is more conservative than needed.
  const riskGap = profile.risk - (appetite + 1);
  const volatility = metrics?.volatilityPct;
  byKey.riskTolerance = buildPillar({
    key: 'riskTolerance',
    label: 'Risk-tolerance match',
    weight: 25,
    minimumCoverage: 50,
    parts: [
      { key: 'categoryRiskGap', weight: 60, value: riskGap, score: bandScore(riskGap, [[-3, 46], [-2, 60], [-1, 76], [0, 90], [1, 52], [2, 26], [3, 10]]) },
      { key: 'realisedVolatilityPct', weight: 40, value: volatility, score: (() => {
        const tolerance = appetite === 1 ? 8 : appetite === 2 ? 15 : 24;
        return bandScore(finite(volatility) ? volatility - tolerance : undefined, [[-10, 82], [-4, 88], [0, 78], [4, 54], [9, 28], [16, 10]]);
      })() }
    ],
    confidence,
    detail: () => `A ${['', 'very low', 'low-to-moderate', 'moderate-to-high', 'high'][profile.risk]}-risk category assessed against a ${investorProfile.riskTolerance} investor, with ${finite(volatility) ? `${volatility.toFixed(1)}%` : '—'} realised annualised volatility. SEBI Riskometer values are not published in a machine-readable free feed, so category risk is inferred from the scheme's SEBI category.`,
    unavailableDetail: 'Not Rated — a resolvable scheme category is required.'
  });

  const horizonGap = horizonYears - profile.horizonYears;
  byKey.timeHorizon = buildPillar({
    key: 'timeHorizon',
    label: 'Investment-horizon match',
    weight: 20,
    minimumCoverage: 50,
    parts: [
      { key: 'horizonGapYears', weight: 100, value: horizonGap, score: bandScore(horizonGap, [[-6, 8], [-3, 26], [-1, 58], [0, 86], [2, 90], [5, 82], [9, 74]]) }
    ],
    confidence,
    detail: () => `The category's suggested minimum holding period is about ${profile.horizonYears} years against a stated ${horizonYears}-year horizon. Holding an equity-oriented scheme for less than its suggested period is the single most common cause of realised underperformance.`,
    unavailableDetail: 'Not Rated — a stated investment horizon is required.'
  });

  const goalMatch = profile.goals.includes(investorProfile.goal);
  byKey.goalSuitability = buildPillar({
    key: 'goalSuitability',
    label: 'Goal suitability',
    weight: 15,
    minimumCoverage: 50,
    parts: [
      { key: 'goalCategoryMatch', weight: 100, value: goalMatch ? 1 : 0, score: goalMatch ? 86 : 34 }
    ],
    confidence,
    detail: () => `This category is typically used for ${profile.goals.join(', ')}; the stated goal is ${investorProfile.goal}. ${goalMatch ? 'The mandate matches the stated goal.' : 'The mandate does not match the stated goal, which usually matters more than any performance difference.'}`,
    unavailableDetail: 'Not Rated — a stated goal is required.'
  });

  const maxDrawdown = Math.abs(Number(metrics?.maxDrawdownPct));
  const tolerable = Number(investorProfile.maxDrawdownPct);
  byKey.drawdownTolerance = buildPillar({
    key: 'drawdownTolerance',
    label: 'Drawdown-tolerance match',
    weight: 10,
    minimumCoverage: 50,
    parts: [
      { key: 'drawdownHeadroomPct', weight: 100, value: finite(maxDrawdown) && finite(tolerable) ? tolerable - maxDrawdown : undefined, score: bandScore(finite(maxDrawdown) && finite(tolerable) ? tolerable - maxDrawdown : undefined, [[-25, 6], [-12, 22], [-4, 44], [0, 66], [6, 84], [18, 92]]) }
    ],
    confidence,
    detail: () => `The scheme's worst observed peak-to-trough fall was ${finite(maxDrawdown) ? `${maxDrawdown.toFixed(1)}%` : '—'} against a stated tolerance of ${finite(tolerable) ? `${tolerable}%` : '—'}. This is the historical worst on available NAV history, not a limit on future falls.`,
    unavailableDetail: 'Not Rated — NAV drawdown history and a stated drawdown tolerance are required.'
  });

  const needsLiquidity = investorProfile.liquidityNeed === 'high';
  byKey.liquidityRequirement = buildPillar({
    key: 'liquidityRequirement',
    label: 'Liquidity requirement',
    weight: 5,
    minimumCoverage: 50,
    parts: [
      { key: 'lockInVersusNeed', weight: 100, value: profile.lockInYears, score: profile.lockInYears > 0
        ? (needsLiquidity ? 8 : investorProfile.liquidityNeed === 'medium' ? 38 : 66)
        : (needsLiquidity ? (profile.risk <= 1 ? 88 : profile.risk === 2 ? 58 : 30) : 82) }
    ],
    confidence,
    detail: () => `${profile.lockInYears ? `A statutory ${profile.lockInYears}-year lock-in applies.` : 'No statutory lock-in applies.'} Stated liquidity need is ${investorProfile.liquidityNeed}. Scheme-specific exit loads are not published in a machine-readable free feed and are not included.`,
    unavailableDetail: 'Not Rated — a stated liquidity need is required.'
  });

  const equityTaxed = profile.taxEquity;
  const longHold = horizonYears >= (equityTaxed ? 1 : 2);
  byKey.taxSuitability = buildPillar({
    key: 'taxSuitability',
    label: 'Tax suitability',
    weight: 5,
    minimumCoverage: 50,
    parts: [
      { key: 'holdingPeriodVersusTaxation', weight: 100, value: longHold ? 1 : 0, score: equityTaxed
        ? (longHold ? 84 : 40)
        : (investorProfile.taxBracket === 'high' ? (longHold ? 52 : 30) : (longHold ? 72 : 56)) }
    ],
    confidence,
    detail: () => `${equityTaxed ? 'Taxed as an equity scheme' : 'Taxed as a non-equity scheme'} against a ${horizonYears}-year horizon and a ${investorProfile.taxBracket} tax bracket. Indicative only — this is not tax advice and does not account for your full return position.`,
    unavailableDetail: 'Not Rated — a stated tax bracket and horizon are required.'
  });

  const sip = investorProfile.mode === 'sip';
  byKey.investmentMode = buildPillar({
    key: 'investmentMode',
    label: 'SIP/lump-sum suitability',
    weight: 5,
    minimumCoverage: 50,
    parts: [
      { key: 'volatilityVersusMode', weight: 100, value: volatility, score: finite(volatility)
        ? (sip ? bandScore(volatility, [[3, 52], [8, 64], [14, 78], [22, 86], [32, 80]]) : bandScore(volatility, [[3, 84], [8, 76], [14, 62], [22, 44], [32, 28]]))
        : null }
    ],
    confidence,
    detail: () => `${sip ? 'A staggered SIP' : 'A lump-sum investment'} into a scheme with ${finite(volatility) ? `${volatility.toFixed(1)}%` : '—'} realised volatility. Higher volatility rewards staggered entry and penalises single-date lump sums.`,
    unavailableDetail: 'Not Rated — realised volatility is required.'
  });

  byKey.portfolioOverlap.detail = 'Not Rated — this requires the schemes you already hold, which are not part of the current profile. Overlap cannot be inferred from a single fund.';
  return byKey;
}

function overallDataConfidence({ qualityPillars, metrics, momentum, peerData, selectedProxy, fund }) {
  if (!fund) return { score: null, confidence: 0, components: {}, detail: 'Select a fund to assess data confidence.' };
  const qualityWeight = Object.values(qualityPillars).reduce((sum, item) => sum + (finite(item.score) ? item.weight : 0), 0);
  const dataCompleteness = clamp(Math.max(
    qualityWeight,
    Number(momentum?.coverage?.resolvedPct || 0) * 0.7,
    Number(momentum?.coverage?.fundamentalsWeightPct || 0) * 0.6
  ));
  const components = {
    dataCompleteness,
    historyLength: historyConfidence(effectiveYears(metrics)),
    benchmarkQuality: benchmarkQualityScore(selectedProxy),
    inferenceQuality: inferenceConfidence(momentum),
    modelStability: peerData?.peerCount >= 15 ? 90 : peerData?.peerCount >= 10 ? 75 : peerData?.peerCount >= 6 ? 55 : 0
  };
  if (peerData?.comparability?.pointInTime !== true) components.modelStability = Math.max(0, components.modelStability - 15);
  const score = confidenceScore(components);
  return {
    score,
    confidence: score,
    coveragePct: 100,
    status: score >= 75 ? 'full' : score >= 50 ? 'moderate' : 'provisional',
    range: null,
    components,
    detail: 'Reliability based on completeness, usable history, benchmark quality, holdings/trade inference quality and model stability.'
  };
}

function recommendation(quality, opportunity, fit, confidence) {
  if (!finite(quality?.score) || !finite(opportunity?.score) || !finite(fit?.score)) {
    return { score: null, status: 'not-rated', detail: 'No recommendation — Quality, Opportunity and Investor Fit must all be rated.' };
  }
  if (fit.score < 40) return { score: null, status: 'blocked', detail: 'Do not recommend — Investor Fit is below 40.' };
  if (!finite(confidence?.score) || confidence.score < 50) return { score: null, status: 'blocked', detail: 'Insufficient evidence — Data Confidence is below 50.' };
  const score = 100 * Math.pow(quality.score / 100, 0.55) * Math.pow(opportunity.score / 100, 0.15) * Math.pow(fit.score / 100, 0.30);
  return { score: clamp(score), status: 'rated', detail: 'Geometric recommendation score with Quality 55%, Opportunity 15% and Investor Fit 30%.' };
}

export function calculateManagerLensScores({ fund, manager, snapshot, market, traditional, peerData, selectedProxy, investorProfile }) {
  const model = qualityModelFor(fund);
  const prototypeDiagnostics = calculatePrototypeDiagnostics({
    schemeId: 'generic',
    snapshot,
    market,
    traditional
  });
  const diagnostics = {
    ...prototypeDiagnostics,
    overall: null,
    momentumScore: null,
    traditionalScore: null,
    factors: Object.fromEntries(Object.entries(prototypeDiagnostics?.factors || {}).map(([key, factor]) => [key, {
      ...factor,
      score: null,
      diagnosticOnly: true
    }]))
  };
  const pillarInput = { metrics: traditional, peerData, selectedProxy, momentum: market, manager, fund };
  const qualityPillars = model.id === 'equity'
    ? equityQualityPillars(pillarInput)
    : model.id === 'debt'
      ? debtQualityPillars(pillarInput)
      : hybridQualityPillars(pillarInput);
  const currentOpportunityFactors = opportunityFactors({ momentum: market, metrics: traditional, peerData, selectedProxy, fund });
  const fitFactors = investorFitFactors({ fund, metrics: traditional, momentum: market, investorProfile });
  const fundQuality = aggregateHeadline({
    key: 'fundQuality',
    label: 'Fund Quality',
    factors: qualityPillars,
    minimumCoverage: 70,
    mandatory: model.id === 'equity' ? ['riskAdjustedAlpha', 'downsideProtection'] : []
  });
  const currentOpportunity = aggregateHeadline({
    key: 'currentOpportunity',
    label: 'Current Opportunity',
    factors: currentOpportunityFactors,
    minimumCoverage: 60
  });
  const investorFit = aggregateHeadline({
    key: 'investorFit',
    label: 'Investor Fit',
    factors: fitFactors,
    minimumCoverage: 70,
    mandatory: ['riskTolerance', 'timeHorizon']
  });
  const dataConfidence = overallDataConfidence({
    qualityPillars,
    metrics: traditional,
    momentum: market,
    peerData,
    selectedProxy,
    fund
  });
  const recommendationScore = recommendation(fundQuality, currentOpportunity, investorFit, dataConfidence);
  const orderedQualityPillars = model.pillars.map(([key]) => qualityPillars[key]);
  const orderedOpportunityFactors = OPPORTUNITY_FACTORS.map(([key]) => currentOpportunityFactors[key]);
  const orderedInvestorFitFactors = INVESTOR_FIT_FACTORS.map(([key]) => fitFactors[key]);

  return {
    methodologyVersion: '2.1-peer-confidence',
    model,
    headlines: { fundQuality, currentOpportunity, investorFit, dataConfidence },
    recommendation: recommendationScore,
    qualityPillars,
    opportunityFactors: currentOpportunityFactors,
    investorFitFactors: fitFactors,
    orderedQualityPillars,
    orderedOpportunityFactors,
    orderedInvestorFitFactors,
    diagnostics,
    peerContext: peerData || null,
    investorProfile: investorProfile || null,
    guardrails: [
      '50 means peer median or no demonstrated edge; missing evidence is Not Rated.',
      'Rated factors use median/MAD peer standardisation, z-score winsorisation at ±3 and confidence shrinkage toward 50.',
      'Fund Quality requires 70% of factor weight; Current Opportunity requires 60%.',
      'Alpha is single-factor and NAV-derived; holdings attribution uses the latest disclosed portfolio, not point-in-time books.',
      'Security fundamentals cover only the priced portion of the disclosed portfolio; coverage is stated on every affected factor.',
      'Inferred monthly trades and exit-peak context are descriptive diagnostics, not core Fund Quality inputs.',
      peerData?.comparability?.pointInTime === true
        ? 'Peer membership is point-in-time validated.'
        : 'Peer membership reflects today’s category, so model stability is capped by a fixed confidence penalty.'
    ],
    manager
  };
}

export { CONFIDENCE_WEIGHTS, EQUITY_QUALITY_PILLARS, DEBT_QUALITY_PILLARS, HYBRID_QUALITY_PILLARS, OPPORTUNITY_FACTORS, INVESTOR_FIT_FACTORS, categoryProfile };
