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

function AllocationStrip({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <article className="allocation-strip">
      <span>{title}</span>
      <div>{rows.map(item => <b key={item.name}>{item.name}<em>{pct(item.weight)}</em></b>)}</div>
    </article>
  );
}

function movementText(value) {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 0.01) return 'No change';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)} pp`;
}

function weightText(item) {
  const previous = Number.isFinite(item.previousWeight) ? `${item.previousWeight.toFixed(2)}%` : '0.00%';
  const current = Number.isFinite(item.currentWeight) ? `${item.currentWeight.toFixed(2)}%` : '0.00%';
  return `${previous} → ${current}`;
}

function EventCard({ item, type }) {
  const isExit = type === 'exit';
  const action = item.action === 'new' ? 'New position'
    : item.action === 'increased' ? 'Weight increased'
      : item.action === 'exited' ? 'Complete exit'
        : item.action === 'reduced' ? 'Weight reduced'
          : isExit ? 'Exit / reduction' : 'Entry / addition';
  const headline = isExit
    ? (item.ok ? `${pct(item.peakProximityPct)} of local peak` : 'Price unresolved')
    : (item.ok ? pct(item.returnSinceEventPct) : 'Price unresolved');
  const tone = item.ok
    ? (isExit ? scoreTone(50 - (item.postEventReturnPct || 0) * 2) : scoreTone(50 + (item.returnSinceEventPct || 0) * 2))
    : 'neutral';

  return (
    <article className="event-card">
      <div><strong>{item.name}</strong><span>{item.sector || 'Sector not classified'} · {action}</span></div>
      <b className={tone}>{headline}</b>
      <p><strong>{weightText(item)}</strong>{Number.isFinite(item.changeWeightPct) ? ` · ${item.changeWeightPct > 0 ? '+' : ''}${item.changeWeightPct.toFixed(2)} percentage points.` : ''}</p>
      <p>{item.ok
        ? (isExit
          ? `Observed around ${item.eventPriceDate}; post-change move ${pct(item.postEventReturnPct)} from ₹${num(item.eventPrice)}.`
          : `Observed around ${item.eventPriceDate}; move since observation ${pct(item.returnSinceEventPct)} from ₹${num(item.eventPrice)}.`)
        : item.error}</p>
    </article>
  );
}

function deriveSectors(holdings) {
  const totals = new Map();
  for (const item of holdings || []) {
    const sector = item.sector || 'Other';
    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    totals.set(sector, (totals.get(sector) || 0) + weight);
  }
  return [...totals.entries()]
    .map(([sector, weight]) => ({ sector, weight }))
    .sort((a, b) => b.weight - a.weight);
}

function CurrentBook({ title, holdings, note }) {
  if (!holdings?.length) return <div className="coverage-note"><strong>Portfolio loading.</strong> The recovery loader is retrying the selected fund’s holdings source.</div>;
  return (
    <div className="current-book">
      <span>{title}</span>
      {note ? <small>{note}</small> : null}
      {holdings.slice(0, 10).map(item => <p key={item.name}><strong>{item.name}</strong><b>{pct(item.weight)}</b></p>)}
    </div>
  );
}

export default function AnalyticsTabs({ data }) {
  const {
    activeTab, score, fundSeries, proxySeries, fundSource, selectedFund, proxyName,
    momentumData, metrics, manager, exactAssignment
  } = data;
  const managerSources = [manager?.source, ...(manager?.additionalSources || [])].filter(item => item?.url);
  const researchSources = (momentumData?.sources || []).filter(item => item?.url);
  const holdings = momentumData?.holdings || momentumData?.snapshot?.holdings || [];
  const sourceSectors = momentumData?.sectors || momentumData?.snapshot?.sectorWeights || [];
  const sectors = sourceSectors.length ? sourceSectors : deriveSectors(holdings);
  const entries = momentumData?.entries || [];
  const exits = momentumData?.exits || [];
  const snapshotCount = momentumData?.coverage?.snapshotCount || momentumData?.snapshot?.snapshotCount || (holdings.length ? 1 : 0);
  const comparisonMode = momentumData?.coverage?.comparisonMode || momentumData?.snapshot?.comparisonMode || 'top-holdings-proxy';
  const sourceLabel = momentumData?.snapshot?.factsheetLabel || researchSources.map(item => item.name).join(' + ') || 'Value Research Online + AdvisorKhoj';
  const sectorHistory = new Map((momentumData?.snapshot?.sectorHistory || []).map(item => [item.sector, item]));
  const currentAsOf = momentumData?.snapshot?.currentAsOf || momentumData?.managerChanges?.currentAsOf;
  const previousAsOf = momentumData?.snapshot?.previousAsOf || momentumData?.managerChanges?.previousAsOf;

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
        <div className="section-heading"><div><span className="eyebrow">Sector positioning</span><h2>Was the manager in the right sectors at the right time?</h2></div><b>{sourceLabel}</b></div>
        <div className="coverage-note sector-basis">
          <strong>Coverage basis:</strong> {momentumData?.snapshot?.sectorBasis || 'Current disclosed holdings grouped by reported or resolved sector'}.
          {snapshotCount >= 2 ? ` Allocation change compares ${previousAsOf || 'the previous snapshot'} with ${currentAsOf || 'the current snapshot'}.` : ' Current sector weights are shown from the latest available holdings snapshot.'}
        </div>
        {sectors.length ? (
          <div className="sector-table-wrap"><table><thead><tr><th>Sector</th><th>Current weight</th><th>Allocation change</th><th>1M</th><th>3M</th><th>6M</th><th>Status</th></tr></thead><tbody>{sectors.map(item => {
            const movement = sectorHistory.get(item.sector)?.changeWeightPct;
            return <tr key={item.sector}><td>{item.sector}</td><td>{pct(item.weight)}</td><td className={Number.isFinite(movement) ? scoreTone(50 + movement * 4) : 'neutral'}>{movementText(movement)}</td><td>{pct(item.return1mPct)}</td><td className={scoreTone(50 + (item.return3mPct || 0) * 2)}>{pct(item.return3mPct)}</td><td>{pct(item.return6mPct)}</td><td>{item.ok ? 'Price matched' : 'Weight available'}</td></tr>;
          })}</tbody></table></div>
        ) : <div className="coverage-note"><strong>Portfolio recovery in progress.</strong> The selected fund is being retried through the live source and official-snapshot fallback.</div>}
        <div className="portfolio-composition-grid">
          <AllocationStrip title="Asset allocation" rows={momentumData?.snapshot?.assetAllocation || momentumData?.fundFacts?.assetAllocation} />
          <AllocationStrip title="Market-cap mix" rows={momentumData?.snapshot?.marketCap || momentumData?.fundFacts?.marketCap} />
        </div>
        {holdings.length ? <div className="holding-grid">{holdings.map(item => <article key={item.name}><span>{item.sector || 'Sector not classified'}</span><strong>{item.name}</strong><small>{pct(item.weight)} portfolio weight</small><div><b>1M {pct(item.return1mPct)}</b><b>3M {pct(item.return3mPct)}</b><b>6M {pct(item.return6mPct)}</b></div></article>)}</div> : null}
      </section>
    );
  }

  if (activeTab === 'timing') {
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Trade timing</span><h2>Entries, exits and peak proximity</h2></div><b>{snapshotCount >= 2 ? `${comparisonMode === 'complete-portfolio' ? 'Complete portfolio' : 'Top-holdings'} comparison` : 'Current holdings baseline'}</b></div>
        <div className="coverage-note">
          <strong>{snapshotCount >= 2 ? 'Two dated source snapshots compared.' : 'Timing baseline established.'}</strong>{' '}
          {snapshotCount >= 2
            ? `${previousAsOf || 'Previous snapshot'} → ${currentAsOf || 'current snapshot'}. New, increased, reduced and exited positions are derived from the source disclosures; Yahoo is used only for price-path analysis.`
            : 'The latest disclosed holdings are shown as the current timing baseline. No entry or exit date is invented when an earlier source snapshot is unavailable.'}
        </div>
        <div className="timing-columns">
          <div><h3>New / increased positions</h3>{entries.length
            ? entries.map(item => <EventCard key={`${item.name}-${item.action}`} item={item} type="entry" />)
            : snapshotCount >= 2
              ? <div className="coverage-note"><strong>No qualifying additions detected.</strong> No new top holding or weight increase of at least 0.35 percentage points was found between the two source snapshots.</div>
              : <CurrentBook title="Current disclosed positions" holdings={holdings} note="These are the latest positions; they are not labelled as new without a prior snapshot." />}</div>
          <div><h3>Exited / reduced positions</h3>{exits.length
            ? exits.map(item => <EventCard key={`${item.name}-${item.action}`} item={item} type="exit" />)
            : snapshotCount >= 2
              ? <div className="coverage-note"><strong>No qualifying reductions detected.</strong> No complete exit or weight reduction of at least 0.35 percentage points was found between the two source snapshots.</div>
              : <CurrentBook title="Retained holdings baseline" holdings={holdings} note="A prior dated disclosure is still required before any genuine reduction or exit is claimed." />}</div>
        </div>
        <div className="turnover-panel">
          <div><span>Equity turnover</span><strong>{pct(momentumData?.snapshot?.turnover?.equityPct)}</strong></div>
          <div><span>Source snapshots</span><strong>{snapshotCount || 'Loading'}</strong></div>
          <div><span>Comparison type</span><strong>{snapshotCount >= 2 ? (comparisonMode === 'complete-portfolio' ? 'Full' : 'Top holdings') : 'Baseline'}</strong></div>
          <div><span>Turnover score</span><strong>{Math.round(score.factors.turnoverEfficiency.score)}</strong></div>
          <p>{score.factors.turnoverEfficiency.detail || 'Turnover awaits a Value Research Online or AdvisorKhoj fund record.'}</p>
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
          {momentumData?.fundFacts?.riskMetrics?.alpha !== undefined ? <MetricCard label="AdvisorKhoj alpha" value={pct(momentumData.fundFacts.riskMetrics.alpha)} note="Research-source cross-check" /> : null}
          {momentumData?.fundFacts?.riskMetrics?.sharpe !== undefined ? <MetricCard label="AdvisorKhoj Sharpe" value={num(momentumData.fundFacts.riskMetrics.sharpe)} note="Research-source cross-check" /> : null}
        </div>
        <div className="factor-grid compact">{TRADITIONAL_KEYS.map(key => <FactorRow key={key} factorKey={key} factor={score.factors[key]} />)}</div>
      </section>
    );
  }

  const allSources = [...managerSources.map(item => ({ name: item.label, type: 'Manager / assignment source', url: item.url, asOf: item.asOf })), ...researchSources];
  const uniqueSources = [...new Map(allSources.filter(item => item.url).map(item => [item.url, item])).values()];
  return (
    <section className="tab-content">
      <div className="section-heading"><div><span className="eyebrow">Data provenance</span><h2>Manager identity, fund code and analytics sources</h2></div><b>{manager?.confidence ? `${Math.round(manager.confidence * 100)}% manager-record confidence` : 'Pending'}</b></div>
      <div className="source-grid">
        {uniqueSources.map(source => <article key={source.url}><span>{source.type || 'Research source'}</span><strong>{source.name}</strong><small>As of {source.asOf || 'current'}</small><a href={source.url} target="_blank" rel="noreferrer">Open source</a></article>)}
        <article><span>Fund universe and NAV verification</span><strong>AMFI NAVAll</strong><small>Scheme code {selectedFund?.preferredSchemeCode || 'pending'}</small><a href="https://portal.amfiindia.com/spages/NAVAll.txt" target="_blank" rel="noreferrer">Open AMFI feed</a></article>
        <article><span>NAV history</span><strong>MFapi.in</strong><small>Live scheme history and code resolution</small><a href="https://www.mfapi.in/docs/" target="_blank" rel="noreferrer">Open documentation</a></article>
      </div>
      <div className="coverage-note">Manager, turnover, holdings, sector allocation and portfolio changes are sourced through Value Research Online and AdvisorKhoj. AMFI/MFapi and Yahoo are retained for scheme/NAV verification and market-price enrichment.</div>
      <div className="coverage-note">{exactAssignment ? 'This manager–fund link is matched to a source-tracked scheme alias.' : 'The selected fund is an AMC fallback until Value Research Online or AdvisorKhoj confirms the manager–scheme assignment.'}</div>
    </section>
  );
}
