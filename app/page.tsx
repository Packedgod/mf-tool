"use client";

import { useMemo, useState } from "react";

type SeriesPoint = { date: string; nav: number };
type FundSeries = { meta: any; data: SeriesPoint[] };

const isoYearsAgo = (years: number) => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
};
const todayIso = () => new Date().toISOString().slice(0, 10);
const fmt = (v?: number, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const pct = (v?: number, d = 2) => (typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(d)}%` : "—");

function parseDate(value: string) {
  const parts = value.trim().split("-");
  if (parts.length === 3 && parts[0].length === 2) {
    const [dd, mm, yyyy] = parts.map(Number);
    return new Date(Date.UTC(yyyy, mm - 1, dd));
  }
  return new Date(value);
}

function normalise(data: any[]): SeriesPoint[] {
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

function dailyReturns(series: SeriesPoint[]) {
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
  const mx = mean(x), my = mean(y);
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
function align(fund: SeriesPoint[], benchmark: SeriesPoint[]) {
  const benchMap = new Map(dailyReturns(benchmark).map((x) => [x.date, x.value]));
  return dailyReturns(fund)
    .map((x) => (benchMap.has(x.date) ? { date: x.date, fund: x.value, benchmark: benchMap.get(x.date)! } : null))
    .filter(Boolean) as Array<{ date: string; fund: number; benchmark: number }>;
}

function computeMetrics(fund: SeriesPoint[], benchmark: SeriesPoint[], riskFree: number) {
  const warnings: string[] = [];
  if (fund.length < 3) return { warnings, observations: fund.length } as any;
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
  let beta: number | undefined, alphaPct: number | undefined, activeReturnPct: number | undefined, trackingErrorPct: number | undefined, informationRatio: number | undefined, upCapturePct: number | undefined, downCapturePct: number | undefined, overallCapturePct: number | undefined;
  if (benchmark.length) {
    const aligned = align(fund, benchmark);
    if (aligned.length < 30) warnings.push("Benchmark overlap is low; benchmark-relative metrics may be unstable.");
    const fr = aligned.map((x) => x.fund);
    const br = aligned.map((x) => x.benchmark);
    const brStd = stdev(br);
    const cov = covariance(fr, br);
    if (cov !== undefined && brStd && brStd !== 0) beta = cov / Math.pow(brStd, 2);
    const mf = mean(fr), mb = mean(br);
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
    const upFund = mean(up.map((x) => x.fund)), upBench = mean(up.map((x) => x.benchmark));
    const downFund = mean(down.map((x) => x.fund)), downBench = mean(down.map((x) => x.benchmark));
    if (upFund !== undefined && upBench) upCapturePct = (upFund / upBench) * 100;
    if (downFund !== undefined && downBench) downCapturePct = (downFund / downBench) * 100;
    if (upCapturePct !== undefined && downCapturePct) overallCapturePct = (upCapturePct / downCapturePct) * 100;
  } else warnings.push("No benchmark/peer selected; alpha, beta, information ratio and capture ratios cannot be calculated.");
  const parts = [sharpe !== undefined ? Math.max(0, Math.min(100, 45 + sharpe * 25)) : undefined, informationRatio !== undefined ? Math.max(0, Math.min(100, 50 + informationRatio * 30)) : undefined, downCapturePct !== undefined ? Math.max(0, Math.min(100, 110 - downCapturePct)) : undefined, upCapturePct !== undefined ? Math.max(0, Math.min(100, upCapturePct - 15)) : undefined, Math.max(0, Math.min(100, 100 + maxDrawdown(fund) * 2)), positiveMonthHitRatePct].filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const decisionQualityScore = parts.length ? mean(parts) : undefined;
  return { observations: fund.length, startDate: start.date, endDate: end.date, cagrPct, totalReturnPct, volatilityPct, sharpe, maxDrawdownPct: maxDrawdown(fund), beta, alphaPct, activeReturnPct, trackingErrorPct, informationRatio, upCapturePct, downCapturePct, overallCapturePct, positiveMonthHitRatePct, decisionQualityScore, warnings };
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong>{hint ? <div className="footnote">{hint}</div> : null}</div>;
}
function scoreClass(value?: number) {
  if (value === undefined) return "warn";
  if (value >= 72) return "good";
  if (value >= 52) return "warn";
  return "bad";
}

export default function Home() {
  const [fundQuery, setFundQuery] = useState("Parag Parikh Flexi Cap Direct Growth");
  const [benchQuery, setBenchQuery] = useState("Nifty 500 Index Fund Direct Growth");
  const [fundResults, setFundResults] = useState<any[]>([]);
  const [benchResults, setBenchResults] = useState<any[]>([]);
  const [fund, setFund] = useState<FundSeries | null>(null);
  const [benchmark, setBenchmark] = useState<FundSeries | null>(null);
  const [startDate, setStartDate] = useState(isoYearsAgo(5));
  const [endDate, setEndDate] = useState(todayIso());
  const [riskFree, setRiskFree] = useState(6.5);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [fmpSymbol, setFmpSymbol] = useState("SPY");
  const [fmpResource, setFmpResource] = useState("info");
  const [fmpData, setFmpData] = useState<any>(null);
  const [scenario, setScenario] = useState({ startingNav: 100, weightDeltaPct: 10, relativeReturnSpreadPct: 5, implementationCostPerUnit: 0 });

  const filteredFund = useMemo(() => (fund?.data || []).filter((x) => x.date >= startDate && x.date <= endDate), [fund, startDate, endDate]);
  const filteredBenchmark = useMemo(() => (benchmark?.data || []).filter((x) => x.date >= startDate && x.date <= endDate), [benchmark, startDate, endDate]);
  const metrics = useMemo(() => computeMetrics(filteredFund, filteredBenchmark, riskFree), [filteredFund, filteredBenchmark, riskFree]);
  const navEffect = scenario.startingNav * (scenario.weightDeltaPct / 100) * (scenario.relativeReturnSpreadPct / 100) - scenario.implementationCostPerUnit;

  async function search(kind: "fund" | "benchmark") {
    setError("");
    setLoading(kind === "fund" ? "Searching fund..." : "Searching benchmark/peer...");
    try {
      const q = kind === "fund" ? fundQuery : benchQuery;
      const res = await fetch(`/api/mfapi/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      if (kind === "fund") setFundResults(data.results || []); else setBenchResults(data.results || []);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(""); }
  }
  async function loadHistory(code: number, kind: "fund" | "benchmark") {
    setError("");
    setLoading(kind === "fund" ? "Loading fund history..." : "Loading benchmark history...");
    try {
      const params = new URLSearchParams({ code: String(code), startDate, endDate });
      const res = await fetch(`/api/mfapi/history?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "History fetch failed");
      const series = { meta: data.meta || {}, data: normalise(data.data || []) };
      if (kind === "fund") setFund(series); else setBenchmark(series);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(""); }
  }
  async function loadFmp() {
    setError(""); setLoading("Loading FMP...");
    try {
      const params = new URLSearchParams({ resource: fmpResource, symbol: fmpSymbol });
      const res = await fetch(`/api/fmp?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "FMP request failed");
      setFmpData(data);
    } catch (err) { setFmpData(null); setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(""); }
  }

  return <main className="shell">
    <section className="hero"><div className="card hero-main"><div className="eyebrow">Live mutual fund analytics</div><h1>Live NAV history, benchmark behaviour & manager decision quality.</h1><p>This tool uses MFapi.in and AMFI for Indian mutual funds, with optional FMP support for global funds and ETFs. It evaluates manager decision-making through realised NAV behaviour versus a chosen benchmark or peer proxy.</p></div><div className="card kpis"><div className="kpi"><span>Indian source</span><strong>MFapi.in</strong></div><div className="kpi"><span>Official cross-check</span><strong>AMFI NAV</strong></div><div className="kpi"><span>Global optional</span><strong>FMP</strong></div></div></section>
    {loading ? <div className="warning">{loading}</div> : null}{error ? <div className="warning">{error}</div> : null}
    <section className="grid two"><div className="card panel"><div className="section-head"><div><h2>1. Select Indian fund</h2><p className="muted">Search MFapi and load historical NAV.</p></div><span className="badge">live</span></div><div className="grid three"><div className="field"><label>Start date</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div><div className="field"><label>End date</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div><div className="field"><label>Risk-free rate %</label><input type="number" value={riskFree} onChange={(e) => setRiskFree(Number(e.target.value))} /></div></div><div className="field" style={{ marginTop: 14 }}><label>Fund search</label><input value={fundQuery} onChange={(e) => setFundQuery(e.target.value)} /></div><div className="inline-actions" style={{ marginTop: 12 }}><button onClick={() => search("fund")}>Search fund</button><button className="secondary" onClick={() => setFundResults([])}>Clear</button></div><div className="search-results">{fundResults.map((x) => <button className="result-row" key={x.schemeCode} onClick={() => loadHistory(x.schemeCode, "fund")}><strong>{x.schemeName}</strong><span>Scheme code {x.schemeCode}</span></button>)}</div></div>
    <div className="card panel"><div className="section-head"><div><h2>2. Select benchmark / peer proxy</h2><p className="muted">MFapi does not expose index levels, so choose an index fund, category fund or peer.</p></div><span className="badge">comparison</span></div><div className="field"><label>Benchmark or peer search</label><input value={benchQuery} onChange={(e) => setBenchQuery(e.target.value)} /></div><div className="inline-actions" style={{ marginTop: 12 }}><button onClick={() => search("benchmark")}>Search proxy</button><button className="secondary" onClick={() => setBenchmark(null)}>Remove benchmark</button></div><div className="search-results">{benchResults.map((x) => <button className="result-row" key={x.schemeCode} onClick={() => loadHistory(x.schemeCode, "benchmark")}><strong>{x.schemeName}</strong><span>Scheme code {x.schemeCode}</span></button>)}</div></div></section>
    <section className="card panel" style={{ marginTop: 18 }}><div className="section-head"><div><h2>Live performance dashboard</h2><p className="muted">Fund: {fund?.meta?.scheme_name || "not loaded"} · Benchmark/peer: {benchmark?.meta?.scheme_name || "not selected"}</p></div><span className={`badge ${scoreClass(metrics.decisionQualityScore)}`}>{metrics.decisionQualityScore !== undefined ? `${metrics.decisionQualityScore.toFixed(0)}/100` : "score pending"}</span></div><div className="metrics"><Metric label="CAGR" value={pct(metrics.cagrPct)} hint={`${metrics.startDate || "—"} to ${metrics.endDate || "—"}`} /><Metric label="Total return" value={pct(metrics.totalReturnPct)} /><Metric label="Volatility" value={pct(metrics.volatilityPct)} /><Metric label="Sharpe" value={fmt(metrics.sharpe)} /><Metric label="Max drawdown" value={pct(metrics.maxDrawdownPct)} /><Metric label="Positive month hit rate" value={pct(metrics.positiveMonthHitRatePct)} /><Metric label="Beta" value={fmt(metrics.beta)} /><Metric label="Annual alpha" value={pct(metrics.alphaPct)} /><Metric label="Information ratio" value={fmt(metrics.informationRatio)} /><Metric label="Tracking error" value={pct(metrics.trackingErrorPct)} /><Metric label="Upside capture" value={pct(metrics.upCapturePct)} /><Metric label="Downside capture" value={pct(metrics.downCapturePct)} /></div><div style={{ marginTop: 16 }}><div className="section-head" style={{ marginBottom: 6 }}><span className="footnote">Live decision-quality proxy score</span><span className={`badge ${scoreClass(metrics.decisionQualityScore)}`}>{metrics.decisionQualityScore !== undefined ? `${metrics.decisionQualityScore.toFixed(0)}/100` : "needs benchmark"}</span></div><div className="bar" style={{ "--w": `${Math.max(0, Math.min(100, metrics.decisionQualityScore || 0))}%` } as React.CSSProperties}><span /></div></div>{metrics.warnings?.map((w: string) => <div className="warning" key={w}>{w}</div>)}<p className="footnote" style={{ marginTop: 14 }}>This score is a live outcome-quality proxy. It evaluates realised fund behaviour: return efficiency, downside control, active-risk productivity, benchmark capture and consistency.</p></section>
    <section className="grid two" style={{ marginTop: 18 }}><div className="card panel"><div className="section-head"><div><h2>FMP global fund data</h2><p className="muted">Optional. Add FMP_API_KEY in Vercel Environment Variables to use this panel.</p></div></div><div className="grid three"><div className="field"><label>Symbol</label><input value={fmpSymbol} onChange={(e) => setFmpSymbol(e.target.value.toUpperCase())} /></div><div className="field"><label>Resource</label><select value={fmpResource} onChange={(e) => setFmpResource(e.target.value)}><option value="info">Fund info</option><option value="holdings">Holdings</option><option value="sector">Sector allocation</option><option value="country">Country allocation</option><option value="asset-exposure">Asset exposure</option><option value="disclosure-latest">Latest disclosure holders</option><option value="quotes">Mutual fund quotes batch</option></select></div><div className="field"><label>Action</label><button onClick={loadFmp}>Load FMP</button></div></div><div className="data-panel"><div className="data-row"><pre>{fmpData ? JSON.stringify(fmpData, null, 2).slice(0, 9000) : "FMP output will appear here."}</pre></div></div></div><div className="card panel"><div className="section-head"><div><h2>Decision-impact simulator</h2><p className="muted">Estimate how exposure changes could affect NAV.</p></div></div><div className="scenario-grid"><div className="field"><label>Starting NAV</label><input type="number" value={scenario.startingNav} onChange={(e) => setScenario({ ...scenario, startingNav: Number(e.target.value) })} /></div><div className="field"><label>Weight change %</label><input type="number" value={scenario.weightDeltaPct} onChange={(e) => setScenario({ ...scenario, weightDeltaPct: Number(e.target.value) })} /></div><div className="field"><label>Relative spread %</label><input type="number" value={scenario.relativeReturnSpreadPct} onChange={(e) => setScenario({ ...scenario, relativeReturnSpreadPct: Number(e.target.value) })} /></div><div className="field"><label>Cost per unit ₹</label><input type="number" value={scenario.implementationCostPerUnit} onChange={(e) => setScenario({ ...scenario, implementationCostPerUnit: Number(e.target.value) })} /></div></div><div className="big-result"><span className="footnote">Approximate NAV effect</span><strong>{navEffect >= 0 ? "+" : ""}₹{navEffect.toFixed(2)}</strong><p className="footnote">Ending NAV: ₹{(scenario.startingNav + navEffect).toFixed(2)} · Effect: {scenario.startingNav ? ((navEffect / scenario.startingNav) * 100).toFixed(2) : "0.00"}%</p></div></div></section>
  </main>;
}
