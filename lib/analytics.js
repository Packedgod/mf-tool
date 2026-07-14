function parseDate(value) {
  const text = String(value || "").trim();
  const parts = text.split("-");
  if (parts.length === 3 && parts[0].length === 2) {
    const [dd, mm, yyyy] = parts.map(Number);
    return new Date(Date.UTC(yyyy, mm - 1, dd));
  }
  return new Date(text);
}

function normaliseSeries(data) {
  return (Array.isArray(data) ? data : [])
    .map((point) => {
      const date = parseDate(point.date);
      const nav = Number(point.nav);
      if (!Number.isFinite(date.getTime()) || !Number.isFinite(nav) || nav <= 0) return null;
      return { date: date.toISOString().slice(0, 10), nav };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function stdev(values) {
  if (values.length < 2) return undefined;
  const avg = mean(values);
  if (avg === undefined) return undefined;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function covariance(x, y) {
  if (x.length < 2 || x.length !== y.length) return undefined;
  const mx = mean(x);
  const my = mean(y);
  if (mx === undefined || my === undefined) return undefined;
  return x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0) / (x.length - 1);
}

function dailyReturns(series) {
  const out = [];
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];
    if (previous.nav > 0 && current.nav > 0) {
      out.push({ date: current.date, value: current.nav / previous.nav - 1 });
    }
  }
  return out;
}

function alignReturns(fund, benchmark) {
  const benchmarkMap = new Map(dailyReturns(benchmark).map((point) => [point.date, point.value]));
  return dailyReturns(fund)
    .map((point) => {
      if (!benchmarkMap.has(point.date)) return null;
      return { date: point.date, fund: point.value, benchmark: benchmarkMap.get(point.date) };
    })
    .filter(Boolean);
}

function annualiseDaily(dailyReturn) {
  return (Math.pow(1 + dailyReturn, 252) - 1) * 100;
}

function maximumDrawdown(series) {
  let peak = -Infinity;
  let worst = 0;
  for (const point of series) {
    peak = Math.max(peak, point.nav);
    if (peak > 0) worst = Math.min(worst, point.nav / peak - 1);
  }
  return worst * 100;
}

function drawdownProfile(series) {
  if (!series.length) return {};
  let peak = -Infinity;
  let underwaterDays = 0;
  let currentUnderwaterDays = 0;
  const completedDurations = [];
  const drawdowns = [];
  for (const point of series) {
    if (point.nav >= peak) {
      if (currentUnderwaterDays > 0) completedDurations.push(currentUnderwaterDays);
      peak = point.nav;
      currentUnderwaterDays = 0;
      drawdowns.push(0);
      continue;
    }
    const drawdown = peak > 0 ? (point.nav / peak - 1) * 100 : 0;
    drawdowns.push(drawdown);
    underwaterDays += 1;
    currentUnderwaterDays += 1;
  }
  if (currentUnderwaterDays > 0) completedDurations.push(currentUnderwaterDays);
  const sorted = [...drawdowns].sort((left, right) => left - right);
  const tailCount = Math.max(1, Math.ceil(sorted.length * 0.1));
  return {
    conditionalDrawdownAtRiskPct: mean(sorted.slice(0, tailCount)),
    timeUnderWaterPct: series.length ? underwaterDays / series.length * 100 : undefined,
    recoveryDays: completedDurations.length ? mean(completedDurations) : 0
  };
}

function monthlyReturns(series) {
  const months = new Map();
  for (const point of series) {
    const key = point.date.slice(0, 7);
    const current = months.get(key);
    if (!current) months.set(key, { first: point, last: point });
    else {
      if (point.date < current.first.date) current.first = point;
      if (point.date > current.last.date) current.last = point;
    }
  }
  return Array.from(months.entries()).map(([month, value]) => ({
    month,
    value: value.last.nav / value.first.nav - 1
  }));
}

function alphaPersistence(aligned) {
  if (aligned.length < 120) return undefined;
  const chunks = 4;
  const size = Math.floor(aligned.length / chunks);
  const activeMeans = [];
  for (let index = 0; index < chunks; index += 1) {
    const start = index * size;
    const end = index === chunks - 1 ? aligned.length : (index + 1) * size;
    const active = aligned.slice(start, end).map((row) => row.fund - row.benchmark);
    const avg = mean(active);
    if (avg !== undefined) activeMeans.push(avg);
  }
  if (!activeMeans.length) return undefined;
  const positive = activeMeans.filter((value) => value > 0).length;
  const consistency = positive / activeMeans.length;
  const dispersion = stdev(activeMeans) || 0;
  const average = mean(activeMeans) || 0;
  const stability = Math.max(0, 1 - Math.min(1, Math.abs(dispersion / (Math.abs(average) + 0.000001)) / 3));
  return Math.max(0, Math.min(100, consistency * 70 + stability * 30));
}

function buildSyntheticProxy(componentSeries, weights) {
  if (!componentSeries.length) return [];
  if (componentSeries.length === 1) {
    const base = componentSeries[0];
    if (!base.length) return [];
    const start = base[0].nav;
    return base.map((point) => ({ date: point.date, nav: (point.nav / start) * 100 }));
  }

  const returnMaps = componentSeries.map((series) => new Map(dailyReturns(series).map((row) => [row.date, row.value])));
  const commonDates = Array.from(returnMaps[0].keys()).filter((date) => returnMaps.every((map) => map.has(date))).sort();
  if (!commonDates.length) return [];

  let nav = 100;
  const out = [];
  for (const date of commonDates) {
    let weightedReturn = 0;
    for (let index = 0; index < returnMaps.length; index += 1) {
      weightedReturn += (weights[index] || 0) * returnMaps[index].get(date);
    }
    nav *= 1 + weightedReturn;
    out.push({ date, nav });
  }
  return out;
}

function calculateDataConfidence({ fund, benchmark, sourceHealth, proxyQuality, managerStartDate }) {
  let score = 0;
  const notes = [];

  if (fund.length >= 756) score += 25;
  else if (fund.length >= 252) score += 18;
  else if (fund.length >= 60) score += 10;
  else notes.push("Short fund history");

  if (benchmark.length >= 756) score += 20;
  else if (benchmark.length >= 252) score += 14;
  else if (benchmark.length >= 60) score += 8;
  else notes.push("Short proxy history");

  if (sourceHealth?.mfapi === "online") score += 15;
  else notes.push("MFapi degraded");

  if (sourceHealth?.amfi === "online") score += 15;
  else notes.push("AMFI validation unavailable");

  if (proxyQuality === "High") score += 15;
  else if (proxyQuality === "Medium-high") score += 12;
  else if (proxyQuality === "Medium") score += 8;

  if (managerStartDate) score += 10;
  else notes.push("Manager start date unavailable");

  return {
    score: Math.max(0, Math.min(100, score)),
    grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D",
    notes
  };
}

function computeMetrics(fund, benchmark, riskFreeRate = 6.5) {
  const warnings = [];
  if (fund.length < 3) {
    return { observations: fund.length, warnings: ["Not enough live NAV observations."] };
  }

  const start = fund[0];
  const end = fund[fund.length - 1];
  const years = Math.max((parseDate(end.date) - parseDate(start.date)) / (365.25 * 24 * 60 * 60 * 1000), 1 / 365.25);
  const totalReturnPct = (end.nav / start.nav - 1) * 100;
  const cagrPct = (Math.pow(end.nav / start.nav, 1 / years) - 1) * 100;
  const fundReturns = dailyReturns(fund).map((point) => point.value);
  const averageDaily = mean(fundReturns);
  const dailyStd = stdev(fundReturns);
  const volatilityPct = dailyStd === undefined ? undefined : dailyStd * Math.sqrt(252) * 100;
  const annualReturnPct = averageDaily === undefined ? undefined : annualiseDaily(averageDaily);
  const sharpe = volatilityPct && annualReturnPct !== undefined ? (annualReturnPct - riskFreeRate) / volatilityPct : undefined;
  const drawdownPct = maximumDrawdown(fund);
  const drawdown = drawdownProfile(fund);
  const monthly = monthlyReturns(fund);
  const positiveMonthHitRatePct = monthly.length ? (monthly.filter((point) => point.value > 0).length / monthly.length) * 100 : undefined;
  const tailLossFrequencyPct = fundReturns.length ? fundReturns.filter(value => value <= -0.02).length / fundReturns.length * 100 : undefined;

  let beta;
  let alphaPct;
  let activeReturnPct;
  let trackingErrorPct;
  let informationRatio;
  let upCapturePct;
  let downCapturePct;
  let overallCapturePct;
  let alphaPersistenceScore;
  let passiveTerminalNav;
  let managerValueAddNav;
  let maxDrawdownRelativePct;
  let negativeMonthAlphaPct;
  let alignedObservations = 0;

  if (benchmark.length) {
    const aligned = alignReturns(fund, benchmark);
    alignedObservations = aligned.length;
    if (aligned.length < 60) warnings.push("Low fund/proxy overlap; benchmark-relative metrics may be unstable.");
    const fundAligned = aligned.map((row) => row.fund);
    const benchmarkAligned = aligned.map((row) => row.benchmark);
    const benchmarkStd = stdev(benchmarkAligned);
    const cov = covariance(fundAligned, benchmarkAligned);
    if (cov !== undefined && benchmarkStd) beta = cov / Math.pow(benchmarkStd, 2);

    const meanFund = mean(fundAligned);
    const meanBenchmark = mean(benchmarkAligned);
    if (meanFund !== undefined && meanBenchmark !== undefined) {
      activeReturnPct = annualiseDaily(meanFund) - annualiseDaily(meanBenchmark);
      if (beta !== undefined) {
        const dailyRiskFree = Math.pow(1 + riskFreeRate / 100, 1 / 252) - 1;
        alphaPct = annualiseDaily(meanFund - (dailyRiskFree + beta * (meanBenchmark - dailyRiskFree)));
      }
    }

    const activeDaily = aligned.map((row) => row.fund - row.benchmark);
    const activeStd = stdev(activeDaily);
    trackingErrorPct = activeStd === undefined ? undefined : activeStd * Math.sqrt(252) * 100;
    informationRatio = trackingErrorPct && activeReturnPct !== undefined ? activeReturnPct / trackingErrorPct : undefined;

    const upDays = aligned.filter((row) => row.benchmark > 0);
    const downDays = aligned.filter((row) => row.benchmark < 0);
    const meanUpFund = mean(upDays.map((row) => row.fund));
    const meanUpBenchmark = mean(upDays.map((row) => row.benchmark));
    const meanDownFund = mean(downDays.map((row) => row.fund));
    const meanDownBenchmark = mean(downDays.map((row) => row.benchmark));
    if (meanUpFund !== undefined && meanUpBenchmark) upCapturePct = (meanUpFund / meanUpBenchmark) * 100;
    if (meanDownFund !== undefined && meanDownBenchmark) downCapturePct = (meanDownFund / meanDownBenchmark) * 100;
    if (upCapturePct !== undefined && downCapturePct) overallCapturePct = (upCapturePct / downCapturePct) * 100;

    const benchmarkDrawdownPct = maximumDrawdown(benchmark);
    maxDrawdownRelativePct = drawdownPct - benchmarkDrawdownPct;
    const benchmarkMonthlyMap = new Map(monthlyReturns(benchmark).map(point => [point.month, point.value]));
    const downMonthActiveReturns = monthly
      .filter(point => Number.isFinite(benchmarkMonthlyMap.get(point.month)) && benchmarkMonthlyMap.get(point.month) < 0)
      .map(point => point.value - benchmarkMonthlyMap.get(point.month));
    negativeMonthAlphaPct = downMonthActiveReturns.length ? mean(downMonthActiveReturns) * 100 : undefined;

    alphaPersistenceScore = alphaPersistence(aligned);

    const benchmarkStart = benchmark[0];
    const benchmarkEnd = benchmark[benchmark.length - 1];
    if (benchmarkStart?.nav > 0 && benchmarkEnd?.nav > 0) {
      passiveTerminalNav = start.nav * (benchmarkEnd.nav / benchmarkStart.nav);
      managerValueAddNav = end.nav - passiveTerminalNav;
    }
  } else {
    warnings.push("No live proxy data available; alpha and capture metrics are withheld.");
  }

  const scoreParts = [];
  if (sharpe !== undefined) scoreParts.push({ value: Math.max(0, Math.min(100, 45 + sharpe * 25)), weight: 0.18 });
  if (informationRatio !== undefined) scoreParts.push({ value: Math.max(0, Math.min(100, 50 + informationRatio * 30)), weight: 0.22 });
  if (downCapturePct !== undefined) scoreParts.push({ value: Math.max(0, Math.min(100, 120 - downCapturePct)), weight: 0.18 });
  if (upCapturePct !== undefined) scoreParts.push({ value: Math.max(0, Math.min(100, upCapturePct - 10)), weight: 0.12 });
  scoreParts.push({ value: Math.max(0, Math.min(100, 100 + drawdownPct * 2)), weight: 0.12 });
  if (positiveMonthHitRatePct !== undefined) scoreParts.push({ value: positiveMonthHitRatePct, weight: 0.08 });
  if (alphaPersistenceScore !== undefined) scoreParts.push({ value: alphaPersistenceScore, weight: 0.1 });
  const totalWeight = scoreParts.reduce((sum, part) => sum + part.weight, 0);
  const decisionQualityScore = totalWeight
    ? scoreParts.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight
    : undefined;

  return {
    observations: fund.length,
    alignedObservations,
    startDate: start.date,
    endDate: end.date,
    years,
    startNav: start.nav,
    endNav: end.nav,
    cagrPct,
    totalReturnPct,
    volatilityPct,
    sharpe,
    maxDrawdownPct: drawdownPct,
    conditionalDrawdownAtRiskPct: drawdown.conditionalDrawdownAtRiskPct,
    timeUnderWaterPct: drawdown.timeUnderWaterPct,
    recoveryDays: drawdown.recoveryDays,
    maxDrawdownRelativePct,
    negativeMonthAlphaPct,
    tailLossFrequencyPct,
    beta,
    alphaPct,
    activeReturnPct,
    trackingErrorPct,
    informationRatio,
    upCapturePct,
    downCapturePct,
    overallCapturePct,
    positiveMonthHitRatePct,
    alphaPersistenceScore,
    decisionQualityScore,
    passiveTerminalNav,
    managerValueAddNav,
    warnings
  };
}

function runAllocationWhatIf(startingNav, weightDeltaPct, relativeReturnSpreadPct, implementationCostPerUnit = 0) {
  const navEffect = startingNav * (weightDeltaPct / 100) * (relativeReturnSpreadPct / 100) - implementationCostPerUnit;
  return {
    navEffect,
    endingNav: startingNav + navEffect,
    effectPct: startingNav ? (navEffect / startingNav) * 100 : 0
  };
}

function runFeeWhatIf(endNav, years, feeDeltaPct) {
  if (!Number.isFinite(endNav) || !Number.isFinite(years)) return undefined;
  const adjusted = endNav * Math.pow(1 - feeDeltaPct / 100, years);
  return adjusted - endNav;
}

function simulateCaptureImprovement(fund, benchmark, direction, improvementPct) {
  const aligned = alignReturns(fund, benchmark);
  if (!aligned.length || !fund[0]) return undefined;
  let nav = fund[0].nav;
  for (const row of aligned) {
    let adjusted = row.fund;
    if (direction === "downside" && row.benchmark < 0) adjusted += Math.abs(row.benchmark) * (improvementPct / 100);
    if (direction === "upside" && row.benchmark > 0) adjusted += row.benchmark * (improvementPct / 100);
    nav *= 1 + adjusted;
  }
  return nav - fund[fund.length - 1].nav;
}

export {
  parseDate,
  normaliseSeries,
  dailyReturns,
  alignReturns,
  buildSyntheticProxy,
  calculateDataConfidence,
  computeMetrics,
  runAllocationWhatIf,
  runFeeWhatIf,
  simulateCaptureImprovement
};
