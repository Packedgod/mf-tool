import { calculateManagerScore as calculatePrototypeDiagnostics } from '@/lib/momentum-engine';

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

function metricScore(metrics, peers, key, direction = 1) {
  if (peers?.comparability?.pointInTime !== true) return null;
  return robustPeerScore(metrics?.[key], peers?.distributions?.[key], direction);
}

function navPillarConfidence({ metrics, peerData, selectedProxy, completeness = 100 }) {
  const modelStability = peerData?.peerCount >= 15 ? 90 : peerData?.peerCount >= 10 ? 75 : peerData?.peerCount >= 6 ? 55 : 0;
  const pointInTimePenalty = peerData?.comparability?.pointInTime === true ? 0 : 15;
  return confidenceScore({
    dataCompleteness: completeness,
    historyLength: historyConfidence(metrics?.years),
    benchmarkQuality: benchmarkQualityScore(selectedProxy),
    inferenceQuality: 100,
    modelStability: Math.max(0, modelStability - pointInTimePenalty)
  });
}

function equityQualityPillars({ metrics, peerData, selectedProxy, momentum }) {
  const byKey = Object.fromEntries(EQUITY_QUALITY_PILLARS.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    'Not Rated — the required peer-relative, point-in-time evidence is not yet available.'
  )]));

  byKey.riskAdjustedAlpha = notRated(
    'riskAdjustedAlpha',
    'Risk-adjusted manager alpha',
    18,
    'Not Rated — the available Jensen-style NAV alpha is retained as descriptive evidence, but cannot replace multi-factor, net-of-fee, Bayesian-shrunk alpha.'
  );

  byKey.skillPersistence = notRated(
    'skillPersistence',
    'Skill persistence',
    12,
    'Not Rated — the prototype four-window consistency statistic is descriptive only; independent rolling, non-overlapping, manager-change and AUM-growth tests are required.'
  );

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
  const downsideConfidence = navPillarConfidence({ metrics, peerData, selectedProxy, completeness: downsideCoverage });
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

  const inference = inferenceConfidence(momentum);
  byKey.stockSelection.confidence = inference;
  byKey.stockSelection.detail = 'Not Rated — factor-adjusted forward stock returns over 1, 3, 6 and 12 months are not yet available.';
  byKey.sectorAllocation.confidence = inference;
  byKey.sectorAllocation.detail = 'Not Rated — benchmark sector weights and point-in-time Brinson allocation history are required.';
  byKey.tradingExecution.confidence = inference;
  byKey.tradingExecution.detail = 'Not Rated — inferred monthly trades remain descriptive until forward factor-adjusted returns and trading costs are available.';
  byKey.portfolioConstruction.confidence = momentum?.holdings?.length ? 35 : 0;
  byKey.portfolioConstruction.detail = 'Not Rated — Active Share, benchmark overlap, factor concentration and contribution-to-risk peers are required.';
  byKey.costEfficiency.detail = 'Not Rated — category-peer expense ratios and estimated implementation costs are required.';
  byKey.liquidityCapacity.confidence = momentum?.fundFacts?.aumCr ? 25 : 0;
  byKey.liquidityCapacity.detail = 'Not Rated — AUM alone is insufficient; holding-level liquidity, ownership and market-impact capacity are required.';
  byKey.managerStability.detail = 'Not Rated — tenure, team changes, mandate stability and governance must be tracked point-in-time.';
  byKey.holdingsQuality.confidence = momentum?.holdings?.length ? 25 : 0;
  byKey.holdingsQuality.detail = 'Not Rated — security-level profitability, balance-sheet, earnings and valuation evidence is unavailable.';
  byKey.regimeResilience.detail = 'Not Rated — empirical, point-in-time regime observations have not met the publication minimum.';
  return byKey;
}

function emptyPillars(definitions, modelLabel) {
  return Object.fromEntries(definitions.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    `Not Rated — the ${modelLabel.toLowerCase()} data pipeline for this pillar is not yet complete.`
  )]));
}

function aggregateHeadline({ key, label, factors, minimumCoverage = 70, mandatory = [] }) {
  const rows = Object.values(factors);
  const totalWeight = rows.reduce((sum, item) => sum + item.weight, 0) || 100;
  const ratedRows = rows.filter(item => finite(item.score));
  const availableWeight = ratedRows.reduce((sum, item) => sum + item.weight, 0);
  const coveragePct = availableWeight / totalWeight * 100;
  const mandatoryReady = mandatory.every(required => finite(factors[required]?.score));
  const confidence = ratedRows.length
    ? ratedRows.reduce((sum, item) => sum + item.confidence * item.weight, 0) / availableWeight
    : 0;
  if (coveragePct < minimumCoverage || !mandatoryReady) {
    return {
      key,
      label,
      score: null,
      confidence: clamp(confidence),
      coveragePct,
      status: 'not-rated',
      range: null,
      detail: `Not Rated — ${Math.round(coveragePct)}% of required factor weight is available; publication requires at least ${minimumCoverage}% and all mandatory evidence.`
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

function opportunityFactors() {
  return Object.fromEntries(OPPORTUNITY_FACTORS.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    'Not Rated — point-in-time valuation, earnings, ownership, factor and liquidity evidence is required.'
  )]));
}

function investorFitFactors() {
  return Object.fromEntries(INVESTOR_FIT_FACTORS.map(([key, label, weight]) => [key, notRated(
    key,
    label,
    weight,
    'Not Rated — an investor profile and verified scheme Riskometer are required.'
  )]));
}

function overallDataConfidence({ qualityPillars, metrics, momentum, peerData, selectedProxy, fund }) {
  if (!fund) return { score: null, confidence: 0, components: {}, detail: 'Select a fund to assess data confidence.' };
  const qualityWeight = Object.values(qualityPillars).reduce((sum, item) => sum + (finite(item.score) ? item.weight : 0), 0);
  const dataCompleteness = clamp(Math.max(
    qualityWeight,
    Number(momentum?.coverage?.resolvedPct || 0) * 0.7
  ));
  const components = {
    dataCompleteness,
    historyLength: historyConfidence(metrics?.years),
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

export function calculateManagerLensScores({ fund, manager, snapshot, market, traditional, peerData, selectedProxy }) {
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
  const qualityPillars = model.id === 'equity'
    ? equityQualityPillars({ metrics: traditional, peerData, selectedProxy, momentum: market })
    : emptyPillars(model.pillars, model.label);
  const currentOpportunityFactors = opportunityFactors();
  const fitFactors = investorFitFactors();
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
    minimumCoverage: 70
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
    methodologyVersion: '2.0-peer-confidence',
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
    guardrails: [
      '50 means peer median or no demonstrated edge; missing evidence is Not Rated.',
      'Rated factors use median/MAD peer standardisation, z-score winsorisation at ±3 and confidence shrinkage toward 50.',
      'No headline score is published below 70% required factor-weight coverage.',
      'Inferred monthly trades and exit-peak context are descriptive diagnostics, not core Fund Quality inputs.',
      peerData?.comparability?.pointInTime === true
        ? 'Peer membership is point-in-time validated.'
        : 'Peer membership currently reflects today’s category and is therefore capped below full confidence until historical membership is available.'
    ],
    manager
  };
}

export { CONFIDENCE_WEIGHTS, EQUITY_QUALITY_PILLARS, DEBT_QUALITY_PILLARS, HYBRID_QUALITY_PILLARS };
