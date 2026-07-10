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

const PROXY_OPTIONS = [
  { id: "official", label: "Official" },
  { id: "category", label: "Category" },
  { id: "broad", label: "Broad" },
  { id: "defensive", label: "Defensive" },
  { id: "custom", label: "Custom AMFI code" }
];

const TABS = ["scorecard", "decisions", "whatifs", "sources"];

function yearsAgo(years) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isValidCode(value) {
  return /^\d{4,9}$/.test(String(value || "").trim());
}

function pct(value, digits = 2) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—";
}

function num(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function money(value, digits = 2) {
  return Number.isFinite(value) ? `₹${value.toFixed(digits)}` : "—";
}

function effectiveStart(userStart, managerStart) {
  return managerStart && managerStart > userStart ? managerStart : userStart;
}

function StatusDot({ state }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

function Metric({ label, value, hint, tone = "neutral" }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

async function requestSeries(payload) {
  const response = await fetch("/api/live/series", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store"
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.detail || data.error || "Live series request failed.");
  return data;
}

function normaliseForChart(series) {
  if (!series.length) return [];
  const start = series[0].nav;
  return series.map((point) => ({ date: point.date, value: (point.nav / start) * 100 }));
}

function chartRows(fund, proxy) {
  const f = normaliseForChart(fund);
  const pMap = new Map(normaliseForChart(proxy).map((point) => [point.date, point.value]));
  const aligned = f.filter((point) => pMap.has(point.date)).map((point) => ({ date: point.date, fund: point.value, proxy: pMap.get(point.date) }));
  if (aligned.length <= 240) return aligned;
  const step = Math.ceil(aligned.length / 240);
  return aligned.filter((_, index) => index % step === 0 || index === aligned.length - 1);
}

function PerformanceChart({ fund, proxy, fundName, proxyName }) {
  const rows = useMemo(() => chartRows(fund, proxy), [fund, proxy]);
  if (rows.length < 2) return <div className="chart-empty">The chart will appear after both live series load successfully.</div>;

  const width = 960;
  const height = 300;
  const pad = 26;
  const values = rows.flatMap((row) => [row.fund, row.proxy]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const point = (value, index) => {
    const x = pad + (index / (rows.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        <span><i className="legend-fund" />{fundName}</span>
        <span><i className="legend-proxy" />{proxyName}</span>
        <small>Normalised to 100</small>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} aria-label="Fund and proxy performance">
        <polyline className="proxy-line" points={rows.map((row, index) => point(row.proxy, index)).join(" ")} />
        <polyline className="fund-line" points={rows.map((row, index) => point(row.fund, index)).join(" ")} />
      </svg>
      <div className="chart-dates"><span>{rows[0].date}</span><span>{rows[rows.length - 1].date}</span></div>
    </div>
  );
}

export default function ManagerLensApp() {
  const [managerId, setManagerId] = useState(MANAGERS[0].id);
  const [managerSearch, setManagerSearch] = useState("");
  const [proxyStandard, setProxyStandard] = useState("official");
  const [activeTab, setActiveTab] = useState("scorecard");
  const [startDate, setStartDate] = useState(yearsAgo(10));
  const [endDate, setEndDate] = useState(today());
  const [riskFree, setRiskFree] = useState(6.5);
  const [fundCodeInput, setFundCodeInput] = useState("");
  const [appliedFundCode, setAppliedFundCode] = useState("");
  const [proxyCodeInput, setProxyCodeInput] = useState("");
  const [appliedProxyCode, setAppliedProxyCode] = useState("");
  const [fundCodeStatus, setFundCodeStatus] = useState(null);
  const [proxyCodeStatus, setProxyCodeStatus] = useState(null);
  const [fundSeries, setFundSeries] = useState([]);
  const [proxySeries, setProxySeries] = useState([]);
  const [fundSource, setFundSource] = useState(null);
  const [proxySource, setProxySource] = useState(null);
  const [health, setHealth] = useState({ mfapi: "checking", amfi: "checking" });
  const [syncState, setSyncState] = useState("idle");
  const [syncMessage, setSyncMessage] = useState("Preparing live data.");
  const [lastGoodAt, setLastGoodAt] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [allocationWeight, setAllocationWeight] = useState(10);
  const [relativeSpread, setRelativeSpread] = useState(5);
  const [feeDelta, setFeeDelta] = useState(0.4);
  const [captureImprove, setCaptureImprove] = useState(10);
  const sequence = useRef(0);

  const manager = getManagerById(managerId);
  const scheme = getSchemeById(manager.schemeId);
  const standardProxy = scheme.proxies[proxyStandard === "custom" ? "official" : proxyStandard] || scheme.proxies.official;
  const customReady = proxyStandard !== "custom" || isValidCode(appliedProxyCode);
  const analysisStart = effectiveStart(startDate, manager.startDate);
  const proxyName = proxyStandard === "custom"
    ? proxyCodeStatus?.schemeName || (appliedProxyCode ? `AMFI scheme ${appliedProxyCode}` : "Custom proxy")
    : standardProxy.label;

  const filteredManagers = useMemo(() => {
    const query = managerSearch.trim().toLowerCase();
    if (!query) return MANAGERS;
    return MANAGERS.filter((item) => [item.name, item.amc, item.role, item.style].join(" ").toLowerCase().includes(query));
  }, [managerSearch]);

  const metrics = useMemo(() => computeMetrics(fundSeries, proxySeries, riskFree), [fundSeries, proxySeries, riskFree]);
  const confidence = useMemo(() => calculateDataConfidence({
    fund: fundSeries,
    benchmark: proxySeries,
    sourceHealth: health,
    proxyQuality: proxyStandard === "custom" ? "Medium-high" : standardProxy.quality,
    managerStartDate: manager.startDate
  }), [fundSeries, proxySeries, health, standardProxy.quality, proxyStandard, manager.startDate]);

  const allocationScenario = runAllocationWhatIf(metrics.endNav || 100, allocationWeight, relativeSpread, 0);
  const feeScenario = runFeeWhatIf(metrics.endNav, metrics.years, feeDelta);
  const downsideScenario = simulateCaptureImprovement(fundSeries, proxySeries, "downside", captureImprove);
  const upsideScenario = simulateCaptureImprovement(fundSeries, proxySeries, "upside", captureImprove);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/live/health", { cache: "no-store" });
      const data = await response.json();
      setHealth({ mfapi: data.mfapi || "degraded", amfi: data.amfi || "degraded" });
    } catch {
      setHealth({ mfapi: "degraded", amfi: "degraded" });
    }
  }, []);

  const validateCode = useCallback(async (kind) => {
    const raw = kind === "fund" ? fundCodeInput : proxyCodeInput;
    const setter = kind === "fund" ? setFundCodeStatus : setProxyCodeStatus;
    const apply = kind === "fund" ? setAppliedFundCode : setAppliedProxyCode;
    if (!isValidCode(raw)) {
      setter({ ok: false, error: "Enter a 4 to 9 digit AMFI scheme code." });
      return;
    }
    setter({ loading: true });
    try {
      const response = await fetch(`/api/live/code?code=${encodeURIComponent(raw.trim())}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Scheme code could not be validated.");
      setter(data);
      apply(raw.trim());
      if (kind === "proxy") setProxyStandard("custom");
    } catch (error) {
      setter({ ok: false, error: error.message });
    }
  }, [fundCodeInput, proxyCodeInput]);

  const loadLive = useCallback(async ({ silent = false } = {}) => {
    if (proxyStandard === "custom" && !isValidCode(appliedProxyCode)) {
      setSyncState("idle");
      setSyncMessage("Enter and validate a custom proxy AMFI code before refreshing. No request is being sent yet.");
      return;
    }

    const current = ++sequence.current;
    if (!silent) setSyncState("syncing");
    setSyncMessage("Loading live fund and comparison data from MFapi and AMFI…");

    try {
      const fundPayload = appliedFundCode
        ? { schemeCode: appliedFundCode, startDate: analysisStart, endDate }
        : { queries: scheme.schemeQueries, startDate: analysisStart, endDate };

      const fundPromise = requestSeries(fundPayload);
      let proxyPromise;
      if (proxyStandard === "custom") {
        proxyPromise = requestSeries({ schemeCode: appliedProxyCode, startDate: analysisStart, endDate }).then((result) => ({ result, series: normaliseSeries(result.data) }));
      } else {
        proxyPromise = Promise.all(standardProxy.components.map((component) => requestSeries({ queries: component.queries, startDate: analysisStart, endDate })))
          .then((results) => ({
            result: results[0],
            results,
            series: buildSyntheticProxy(results.map((result) => normaliseSeries(result.data)), standardProxy.components.map((component) => component.weight))
          }));
      }

      const [fundResult, proxyBundle] = await Promise.all([fundPromise, proxyPromise]);
      if (current !== sequence.current) return;
      const fund = normaliseSeries(fundResult.data);
      const proxy = proxyBundle.series;
      if (fund.length < 3) throw new Error("The selected fund code returned insufficient NAV history.");
      if (proxy.length < 3) throw new Error("The selected proxy code returned insufficient NAV history.");

      setFundSeries(fund);
      setProxySeries(proxy);
      setFundSource(fundResult.source);
      setProxySource(proxyBundle.result?.source || proxyBundle.results?.map((item) => item.source));
      setLastGoodAt(new Date());
      const stale = fundResult.source?.stale || proxyBundle.result?.source?.stale || proxyBundle.results?.some((item) => item.source?.stale);
      setSyncState(stale ? "stale" : "ready");
      setSyncMessage(stale ? "A source is temporarily unavailable; the last valid cached series remains in use." : "Live histories loaded successfully and AMFI validation was applied where available.");
    } catch (error) {
      if (current !== sequence.current) return;
      setSyncState(fundSeries.length && proxySeries.length ? "degraded" : "error");
      setSyncMessage(fundSeries.length && proxySeries.length
        ? `Refresh failed, but the last valid chart remains visible. ${error.message}`
        : error.message);
    }
  }, [proxyStandard, appliedProxyCode, appliedFundCode, analysisStart, endDate, scheme, standardProxy, fundSeries.length, proxySeries.length]);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    if (!customReady) return undefined;
    const timer = window.setTimeout(() => loadLive({ silent: true }), 250);
    return () => window.clearTimeout(timer);
  }, [managerId, proxyStandard, appliedProxyCode, appliedFundCode, analysisStart, endDate]);

  useEffect(() => {
    if (!autoRefresh || !customReady) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadLive({ silent: true });
    }, 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, customReady, loadLive]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">M</span><div><strong>ManagerLens</strong><small>Mutual fund decision intelligence</small></div></div>
        <div className="top-actions">
          <div className={`sync-badge ${syncState}`}><StatusDot state={syncState} /><span>{syncState === "ready" ? "Live" : syncState === "syncing" ? "Syncing" : syncState}</span></div>
          <button className="ghost-button" onClick={() => setAutoRefresh((value) => !value)}>{autoRefresh ? "Auto-sync on" : "Auto-sync off"}</button>
          <button className="primary-button" onClick={() => loadLive()} disabled={syncState === "syncing" || !customReady}>Refresh now</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="manager-rail">
          <div className="rail-heading"><div><span className="overline">Verified directory</span><h2>MF managers</h2></div><span className="count-badge">{filteredManagers.length}</span></div>
          <label className="search-field"><span>Search</span><input value={managerSearch} onChange={(event) => setManagerSearch(event.target.value)} /></label>
          <div className="manager-list">
            {filteredManagers.map((item) => <button key={item.id} className={`manager-row ${managerId === item.id ? "active" : ""}`} onClick={() => setManagerId(item.id)}><span className="avatar">{item.name.split(/\s+/).map((part) => part[0]).slice(0,2).join("")}</span><span className="manager-copy"><strong>{item.name}</strong><small>{item.role}</small><em>{item.amc}</em></span></button>)}
          </div>
        </aside>

        <main className="main-panel">
          <section className="manager-hero-card">
            <div className="manager-primary"><div className="manager-title-row"><span className="large-avatar">{manager.name.split(/\s+/).map((part) => part[0]).slice(0,2).join("")}</span><div><span className="overline">{manager.amc}</span><h1>{manager.name}</h1><p>{manager.role} · {manager.startLabel}</p></div></div><p className="manager-style">{manager.style}</p><div className="decision-tags">{manager.decisions.map((decision) => <span key={decision}>{decision}</span>)}</div></div>
            <div className="hero-score"><span>Decision-quality score</span><strong>{Number.isFinite(metrics.decisionQualityScore) ? Math.round(metrics.decisionQualityScore) : "—"}</strong><small>Confidence {confidence.grade} · {confidence.score}/100</small></div>
          </section>

          <section className={`sync-notice ${syncState}`}><div><StatusDot state={syncState} /><span>{syncMessage}</span></div><small>{lastGoodAt ? `Last good sync: ${lastGoodAt.toLocaleString()}` : "No successful sync yet"}</small></section>

          <section className="control-deck custom-control-deck">
            <div className="control-block proxy-control">
              <span className="control-label">Comparison standard</span>
              <div className="segmented-control five-way">{PROXY_OPTIONS.map((option) => <button key={option.id} className={proxyStandard === option.id ? "active" : ""} onClick={() => setProxyStandard(option.id)}>{option.label}</button>)}</div>
              {proxyStandard === "custom" ? (
                <div className="code-entry">
                  <label><span>Custom proxy AMFI scheme code</span><input inputMode="numeric" value={proxyCodeInput} onChange={(event) => setProxyCodeInput(event.target.value.replace(/\D/g, ""))} placeholder="Example: 125497" /></label>
                  <button onClick={() => validateCode("proxy")} disabled={proxyCodeStatus?.loading}>{proxyCodeStatus?.loading ? "Validating…" : "Validate & apply"}</button>
                  <div className={`code-result ${proxyCodeStatus?.ok ? "good" : proxyCodeStatus?.error ? "risk" : ""}`}>{proxyCodeStatus?.ok ? `${proxyCodeStatus.schemeName} · ${proxyCodeStatus.observations} observations` : proxyCodeStatus?.error || "The app will not request data until this code is validated."}</div>
                </div>
              ) : <div className="proxy-summary"><strong>{standardProxy.label}</strong><span>{standardProxy.description}</span><small>Proxy quality: {standardProxy.quality}</small></div>}
            </div>

            <div className="control-block code-control">
              <span className="control-label">Direct fund-code override</span>
              <div className="code-entry compact">
                <label><span>Fund AMFI scheme code (optional)</span><input inputMode="numeric" value={fundCodeInput} onChange={(event) => setFundCodeInput(event.target.value.replace(/\D/g, ""))} placeholder="Leave blank to auto-resolve" /></label>
                <div className="code-buttons"><button onClick={() => validateCode("fund")} disabled={!fundCodeInput || fundCodeStatus?.loading}>{fundCodeStatus?.loading ? "Validating…" : "Apply code"}</button><button className="clear-code" onClick={() => { setFundCodeInput(""); setAppliedFundCode(""); setFundCodeStatus(null); }}>Clear</button></div>
                <div className={`code-result ${fundCodeStatus?.ok ? "good" : fundCodeStatus?.error ? "risk" : ""}`}>{fundCodeStatus?.ok ? `${fundCodeStatus.schemeName} · code ${fundCodeStatus.schemeCode}` : fundCodeStatus?.error || `Auto-resolving ${scheme.name}`}</div>
              </div>
            </div>
          </section>

          <section className="control-block date-control date-deck">
            <label><span>From</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
            <label><span>Manager-aware start</span><input type="date" value={analysisStart} readOnly /></label>
            <label><span>To</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
            <label><span>Risk-free %</span><input type="number" step="0.1" value={riskFree} onChange={(event) => setRiskFree(Number(event.target.value))} /></label>
          </section>

          <nav className="tabbar">{TABS.map((tab) => <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>{tab === "whatifs" ? "What-if studio" : tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>

          {activeTab === "scorecard" && <section className="tab-content"><PerformanceChart fund={fundSeries} proxy={proxySeries} fundName={fundSource?.schemeName || scheme.name} proxyName={proxyName} /><div className="metric-grid"><Metric label="CAGR" value={pct(metrics.cagrPct)} hint="Manager-aware period" /><Metric label="Annual alpha" value={pct(metrics.alphaPct)} hint="Proxy-dependent Jensen alpha" tone={metrics.alphaPct >= 0 ? "good" : "risk"} /><Metric label="Information ratio" value={num(metrics.informationRatio)} hint="Active return / tracking error" /><Metric label="Sharpe" value={num(metrics.sharpe)} hint="Total-risk efficiency" /><Metric label="Downside capture" value={pct(metrics.downCapturePct)} hint="Below 100 indicates protection" /><Metric label="Upside capture" value={pct(metrics.upCapturePct)} hint="Positive-market participation" /><Metric label="Max drawdown" value={pct(metrics.maxDrawdownPct)} hint="Worst peak-to-trough decline" tone="risk" /><Metric label="Beta" value={num(metrics.beta)} hint="Sensitivity to proxy" /><Metric label="Tracking error" value={pct(metrics.trackingErrorPct)} hint="Annualised active risk" /><Metric label="Alpha persistence" value={Number.isFinite(metrics.alphaPersistenceScore) ? `${Math.round(metrics.alphaPersistenceScore)}/100` : "—"} hint="Four-window consistency" /></div></section>}

          {activeTab === "decisions" && <section className="tab-content"><div className="decision-overview"><span className="overline">Decision attribution</span><h2>Manager outcome versus {proxyName}</h2><p>The selected manager tenure, fund series and proxy series are aligned before active-return and capture calculations are run.</p></div><div className="insight-grid"><Metric label="Manager value-add" value={money(metrics.managerValueAddNav)} hint="NAV difference versus proxy" /><Metric label="Passive terminal NAV" value={money(metrics.passiveTerminalNav)} hint="No-active-skill baseline" /><Metric label="Active return" value={pct(metrics.activeReturnPct)} hint="Annualised excess return" /><Metric label="Positive-month rate" value={pct(metrics.positiveMonthHitRatePct)} hint="Consistency indicator" /></div><div className="decision-lever-grid">{scheme.decisionLevers.map((lever) => <article className="lever-card" key={lever.id}><span>{lever.label}</span><strong>{lever.defaultWeightPct}% test weight</strong><p>{lever.description}</p></article>)}</div></section>}

          {activeTab === "whatifs" && <section className="tab-content"><div className="scenario-controls"><label><span>Decision weight %</span><input type="number" value={allocationWeight} onChange={(event) => setAllocationWeight(Number(event.target.value))} /></label><label><span>Relative spread %</span><input type="number" value={relativeSpread} onChange={(event) => setRelativeSpread(Number(event.target.value))} /></label><label><span>Fee delta %</span><input type="number" value={feeDelta} onChange={(event) => setFeeDelta(Number(event.target.value))} /></label><label><span>Capture improvement %</span><input type="number" value={captureImprove} onChange={(event) => setCaptureImprove(Number(event.target.value))} /></label></div><div className="whatif-grid"><article className="whatif-card featured"><span>Allocation effect</span><strong>{money(allocationScenario.navEffect)}</strong><p>Estimated NAV effect from changing {allocationWeight}% of exposure with a {relativeSpread}% relative return spread.</p></article><article className="whatif-card"><span>Passive replacement</span><strong>{money(metrics.passiveTerminalNav)}</strong><p>Terminal NAV if the selected proxy replaced active management.</p></article><article className="whatif-card"><span>Fee drag</span><strong>{money(feeScenario)}</strong><p>Estimated terminal impact of a {feeDelta}% annual fee change.</p></article><article className="whatif-card"><span>Better downside capture</span><strong>{money(downsideScenario)}</strong><p>Estimated gain from improved protection.</p></article><article className="whatif-card"><span>Better upside capture</span><strong>{money(upsideScenario)}</strong><p>Estimated gain from improved participation.</p></article></div></section>}

          {activeTab === "sources" && <section className="tab-content"><div className="source-health-grid"><div className="source-pill"><StatusDot state={health.mfapi} /><div><strong>MFapi.in</strong><span>Primary historical NAV source</span></div></div><div className="source-pill"><StatusDot state={health.amfi} /><div><strong>AMFI NAVAll</strong><span>Code validation and latest-NAV cross-check</span></div></div><div className="source-pill"><StatusDot state="online" /><div><strong>AMC factsheet</strong><span>{manager.source.label}</span></div></div></div><div className="provenance-grid"><article className="provenance-card"><span className="overline">Fund series</span><h3>{fundSource?.schemeName || "Pending"}</h3><p>Scheme code {fundSource?.schemeCode || appliedFundCode || "auto"}; resolved by {fundSource?.resolvedBy || "pending"}.</p></article><article className="provenance-card"><span className="overline">Proxy series</span><h3>{proxyName}</h3><p>{proxyStandard === "custom" ? `Direct AMFI code ${appliedProxyCode || "not applied"}.` : "Disclosed investable proxy construction."}</p></article><article className="provenance-card"><span className="overline">Direct-code fix</span><h3>Range fallback enabled</h3><p>If MFapi returns no rows for a ranged request, the server retries full history and filters the requested dates locally.</p></article></div><div className="official-links"><a href={SOURCES.mfapi.url} target="_blank" rel="noreferrer">MFapi documentation</a><a href={SOURCES.amfiNav.url} target="_blank" rel="noreferrer">AMFI NAV feed</a></div></section>}
        </main>
      </div>
    </div>
  );
}
