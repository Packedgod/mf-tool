export type SeriesPoint = { date: string; nav: number };

export type ManagerMetrics = {
  observations: number;
  startDate?: string;
  endDate?: string;
  years?: number;
  startNav?: number;
  endNav?: number;
  cagrPct?: number;
  totalReturnPct?: number;
  volatilityPct?: number;
  sharpe?: number;
  maxDrawdownPct?: number;
  beta?: number;
  alphaPct?: number;
  activeReturnPct?: number;
  trackingErrorPct?: number;
  informationRatio?: number;
  upCapturePct?: number;
  downCapturePct?: number;
  overallCapturePct?: number;
  positiveMonthHitRatePct?: number;
  alphaPersistenceScore?: number;
  decisionQualityScore?: number;
  passiveTerminalNav?: number;
  managerValueAddNav?: number;
  warnings: string[];
};

export function parseDate(value: string) {
  const parts = value.trim().split("-");
  if (parts.length === 3 && parts[0].length === 2) {
    const [dd, mm, yyyy] = parts.map(Number);
    return new Date(Date.UTC(yyyy, mm - 1, dd));
  }
  return new Date(value);
}

export function normaliseSeries(data: any[]): SeriesPoint[] {
  return (data || [])
    .map((point) => {
      const date = parseDate(String(point.date));
      const nav = Number(point.nav);
      if (!Number.isFinite(date.getTime()) || !Number.isFinite(nav)) return null;
      return { date: date.toISOString().slice(0, 10), nav };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.date.localeCompare(b.date)) as SeriesPoint[];
}

export function dailyReturns(series: SeriesPoint[]) {
  const out: Array<{ date: string; value: number }> = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1].nav > 0 && series[i].nav > 0) {
      out.push({ date: series[i].date, value: series[i].nav / series[i - 1].nav - 1 });
    }
  }
  return out;
}

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : undefined);

function stdev(x: number[]) {
  if (x.length < 2) return undefined;
  const m = mean(x);
  if (m === undefined) return undefined;
  return Math.sqrt(x.reduce((s, v) => s + Math.pow(v - m, 2), 0) / (x.length - 1));
}

function covariance(x: number[], y: number[]) {
  if (x.length < 2 || x.length !== y.length) return undefined;
  const mx = mean(x);
  const my = mean(y);
  if (mx === undefined || my === undefined) return undefined;
  return x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / (x.length - 1);
}

const annualise = (daily: number) => (Math.pow(1 + daily, 252) - 1) * 100;

function maxDrawdown(series: SeriesPoint[]) {
  let peak = -Infinity;
  let worst = 0;
  for (const point of series) {
    peak = Math.max(peak, point.nav);
    if (peak > 0) worst = Math.min(worst, point.nav / peak - 1);
  }
  return worst * 100;
}

function monthlyReturns(series: SeriesPoint[]) {
  const months = new Map<string, { first: SeriesPoint; last: SeriesPoint }>();
  for (const point of series) {
    const key = point.date.slice(0, 7);
    const existing = months.get(key);
    if (!existing) months.set(key, { first: point, last: point });
    else {
      if (point.date < existing.first.date) existing.first = point;
      if (point.date > existing.last.date) existing.last = point;
    }
  }
  return Array.from(months.values()).map((v) => v.last.nav / v.first.nav - 1);
}

export function alignReturns(fund: SeriesPoint[], benchmark: SeriesPoint[]) {
  const benchMap = new Map(dailyReturns(benchmark).map((x) => [x.date, x.value]));
  return dailyReturns(fund)
    .map((x) => (benchMap.has(x.date) ? { date: x.date, fund: x.value, benchmark: benchMap.get(x.date)! } : null))
    .filter(Boolean) as Array<{ date: string; fund: number; benchmark: number }>;
}

function alphaPersistence(aligned: Array<{ fund: number; benchmark: number }>) {
  if (aligned.length < 60) return undefined;
  const mid = Math.floor(aligned.length / 2);
  const first = aligned.slice(0, mid).map((x) => x.fund - x.benchmark);
  const second = aligned.slice(mid).map((x) => x.fund - x.benchmark);
  const firstMean = mean(first);
  const secondMean = mean(second);
  if (firstMean === undefined || secondMean === undefined) return undefined;
  if (firstMean > 0 && secondMean > 0) return 85;
  if (firstMean > 0 || secondMean > 0) return 55;
  return 25;
}

export function computeMetrics(fund: SeriesPoint[], benchmark: SeriesPoint[], riskFree: number): ManagerMetrics {
  const warnings: string[] = [];
  if (fund.length < 3) return { observations: fund.length, warnings: ["Not enough NAV observations to calculate manager quality."] };

  const start = fund[0];
  const end = fund[fund.length - 1];
  const years = Math.max((parseDate(end.date).getTime() - parseDate(start.date).getTime()) / (365.25 * 24 * 60 * 60 * 1000), 1 / 365.25);
  const totalReturnPct = (end.nav / start.nav - 1) * 100;
  const cagrPct = (Math.pow(end.nav / start.nav, 1 / years) - 1) * 100;
  const ret = dailyReturns(fund).map((x) => x.value);
  const avgDaily = mean(ret);
  const vol = stdev(ret);
  const volatilityPct = vol === undefined ? undefined : vol * Math.sqrt(252) * 100;
  const annualReturnPct = avgDaily === undefined ? undefined : annualise(avgDaily);
  const sharpe = volatilityPct && annualReturnPct !== undefined ? (annualReturnPct - riskFree) / volatilityPct : undefined;
  const months = monthlyReturns(fund);
  const positiveMonthHitRatePct = months.length ? (months.filter((x) => x > 0).length / months.length) * 100 : undefined;

  let beta: number | undefined;
  let alphaPct: number | undefined;
  let activeReturnPct: number | undefined;
  let trackingErrorPct: number | undefined;
  let informationRatio: number | undefined;
  let upCapturePct: number | undefined;
  let downCapturePct: number | undefined;
  let overallCapturePct: number | undefined;
  let alphaPersistenceScore: number | undefined;
  let passiveTerminalNav: number | undefined;
  let managerValueAddNav: number | undefined;

  if (benchmark.length) {
    const aligned = alignReturns(fund, benchmark);
    if (aligned.length < 30) warnings.push("Benchmark overlap is low; benchmark-relative metrics may be unstable.");
    const fr = aligned.map((x) => x.fund);
    const br = aligned.map((x) => x.benchmark);
    const brStd = stdev(br);
    const cov = covariance(fr, br);
    if (cov !== undefined && brStd && brStd !== 0) beta = cov / Math.pow(brStd, 2);
    const mf = mean(fr);
    const mb = mean(br);
    if (mf !== undefined && mb !== undefined) activeReturnPct = annualise(mf) - annualise(mb);
    if (beta !== undefined && mf !== undefined && mb !== undefined) {
      const dailyRf = Math.pow(1 + riskFree / 100, 1 / 252) - 1;
      alphaPct = annualise(mf - (dailyRf + beta * (mb - dailyRf)));
    }
    const active = aligned.map((x) => x.fund - x.benchmark);
    const activeStd = stdev(active);
    trackingErrorPct = activeStd === undefined ? undefined : activeStd * Math.sqrt(252) * 100;
    informationRatio = trackingErrorPct && activeReturnPct !== undefined ? activeReturnPct / trackingErrorPct : undefined;
    const up = aligned.filter((x) => x.benchmark > 0);
    const down = aligned.filter((x) => x.benchmark < 0);
    const upFund = mean(up.map((x) => x.fund));
    const upBench = mean(up.map((x) => x.benchmark));
    const downFund = mean(down.map((x) => x.fund));
    const downBench = mean(down.map((x) => x.benchmark));
    if (upFund !== undefined && upBench) upCapturePct = (upFund / upBench) * 100;
    if (downFund !== undefined && downBench) downCapturePct = (downFund / downBench) * 100;
    if (upCapturePct !== undefined && downCapturePct) overallCapturePct = (upCapturePct / downCapturePct) * 100;
    alphaPersistenceScore = alphaPersistence(aligned);
    const benchStart = benchmark[0];
    const benchEnd = benchmark[benchmark.length - 1];
    if (benchStart?.nav > 0 && benchEnd?.nav > 0) {
      passiveTerminalNav = start.nav * (benchEnd.nav / benchStart.nav);
      managerValueAddNav = end.nav - passiveTerminalNav;
    }
  } else {
    warnings.push("No benchmark/peer selected; alpha, beta, information ratio and capture ratios cannot be calculated.");
  }

  const parts = [
    sharpe !== undefined ? Math.max(0, Math.min(100, 45 + sharpe * 25)) : undefined,
    informationRatio !== undefined ? Math.max(0, Math.min(100, 50 + informationRatio * 30)) : undefined,
    downCapturePct !== undefined ? Math.max(0, Math.min(100, 110 - downCapturePct)) : undefined,
    upCapturePct !== undefined ? Math.max(0, Math.min(100, upCapturePct - 15)) : undefined,
    Math.max(0, Math.min(100, 100 + maxDrawdown(fund) * 2)),
    positiveMonthHitRatePct,
    alphaPersistenceScore
  ].filter((x): x is number => typeof x === "number" && Number.isFinite(x));

  return {
    observations: fund.length,
    startDate: start.date,
    endDate: end.date,
    years,
    startNav: start.nav,
    endNav: end.nav,
    cagrPct,
    totalReturnPct,
    volatilityPct,
    sharpe,
    maxDrawdownPct: maxDrawdown(fund),
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
    decisionQualityScore: parts.length ? mean(parts) : undefined,
    passiveTerminalNav,
    managerValueAddNav,
    warnings
  };
}

export function runAllocationWhatIf(startingNav: number, weightDeltaPct: number, relativeReturnSpreadPct: number, implementationCostPerUnit: number) {
  const navEffect = startingNav * (weightDeltaPct / 100) * (relativeReturnSpreadPct / 100) - implementationCostPerUnit;
  return { navEffect, endingNav: startingNav + navEffect, effectPct: startingNav === 0 ? 0 : (navEffect / startingNav) * 100 };
}

export function runFeeDragWhatIf(endNav: number | undefined, years: number | undefined, feeDeltaPct: number) {
  if (!endNav || !years) return undefined;
  return endNav * Math.pow(1 - feeDeltaPct / 100, years) - endNav;
}
