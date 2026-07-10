'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MANAGERS, getManagerById, getSchemeById } from '@/lib/manager-data';
import { buildSyntheticProxy, computeMetrics, normaliseSeries } from '@/lib/analytics';
import { calculateManagerScore } from '@/lib/momentum-engine';
import { getMomentumSnapshot, CYCLE_PROFILES, MOMENTUM_WEIGHTS } from '@/lib/momentum-data';

const PROXY_MODES = ['official', 'category', 'broad', 'defensive', 'custom'];
const TABS = [
  { id: 'racecard', label: 'Racecard' },
  { id: 'sectors', label: 'Sector track' },
  { id: 'timing', label: 'Entry / exit timing' },
  { id: 'traditional', label: 'Traditional 25%' },
  { id: 'sources', label: 'Sources' }
];

const FACTOR_LABELS = {
  sectorBias: 'Sector positioning & bias',
  sectorMomentum: 'Sector movement timing',
  entryTiming: 'Stock entry timing',
  exitTiming: 'Stock exit timing',
  exitPeakProximity: 'Exit near local peak',
  turnoverEfficiency: 'Turnover efficiency',
  cycleFit: 'Market-cycle fit',
  alphaInformationRatio: 'Alpha & information ratio',
  sharpeDownside: 'Sharpe & downside capture',
  drawdownControl: 'Drawdown control',
  persistence: 'Alpha persistence',
  managerValueAdd: 'NAV value-add'
};

const validCode = value => /^\d{4,9}$/.test(String(value || '').trim());
const today = () => new Date().toISOString().slice(0, 10);
const yearsAgo = years => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
};
const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const percent = (value, digits = 2) => Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—';
const money = value => Number.isFinite(value) ? `₹${value.toFixed(2)}` : '—';
const tone = value => !Number.isFinite(value) ? 'neutral' : value >= 75 ? 'strong' : value >= 60 ? 'positive' : value >= 45 ? 'watch' : 'risk';

async function requestSeries(payload) {
  const response = await fetch('/api/live/series', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store'
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.detail || data.error || 'Live NAV data failed.');
  return data;
}

async function validateAmfiCode(code) {
  const response = await fetch(`/api/live/code?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'AMFI code validation failed.');
  return data;
}

function alignChartRows(fund, proxy) {
  if (!fund.length || !proxy.length) return [];
  const fundBase = fund[0].nav;
  const proxyBase = proxy[0].nav;
  const proxyMap = new Map(proxy.map(point => [point.date, point.nav / proxyBase * 100]));
  const aligned = fund
    .filter(point => proxyMap.has(point.date))
    .map(point => ({ date: point.date, fund: point.nav / fundBase * 100, proxy: proxyMap.get(point.date) }));
  const step = Math.max(1, Math.ceil(aligned.length / 260));
  return aligned.filter((_, index) => index % step === 0 || index === aligned.length - 1);
}

function PerformanceChart({ fund, proxy, fundName, proxyName }) {
  const rows = useMemo(() => alignChartRows(fund, proxy), [fund, proxy]);
  if (rows.length < 2) return <div className="empty-chart">The live fund/proxy chart appears after both NAV series finish loading.</div>;
  const width = 980;
  const height = 300;
  const padding = 26;
  const values = rows.flatMap(row => [row.fund, row.proxy]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = key => rows.map((row, index) => {
    const x = padding + index / (rows.length - 1) * (width - padding * 2);
    const y = height - padding - (row[key] - min) / range * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <div className="performance-chart">
      <div className="chart-legend">
        <span><i className="fund-swatch" />{fundName}</span>
        <span><i className="proxy-swatch" />{proxyName}</span>
        <small>Normalised to 100</small>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Fund and selected proxy performance">
        <polyline className="proxy-line" points={points('proxy')} />
        <polyline className="fund-line" points={points('fund')} />
      </svg>
      <div className="chart-dates"><span>{rows[0].date}</span><span>{rows.at(-1).date}</span></div>
    </div>
  );
}

function ScoreRing({ value, label, sublabel }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="score-ring" style={{ '--score': `${safe * 3.6}deg` }}>
      <div>
        <strong>{Number.isFinite(value) ? Math.round(value) : '—'}</strong>
        <span>{label}</span>
        {sublabel ? <small>{sublabel}</small> : null}
      </div>
    </div>
  );
}

function FactorRow({ factorKey, factor }) {
  const weight = MOMENTUM_WEIGHTS[factorKey] || 0;
  const score = Number.isFinite(factor?.score) ? factor.score : 50;
  return (
    <article className="factor-row">
      <div className="factor-title">
        <strong>{FACTOR_LABELS[factorKey]}</strong>
        <span>{weight}% weight</span>
      </div>
      <div className="factor-bar"><i style={{ width: `${Math.max(0, Math.min(100, score))}%` }} /></div>
      <b className={tone(score)}>{Math.round(score)}</b>
      <p>{factor?.detail || (factor?.available ? 'Live factor available.' : 'Using a neutral provisional score because source coverage is incomplete.')}</p>
    </article>
  );
}

function MetricCard({ label, value, note, className = '' }) {
  return <article className={`metric-card ${className}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

export default function Home() {
  const [managerId, setManagerId] = useState(MANAGERS[0].id);
  const [managerSearch, setManagerSearch] = useState('');
  const [proxyMode, setProxyMode] = useState('official');
  const [activeTab, setActiveTab] = useState('racecard');
  const [startDate, setStartDate] = useState(yearsAgo(10));
  const [endDate, setEndDate] = useState(today());
  const [riskFree, setRiskFree] = useState(6.5);
  const [fundCodeInput, setFundCodeInput] = useState('');
  const [fundCode, setFundCode] = useState('');
  const [proxyCodeInput, setProxyCodeInput] = useState('');
  const [proxyCode, setProxyCode] = useState('');
  const [fundCodeStatus, setFundCodeStatus] = useState(null);
  const [proxyCodeStatus, setProxyCodeStatus] = useState(null);
  const [fundSeries, setFundSeries] = useState([]);
  const [proxySeries, setProxySeries] = useState([]);
  const [fundSource, setFundSource] = useState(null);
  const [proxySource, setProxySource] = useState(null);
  const [navState, setNavState] = useState('idle');
  const [navMessage, setNavMessage] = useState('Preparing live fund and proxy data.');
  const [momentumState, setMomentumState] = useState('idle');
  const [momentumData, setMomentumData] = useState(null);
  const [momentumMessage, setMomentumMessage] = useState('Preparing sector, stock and cycle data.');
  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const manager = getManagerById(managerId);
  const scheme = getSchemeById(manager.schemeId);
  const standardProxy = scheme.proxies[proxyMode === 'custom' ? 'official' : proxyMode] || scheme.proxies.official;
  const analysisStart = manager.startDate && manager.startDate > startDate ? manager.startDate : startDate;
  const proxyName = proxyMode === 'custom'
    ? proxyCodeStatus?.schemeName || (proxyCode ? `AMFI scheme ${proxyCode}` : 'Custom proxy')
    : standardProxy.label;
  const snapshot = momentumData?.snapshot || getMomentumSnapshot(scheme.id);
  const cycleProfile = CYCLE_PROFILES[scheme.id];

  const visibleManagers = useMemo(() => {
    const query = managerSearch.trim().toLowerCase();
    if (!query) return MANAGERS;
    return MANAGERS.filter(item => [item.name, item.amc, item.role, item.style].join(' ').toLowerCase().includes(query));
  }, [managerSearch]);

  const traditionalMetrics = useMemo(
    () => computeMetrics(fundSeries, proxySeries, riskFree),
    [fundSeries, proxySeries, riskFree]
  );

  const score = useMemo(() => calculateManagerScore({
    schemeId: scheme.id,
    snapshot,
    market: momentumData,
    traditional: traditionalMetrics
  }), [scheme.id, snapshot, momentumData, traditionalMetrics]);

  const validateCode = async kind => {
    const value = kind === 'fund' ? fundCodeInput : proxyCodeInput;
    const setStatus = kind === 'fund' ? setFundCodeStatus : setProxyCodeStatus;
    const setApplied = kind === 'fund' ? setFundCode : setProxyCode;
    if (!validCode(value)) {
      setStatus({ error: 'Enter a 4–9 digit AMFI scheme code.' });
      return;
    }
    setStatus({ loading: true });
    try {
      const data = await validateAmfiCode(value);
      setStatus(data);
      setApplied(value.trim());
      if (kind === 'proxy') setProxyMode('custom');
    } catch (error) {
      setStatus({ error: error.message });
    }
  };

  const loadNavData = useCallback(async ({ silent = false } = {}) => {
    if (proxyMode === 'custom' && !validCode(proxyCode)) {
      setNavState('idle');
      setNavMessage('Validate the custom proxy AMFI code before loading. No repeated request will be sent.');
      return;
    }
    if (!silent) setNavState('syncing');
    setNavMessage('Loading live MFapi NAV histories and validating scheme identity through AMFI…');
    try {
      const fundPayload = fundCode
        ? { schemeCode: fundCode, startDate: analysisStart, endDate }
        : { queries: scheme.schemeQueries, startDate: analysisStart, endDate };
      const fundResultPromise = requestSeries(fundPayload);
      let proxyResultPromise;
      if (proxyMode === 'custom') {
        proxyResultPromise = requestSeries({ schemeCode: proxyCode, startDate: analysisStart, endDate })
          .then(result => ({ result, series: normaliseSeries(result.data) }));
      } else {
        proxyResultPromise = Promise.all(standardProxy.components.map(component => requestSeries({
          queries: component.queries,
          startDate: analysisStart,
          endDate
        }))).then(results => ({
          result: results[0],
          results,
          series: buildSyntheticProxy(
            results.map(result => normaliseSeries(result.data)),
            standardProxy.components.map(component => component.weight)
          )
        }));
      }
      const [fundResult, proxyBundle] = await Promise.all([fundResultPromise, proxyResultPromise]);
      const fund = normaliseSeries(fundResult.data);
      const proxy = proxyBundle.series;
      if (fund.length < 3 || proxy.length < 3) throw new Error('The live sources returned insufficient overlapping NAV history.');
      setFundSeries(fund);
      setProxySeries(proxy);
      setFundSource(fundResult.source);
      setProxySource(proxyBundle.result?.source || proxyBundle.results?.map(item => item.source));
      setNavState('ready');
      setNavMessage('Fund and proxy histories loaded successfully.');
      setLastRefresh(new Date());
    } catch (error) {
      setNavState(fundSeries.length && proxySeries.length ? 'degraded' : 'error');
      setNavMessage(`${fundSeries.length && proxySeries.length ? 'Last valid chart retained. ' : ''}${error.message}`);
    }
  }, [proxyMode, proxyCode, fundCode, analysisStart, endDate, scheme, standardProxy, fundSeries.length, proxySeries.length]);

  const loadMomentumData = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setMomentumState('syncing');
    setMomentumMessage('Pulling live sector indices, holdings and exit-window prices from Yahoo Finance…');
    try {
      const response = await fetch(`/api/momentum?schemeId=${encodeURIComponent(scheme.id)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Momentum data failed.');
      setMomentumData(data);
      setMomentumState(data.coverage?.resolvedPct >= 60 ? 'ready' : 'degraded');
      setMomentumMessage(`Momentum data resolved for ${Math.round(data.coverage?.resolvedPct || 0)}% of requested market symbols.`);
      setLastRefresh(new Date());
    } catch (error) {
      setMomentumState(momentumData ? 'degraded' : 'error');
      setMomentumMessage(`${momentumData ? 'Last valid momentum dataset retained. ' : ''}${error.message}`);
    }
  }, [scheme.id, momentumData]);

  const refreshAll = useCallback(async ({ silent = false } = {}) => {
    await Promise.all([loadNavData({ silent }), loadMomentumData({ silent })]);
  }, [loadNavData, loadMomentumData]);

  useEffect(() => {
    const timer = setTimeout(() => refreshAll({ silent: true }), 250);
    return () => clearTimeout(timer);
  }, [managerId, proxyMode, proxyCode, fundCode, analysisStart, endDate]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshAll({ silent: true });
    }, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, refreshAll]);

  const momentumFactorKeys = ['sectorBias', 'sectorMomentum', 'entryTiming', 'exitTiming', 'exitPeakProximity', 'turnoverEfficiency', 'cycleFit'];
  const traditionalFactorKeys = ['alphaInformationRatio', 'sharpeDownside', 'drawdownControl', 'persistence', 'managerValueAdd'];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">ML</span><div><strong>ManagerLens</strong><small>Momentum-first manager intelligence</small></div></div>
        <div className="top-actions">
          <button className="ghost-button" onClick={() => setAutoRefresh(value => !value)}>{autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off'}</button>
          <button className="primary-button" onClick={() => refreshAll()} disabled={navState === 'syncing' || momentumState === 'syncing'}>Refresh live data</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="manager-rail">
          <div className="rail-head"><div><span>Verified field</span><h2>Fund managers</h2></div><b>{visibleManagers.length}</b></div>
          <input className="manager-search" value={managerSearch} onChange={event => setManagerSearch(event.target.value)} placeholder="Search manager, AMC or role" />
          <div className="manager-list">
            {visibleManagers.map(item => (
              <button key={item.id} className={item.id === managerId ? 'active' : ''} onClick={() => { setManagerId(item.id); setActiveTab('racecard'); }}>
                <span className="avatar">{item.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('')}</span>
                <span><strong>{item.name}</strong><small>{item.role}</small><em>{item.amc}</em></span>
              </button>
            ))}
          </div>
        </aside>

        <main className="main-panel">
          <section className="manager-hero">
            <div>
              <span className="eyebrow">{manager.amc}</span>
              <h1>{manager.name}</h1>
              <p>{manager.role} · {manager.startLabel}</p>
              <div className="decision-tags">{manager.decisions.map(item => <span key={item}>{item}</span>)}</div>
            </div>
            <div className="horse-card">
              <span>Horse type</span>
              <strong>{cycleProfile?.label || 'Unclassified runner'}</strong>
              <p>Current track: {momentumData?.regime?.label || 'loading'}.</p>
              <b className={score.horse.tone}>{score.horse.label}</b>
              <small>{score.horse.action}</small>
            </div>
          </section>

          <section className="status-grid">
            <article className={navState}><span>Fund & proxy NAV</span><strong>{navState}</strong><p>{navMessage}</p></article>
            <article className={momentumState}><span>Momentum feed</span><strong>{momentumState}</strong><p>{momentumMessage}</p></article>
            <article><span>Last refresh</span><strong>{lastRefresh ? lastRefresh.toLocaleTimeString() : 'Pending'}</strong><p>Automatic refresh runs every 15 minutes while the page is visible.</p></article>
          </section>

          <section className="score-deck">
            <ScoreRing value={score.overall} label="Overall" sublabel="75 / 25 model" />
            <ScoreRing value={score.momentumScore} label="Momentum" sublabel="75% weight" />
            <ScoreRing value={score.traditionalScore} label="Traditional" sublabel="25% weight" />
            <div className="score-summary">
              <span className="eyebrow">Current market cycle</span>
              <h2>{momentumData?.regime?.label || 'Awaiting live market data'}</h2>
              <p>{momentumData?.regime?.explanation || 'The track condition is calculated from live broad-market momentum and cross-sector dispersion.'}</p>
              <div><b>Data coverage</b><strong>{Math.round(score.coveragePct)}%</strong></div>
            </div>
          </section>

          <section className="control-deck">
            <div className="proxy-control">
              <label>Comparison proxy</label>
              <div className="segmented-control">
                {PROXY_MODES.map(mode => <button key={mode} className={proxyMode === mode ? 'active' : ''} onClick={() => setProxyMode(mode)}>{mode}</button>)}
              </div>
              {proxyMode === 'custom' ? (
                <div className="code-control">
                  <input inputMode="numeric" value={proxyCodeInput} onChange={event => setProxyCodeInput(event.target.value.replace(/\D/g, ''))} placeholder="Custom proxy AMFI code" />
                  <button onClick={() => validateCode('proxy')}>Validate & apply</button>
                  <small className={proxyCodeStatus?.error ? 'risk' : 'positive'}>{proxyCodeStatus?.schemeName || proxyCodeStatus?.error || 'No request is sent until the code validates.'}</small>
                </div>
              ) : <p><strong>{standardProxy.label}</strong><span>{standardProxy.description}</span></p>}
            </div>
            <div className="fund-code-control">
              <label>Optional direct fund AMFI code</label>
              <div className="code-control">
                <input inputMode="numeric" value={fundCodeInput} onChange={event => setFundCodeInput(event.target.value.replace(/\D/g, ''))} placeholder="Leave blank for automatic resolution" />
                <button onClick={() => validateCode('fund')}>Apply</button>
                <button className="secondary" onClick={() => { setFundCodeInput(''); setFundCode(''); setFundCodeStatus(null); }}>Clear</button>
                <small className={fundCodeStatus?.error ? 'risk' : 'positive'}>{fundCodeStatus?.schemeName || fundCodeStatus?.error || scheme.name}</small>
              </div>
            </div>
          </section>

          <section className="date-controls">
            <label>From<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
            <label>Manager-aware start<input type="date" value={analysisStart} readOnly /></label>
            <label>To<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
            <label>Risk-free rate %<input type="number" value={riskFree} step="0.1" onChange={event => setRiskFree(Number(event.target.value))} /></label>
          </section>

          <nav className="tabbar">{TABS.map(tab => <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}</nav>

          {activeTab === 'racecard' && (
            <section className="tab-content">
              <PerformanceChart fund={fundSeries} proxy={proxySeries} fundName={fundSource?.schemeName || scheme.name} proxyName={proxyName} />
              <div className="factor-grid">
                {momentumFactorKeys.map(key => <FactorRow key={key} factorKey={key} factor={score.factors[key]} />)}
              </div>
              <div className="insight-panel">
                <span className="eyebrow">Race steward notes</span>
                {score.insights.map((insight, index) => <p key={index}>• {insight}</p>)}
              </div>
            </section>
          )}

          {activeTab === 'sectors' && (
            <section className="tab-content">
              <div className="section-heading"><div><span className="eyebrow">Sector positioning</span><h2>Was the manager in the right sectors at the right time?</h2></div><b>{snapshot?.factsheetLabel}</b></div>
              <div className="sector-table-wrap">
                <table><thead><tr><th>Sector</th><th>Fund weight</th><th>1M</th><th>3M</th><th>6M</th><th>Latest allocation move</th></tr></thead><tbody>
                  {(momentumData?.sectors || snapshot?.sectorWeights || []).map(item => {
                    const history = snapshot?.sectorHistory?.find(row => row.sector === item.sector)?.values || [];
                    const change = history.length >= 2 ? history.at(-1) - history.at(-2) : undefined;
                    return <tr key={item.sector}><td>{item.sector}</td><td>{percent(item.weight)}</td><td>{percent(item.return1mPct)}</td><td className={tone(50 + (item.return3mPct || 0) * 2)}>{percent(item.return3mPct)}</td><td>{percent(item.return6mPct)}</td><td>{Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)} pp` : 'Current snapshot only'}</td></tr>;
                  })}
                </tbody></table>
              </div>
              <div className="holding-grid">
                {(momentumData?.holdings || []).map(item => <article key={item.name}><span>{item.sector}</span><strong>{item.name}</strong><small>{percent(item.weight)} portfolio weight</small><div><b>3M {percent(item.return3mPct)}</b><b>6M {percent(item.return6mPct)}</b></div></article>)}
              </div>
            </section>
          )}

          {activeTab === 'timing' && (
            <section className="tab-content">
              <div className="section-heading"><div><span className="eyebrow">Trade timing</span><h2>Entries, exits and peak proximity</h2></div><b>Approximate monthly disclosure dates</b></div>
              <div className="timing-columns">
                <div><h3>Entries</h3>{(momentumData?.entries || []).length ? momentumData.entries.map(item => <article className="event-card" key={item.name}><div><strong>{item.name}</strong><span>{item.sector}</span></div><b className={item.ok ? tone(50 + (item.returnSinceEventPct || 0) * 2) : 'neutral'}>{item.ok ? percent(item.returnSinceEventPct) : 'Unresolved'}</b><p>{item.ok ? `Approximate entry price ${number(item.eventPrice)} on ${item.eventPriceDate}; ${percent(item.peakProximityPct)} of the local peak.` : item.error}</p></article>) : <div className="coverage-note">This factsheet does not disclose a monthly entry list. The factor stays neutral and lowers coverage.</div>}</div>
                <div><h3>Exits</h3>{(momentumData?.exits || []).length ? momentumData.exits.map(item => <article className="event-card" key={item.name}><div><strong>{item.name}</strong><span>{item.sector}</span></div><b className={item.ok ? tone(50 - (item.postEventReturnPct || 0) * 2) : 'neutral'}>{item.ok ? `${percent(item.peakProximityPct)} of peak` : 'Unresolved'}</b><p>{item.ok ? `Post-exit move ${percent(item.postEventReturnPct)} from approximate exit price ${number(item.eventPrice)} on ${item.eventPriceDate}.` : item.error}</p></article>) : <div className="coverage-note">This factsheet does not disclose a monthly exit list. The factor stays neutral and lowers coverage.</div>}</div>
              </div>
              <div className="turnover-panel"><div><span>Equity turnover</span><strong>{percent(snapshot?.turnover?.equityPct)}</strong></div><div><span>Total turnover</span><strong>{percent(snapshot?.turnover?.totalPct)}</strong></div><div><span>Turnover score</span><strong>{Math.round(score.factors.turnoverEfficiency.score)}</strong></div><p>{snapshot?.turnover?.interpretation}. {score.factors.turnoverEfficiency.detail}</p></div>
            </section>
          )}

          {activeTab === 'traditional' && (
            <section className="tab-content">
              <div className="section-heading"><div><span className="eyebrow">Traditional quality</span><h2>The remaining 25% of the score</h2></div><b>Proxy-dependent</b></div>
              <div className="traditional-metrics">
                <MetricCard label="CAGR" value={percent(traditionalMetrics.cagrPct)} note="Manager-aware period" />
                <MetricCard label="Annual alpha" value={percent(traditionalMetrics.alphaPct)} note="Jensen-style alpha" />
                <MetricCard label="Information ratio" value={number(traditionalMetrics.informationRatio)} note="Active return per unit of tracking error" />
                <MetricCard label="Sharpe ratio" value={number(traditionalMetrics.sharpe)} note="Total-risk efficiency" />
                <MetricCard label="Downside capture" value={percent(traditionalMetrics.downCapturePct)} note="Below 100 indicates protection" />
                <MetricCard label="Maximum drawdown" value={percent(traditionalMetrics.maxDrawdownPct)} note="Worst peak-to-trough NAV decline" />
                <MetricCard label="Alpha persistence" value={Number.isFinite(traditionalMetrics.alphaPersistenceScore) ? `${Math.round(traditionalMetrics.alphaPersistenceScore)}/100` : '—'} note="Four-window consistency" />
                <MetricCard label="Manager value-add" value={money(traditionalMetrics.managerValueAddNav)} note="Ending NAV difference versus selected proxy" />
              </div>
              <div className="factor-grid compact">{traditionalFactorKeys.map(key => <FactorRow key={key} factorKey={key} factor={score.factors[key]} />)}</div>
            </section>
          )}

          {activeTab === 'sources' && (
            <section className="tab-content">
              <div className="section-heading"><div><span className="eyebrow">Data provenance</span><h2>Only the agreed source lanes</h2></div><b>{Math.round(momentumData?.coverage?.resolvedPct || 0)}% live symbol resolution</b></div>
              <div className="source-grid">
                {(momentumData?.sources || [
                  { name: snapshot?.factsheetLabel, type: 'Official AMC factsheet', url: snapshot?.factsheetUrl, asOf: snapshot?.asOf },
                  { name: 'Yahoo Finance', type: 'Live stock and sector histories', asOf: 'live' },
                  { name: 'MFapi.in / AMFI', type: 'Fund and proxy NAV data', asOf: 'live' }
                ]).map(source => <article key={`${source.name}-${source.type}`}><span>{source.type}</span><strong>{source.name}</strong><small>As of {source.asOf}</small>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">Open source</a> : null}</article>)}
              </div>
              <div className="coverage-note">{snapshot?.coverageNote}</div>
              <div className="methodology-card"><h3>Score construction</h3><p>Momentum and timing factors carry 75%. Traditional risk/return factors carry 25%. Missing monthly portfolio-change data is not invented: the affected factor receives a neutral provisional score and the data-coverage percentage falls.</p><pre>{JSON.stringify(MOMENTUM_WEIGHTS, null, 2)}</pre></div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
