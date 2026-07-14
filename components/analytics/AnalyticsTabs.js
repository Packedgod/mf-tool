'use client';

import {
  FactorRow,
  MetricCard,
  PerformanceChart,
  money,
  num,
  pct,
  scoreTone
} from '@/components/analytics/AnalyticsPanels';

export const TABS = [
  ['racecard', 'Racecard'],
  ['traditional', 'Fund quality'],
  ['opportunity', 'Opportunity'],
  ['investor', 'Investor fit'],
  ['sectors', 'Sector track'],
  ['timing', 'Entry / exit timing'],
  ['sources', 'Sources']
];

const DIAGNOSTIC_LABELS = {
  sectorBias: 'Recent sector return context',
  sectorMomentum: 'Recent allocation-change context',
  entryTiming: 'Approximate entry-price context',
  exitTiming: 'Approximate post-exit context',
  exitPeakProximity: 'Exit Price Context',
  turnoverEfficiency: 'Reported portfolio turnover',
  cycleFit: 'Observed market regime'
};

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

function usableSector(item) {
  const sector = String(item?.sector || '').trim();
  if (sector && !/^(other|unclassified|sector classification pending)$/i.test(sector)) return sector;
  const name = String(item?.name || '').toLowerCase();
  if (/bank|financial|finance|insurance/.test(name)) return 'Financial Services';
  if (/technology|software|digital/.test(name)) return 'Information Technology';
  if (/pharma|health|diagnostic|biotech/.test(name)) return 'Healthcare';
  if (/fmcg|consumption|consumer|rural/.test(name)) return 'Consumer';
  if (/transport|logistic|industrial|infrastructure/.test(name)) return 'Industrials';
  if (/gilt|bond|savings|liquid|debt/.test(name)) return 'Fixed Income';
  if (/treps|current assets|cash/.test(name)) return 'Cash & Equivalents';
  return item?.holdingType === 'underlying-fund' ? 'Diversified / Multi-asset' : 'Sector classification pending';
}

function holdingTypeLabel(item) {
  if (item?.holdingType === 'look-through-stock') return 'Look-through stock';
  if (item?.holdingType === 'underlying-fund') return 'Underlying fund';
  if (item?.holdingType === 'debt') return 'Debt security';
  if (item?.holdingType === 'cash') return 'Cash / TREPS';
  return 'Stock';
}

function approxExposureCr(item, aumCr) {
  if (!Number.isFinite(item?.changeWeightPct) || !Number.isFinite(aumCr)) return null;
  return Math.abs(item.changeWeightPct) * aumCr / 100;
}

function EventCard({ item, type, aumCr }) {
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
  const exposureCr = approxExposureCr(item, aumCr);

  return (
    <article className="event-card">
      <div><strong>{item.name}</strong><span>{usableSector(item)} · {action}</span></div>
      <b className={tone}>{headline}</b>
      <p><strong>{weightText(item)}</strong>{Number.isFinite(item.changeWeightPct) ? ` · ${item.changeWeightPct > 0 ? '+' : ''}${item.changeWeightPct.toFixed(2)} percentage points.` : ''}</p>
      {Number.isFinite(exposureCr) ? <p>Approximate portfolio exposure {isExit ? 'reduced' : 'added'}: <strong>₹{num(exposureCr)} crore</strong> using latest AUM.</p> : null}
      <p>{item.ok
        ? (isExit
          ? `Market price near the start of the observed change: ₹${num(item.eventPrice)} on ${item.eventPriceDate}; subsequent market move ${pct(item.postEventReturnPct)}.`
          : `Market price near the start of the observed change: ₹${num(item.eventPrice)} on ${item.eventPriceDate}; subsequent market move ${pct(item.returnSinceEventPct)}.`)
        : item.error}</p>
      <small>Prices and AUM-derived exposure are reference estimates, not the fund's undisclosed execution price or transaction proceeds.</small>
    </article>
  );
}

function nearestNav(rows, date, fallbackIndex) {
  if (!rows?.length) return null;
  const fallback = rows[Math.max(0, Math.min(rows.length - 1, fallbackIndex))];
  if (!date) return fallback;
  const target = new Date(date).getTime();
  if (!Number.isFinite(target)) return fallback;
  return rows.reduce((best, item) => Math.abs(new Date(item.date).getTime() - target) < Math.abs(new Date(best.date).getTime() - target) ? item : best, rows[0]);
}

function NavMovement({ series, previousAsOf, currentAsOf }) {
  if (!series?.length) return null;
  const end = nearestNav(series, currentAsOf, series.length - 1);
  const start = nearestNav(series, previousAsOf, Math.max(0, series.length - 23));
  const change = end && start && start.nav > 0 ? (end.nav / start.nav - 1) * 100 : null;
  return (
    <div className="nav-movement-panel">
      <div><span>Fund NAV at period start</span><strong>₹{num(start?.nav)}</strong><small>{start?.date || 'Unavailable'}</small></div>
      <div><span>Latest fund NAV</span><strong>₹{num(end?.nav)}</strong><small>{end?.date || 'Unavailable'}</small></div>
      <div><span>NAV movement during change window</span><strong className={scoreTone(50 + (change || 0) * 2)}>{pct(change)}</strong><small>Market and portfolio effects combined</small></div>
    </div>
  );
}

function replacementPairs(entries, exits) {
  const remaining = [...entries];
  return exits.map(sold => {
    if (!remaining.length) return { sold, bought: null };
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((bought, index) => {
      const sameSector = usableSector(sold) === usableSector(bought) ? 10 : 0;
      const weightDistance = Math.abs(Math.abs(sold.changeWeightPct || 0) - Math.abs(bought.changeWeightPct || 0));
      const score = sameSector - weightDistance;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    return { sold, bought: remaining.splice(bestIndex, 1)[0] };
  }).filter(item => item.bought);
}

function ReplacementMap({ entries, exits, aumCr }) {
  const pairs = replacementPairs(entries, exits);
  if (!pairs.length) return null;
  return (
    <div className="replacement-panel">
      <div className="subsection-heading"><div><span className="eyebrow">Same-period allocation map</span><h3>What was reduced and what was added</h3></div><small>Pairing is inferred from sector and weight movement; filings do not identify transaction-to-transaction replacements.</small></div>
      <div className="replacement-grid">{pairs.map(({ sold, bought }) => {
        const soldCr = approxExposureCr(sold, aumCr);
        const boughtCr = approxExposureCr(bought, aumCr);
        return <article key={`${sold.name}-${bought.name}`}><div><span>Reduced / sold</span><strong>{sold.name}</strong><small>{Math.abs(sold.changeWeightPct || 0).toFixed(2)} pp{Number.isFinite(soldCr) ? ` · approx. ₹${num(soldCr)} cr` : ''}{Number.isFinite(sold.eventPrice) ? ` · market ₹${num(sold.eventPrice)}` : ''}</small></div><b>→</b><div><span>Added / probable replacement</span><strong>{bought.name}</strong><small>{Math.abs(bought.changeWeightPct || 0).toFixed(2)} pp{Number.isFinite(boughtCr) ? ` · approx. ₹${num(boughtCr)} cr` : ''}{Number.isFinite(bought.eventPrice) ? ` · market ₹${num(bought.eventPrice)}` : ''}</small></div></article>;
      })}</div>
    </div>
  );
}

function deriveSectors(holdings) {
  const totals = new Map();
  for (const item of holdings || []) {
    const sector = usableSector(item);
    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    totals.set(sector, (totals.get(sector) || 0) + weight);
  }
  return [...totals.entries()].map(([sector, weight]) => ({ sector, weight })).sort((a, b) => b.weight - a.weight);
}

function CurrentBook({ title, holdings, note }) {
  if (!holdings?.length) return <div className="coverage-note"><strong>Portfolio loading.</strong> The recovery loader is retrying the selected fund's holdings source.</div>;
  return (
    <div className="current-book">
      <span>{title}</span>
      {note ? <small>{note}</small> : null}
      {holdings.slice(0, 12).map(item => <p key={item.name}><strong>{item.name}</strong><b>{pct(item.weight)}</b></p>)}
    </div>
  );
}

function HoldingsTable({ holdings, holdingBasis }) {
  if (!holdings?.length) return null;
  return (
    <div className="holdings-section">
      <div className="subsection-heading"><div><span className="eyebrow">Portfolio holdings</span><h3>Stocks and securities held</h3></div><small>{holdingBasis}</small></div>
      <div className="sector-table-wrap holdings-table-wrap"><table><thead><tr><th>Holding</th><th>Type</th><th>Sector / mandate</th><th>Portfolio weight</th><th>1M allocation change</th><th>1M market move</th><th>3M</th><th>6M</th></tr></thead><tbody>{holdings.map(item => <tr key={item.name}><td><strong>{item.name}</strong>{item.exposureSources?.length ? <small>Via {item.exposureSources.slice(0, 2).join(', ')}</small> : null}</td><td>{holdingTypeLabel(item)}</td><td>{usableSector(item)}</td><td>{pct(item.weight)}</td><td>{Number.isFinite(item.oneMonthWeightChange) ? movementText(item.oneMonthWeightChange) : 'Not reported'}</td><td>{pct(item.return1mPct)}</td><td>{pct(item.return3mPct)}</td><td>{pct(item.return6mPct)}</td></tr>)}</tbody></table></div>
    </div>
  );
}

function UnderlyingFunds({ funds }) {
  if (!funds?.length) return null;
  return (
    <div className="underlying-section">
      <div className="subsection-heading"><div><span className="eyebrow">Direct FoF holdings</span><h3>Underlying funds held directly</h3></div><small>Every underlying scheme is classified by mandate; resolved schemes also show their stock look-through coverage.</small></div>
      <div className="underlying-grid">{funds.map(item => <article key={item.name}><span>{usableSector(item)}</span><strong>{item.name}</strong><div><b>{pct(item.weight)} direct weight</b><b>{Number.isFinite(item.oneMonthWeightChange) ? `${movementText(item.oneMonthWeightChange)} in 1M` : '1M change not reported'}</b></div><small>{item.lookThroughStatus === 'resolved' ? `${item.lookThroughHoldings} stocks · ${item.lookThroughSectors} sectors resolved` : item.holdingType === 'underlying-fund' ? 'Mandate data shown; stock look-through not returned' : holdingTypeLabel(item)}</small></article>)}</div>
    </div>
  );
}

export default function AnalyticsTabs({ data }) {
  const {
    activeTab, score, fundSeries, proxySeries, fundSource, selectedFund, proxyName,
    momentumData, metrics, manager, exactAssignment, peerData, peerState, peerMessage
  } = data;
  const managerSources = [manager?.source, ...(manager?.additionalSources || [])].filter(item => item?.url);
  const researchSources = (momentumData?.sources || []).filter(item => item?.url);
  const holdings = momentumData?.holdings || momentumData?.snapshot?.holdings || [];
  const sourceSectors = momentumData?.sectors || momentumData?.snapshot?.sectorWeights || [];
  const sectors = sourceSectors.length ? sourceSectors : deriveSectors(holdings);
  const entries = momentumData?.entries || [];
  const exits = momentumData?.exits || [];
  const snapshotCount = momentumData?.coverage?.snapshotCount || momentumData?.snapshot?.snapshotCount || (holdings.length ? 1 : 0);
  const comparisonMode = momentumData?.coverage?.comparisonMode || momentumData?.snapshot?.comparisonMode || 'current-holdings-baseline';
  const sourceLabel = momentumData?.snapshot?.factsheetLabel || researchSources.map(item => item.name).join(' + ') || 'Moneycontrol + Value Research Online';
  const sectorHistory = new Map((momentumData?.snapshot?.sectorHistory || []).map(item => [item.sector, item]));
  const currentAsOf = momentumData?.snapshot?.currentAsOf || momentumData?.managerChanges?.currentAsOf;
  const previousAsOf = momentumData?.snapshot?.previousAsOf || momentumData?.managerChanges?.previousAsOf;
  const directHoldings = momentumData?.snapshot?.underlyingFunds?.length
    ? momentumData.snapshot.underlyingFunds
    : momentumData?.snapshot?.directHoldings || [];
  const holdingBasis = momentumData?.snapshot?.holdingBasis || 'Direct securities reported by the selected fund.';
  const aumCr = momentumData?.fundFacts?.aumCr;
  const reportedChangeMode = comparisonMode === 'reported-one-month-allocation-change';
  const datedComparison = snapshotCount >= 2 && !reportedChangeMode;

  if (activeTab === 'racecard') {
    return (
      <section className="tab-content">
        <PerformanceChart fund={fundSeries} proxy={proxySeries} fundName={fundSource?.schemeName || selectedFund?.displayName || 'Fund'} proxyName={proxyName || 'Proxy'} />
        <div className="section-heading"><div><span className="eyebrow">Fund Quality pillars</span><h2>Twelve evidence tests — scored only when the required peer data exists</h2></div><b>{score.model.label}</b></div>
        <div className="factor-grid quality-pillar-grid">{score.orderedQualityPillars.map(factor => <FactorRow key={factor.key} factorKey={factor.key} factor={factor} />)}</div>
        <div className="section-heading"><div><span className="eyebrow">Additional insights</span><h2>Descriptive context excluded from the core score</h2></div><b>0% Fund Quality weight</b></div>
        <div className="descriptive-diagnostic-grid">{Object.entries(DIAGNOSTIC_LABELS).map(([key, label]) => {
          const factor = score.diagnostics?.factors?.[key];
          return <article key={key}><span>{label}</span><strong>{factor?.detail || 'Evidence unavailable.'}</strong><small>Diagnostic only — no contribution to Fund Quality.</small></article>;
        })}</div>
        <div className="insight-panel"><span className="eyebrow">Publication guardrails</span>{score.guardrails.map((item, index) => <p key={index}>• {item}</p>)}</div>
      </section>
    );
  }

  if (activeTab === 'opportunity') {
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Current Opportunity Score</span><h2>Present valuation, fundamentals, factor alignment and crowding</h2></div><b>{score.headlines.currentOpportunity.status === 'not-rated' ? 'Not Rated' : `${Math.round(score.headlines.currentOpportunity.score)}/100`}</b></div>
        <div className="coverage-note"><strong>Separate from historical quality.</strong> A strong manager can have an unattractive current portfolio. Scores remain NR until point-in-time security fundamentals, valuation histories, ownership and liquidity inputs are available.</div>
        <div className="factor-grid">{score.orderedOpportunityFactors.map(factor => <FactorRow key={factor.key} factorKey={factor.key} factor={factor} />)}</div>
      </section>
    );
  }

  if (activeTab === 'investor') {
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Investor Fit Score</span><h2>Suitability depends on the investor, not only the fund</h2></div><b>{score.headlines.investorFit.status === 'not-rated' ? 'Not Rated' : `${Math.round(score.headlines.investorFit.score)}/100`}</b></div>
        <div className="coverage-note"><strong>No generic recommendation is published.</strong> A verified SEBI Riskometer plus investor risk tolerance, horizon, goal, portfolio overlap, drawdown tolerance, liquidity and tax inputs are required.</div>
        <div className="factor-grid">{score.orderedInvestorFitFactors.map(factor => <FactorRow key={factor.key} factorKey={factor.key} factor={factor} />)}</div>
        <div className="coverage-note"><strong>Risk gates:</strong> Fit below 40 blocks a recommendation; confidence below 50 means insufficient evidence; recent manager or mandate changes require a provisional label.</div>
      </section>
    );
  }

  if (activeTab === 'sectors') {
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Sector positioning</span><h2>Sector weightage and the securities behind it</h2></div><b>{sourceLabel}</b></div>
        <div className="coverage-note sector-basis">
          <strong>Coverage basis:</strong> {momentumData?.snapshot?.sectorBasis || 'Current disclosed holdings grouped by reported or resolved sector'}.
          {datedComparison || reportedChangeMode ? ` Allocation change compares ${previousAsOf || 'the prior period'} with ${currentAsOf || 'the current portfolio'}.` : ' Current sector weights are shown from the latest available holdings snapshot.'}
        </div>
        {sectors.length ? (
          <div className="sector-table-wrap"><table><thead><tr><th>Sector</th><th>Current weight</th><th>Allocation change</th><th>1M</th><th>3M</th><th>6M</th><th>Status</th></tr></thead><tbody>{sectors.map(item => {
            const movement = sectorHistory.get(item.sector)?.changeWeightPct;
            return <tr key={item.sector}><td>{item.sector}</td><td>{pct(item.weight)}</td><td className={Number.isFinite(movement) ? scoreTone(50 + movement * 4) : 'neutral'}>{movementText(movement)}</td><td>{pct(item.return1mPct)}</td><td className={scoreTone(50 + (item.return3mPct || 0) * 2)}>{pct(item.return3mPct)}</td><td>{pct(item.return6mPct)}</td><td>{item.ok ? 'Market matched' : item.lookThrough ? 'Look-through weight' : 'Portfolio weight'}</td></tr>;
          })}</tbody></table></div>
        ) : <div className="coverage-note"><strong>Portfolio recovery in progress.</strong> The selected fund is being retried through the live source and official-snapshot fallback.</div>}
        <div className="portfolio-composition-grid">
          <AllocationStrip title="Asset allocation" rows={momentumData?.snapshot?.assetAllocation || momentumData?.fundFacts?.assetAllocation} />
          <AllocationStrip title="Market-cap mix" rows={momentumData?.snapshot?.marketCap || momentumData?.fundFacts?.marketCap} />
        </div>
        <HoldingsTable holdings={holdings} holdingBasis={holdingBasis} />
        <UnderlyingFunds funds={directHoldings} />
      </section>
    );
  }

  if (activeTab === 'timing') {
    const timingLabel = datedComparison ? `${comparisonMode === 'complete-portfolio' ? 'Complete portfolio' : 'Top-holdings'} comparison` : reportedChangeMode ? 'Moneycontrol 1M changes' : 'Current holdings baseline';
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Trade timing</span><h2>Entries, exits, replacements and NAV movement</h2></div><b>{timingLabel}</b></div>
        <div className="coverage-note">
          <strong>{datedComparison ? 'Two dated source snapshots compared.' : reportedChangeMode ? 'Reported one-month allocation changes loaded.' : 'Timing baseline established.'}</strong>{' '}
          {datedComparison
            ? `${previousAsOf || 'Previous snapshot'} → ${currentAsOf || 'current snapshot'}. New, increased, reduced and exited positions come from portfolio disclosures; Yahoo is used only for market-price context.`
            : reportedChangeMode
              ? `${previousAsOf || 'Prior month'} → ${currentAsOf || 'current portfolio'}. Weight changes are source-reported; market prices and NAV explain the same observation window but are not claimed as execution prices.`
              : 'The latest disclosed holdings are shown once as the current baseline. No sale, purchase, or replacement is claimed without a prior disclosure or source-reported allocation change.'}
        </div>
        <NavMovement series={fundSeries} previousAsOf={previousAsOf} currentAsOf={currentAsOf} />
        <div className="timing-columns">
          <div><h3>New / increased positions</h3>{entries.length
            ? entries.map(item => <EventCard key={`${item.name}-${item.action}`} item={item} type="entry" aumCr={aumCr} />)
            : <div className="coverage-note"><strong>No qualifying additions detected.</strong> No reported new position or weight increase of at least 0.35 percentage points is available for this comparison window.</div>}</div>
          <div><h3>Exited / reduced positions</h3>{exits.length
            ? exits.map(item => <EventCard key={`${item.name}-${item.action}`} item={item} type="exit" aumCr={aumCr} />)
            : <div className="coverage-note"><strong>No qualifying reductions detected.</strong> No reported complete exit or weight reduction of at least 0.35 percentage points is available for this comparison window.</div>}</div>
        </div>
        <ReplacementMap entries={entries} exits={exits} aumCr={aumCr} />
        {!entries.length && !exits.length ? <CurrentBook title="Current disclosed positions" holdings={directHoldings.length ? directHoldings : holdings} note="Shown once as the baseline; these positions are not mislabelled as both entries and exits." /> : null}
        <div className="turnover-panel">
          <div><span>Equity turnover</span><strong>{pct(momentumData?.snapshot?.turnover?.equityPct)}</strong></div>
          <div><span>Source snapshots</span><strong>{snapshotCount || 'Loading'}</strong></div>
          <div><span>Comparison type</span><strong>{datedComparison ? (comparisonMode === 'complete-portfolio' ? 'Full' : 'Top holdings') : reportedChangeMode ? 'Reported 1M' : 'Baseline'}</strong></div>
          <div><span>Scoring treatment</span><strong>Diagnostic only</strong></div>
          <p>Turnover is reported as evidence but receives no core score until net trading value added, costs, liquidity and category-peer efficiency can be measured.</p>
        </div>
      </section>
    );
  }

  if (activeTab === 'traditional') {
    return (
      <section className="tab-content">
        <div className="section-heading"><div><span className="eyebrow">Fund Quality evidence</span><h2>NAV, benchmark and category-peer measurements</h2></div><b>{proxyName || 'Proxy pending'}</b></div>
        <div className={`coverage-note peer-context ${peerState || 'idle'}`}><strong>{peerData?.peerCount ? `${peerData.peerCount} usable peers.` : 'Peer benchmark pending.'}</strong> {peerMessage}{peerData?.comparability?.note ? ` ${peerData.comparability.note}` : ''}</div>
        <div className="traditional-metrics">
          <MetricCard label="CAGR" value={pct(metrics.cagrPct)} note="Selected analysis period" />
          <MetricCard label="Annual alpha" value={pct(metrics.alphaPct)} note="Jensen-style alpha" />
          <MetricCard label="Information ratio" value={num(metrics.informationRatio)} note="Active return per unit of tracking error" />
          <MetricCard label="Sharpe ratio" value={num(metrics.sharpe)} note="Total-risk efficiency" />
          <MetricCard label="Downside capture" value={pct(metrics.downCapturePct)} note="Below 100 indicates protection" />
          <MetricCard label="Maximum drawdown" value={pct(metrics.maxDrawdownPct)} note="Worst peak-to-trough decline" />
          <MetricCard label="Conditional drawdown at risk" value={pct(metrics.conditionalDrawdownAtRiskPct)} note="Average of the worst 10% drawdown observations" />
          <MetricCard label="Time under water" value={pct(metrics.timeUnderWaterPct)} note="Share of NAV observations below the prior peak" />
          <MetricCard label="Recovery speed" value={Number.isFinite(metrics.recoveryDays) ? `${Math.round(metrics.recoveryDays)} trading days` : '—'} note="Average completed underwater spell" />
          <MetricCard label="Negative-month alpha" value={pct(metrics.negativeMonthAlphaPct)} note="Average active return when the proxy fell" />
          <MetricCard label="Tail-loss frequency" value={pct(metrics.tailLossFrequencyPct)} note="Share of daily returns at or below −2%" />
          <MetricCard label="Alpha persistence" value={Number.isFinite(metrics.alphaPersistenceScore) ? `${Math.round(metrics.alphaPersistenceScore)}/100` : '—'} note="Four-window consistency" />
          <MetricCard label="Manager value-add" value={money(metrics.managerValueAddNav)} note="Ending NAV difference versus proxy" />
          {momentumData?.fundFacts?.riskMetrics?.alpha !== undefined ? <MetricCard label="AdvisorKhoj alpha" value={pct(momentumData.fundFacts.riskMetrics.alpha)} note="Research-source cross-check" /> : null}
          {momentumData?.fundFacts?.riskMetrics?.sharpe !== undefined ? <MetricCard label="AdvisorKhoj Sharpe" value={num(momentumData.fundFacts.riskMetrics.sharpe)} note="Research-source cross-check" /> : null}
        </div>
        <div className="factor-grid compact">{score.orderedQualityPillars.map(factor => <FactorRow key={factor.key} factorKey={factor.key} factor={factor} />)}</div>
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
      <div className="coverage-note">Moneycontrol supplies exact-ISIN holdings, allocation changes, and FoF look-through portfolios. Value Research Online and AdvisorKhoj provide manager and disclosure cross-checks. AMFI/MFapi and Yahoo are retained for NAV and market-price context.</div>
      <div className="coverage-note">{exactAssignment ? 'This manager–fund link is matched to a source-tracked scheme alias.' : 'The selected fund is an AMC fallback until a public source confirms the manager–scheme assignment.'}</div>
    </section>
  );
}
