'use client';

import useManagerAnalytics from '@/components/analytics/useDisplayedManagerAnalytics';
import AnalyticsTabs, { TABS } from '@/components/analytics/AnalyticsTabs';
import { ScoreRing } from '@/components/analytics/AnalyticsPanels';

const PROXY_MODES = ['official', 'category', 'broad', 'defensive', 'custom'];

function initials(value) {
  return String(value || 'MF').split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase();
}

function FundSelector({ exactFunds, amcFunds, selectedFundId, onChange, loading }) {
  const exactIds = new Set(exactFunds.map(item => item.id));
  const fallback = amcFunds.filter(item => !exactIds.has(item.id));
  return (
    <label className="fund-selector">
      <span>Fund managed / analysed</span>
      <select value={selectedFundId || ''} onChange={event => onChange(event.target.value)} disabled={loading || (!exactFunds.length && !fallback.length)}>
        {!selectedFundId ? <option value="">Select a fund</option> : null}
        {exactFunds.length ? <optgroup label="Verified manager assignments">{exactFunds.map(fund => <option key={fund.id} value={fund.id}>{fund.displayName}</option>)}</optgroup> : null}
        {fallback.length ? <optgroup label="Other funds from the same AMC — verify assignment">{fallback.map(fund => <option key={fund.id} value={fund.id}>{fund.displayName}</option>)}</optgroup> : null}
      </select>
      <small>{exactFunds.length ? `${exactFunds.length} officially mapped fund ${exactFunds.length === 1 ? 'family' : 'families'}.` : 'No exact scheme assignment is ingested yet. Same-AMC funds remain selectable but are visibly marked as unverified assignments.'}</small>
    </label>
  );
}

export default function AllManagerAnalyticsApp({ initialManagerName = '', initialAmfiCode = '' }) {
  const data = useManagerAnalytics({ initialManagerName, initialAmfiCode });
  const {
    managers, manager, managerId, setManagerId, managerSearch, setManagerSearch, filteredManagers,
    managerState, managerMessage, exactFunds, amcFunds, selectedFund, selectedFundId, setSelectedFundId,
    fundState, exactAssignment, proxyMode, setProxyMode, proxyCodeInput, setProxyCodeInput,
    proxyCodeStatus, validateProxyCode, selectedProxy, activeTab, setActiveTab,
    startDate, setStartDate, endDate, setEndDate, riskFree, setRiskFree,
    navState, navMessage, momentumData, momentumState, momentumMessage, lastRefresh,
    autoRefresh, setAutoRefresh, score, provisional, refreshAll
  } = data;

  return (
    <div className="all-manager-app">
      <header className="topbar full-topbar">
        <div className="brand"><span className="brand-mark">ML</span><div><strong>ManagerLens</strong><small>India-wide manager and fund intelligence</small></div></div>
        <div className="top-actions">
          <span className={`registry-state ${managerState}`}>{managerState === 'ready' ? `${managers.length} managers` : managerState}</span>
          <button className="ghost-button" onClick={() => setAutoRefresh(value => !value)}>{autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off'}</button>
          <button className="primary-button" onClick={() => refreshAll()} disabled={!selectedFund || navState === 'syncing'}>Refresh live data</button>
        </div>
      </header>

      <div className="workspace full-workspace">
        <aside className="manager-rail full-manager-rail">
          <div className="rail-head"><div><span>Indian manager universe</span><h2>Fund managers</h2></div><b>{filteredManagers.length}</b></div>
          <input className="manager-search" value={managerSearch} onChange={event => setManagerSearch(event.target.value)} placeholder="Search manager, AMC or fund" />
          <p className={`manager-load-note ${managerState}`}>{managerMessage}</p>
          <div className="manager-list">
            {filteredManagers.map(item => (
              <button key={item.id} className={item.id === managerId ? 'active' : ''} onClick={() => setManagerId(item.id)}>
                <span className="avatar">{initials(item.name)}</span>
                <span><strong>{item.name}</strong><small>{item.role || 'Fund manager'}</small><em>{item.amc}</em></span>
                {item.schemeAliases?.length ? <i className="verified-mark">✓</i> : null}
              </button>
            ))}
          </div>
        </aside>

        <main className="main-panel full-main-panel">
          <section className="manager-hero">
            <div className="manager-identity">
              <span className="eyebrow">{manager?.amc || 'Loading manager'}</span>
              <h1>{manager?.name || 'ManagerLens'}</h1>
              <p>{manager?.role || 'Select a manager from the Indian market directory.'}</p>
              <div className="decision-tags">{(manager?.decisions || []).map(item => <span key={item}>{item}</span>)}</div>
            </div>
            <div className="manager-fund-panel">
              <FundSelector exactFunds={exactFunds} amcFunds={amcFunds} selectedFundId={selectedFundId} onChange={setSelectedFundId} loading={fundState === 'loading'} />
              <div className={`assignment-badge ${exactAssignment ? 'verified' : 'pending'}`}>
                <strong>{exactAssignment ? 'Verified manager–fund assignment' : 'AMC fund selected — assignment verification pending'}</strong>
                <small>{selectedFund ? `AMFI ${selectedFund.preferredSchemeCode} · ${selectedFund.category}` : 'Choose a fund to begin.'}</small>
              </div>
            </div>
          </section>

          <section className="status-grid">
            <article className={navState}><span>Fund & proxy NAV</span><strong>{navState}</strong><p>{navMessage}</p></article>
            <article className={momentumState}><span>Momentum coverage</span><strong>{momentumState}</strong><p>{momentumMessage}</p></article>
            <article><span>Last refresh</span><strong>{lastRefresh ? lastRefresh.toLocaleTimeString() : 'Pending'}</strong><p>Automatic refresh runs every 15 minutes while visible.</p></article>
          </section>

          <section className="score-deck">
            <ScoreRing value={score.overall} label="Overall" sublabel="75 / 25 model" provisional={provisional} />
            <ScoreRing value={score.momentumScore} label="Momentum" sublabel="75% weight" provisional={provisional} />
            <ScoreRing value={score.traditionalScore} label="Traditional" sublabel="25% weight" provisional={!data.fundSeries.length} />
            <div className="score-summary">
              <span className="eyebrow">{provisional ? 'Provisional score' : 'Current market-cycle score'}</span>
              <h2>{momentumData?.regime?.label || selectedFund?.category || 'Select a fund'}</h2>
              <p>{provisional ? 'The manager and fund are included, but the 75% portfolio-timing block is not complete until official holdings and transaction disclosures are normalised.' : momentumData?.regime?.explanation}</p>
              <div><b>Factor coverage</b><strong>{Math.round(score.coveragePct)}%</strong></div>
            </div>
          </section>

          <section className="control-deck">
            <div className="proxy-control">
              <label>Comparison proxy</label>
              <div className="segmented-control">{PROXY_MODES.map(mode => <button key={mode} className={proxyMode === mode ? 'active' : ''} onClick={() => setProxyMode(mode)}>{mode}</button>)}</div>
              {proxyMode === 'custom' ? (
                <div className="code-control">
                  <input inputMode="numeric" value={proxyCodeInput} onChange={event => setProxyCodeInput(event.target.value.replace(/\D/g, ''))} placeholder="Custom proxy AMFI code" />
                  <button onClick={validateProxyCode}>{proxyCodeStatus?.loading ? 'Validating…' : 'Validate & apply'}</button>
                  <small className={proxyCodeStatus?.error ? 'risk' : 'positive'}>{proxyCodeStatus?.schemeName || proxyCodeStatus?.error || 'No request is sent until the code validates.'}</small>
                </div>
              ) : <p><strong>{selectedProxy?.label || 'Select a fund'}</strong><span>{selectedProxy?.description}</span></p>}
            </div>
            <div className="selected-fund-summary">
              <label>Current analysis target</label>
              <strong>{selectedFund?.displayName || 'No fund selected'}</strong>
              <span>{selectedFund?.fundHouse}</span>
              <small>{selectedFund ? `${selectedFund.variants?.length || 0} AMFI plan and option variants grouped under this fund family.` : ''}</small>
            </div>
          </section>

          <section className="date-controls">
            <label>From<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
            <label>To<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
            <label>Risk-free rate %<input type="number" value={riskFree} step="0.1" onChange={event => setRiskFree(Number(event.target.value))} /></label>
          </section>

          <nav className="tabbar">{TABS.map(([id, label]) => <button key={id} className={activeTab === id ? 'active' : ''} onClick={() => setActiveTab(id)}>{label}</button>)}</nav>
          <AnalyticsTabs data={data} />
        </main>
      </div>
    </div>
  );
}
