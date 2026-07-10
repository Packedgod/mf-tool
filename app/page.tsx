// @ts-nocheck
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MANAGERS, getManagerById, getSchemeById, SOURCES } from "@/lib/manager-data";
import {
  buildSyntheticProxy,
  calculateDataConfidence,
  computeMetrics,
  normaliseSeries,
  runAllocationWhatIf,
  runFeeWhatIf,
  simulateCaptureImprovement
} from "@/lib/analytics";

const TABS = [
  { id: "scorecard", label: "Scorecard" },
  { id: "decisions", label: "Decision map" },
  { id: "whatifs", label: "What-if studio" },
  { id: "sources", label: "Sources & health" }
];

const PROXY_OPTIONS = [
  { id: "official", label: "Official standard", short: "Official" },
  { id: "category", label: "Category standard", short: "Category" },
  { id: "broad", label: "Broad market", short: "Broad" },
  { id: "defensive", label: "Defensive / cash", short: "Defensive" }
];

function yearsAgo(years) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function formatPercent(value, digits = 2) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—";
}

function formatMoney(value, digits = 2) {
  return Number.isFinite(value) ? `₹${value.toFixed(digits)}` : "—";
}

function scoreTone(value) {
  if (!Number.isFinite(value)) return "muted";
  if (value >= 72) return "good";
  if (value >= 52) return "watch";
  return "risk";
}

function effectiveStart(userStart, managerStart) {
  return managerStart && managerStart > userStart ? managerStart : userStart;
}

async function postSeries(payload) {
  const response = await fetch("/api/live/series", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store"
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.detail || data.error || "Live series request failed");
  }
  return data;
}

function MetricCard({ label, value, hint, tone = "neutral" }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </article>
  );
}

function StatusDot({ state }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

function SourcePill({ label, state, detail }) {
  return (
    <div className="source-pill">
      <StatusDot state={state} />
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function normaliseForChart(series) {
  if (!series?.length) return [];
  const start = series[0].nav;
  return series.map((point) => ({ date: point.date, value: (point.nav / start) * 100 }));
}

function alignChartSeries(fund, proxy) {
  const f = normaliseForChart(fund);
  const p = normaliseForChart(proxy);
  const pMap = new Map(p.map((point) => [point.date, point.value]));
  const rows = f
    .filter((point) => pMap.has(point.date))
    .map((point) => ({ date: point.date, fund: point.value, proxy: pMap.get(point.date) }));
  if (rows.length <= 260) return rows;
  const step = Math.ceil(rows.length / 260);
  return rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
}

function PerformanceChart({ fund, proxy, fundLabel, proxyLabel }) {
  const rows = useMemo(() => alignChartSeries(fund, proxy), [fund, proxy]);
  if (rows.length < 2) {
    return (
      <div className="chart-empty">
        <span>Live chart appears after the fund and proxy finish syncing.</span>
      </div>
    );
  }

  const width = 960;
  const height = 300;
  const pad = 26;
  const values = rows.flatMap((row) => [row.fund, row.proxy]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const toPoint = (value, index) => {
    const x = pad + (index / (rows.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const fundPoints = rows.map((row, index) => toPoint(row.fund, index)).join(" ");
  const proxyPoints = rows.map((row, index) => toPoint(row.proxy, index)).join(" ");

  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        <span><i className="legend-fund" />{fundLabel}</span>
        <span><i className="legend-proxy" />{proxyLabel}</span>
        <small>Normalised to 100</small>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Normalised fund and proxy performance chart">
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} className="chart-axis" />
        <polyline points={proxyPoints} className="proxy-line" />
        <polyline points={fundPoints} className="fund-line" />
      </svg>
      <div className="chart-dates"><span>{rows[0].date}</span><span>{rows[rows.length - 1].date}</span></div>
    </div>
  );
}

function ManagerRail({ managers, selectedId, search, onSearch, onSelect }) {
  return (
    <aside className="manager-rail" aria-label="Verified mutual fund managers">
      <div className="rail-heading">
        <div>
          <span className="overline">Verified directory</span>
          <h2>MF managers</h2>
        </div>
        <span className="count-badge">{managers.length}</span>
      </div>
      <label className="search-field">
        <span>Search</span>
        <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Manager, AMC, role..." />
      </label>
      <div className="manager-list">
        {managers.map((manager) => (
          <button
            type="button"
            key={manager.id}
            className={`manager-row ${selectedId === manager.id ? "active" : ""}`}
            onClick={() => onSelect(manager.id)}
          >
            <span className="avatar">{manager.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span>
            <span className="manager-copy">
              <strong>{manager.name}</strong>
              <small>{manager.role}</small>
              <em>{manager.amc}</em>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export default function Home() {
  const [selectedManagerId, setSelectedManagerId] = useState(MANAGERS[0].id);
  const [managerSearch, setManagerSearch] = useState("");
  const [proxyStandard, setProxyStandard] = useState("official");
  const [activeTab, setActiveTab] = useState("scorecard");
  const [startDate, setStartDate] = useState(yearsAgo(10));
  const [endDate, setEndDate] = useState(today());
  const [riskFree, setRiskFree] = useState(6.5);
  const [fundSeries, setFundSeries] = useState([]);
  const [proxySeries, setProxySeries] = useState([]);
  const [fundSource, setFundSource] = useState(null);
  const [proxySources, setProxySources] = useState([]);
  const [health, setHealth] = useState({ mfapi: "checking", amfi: "checking", checkedAt: null });
  const [syncState, setSyncState] = useState("idle");
  const [syncMessage, setSyncMessage] = useState("Waiting for first live sync.");
  const [lastGoodAt, setLastGoodAt] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [allocationWeight, setAllocationWeight] = useState(10.66);
  const [relativeSpread, setRelativeSpread] = useState(5);
  const [implementationCost, setImplementationCost] = useState(0);
  const [feeDelta, setFeeDelta] = useState(0.4);
  const [captureImprove, setCaptureImprove] = useState(10);
  const [yahooSymbol, setYahooSymbol] = useState("^NSEI");
  const [yahooData, setYahooData] = useState(null);
  const [fmpSymbol, setFmpSymbol] = useState("SPY");
  const [fmpData, setFmpData] = useState(null);
  const requestSequence = useRef(0);

  const selectedManager = getManagerById(selectedManagerId);
  const selectedScheme = getSchemeById(selectedManager.schemeId);
  const selectedProxy = selectedScheme.proxies[proxyStandard] || selectedScheme.proxies.official;
  const analysisStart = effectiveStart(startDate, selectedManager.startDate);

  const filteredManagers = useMemo(() => {
    const query = managerSearch.trim().toLowerCase();
    if (!query) return MANAGERS;
    return MANAGERS.filter((manager) => [manager.name, manager.amc, manager.role, manager.style].join(" ").toLowerCase().includes(query));
  }, [managerSearch]);

  const metrics = useMemo(() => computeMetrics(fundSeries, proxySeries, riskFree), [fundSeries, proxySeries, riskFree]);
  const confidence = useMemo(
    () => calculateDataConfidence({
      fund: fundSeries,
      benchmark: proxySeries,
      sourceHealth: health,
      proxyQuality: selectedProxy.quality,
      managerStartDate: selectedManager.startDate
    }),
    [fundSeries, proxySeries, health, selectedProxy.quality, selectedManager.startDate]
  );

  const allocationScenario = useMemo(
    () => runAllocationWhatIf(metrics.endNav || 100, allocationWeight, relativeSpread, implementationCost),
    [metrics.endNav, allocationWeight, relativeSpread, implementationCost]
  );
  const feeScenario = useMemo(() => runFeeWhatIf(metrics.endNav, metrics.years, feeDelta), [metrics.endNav, metrics.years, feeDelta]);
  const downsideScenario = useMemo(
    () => simulateCaptureImprovement(fundSeries, proxySeries, "downside", captureImprove),
    [fundSeries, proxySeries, captureImprove]
  );
  const upsideScenario = useMemo(
    () => simulateCaptureImprovement(fundSeries, proxySeries, "upside", captureImprove),
    [fundSeries, proxySeries, captureImprove]
  );

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/live/health", { cache: "no-store" });
      const data = await response.json();
      setHealth({ mfapi: data.mfapi || "degraded", amfi: data.amfi || "degraded", checkedAt: data.checkedAt || new Date().toISOString() });
    } catch {
      setHealth({ mfapi: "degraded", amfi: "degraded", checkedAt: new Date().toISOString() });
    }
  }, []);

  const loadLiveAnalysis = useCallback(async ({ silent = false } = {}) => {
    const sequence = ++requestSequence.current;
    if (!silent) setSyncState("syncing");
    setSyncMessage(`Syncing ${selectedScheme.name} against ${selectedProxy.label}…`);

    try {
      const fundPromise = postSeries({ queries: selectedScheme.schemeQueries, startDate: analysisStart, endDate });
      const proxyPromises = selectedProxy.components.map((component) =>
        postSeries({ queries: component.queries, startDate: analysisStart, endDate })
      );
      const [fundResult, proxyResults] = await Promise.all([fundPromise, Promise.all(proxyPromises)]);
      if (sequence !== requestSequence.current) return;

      const fund = normaliseSeries(fundResult.data);
      const components = proxyResults.map((result) => normaliseSeries(result.data));
      const weights = selectedProxy.components.map((component) => component.weight);
      const synthetic = buildSyntheticProxy(components, weights);
      if (fund.length < 3 || synthetic.length < 3) throw new Error("The live sources returned insufficient overlapping NAV history.");

      setFundSeries(fund);
      setProxySeries(synthetic);
      setFundSource(fundResult.source);
      setProxySources(proxyResults.map((result) => result.source));
      setLastGoodAt(new Date());
      setSyncState(fundResult.source?.stale || proxyResults.some((result) => result.source?.stale) ? "stale" : "ready");
      setSyncMessage(
        fundResult.source?.stale || proxyResults.some((result) => result.source?.stale)
          ? "Upstream source was temporarily unavailable; last valid cached data is retained."
          : "Live MFapi history loaded and cross-checked against AMFI where available."
      );
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setSyncState(fundSeries.length ? "degraded" : "error");
      setSyncMessage(
        fundSeries.length
          ? `Live refresh failed, so the last good dataset remains on screen. ${error.message}`
          : `No live dataset is available yet. ${error.message}`
      );
    }
  }, [selectedScheme, selectedProxy, analysisStart, endDate, fundSeries.length]);

  useEffect(() => {
    checkHealth();
    const timer = window.setTimeout(() => loadLiveAnalysis({ silent: true }), 250);
    return () => window.clearTimeout(timer);
  }, [selectedManagerId, proxyStandard, analysisStart, endDate]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        checkHealth();
        loadLiveAnalysis({ silent: true });
      }
    }, 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, checkHealth, loadLiveAnalysis]);

  useEffect(() => {
    const lever = selectedScheme.decisionLevers[0];
    setAllocationWeight(lever?.defaultWeightPct || 10);
  }, [selectedScheme.id]);

  async function loadYahooValidation() {
    setYahooData({ loading: true });
    try {
      const response = await fetch(`/api/live/yahoo?symbol=${encodeURIComponent(yahooSymbol)}&range=1y&interval=1d`, { cache: "no-store" });
      const data = await response.json();
      setYahooData(data);
    } catch (error) {
      setYahooData({ ok: false, error: error.message });
    }
  }

  async function loadFmpValidation(resource = "info") {
    setFmpData({ loading: true });
    try {
      const response = await fetch(`/api/live/fmp?symbol=${encodeURIComponent(fmpSymbol)}&resource=${resource}`, { cache: "no-store" });
      setFmpData(await response.json());
    } catch (error) {
      setFmpData({ ok: false, error: error.message });
    }
  }

  const officialGoogleLink = `https://www.google.com/finance/search?q=${encodeURIComponent(selectedScheme.name)}`;
  const managerValueTone = Number.isFinite(metrics.managerValueAddNav) ? (metrics.managerValueAddNav >= 0 ? "good" : "risk") : "neutral";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div><strong>ManagerLens</strong><small>Mutual fund decision intelligence</small></div>
        </div>
        <div className="top-actions">
          <div className={`sync-badge ${syncState}`}><StatusDot state={syncState} /><span>{syncState === "syncing" ? "Syncing" : syncState === "ready" ? "Live" : syncState === "stale" ? "Cached" : syncState === "degraded" ? "Degraded" : syncState === "error" ? "Offline" : "Starting"}</span></div>
          <button className="ghost-button" type="button" onClick={() => setAutoRefresh((value) => !value)}>{autoRefresh ? "Auto-sync on" : "Auto-sync off"}</button>
          <button className="primary-button" type="button" onClick={() => loadLiveAnalysis()} disabled={syncState === "syncing"}>Refresh now</button>
        </div>
      </header>

      <div className="workspace">
        <ManagerRail
          managers={filteredManagers}
          selectedId={selectedManagerId}
          search={managerSearch}
          onSearch={setManagerSearch}
          onSelect={(id) => {
            setSelectedManagerId(id);
            setActiveTab("scorecard");
          }}
        />

        <main className="main-panel">
          <section className="manager-hero-card">
            <div className="manager-primary">
              <div className="manager-title-row">
                <span className="large-avatar">{selectedManager.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span>
                <div>
                  <span className="overline">{selectedManager.amc}</span>
                  <h1>{selectedManager.name}</h1>
                  <p>{selectedManager.role} · {selectedManager.startLabel}</p>
                </div>
              </div>
              <p className="manager-style">{selectedManager.style}</p>
              <div className="decision-tags">
                {selectedManager.decisions.map((decision) => <span key={decision}>{decision}</span>)}
              </div>
            </div>
            <div className="hero-score">
              <span>Decision-quality score</span>
              <strong className={scoreTone(metrics.decisionQualityScore)}>{Number.isFinite(metrics.decisionQualityScore) ? Math.round(metrics.decisionQualityScore) : "—"}</strong>
              <small>Confidence {confidence.grade} · {confidence.score}/100</small>
            </div>
          </section>

          <section className={`sync-notice ${syncState}`}>
            <div><StatusDot state={syncState} /><span>{syncMessage}</span></div>
            <small>{lastGoodAt ? `Last good sync: ${lastGoodAt.toLocaleString()}` : "No successful sync yet"}</small>
          </section>

          <section className="control-deck">
            <div className="control-block proxy-control">
              <span className="control-label">Comparison standard</span>
              <div className="segmented-control" role="group" aria-label="Proxy standard">
                {PROXY_OPTIONS.map((option) => (
                  <button key={option.id} type="button" className={proxyStandard === option.id ? "active" : ""} onClick={() => setProxyStandard(option.id)}>{option.short}</button>
                ))}
              </div>
              <div className="proxy-summary">
                <strong>{selectedProxy.label}</strong>
                <span>{selectedProxy.description}</span>
                <small>Proxy quality: {selectedProxy.quality} · {selectedScheme.benchmarkName}</small>
              </div>
            </div>
            <div className="control-block date-control">
              <label><span>From</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
              <label><span>Manager-aware start</span><input type="date" value={analysisStart} readOnly /></label>
              <label><span>To</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
              <label><span>Risk-free %</span><input type="number" step="0.1" value={riskFree} onChange={(event) => setRiskFree(Number(event.target.value))} /></label>
            </div>
          </section>

          <nav className="tabbar" aria-label="Analysis sections">
            {TABS.map((tab) => <button type="button" key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
          </nav>

          {activeTab === "scorecard" ? (
            <section className="tab-content">
              <PerformanceChart fund={fundSeries} proxy={proxySeries} fundLabel={selectedScheme.name} proxyLabel={selectedProxy.label} />
              <div className="metric-grid">
                <MetricCard label="CAGR" value={formatPercent(metrics.cagrPct)} hint={`${metrics.startDate || "—"} to ${metrics.endDate || "—"}`} />
                <MetricCard label="Annual alpha" value={formatPercent(metrics.alphaPct)} hint="Jensen-style, proxy dependent" tone={Number.isFinite(metrics.alphaPct) ? (metrics.alphaPct >= 0 ? "good" : "risk") : "neutral"} />
                <MetricCard label="Information ratio" value={formatNumber(metrics.informationRatio)} hint="Active return per unit of active risk" tone={Number.isFinite(metrics.informationRatio) ? (metrics.informationRatio > 0 ? "good" : "risk") : "neutral"} />
                <MetricCard label="Sharpe ratio" value={formatNumber(metrics.sharpe)} hint="Return efficiency versus total risk" />
                <MetricCard label="Downside capture" value={formatPercent(metrics.downCapturePct)} hint="Below 100 can indicate protection" tone={Number.isFinite(metrics.downCapturePct) ? (metrics.downCapturePct < 100 ? "good" : "watch") : "neutral"} />
                <MetricCard label="Upside capture" value={formatPercent(metrics.upCapturePct)} hint="Participation in positive proxy days" />
                <MetricCard label="Maximum drawdown" value={formatPercent(metrics.maxDrawdownPct)} hint="Worst peak-to-trough NAV decline" tone="risk" />
                <MetricCard label="Tracking error" value={formatPercent(metrics.trackingErrorPct)} hint="Annualised active-risk dispersion" />
                <MetricCard label="Beta" value={formatNumber(metrics.beta)} hint="Sensitivity to selected proxy" />
                <MetricCard label="Alpha persistence" value={Number.isFinite(metrics.alphaPersistenceScore) ? `${Math.round(metrics.alphaPersistenceScore)}/100` : "—"} hint="Consistency across four sub-periods" />
              </div>
              {metrics.warnings?.length ? <div className="inline-warning">{metrics.warnings.join(" ")}</div> : null}
            </section>
          ) : null}

          {activeTab === "decisions" ? (
            <section className="tab-content decision-layout">
              <div className="decision-overview">
                <span className="overline">Decision attribution</span>
                <h2>How the manager changed the outcome</h2>
                <p>These signals use the selected manager-tenure window and the currently toggled proxy standard. They are diagnostic estimates, not claims that every return difference was caused by one individual.</p>
              </div>
              <div className="insight-grid">
                <MetricCard label="Manager value-add per NAV unit" value={formatMoney(metrics.managerValueAddNav)} hint={`Versus ${selectedProxy.label}`} tone={managerValueTone} />
                <MetricCard label="Passive terminal NAV" value={formatMoney(metrics.passiveTerminalNav)} hint="Counterfactual terminal NAV using proxy" />
                <MetricCard label="Active return" value={formatPercent(metrics.activeReturnPct)} hint="Annualised fund return minus proxy" tone={Number.isFinite(metrics.activeReturnPct) ? (metrics.activeReturnPct >= 0 ? "good" : "risk") : "neutral"} />
                <MetricCard label="Positive-month hit rate" value={formatPercent(metrics.positiveMonthHitRatePct)} hint="Share of positive fund months" />
              </div>
              <div className="decision-lever-grid">
                {selectedScheme.decisionLevers.map((lever) => (
                  <article key={lever.id} className="lever-card">
                    <span>{lever.label}</span>
                    <strong>{lever.defaultWeightPct}% default test weight</strong>
                    <p>{lever.description}</p>
                  </article>
                ))}
              </div>
              <article className="method-card">
                <h3>Interpretation logic</h3>
                <ol>
                  <li>Restrict history to the selected manager’s verified start date.</li>
                  <li>Normalise fund and proxy data to the same date window.</li>
                  <li>Measure active return, active risk, capture asymmetry and drawdown.</li>
                  <li>Separate outcome quality from data confidence so weak coverage cannot masquerade as skill.</li>
                </ol>
              </article>
            </section>
          ) : null}

          {activeTab === "whatifs" ? (
            <section className="tab-content">
              <div className="whatif-header">
                <div><span className="overline">Counterfactual lab</span><h2>Test a manager decision without rewriting history</h2></div>
                <span className="confidence-chip">Uses {selectedProxy.label}</span>
              </div>
              <div className="scenario-controls">
                <label><span>Decision weight %</span><input type="number" step="0.1" value={allocationWeight} onChange={(event) => setAllocationWeight(Number(event.target.value))} /></label>
                <label><span>Relative return spread %</span><input type="number" step="0.1" value={relativeSpread} onChange={(event) => setRelativeSpread(Number(event.target.value))} /></label>
                <label><span>Implementation cost ₹</span><input type="number" step="0.01" value={implementationCost} onChange={(event) => setImplementationCost(Number(event.target.value))} /></label>
                <label><span>Fee delta % p.a.</span><input type="number" step="0.05" value={feeDelta} onChange={(event) => setFeeDelta(Number(event.target.value))} /></label>
                <label><span>Capture improvement %</span><input type="number" step="1" value={captureImprove} onChange={(event) => setCaptureImprove(Number(event.target.value))} /></label>
              </div>
              <div className="whatif-grid">
                <article className="whatif-card featured"><span>Allocation decision</span><strong>{formatMoney(allocationScenario.navEffect)}</strong><p>Approximate NAV effect from changing {allocationWeight}% of exposure when the selected sleeve outperforms or underperforms by {relativeSpread}%.</p><small>Ending NAV: {formatMoney(allocationScenario.endingNav)} · {formatPercent(allocationScenario.effectPct)}</small></article>
                <article className="whatif-card"><span>Passive replacement</span><strong>{formatMoney(metrics.passiveTerminalNav)}</strong><p>Estimated terminal NAV if the manager simply followed the selected comparison standard.</p></article>
                <article className="whatif-card"><span>Fee-drag sensitivity</span><strong>{formatMoney(feeScenario)}</strong><p>Estimated terminal NAV change from a {feeDelta}% annual expense-ratio difference.</p></article>
                <article className="whatif-card"><span>Better downside capture</span><strong>{formatMoney(downsideScenario)}</strong><p>Estimated NAV gain if losses improved by {captureImprove}% of proxy-negative moves.</p></article>
                <article className="whatif-card"><span>Better upside capture</span><strong>{formatMoney(upsideScenario)}</strong><p>Estimated NAV gain if participation improved by {captureImprove}% of proxy-positive moves.</p></article>
                <article className="whatif-card"><span>Zero-alpha baseline</span><strong>{formatMoney(metrics.passiveTerminalNav)}</strong><p>Uses the selected standard as the no-active-skill counterfactual.</p></article>
              </div>
            </section>
          ) : null}

          {activeTab === "sources" ? (
            <section className="tab-content sources-layout">
              <div className="source-health-grid">
                <SourcePill label="MFapi.in" state={health.mfapi} detail="Primary Indian scheme search and NAV history" />
                <SourcePill label="AMFI NAVAll" state={health.amfi} detail="Official latest-NAV validation and fallback resolution" />
                <SourcePill label="AMC factsheet" state="online" detail={`Manager roster verified as of ${selectedManager.source.asOf}`} />
                <SourcePill label="Yahoo Finance" state={yahooData?.ok ? "online" : "optional"} detail="Optional global market context; never blocks Indian MF analysis" />
                <SourcePill label="Google Finance" state="optional" detail="Manual verification link; no unofficial scraping" />
                <SourcePill label="FMP" state={fmpData?.configured ? (fmpData.ok ? "online" : "degraded") : "optional"} detail="Optional global ETF/fund information with API key" />
              </div>

              <div className="provenance-grid">
                <article className="provenance-card">
                  <span className="overline">Manager record</span>
                  <h3>{selectedManager.source.label}</h3>
                  <p>{selectedManager.name} is included because the role and tenure were verified from the official AMC factsheet, not inferred from NAV data.</p>
                  <a href={selectedManager.source.url} target="_blank" rel="noreferrer">Open official factsheet</a>
                </article>
                <article className="provenance-card">
                  <span className="overline">Live fund series</span>
                  <h3>{fundSource?.schemeName || selectedScheme.name}</h3>
                  <p>Resolved by {fundSource?.resolvedBy || "MFapi/AMFI live resolver"}. AMFI validation: {fundSource?.amfiStatus || "pending"}.</p>
                  <a href={SOURCES.mfapi.url} target="_blank" rel="noreferrer">Open MFapi documentation</a>
                </article>
                <article className="provenance-card">
                  <span className="overline">Proxy construction</span>
                  <h3>{selectedProxy.label}</h3>
                  <p>{selectedProxy.components.length === 1 ? "Single investable proxy series." : `Synthetic proxy built from ${selectedProxy.components.length} live components with fixed disclosed weights.`}</p>
                  <small>{proxySources.map((source) => source?.schemeName).filter(Boolean).join(" + ") || "Pending live sync"}</small>
                </article>
              </div>

              <div className="validation-lab">
                <div className="validation-panel">
                  <h3>Yahoo Finance context</h3>
                  <p>Optional and non-blocking. Use for indices or global symbols, not for the Indian manager roster.</p>
                  <div className="inline-form"><input value={yahooSymbol} onChange={(event) => setYahooSymbol(event.target.value)} placeholder="^NSEI" /><button type="button" onClick={loadYahooValidation}>Validate</button></div>
                  <pre>{yahooData ? JSON.stringify(yahooData, null, 2).slice(0, 3000) : "No Yahoo validation loaded."}</pre>
                </div>
                <div className="validation-panel">
                  <h3>FMP global fund context</h3>
                  <p>Optional. Requires FMP_API_KEY in Vercel environment variables.</p>
                  <div className="inline-form"><input value={fmpSymbol} onChange={(event) => setFmpSymbol(event.target.value.toUpperCase())} placeholder="SPY" /><button type="button" onClick={() => loadFmpValidation("info")}>Fund info</button><button type="button" onClick={() => loadFmpValidation("holdings")}>Holdings</button></div>
                  <pre>{fmpData ? JSON.stringify(fmpData, null, 2).slice(0, 3000) : "No FMP validation loaded."}</pre>
                </div>
              </div>

              <div className="official-links">
                <a href={officialGoogleLink} target="_blank" rel="noreferrer">Verify on Google Finance</a>
                <a href={SOURCES.amfiNav.url} target="_blank" rel="noreferrer">Open AMFI NAV feed</a>
                <button type="button" onClick={checkHealth}>Recheck source health</button>
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
