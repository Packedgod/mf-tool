'use client';

import {
  FactorRow,
  MetricCard,
  MOMENTUM_KEYS,
  TRADITIONAL_KEYS,
  PerformanceChart,
  money,
  num,
  pct,
  scoreTone
} from '@/components/analytics/AnalyticsPanels';

export const TABS = [
  ['racecard', 'Racecard'],
  ['sectors', 'Sector track'],
  ['timing', 'Entry / exit timing'],
  ['traditional', 'Traditional 25%'],
  ['sources', 'Sources']
];

export default function AnalyticsTabs({ data }) {
  const {
    activeTab, score, fundSeries, proxySeries, fundSource, selectedFund, proxyName,
    momentumData, metrics, manager, exactAssignment
  } = data;
  const sourceList = [manager?.source, ...(manager?.additionalSources || [])].filter(item => item?.url);
  const sectors = momentumData?.sectors || momentumData?.snapshot?.sectorWeights || [];
  const entries = momentumData?.entries || [];
  const exits = momentumData?.exits || [];

  if (activeTab === 'racecard') {
    return (
      <section className="tab-content">
        <PerformanceChart fund={fundSeries} proxy={proxySeries} fundName={fundSource?.schemeName || selectedFund?.displayName || 'Fund'} proxyName={proxyName || 'Proxy'} />
        <div className="factor-grid">{MOMENTUM_KEYS.map(key => <FactorRow key={key} factorKey={key} factor={score.factors[key]} />)}</div>
        <div className="insight-panel"><span className="eyebrow">Race steward notes</span>{score.insights.map((item, index) => <p key={index}>• {item}</p>)}</div>
      </section>
    );
  }

  if (activeTab === 'sectors') {
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Sector positioning</span><h2>Was the manager in the right sectors at the right time?</h2></div><b>{momentumData?.snapshot?.factsheetLabel || 'Awaiting normalised official factsheet'}</b></div>
        {sectors.length ? (
          <div className="sector-table-wrap"><table><thead><tr><th>Sector</th><th>Fund weight</th><th>1M</th><th>3M</th><th>6M</th></tr></thead><tbody>{sectors.map(item => <tr key={item.sector}><td>{item.sector}</td><td>{pct(item.weight)}</td><td>{pct(item.return1mPct)}</td><td>{pct(item.return3mPct)}</td><td>{pct(item.return6mPct)}</td></tr>)}</tbody></table></div>
        ) : <div className="coverage-note">This fund is live in the universe, but its holdings and sector tables have not yet passed the official-factsheet normalisation checks. No sector information is invented.</div>}
        <div className="holding-grid">{(momentumData?.holdings || []).map(item => <article key={item.name}><span>{item.sector}</span><strong>{item.name}</strong><small>{pct(item.weight)} portfolio weight</small><div><b>3M {pct(item.return3mPct)}</b><b>6M {pct(item.return6mPct)}</b></div></article>)}</div>
      </section>
    );
  }

  if (activeTab === 'timing') {
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Trade timing</span><h2>Entries, exits and peak proximity</h2></div><b>Official monthly disclosures only</b></div>
        <div className="timing-columns">
          <div><h3>Entries</h3>{entries.length ? entries.map(item => <article className="event-card" key={item.name}><div><strong>{item.name}</strong><span>{item.sector}</span></div><b className={item.ok ? scoreTone(50 + (item.returnSinceEventPct || 0) * 2) : 'neutral'}>{item.ok ? pct(item.returnSinceEventPct) : 'Unresolved'}</b><p>{item.ok ? `Approximate entry price ${num(item.eventPrice)} on ${item.eventPriceDate}; ${pct(item.peakProximityPct)} of the local peak.` : item.error}</p></article>) : <div className="coverage-note">No verified monthly entry list is available for this manager–fund selection yet.</div>}</div>
          <div><h3>Exits</h3>{exits.length ? exits.map(item => <article className="event-card" key={item.name}><div><strong>{item.name}</strong><span>{item.sector}</span></div><b className={item.ok ? scoreTone(50 - (item.postEventReturnPct || 0) * 2) : 'neutral'}>{item.ok ? `${pct(item.peakProximityPct)} of peak` : 'Unresolved'}</b><p>{item.ok ? `Post-exit move ${pct(item.postEventReturnPct)} from approximate exit price ${num(item.eventPrice)} on ${item.eventPriceDate}.` : item.error}</p></article>) : <div className="coverage-note">No verified monthly exit list is available for this manager–fund selection yet.</div>}</div>
        </div>
        <div className="turnover-panel">
          <div><span>Equity turnover</span><strong>{pct(momentumData?.snapshot?.turnover?.equityPct)}</strong></div>
          <div><span>Total turnover</span><strong>{pct(momentumData?.snapshot?.turnover?.totalPct)}</strong></div>
          <div><span>Turnover score</span><strong>{Math.round(score.factors.turnoverEfficiency.score)}</strong></div>
          <p>{score.factors.turnoverEfficiency.detail || 'Turnover awaits the latest official factsheet.'}</p>
        </div>
      </section>
    );
  }

  if (activeTab === 'traditional') {
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Traditional quality</span><h2>The remaining 25% of the score</h2></div><b>{proxyName || 'Proxy pending'}</b></div>
        <div className="traditional-metrics">
          <MetricCard label="CAGR" value={pct(metrics.cagrPct)} note="Manager-aware period" />
          <MetricCard label="Annual alpha" value={pct(metrics.alphaPct)} note="Jensen-style alpha" />
          <MetricCard label="Information ratio" value={num(metrics.informationRatio)} note="Active return per unit of tracking error" />
          <MetricCard label="Sharpe ratio" value={num(metrics.sharpe)} note="Total-risk efficiency" />
          <MetricCard label="Downside capture" value={pct(metrics.downCapturePct)} note="Below 100 indicates protection" />
          <MetricCard label="Maximum drawdown" value={pct(metrics.maxDrawdownPct)} note="Worst peak-to-trough decline" />
          <MetricCard label="Alpha persistence" value={Number.isFinite(metrics.alphaPersistenceScore) ? `${Math.round(metrics.alphaPersistenceScore)}/100` : '—'} note="Four-window consistency" />
          <MetricCard label="Manager value-add" value={money(metrics.managerValueAddNav)} note="Ending NAV difference versus proxy" />
        </div>
        <div className="factor-grid compact">{TRADITIONAL_KEYS.map(key => <FactorRow key={key} factorKey={key} factor={score.factors[key]} />)}</div>
      </section>
    );
  }

  return (
    <section className="tab-content">
      <div className="section-heading"><div><span className="eyebrow">Data provenance</span><h2>Manager identity, fund code and analytics sources</h2></div><b>{manager?.confidence ? `${Math.round(manager.confidence * 100)}% manager-record confidence` : 'Pending'}</b></div>
      <div className="source-grid">
        {sourceList.map(source => <article key={source.url}><span>Manager / assignment source</span><strong>{source.label}</strong><small>As of {source.asOf || 'current'}</small><a href={source.url} target="_blank" rel="noreferrer">Open source</a></article>)}
        <article><span>Fund universe</span><strong>AMFI NAVAll</strong><small>Scheme code {selectedFund?.preferredSchemeCode || 'pending'}</small><a href="https://portal.amfiindia.com/spages/NAVAll.txt" target="_blank" rel="noreferrer">Open AMFI feed</a></article>
        <article><span>NAV history</span><strong>MFapi.in</strong><small>Live scheme history and code resolution</small><a href="https://www.mfapi.in/docs/" target="_blank" rel="noreferrer">Open documentation</a></article>
      </div>
      <div className="coverage-note">{exactAssignment ? 'This manager–fund link is matched to a source-tracked scheme alias.' : 'The manager is current and searchable, but the selected fund is an AMC fallback rather than a verified assignment. It is not represented as an exact mandate until an official factsheet is ingested.'}</div>
    </section>
  );
}
