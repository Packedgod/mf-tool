'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import useManagerAnalytics from '@/components/analytics/useDisplayedManagerAnalytics';
import AnalyticsTabs, { TABS } from '@/components/analytics/AnalyticsTabs';
import { HeadlineScoreCard } from '@/components/analytics/AnalyticsPanels';
import InvestorProfilePanel from '@/components/analytics/InvestorProfilePanel';

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

function matchedAmfiCode(fund, query) {
  const code = String(query || '').match(/\d{4,9}/)?.[0];
  return fund.variants?.find(variant => String(variant.schemeCode) === code)?.schemeCode || fund.preferredSchemeCode;
}

function UnifiedSearch({ query, setQuery, open, setOpen, state, message, results, onSelect }) {
  const rootRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const options = useMemo(() => {
    const funds = (results.funds || []).map(item => ({ type: 'fund', item, key: `fund-${item.id}` }));
    const managers = (results.managers || []).map(item => ({ type: 'manager', item, key: `manager-${item.id}` }));
    const normalized = query.trim().toLowerCase();
    const managerFirst = managers.some(option => String(option.item.name || '').toLowerCase().startsWith(normalized));
    return managerFirst ? [...managers, ...funds] : [...funds, ...managers];
  }, [query, results]);

  useEffect(() => setActiveIndex(0), [query, options.length]);
  useEffect(() => {
    const close = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [setOpen]);

  const choose = option => {
    if (option) onSelect(option.type, option.item);
  };
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open || !options.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(index => (index + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => (index - 1 + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[activeIndex]);
    }
  };

  return (
    <div className="unified-search" ref={rootRef}>
      <div className={`unified-search-field ${open ? 'open' : ''}`}>
        <span className="unified-search-label">Search</span>
        <input
          value={query}
          onChange={event => { setQuery(event.target.value); setOpen(true); }}
          onFocus={event => { setOpen(true); event.currentTarget.select(); }}
          onKeyDown={onKeyDown}
          placeholder="Fund, manager, AMC or AMFI code"
          role="combobox"
          aria-label="Search funds, managers, AMCs or AMFI scheme codes"
          aria-expanded={open}
          aria-controls="unified-search-results"
          aria-activedescendant={open && options[activeIndex] ? `unified-${options[activeIndex].key}` : undefined}
          autoComplete="off"
        />
        <small>Names or AMFI codes</small>
        {query ? <button type="button" className="unified-search-clear" onClick={() => { setQuery(''); setOpen(true); }} aria-label="Clear unified search">×</button> : null}
      </div>
      {open ? (
        <div className={`unified-search-results ${state}`} id="unified-search-results" role="listbox">
          <div className="unified-search-status"><span>{state === 'selecting' ? 'Opening' : state}</span><p>{message}</p></div>
          {options.length ? <div className="unified-search-options">{options.map((option, index) => {
            const isFund = option.type === 'fund';
            const item = option.item;
            return (
              <button
                type="button"
                id={`unified-${option.key}`}
                key={option.key}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'active' : ''}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={event => event.preventDefault()}
                onClick={() => choose(option)}
              >
                <b>{isFund ? 'Fund' : 'Manager'}</b>
                <span><strong>{isFund ? item.displayName : item.name}</strong><small>{isFund ? `${item.fundHouse} · ${item.category}` : `${item.amc} · ${item.role || 'Fund manager'}`}</small></span>
                <em>{isFund ? `AMFI ${matchedAmfiCode(item, query)}` : `${item.schemeAliases?.length || 0} mapped funds`}</em>
              </button>
            );
          })}</div> : null}
          {options.length ? <div className="unified-search-totals">Showing {options.length} of {(results.totalFunds || 0) + (results.totalManagers || 0)} matches · Use ↑ ↓ and Enter</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AllManagerAnalyticsApp({ initialManagerName = '', initialAmfiCode = '' }) {
  const data = useManagerAnalytics({ initialManagerName, initialAmfiCode });
  const {
    managers, manager, managerId, setManagerId, filteredManagers,
    unifiedSearch, setUnifiedSearch, unifiedSearchOpen, setUnifiedSearchOpen,
    unifiedSearchState, unifiedSearchMessage, unifiedResults, selectUnifiedResult,
    managerState, managerMessage, exactFunds, amcFunds, selectedFund, selectedFundId, setSelectedFundId,
    fundState, exactAssignment, proxyMode, setProxyMode, proxyCodeInput, setProxyCodeInput,
    proxyCodeStatus, validateProxyCode, selectedProxy, activeTab, setActiveTab,
    startDate, setStartDate, endDate, setEndDate, riskFree, setRiskFree,
    navState, navMessage, momentumState, momentumMessage, peerState, peerMessage, lastRefresh,
    autoRefresh, setAutoRefresh, score, refreshAll,
    investorProfile, setInvestorProfile
  } = data;

  return (
    <div className="all-manager-app">
      <header className="topbar full-topbar">
        <div className="brand"><span className="brand-mark">ML</span><div><strong>ManagerLens</strong><small>India-wide manager and fund intelligence</small></div></div>
        <UnifiedSearch
          query={unifiedSearch}
          setQuery={setUnifiedSearch}
          open={unifiedSearchOpen}
          setOpen={setUnifiedSearchOpen}
          state={unifiedSearchState}
          message={unifiedSearchMessage}
          results={unifiedResults}
          onSelect={selectUnifiedResult}
        />
        <div className="top-actions">
          <span className={`registry-state ${managerState}`}>{managerState === 'ready' ? `${managers.length} managers` : managerState}</span>
          <button className="ghost-button" onClick={() => setAutoRefresh(value => !value)}>{autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off'}</button>
          <button className="primary-button" onClick={() => refreshAll()} disabled={!selectedFund || navState === 'syncing'}>Refresh live data</button>
        </div>
      </header>

      <div className="workspace full-workspace">
        <aside className="manager-rail full-manager-rail">
          <div className="rail-head"><div><span>Indian manager universe</span><h2>Fund managers</h2></div><b>{filteredManagers.length}</b></div>
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
            <article className={momentumState}><span>Portfolio evidence</span><strong>{momentumState}</strong><p>{momentumMessage}</p></article>
            <article className={peerState}><span>Peer benchmark</span><strong>{peerState || 'idle'}</strong><p>{peerMessage}</p></article>
            <article><span>Last refresh</span><strong>{lastRefresh ? lastRefresh.toLocaleTimeString() : 'Pending'}</strong><p>Automatic refresh runs every 15 minutes while visible.</p></article>
          </section>

          <section className="score-deck score-deck-v2">
            <HeadlineScoreCard headline={score.headlines.fundQuality} />
            <HeadlineScoreCard headline={score.headlines.currentOpportunity} />
            <HeadlineScoreCard headline={score.headlines.investorFit} />
            <HeadlineScoreCard headline={{ ...score.headlines.dataConfidence, label: 'Data Confidence' }} />
          </section>
          <InvestorProfilePanel profile={investorProfile} onChange={setInvestorProfile} />

          <section className="scoring-standard-note">
            <div><span className="eyebrow">ManagerLens methodology 2.1</span><h2>Peer-relative, confidence-shrunk and honest about missing evidence</h2></div>
            <p><strong>50 means category median or no demonstrated edge.</strong> Missing evidence is shown as <b>Not Rated</b>, never converted to 50. Fund Quality is withheld below 70% of required factor weight, Current Opportunity below 60%, and every factor states the share of evidence behind it.</p>
            <div><span>{score.model.label}</span><span>{score.peerContext?.peerCount || 0} usable peers</span><span>{score.recommendation.score === null ? score.recommendation.detail : `Recommendation ${Math.round(score.recommendation.score)}/100`}</span></div>
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
