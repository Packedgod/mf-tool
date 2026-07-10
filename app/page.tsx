"use client";

import { CSSProperties, useEffect, useMemo, useState } from "react";
import { managerUniverse, sourceCoverage, whatIfTemplates } from "@/lib/manager-universe";
import {
  alignReturns,
  computeMetrics,
  normaliseSeries,
  runAllocationWhatIf,
  runFeeDragWhatIf,
  type SeriesPoint
} from "@/lib/manager-analytics";

type FundSeries = { meta: any; data: SeriesPoint[]; source: string; schemeCode?: number };
type LoadState = "idle" | "loading" | "ready" | "error";
type ProxyStandard = "declared" | "category" | "broad" | "defensive" | "custom";

const todayIso = () => new Date().toISOString().slice(0, 10);
const yearsAgo = (years: number) => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
};
const fmt = (v?: number, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const pct = (v?: number, d = 2) => (typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(d)}%` : "—");
const money = (v?: number, d = 2) => (typeof v === "number" && Number.isFinite(v) ? `₹${v.toFixed(d)}` : "—");

function scoreClass(value?: number) {
  if (value === undefined) return "warn";
  if (value >= 72) return "good";
  if (value >= 52) return "warn";
  return "bad";
}

function effectiveStart(userStart: string, managerStart?: string) {
  if (!managerStart) return userStart;
  return managerStart > userStart ? managerStart : userStart;
}

function proxyPresets(category: string, declaredBenchmark: string) {
  const smallCapProxy = "Nifty Smallcap 250 Index Fund Direct Growth";
  const broadProxy = "Nifty 500 Index Fund Direct Growth";
  const nifty50Proxy = "Nifty 50 Index Fund Direct Growth";
  const liquidProxy = "Liquid Fund Direct Growth";
  const categoryProxy = category.toLowerCase().includes("small")
    ? smallCapProxy
    : category.toLowerCase().includes("balanced")
      ? nifty50Proxy
      : broadProxy;

  return {
    declared: {
      label: "Declared / closest scheme benchmark",
      query: declaredBenchmark,
      purpose: "Best default for alpha, information ratio and active-risk checks.",
      source: "MFapi live NAV proxy + AMFI validation"
    },
    category: {
      label: "Category-standard proxy",
      query: categoryProxy,
      purpose: "Compares the manager against a same-category passive/peer yardstick.",
      source: "MFapi live NAV proxy"
    },
    broad: {
      label: "Broad-market proxy",
      query: broadProxy,
      purpose: "Checks if the manager beat a simple diversified market exposure.",
      source: "MFapi live NAV proxy"
    },
    defensive: {
      label: "Defensive / cash-drag proxy",
      query: liquidProxy,
      purpose: "Useful for testing cash calls, hedging and drawdown protection decisions.",
      source: "MFapi live NAV proxy"
    }
  };
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <div className="footnote">{hint}</div> : null}
    </div>
  );
}

function Insight({ title, value, body, tone = "neutral" }: { title: string; value: string; body: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return (
    <div className={`insight ${tone}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{body}</p>
    </div>
  );
}

function simulateCaptureImprovement(fund: SeriesPoint[], benchmark: SeriesPoint[], direction: "upside" | "downside", improvementPct: number) {
  const aligned = alignReturns(fund, benchmark);
  if (!aligned.length || !fund[0]) return undefined;
  let nav = fund[0].nav;
  for (const item of aligned) {
    let adjusted = item.fund;
    if (direction === "downside" && item.benchmark < 0) adjusted = item.fund + Math.abs(item.benchmark) * (improvementPct / 100);
    if (direction === "upside" && item.benchmark > 0) adjusted = item.fund + item.benchmark * (improvementPct / 100);
    nav = nav * (1 + adjusted);
  }
  return nav - fund[fund.length - 1]?.nav;
}

export default function Home() {
  const [selectedManagerId, setSelectedManagerId] = useState(managerUniverse[0].id);
  const [selectedSchemeIndex, setSelectedSchemeIndex] = useState(0);
  const [managerSearch, setManagerSearch] = useState("");
  const [startDate, setStartDate] = useState(yearsAgo(10));
  const [endDate, setEndDate] = useState(todayIso());
  const [riskFree, setRiskFree] = useState(6.5);
  const [liveRefresh, setLiveRefresh] = useState(true);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [status, setStatus] = useState("Select a manager, choose a proxy standard, then load live analysis.");
  const [fund, setFund] = useState<FundSeries | null>(null);
  const [benchmark, setBenchmark] = useState<FundSeries | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [proxyStandard, setProxyStandard] = useState<ProxyStandard>("declared");
  const [customBenchmarkQuery, setCustomBenchmarkQuery] = useState("");
  const [allocation, setAllocation] = useState({ startingNav: 100, weightDeltaPct: 10, spreadPct: 5, cost: 0 });
  const [feeDelta, setFeeDelta] = useState(0.4);
  const [captureImprove, setCaptureImprove] = useState(10);
  const [yahooSymbol, setYahooSymbol] = useState("VTSAX");
  const [yahooOutput, setYahooOutput] = useState<any>(null);

  const selectedManager = managerUniverse.find((manager) => manager.id === selectedManagerId) || managerUniverse[0];
  const selectedScheme = selectedManager.schemes[selectedSchemeIndex] || selectedManager.schemes[0];
  const proxyOptions = proxyPresets(selectedScheme.category, selectedScheme.benchmarkQuery);
  const selectedProxyQuery = proxyStandard === "custom"
    ? customBenchmarkQuery || selectedScheme.benchmarkQuery
    : proxyOptions[proxyStandard].query;
  const selectedProxyMeta = proxyStandard === "custom"
    ? { label: "Custom verified proxy", purpose: "Use a user-specified proxy only if it exists in MFapi/AMFI/Yahoo/FMP coverage.", source: "User-selected valid-source query" }
    : proxyOptions[proxyStandard];
  const analysisStart = effectiveStart(startDate, selectedManager.managerStartDate);

  const visibleManagers = managerUniverse.filter((manager) => {
    const text = [manager.name, manager.amc, manager.style, manager.schemes.map((s) => s.schemeName).join(" ")].join(" ").toLowerCase();
    return !managerSearch || text.includes(managerSearch.toLowerCase());
  });

  const filteredFund = useMemo(() => (fund?.data || []).filter((point) => point.date >= analysisStart && point.date <= endDate), [fund, analysisStart, endDate]);
  const filteredBenchmark = useMemo(() => (benchmark?.data || []).filter((point) => point.date >= analysisStart && point.date <= endDate), [benchmark, analysisStart, endDate]);
  const metrics = useMemo(() => computeMetrics(filteredFund, filteredBenchmark, riskFree), [filteredFund, filteredBenchmark, riskFree]);
  const allocationResult = runAllocationWhatIf(allocation.startingNav, allocation.weightDeltaPct, allocation.spreadPct, allocation.cost);
  const feeDragResult = runFeeDragWhatIf(metrics.endNav, metrics.years, feeDelta);
  const downsideImprovement = simulateCaptureImprovement(filteredFund, filteredBenchmark, "downside", captureImprove);
  const upsideImprovement = simulateCaptureImprovement(filteredFund, filteredBenchmark, "upside", captureImprove);

  async function searchScheme(query: string) {
    const res = await fetch(`/api/mfapi/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "MFapi search failed");
    const result = data.results?.[0];
    if (!result) throw new Error(`No live MFapi/AMFI proxy found for ${query}. Try another standard or custom proxy.`);
    return result as { schemeCode: number; schemeName: string };
  }

  async function loadHistory(code: number) {
    const params = new URLSearchParams({ code: String(code), startDate: analysisStart, endDate });
    const res = await fetch(`/api/mfapi/history?${params.toString()}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "History fetch failed");
    return { meta: data.meta || {}, data: normaliseSeries(data.data || []), source: data.source || "MFapi.in", schemeCode: code };
  }

  async function loadManagerAnalysis() {
    setLoadState("loading");
    setStatus(`Pulling live data for ${selectedManager.name} using ${selectedProxyMeta.label}...`);
    try {
      const schemeResult = await searchScheme(selectedScheme.schemeQuery);
      const benchmarkResult = await searchScheme(selectedProxyQuery);
      const [fundSeries, benchmarkSeries] = await Promise.all([loadHistory(schemeResult.schemeCode), loadHistory(benchmarkResult.schemeCode)]);
      setFund(fundSeries);
      setBenchmark(benchmarkSeries);
      setLastUpdated(new Date().toLocaleString());
      setLoadState("ready");
      setStatus(`Live analysis loaded. Proxy standard: ${selectedProxyMeta.label}.`);
    } catch (error) {
      setLoadState("error");
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadYahoo(resource: "search" | "chart" | "summary") {
    setYahooOutput({ loading: true });
    try {
      const url = resource === "search"
        ? `/api/yahoo/search?q=${encodeURIComponent(yahooSymbol)}`
        : resource === "chart"
          ? `/api/yahoo/chart?symbol=${encodeURIComponent(yahooSymbol)}&range=5y&interval=1d`
          : `/api/yahoo/summary?symbol=${encodeURIComponent(yahooSymbol)}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Yahoo request failed");
      setYahooOutput(data);
    } catch (error) {
      setYahooOutput({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => {
    if (!liveRefresh || loadState !== "ready") return;
    const timer = window.setInterval(() => {
      void loadManagerAnalysis();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRefresh, loadState, selectedManagerId, selectedSchemeIndex, analysisStart, endDate, proxyStandard, customBenchmarkQuery]);

  const passiveLabel = metrics.managerValueAddNav === undefined ? "Needs benchmark" : metrics.managerValueAddNav >= 0 ? "Manager added value" : "Manager lagged proxy";
  const googleFinanceLink = `https://www.google.com/finance/search?q=${encodeURIComponent(selectedScheme.schemeName)}`;

  return (
    <main className="shell app-frame">
      <section className="hero manager-hero">
        <div className="card hero-main">
          <div className="eyebrow">Fund manager decision intelligence</div>
          <h1>Choose a manager. Choose a standard. Compare cleanly.</h1>
          <p>
            The dashboard now uses toggleable proxy standards so every manager can be judged against the same type of benchmark:
            declared benchmark, category proxy, broad-market proxy, defensive/cash proxy or a custom verified proxy.
          </p>
          <div className="inline-actions" style={{ marginTop: 18 }}>
            <button onClick={loadManagerAnalysis} disabled={loadState === "loading"}>{loadState === "loading" ? "Pulling live data..." : "Load live manager analysis"}</button>
            <button className="secondary" onClick={() => setLiveRefresh((value) => !value)}>{liveRefresh ? "Live refresh on" : "Live refresh off"}</button>
          </div>
        </div>
        <div className="card kpis compact-kpis">
          <div className="kpi"><span>Manager</span><strong>{selectedManager.name}</strong></div>
          <div className="kpi"><span>Proxy standard</span><strong>{selectedProxyMeta.label}</strong></div>
          <div className="kpi"><span>Score</span><strong>{metrics.decisionQualityScore !== undefined ? `${metrics.decisionQualityScore.toFixed(0)}/100` : "Pending"}</strong></div>
        </div>
      </section>

      <section className="card panel status-card">
        <div className="section-head"><div><h2>Live source lock</h2><p className="muted">{status}</p></div><span className={`badge ${loadState === "ready" ? "good" : loadState === "error" ? "bad" : "warn"}`}>{lastUpdated ? `updated ${lastUpdated}` : loadState}</span></div>
        <div className="source-strip">
          {sourceCoverage.map((source) => <div className="source-chip" key={source.source}><strong>{source.source}</strong><span>{source.live === true ? "live source" : source.live === false ? "verification link" : "connector required"}</span></div>)}
        </div>
      </section>

      <section className="grid two dashboard-grid" style={{ marginTop: 18 }}>
        <div className="card panel manager-panel">
          <div className="section-head"><div><h2>1. Manager</h2><p className="muted">Start with the decision-maker, then load live fund and proxy data.</p></div><span className="badge">{visibleManagers.length} available</span></div>
          <div className="field"><label>Search manager, AMC or strategy</label><input value={managerSearch} onChange={(e) => setManagerSearch(e.target.value)} placeholder="Rajeev, SBI, downside, flexi cap..." /></div>
          <div className="manager-grid tidy-manager-grid">
            {visibleManagers.map((manager) => (
              <button key={manager.id} className={`manager-card ${manager.id === selectedManagerId ? "active" : ""}`} onClick={() => { setSelectedManagerId(manager.id); setSelectedSchemeIndex(0); setFund(null); setBenchmark(null); }}>
                <span className="mini-label">{manager.amc}</span>
                <strong>{manager.name}</strong>
                <p>{manager.style}</p>
                <span className={`badge ${manager.confidence === "high" ? "good" : "warn"}`}>confidence: {manager.confidence}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="card panel proxy-panel">
          <div className="section-head"><div><h2>2. Proxy standard</h2><p className="muted">Toggle the standard used for alpha, IR, capture ratios and manager value-add.</p></div><span className="badge">{selectedProxyMeta.source}</span></div>
          <div className="proxy-grid">
            {(Object.keys(proxyOptions) as Array<Exclude<ProxyStandard, "custom">>).map((key) => (
              <button key={key} className={`proxy-card ${proxyStandard === key ? "active" : ""}`} onClick={() => setProxyStandard(key)}>
                <strong>{proxyOptions[key].label}</strong>
                <span>{proxyOptions[key].purpose}</span>
                <small>{proxyOptions[key].query}</small>
              </button>
            ))}
            <button className={`proxy-card ${proxyStandard === "custom" ? "active" : ""}`} onClick={() => setProxyStandard("custom")}>
              <strong>Custom verified proxy</strong>
              <span>Use only if the scheme/symbol exists in MFapi, AMFI, Yahoo or FMP coverage.</span>
              <small>{customBenchmarkQuery || "Enter custom query below"}</small>
            </button>
          </div>
          <div className="field" style={{ marginTop: 12 }}><label>Custom proxy query</label><input value={customBenchmarkQuery} onChange={(e) => { setCustomBenchmarkQuery(e.target.value); setProxyStandard("custom"); }} placeholder="Example: Nifty 50 Index Fund Direct Growth" /></div>
        </div>
      </section>

      <section className="card panel" style={{ marginTop: 18 }}>
        <div className="section-head"><div><h2>3. Manager thesis & analysis window</h2><p className="muted">{selectedManager.thesis}</p></div><span className="badge">manager start {selectedManager.managerStartDate || "unknown"}</span></div>
        <div className="scheme-picker">
          {selectedManager.schemes.map((scheme, index) => <button key={scheme.schemeName} className={`scheme-pill ${index === selectedSchemeIndex ? "active" : ""}`} onClick={() => setSelectedSchemeIndex(index)}>{scheme.schemeName}</button>)}
        </div>
        <div className="decision-list compact-decision-list">
          {selectedManager.decisionsToTrack.map((item) => <div className="decision-item" key={item}>↳ {item}</div>)}
        </div>
        <div className="grid three compact-grid controls-grid">
          <div className="field"><label>Analysis start</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
          <div className="field"><label>Effective manager-aware start</label><input value={analysisStart} readOnly /></div>
          <div className="field"><label>End date</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
          <div className="field"><label>Risk-free rate %</label><input type="number" value={riskFree} onChange={(e) => setRiskFree(Number(e.target.value))} /></div>
          <div className="field"><label>Selected fund query</label><input value={selectedScheme.schemeQuery} readOnly /></div>
          <div className="field"><label>Selected proxy query</label><input value={selectedProxyQuery} readOnly /></div>
        </div>
      </section>

      <section className="card panel" style={{ marginTop: 18 }}>
        <div className="section-head"><div><h2>4. Manager scorecard</h2><p className="muted">Fund: {fund?.meta?.scheme_name || selectedScheme.schemeName} · Proxy: {benchmark?.meta?.scheme_name || selectedProxyQuery}</p></div><span className={`badge ${scoreClass(metrics.decisionQualityScore)}`}>{metrics.decisionQualityScore !== undefined ? `${metrics.decisionQualityScore.toFixed(0)}/100` : "score pending"}</span></div>
        <div className="metrics manager-metrics">
          <Metric label="CAGR" value={pct(metrics.cagrPct)} hint={`${metrics.startDate || "—"} to ${metrics.endDate || "—"}`} />
          <Metric label="Alpha" value={pct(metrics.alphaPct)} hint="Jensen-style annual alpha" />
          <Metric label="Information ratio" value={fmt(metrics.informationRatio)} hint="Active return / tracking error" />
          <Metric label="Sharpe" value={fmt(metrics.sharpe)} />
          <Metric label="Downside capture" value={pct(metrics.downCapturePct)} />
          <Metric label="Upside capture" value={pct(metrics.upCapturePct)} />
          <Metric label="Beta" value={fmt(metrics.beta)} />
          <Metric label="Max drawdown" value={pct(metrics.maxDrawdownPct)} />
          <Metric label="Tracking error" value={pct(metrics.trackingErrorPct)} />
          <Metric label="Alpha persistence" value={metrics.alphaPersistenceScore !== undefined ? `${metrics.alphaPersistenceScore.toFixed(0)}/100` : "—"} />
        </div>
        <div style={{ marginTop: 18 }}><div className="section-head" style={{ marginBottom: 6 }}><span className="footnote">Decision-quality score</span><span className={`badge ${scoreClass(metrics.decisionQualityScore)}`}>{metrics.decisionQualityScore !== undefined ? `${metrics.decisionQualityScore.toFixed(0)}/100` : "needs live proxy"}</span></div><div className="bar" style={{ "--w": `${Math.max(0, Math.min(100, metrics.decisionQualityScore || 0))}%` } as CSSProperties}><span /></div></div>
        {metrics.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
      </section>

      <section className="grid two dashboard-grid" style={{ marginTop: 18 }}>
        <div className="card panel">
          <div className="section-head"><div><h2>5. Decision attribution</h2><p className="muted">All attribution uses the currently selected proxy standard.</p></div><span className="badge">{selectedProxyMeta.label}</span></div>
          <div className="insight-grid">
            <Insight title="Passive replacement" value={passiveLabel} body={metrics.managerValueAddNav !== undefined ? `Estimated NAV value-add versus selected proxy: ${money(metrics.managerValueAddNav)} per unit.` : "Load a live proxy to estimate manager value-add."} tone={metrics.managerValueAddNav === undefined ? "warn" : metrics.managerValueAddNav >= 0 ? "good" : "bad"} />
            <Insight title="Downside discipline" value={pct(metrics.downCapturePct)} body="Lower downside capture suggests better defensive calls during proxy-negative periods." tone={metrics.downCapturePct === undefined ? "warn" : metrics.downCapturePct < 90 ? "good" : metrics.downCapturePct < 110 ? "warn" : "bad"} />
            <Insight title="Active efficiency" value={fmt(metrics.informationRatio)} body="Information ratio checks whether active risk is being converted into active return." tone={metrics.informationRatio === undefined ? "warn" : metrics.informationRatio > 0.35 ? "good" : metrics.informationRatio > 0 ? "warn" : "bad"} />
            <Insight title="Skill vs luck proxy" value={metrics.alphaPersistenceScore !== undefined ? `${metrics.alphaPersistenceScore.toFixed(0)}/100` : "—"} body="Splits active return into first-half and second-half windows to test persistence." tone={metrics.alphaPersistenceScore === undefined ? "warn" : metrics.alphaPersistenceScore > 70 ? "good" : metrics.alphaPersistenceScore > 45 ? "warn" : "bad"} />
          </div>
        </div>

        <div className="card panel">
          <div className="section-head"><div><h2>6. What-if studio</h2><p className="muted">Counterfactuals update against the selected proxy standard.</p></div></div>
          <div className="template-list">{whatIfTemplates.map((item) => <div className="template-item" key={item.id}><strong>{item.name}</strong><span>{item.description}</span></div>)}</div>
          <div className="big-result"><span className="footnote">Passive terminal NAV</span><strong>{metrics.passiveTerminalNav !== undefined ? money(metrics.passiveTerminalNav) : "Needs live proxy"}</strong><p className="footnote">Estimated terminal NAV if the fund followed the selected proxy from the same manager-aware start date.</p></div>
        </div>
      </section>

      <section className="grid two dashboard-grid" style={{ marginTop: 18 }}>
        <div className="card panel">
          <h2>Scenario controls</h2>
          <div className="scenario-grid">
            <div className="field"><label>Starting NAV</label><input type="number" value={allocation.startingNav} onChange={(e) => setAllocation({ ...allocation, startingNav: Number(e.target.value) })} /></div>
            <div className="field"><label>Weight change %</label><input type="number" value={allocation.weightDeltaPct} onChange={(e) => setAllocation({ ...allocation, weightDeltaPct: Number(e.target.value) })} /></div>
            <div className="field"><label>Relative spread %</label><input type="number" value={allocation.spreadPct} onChange={(e) => setAllocation({ ...allocation, spreadPct: Number(e.target.value) })} /></div>
            <div className="field"><label>Cost per unit ₹</label><input type="number" value={allocation.cost} onChange={(e) => setAllocation({ ...allocation, cost: Number(e.target.value) })} /></div>
          </div>
          <div className="insight-grid" style={{ marginTop: 14 }}>
            <Insight title="Allocation decision effect" value={money(allocationResult.navEffect)} body={`Ending NAV: ${money(allocationResult.endingNav)} · Effect: ${pct(allocationResult.effectPct)}`} tone={allocationResult.navEffect >= 0 ? "good" : "bad"} />
            <Insight title="Fee-drag sensitivity" value={feeDragResult !== undefined ? money(feeDragResult) : "—"} body={`Terminal NAV impact if TER changes by ${feeDelta}% for the selected period.`} tone={feeDragResult !== undefined && feeDragResult < 0 ? "bad" : "warn"} />
            <Insight title="Downside capture what-if" value={downsideImprovement !== undefined ? money(downsideImprovement) : "—"} body={`NAV gain if downside-period losses improved by ${captureImprove}% of proxy loss.`} tone="good" />
            <Insight title="Upside capture what-if" value={upsideImprovement !== undefined ? money(upsideImprovement) : "—"} body={`NAV gain if upside participation improved by ${captureImprove}% of proxy upside.`} tone="good" />
          </div>
          <div className="grid two compact-grid" style={{ marginTop: 12 }}><div className="field"><label>Fee delta %</label><input type="number" value={feeDelta} onChange={(e) => setFeeDelta(Number(e.target.value))} /></div><div className="field"><label>Capture improvement %</label><input type="number" value={captureImprove} onChange={(e) => setCaptureImprove(Number(e.target.value))} /></div></div>
        </div>

        <div className="card panel">
          <div className="section-head"><div><h2>Yahoo / Google / FMP validation lane</h2><p className="muted">Only the pre-specified source lanes are exposed. Google Finance is kept as a verification link, not scraped as a fake API.</p></div></div>
          <div className="grid three compact-grid"><div className="field"><label>Yahoo symbol/search</label><input value={yahooSymbol} onChange={(e) => setYahooSymbol(e.target.value.toUpperCase())} /></div><div className="field"><label>Google Finance lookup</label><a className="link-button" href={googleFinanceLink} target="_blank" rel="noreferrer">Open Google Finance</a></div><div className="field"><label>Actions</label><div className="inline-actions"><button onClick={() => loadYahoo("search")}>Yahoo search</button><button className="secondary" onClick={() => loadYahoo("summary")}>Summary</button><button className="secondary" onClick={() => loadYahoo("chart")}>Chart</button></div></div></div>
          <div className="data-panel"><div className="data-row"><pre>{yahooOutput ? JSON.stringify(yahooOutput, null, 2).slice(0, 7000) : "Yahoo/FMP output appears here. MFapi and AMFI power the Indian live manager analysis."}</pre></div></div>
        </div>
      </section>
    </main>
  );
}
