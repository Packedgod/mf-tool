'use client';

import { useMemo } from 'react';
import { MOMENTUM_WEIGHTS } from '@/lib/momentum-data';

const LABELS = {
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

export const MOMENTUM_KEYS = ['sectorBias', 'sectorMomentum', 'entryTiming', 'exitTiming', 'exitPeakProximity', 'turnoverEfficiency', 'cycleFit'];
export const TRADITIONAL_KEYS = ['alphaInformationRatio', 'sharpeDownside', 'drawdownControl', 'persistence', 'managerValueAdd'];

export function pct(value, digits = 2) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—';
}

export function num(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export function money(value) {
  return Number.isFinite(value) ? `₹${value.toFixed(2)}` : '—';
}

export function scoreTone(value) {
  if (!Number.isFinite(value)) return 'neutral';
  if (value >= 75) return 'strong';
  if (value >= 60) return 'positive';
  if (value >= 45) return 'watch';
  return 'risk';
}

function chartRows(fund, proxy) {
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

export function PerformanceChart({ fund, proxy, fundName, proxyName }) {
  const rows = useMemo(() => chartRows(fund, proxy), [fund, proxy]);
  if (rows.length < 2) return <div className="empty-chart">The chart appears after the selected fund and proxy finish loading.</div>;

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

export function ScoreRing({ value, label, sublabel, provisional = false }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className={`score-ring ${provisional ? 'provisional' : ''}`} style={{ '--score': `${safe * 3.6}deg` }}>
      <div>
        <strong>{Number.isFinite(value) ? Math.round(value) : '—'}</strong>
        <span>{label}</span>
        <small>{sublabel}</small>
      </div>
    </div>
  );
}

export function HeadlineScoreCard({ headline }) {
  const rated = Number.isFinite(headline?.score);
  const confidence = Number.isFinite(headline?.confidence) ? Math.round(headline.confidence) : 0;
  const coverage = Number.isFinite(headline?.coveragePct) ? Math.round(headline.coveragePct) : 0;
  const range = rated && headline?.range?.length === 2
    ? `${Math.round(headline.range[0])}–${Math.round(headline.range[1])}`
    : null;
  return (
    <article className={`headline-score-card ${rated ? (headline?.status || 'rated') : 'not-rated'}`}>
      <div className="headline-score-top"><span>{headline?.label}</span><b>{rated ? Math.round(headline.score) : 'NR'}</b></div>
      <p>{headline?.detail}</p>
      <div className="headline-score-meta">
        <span>Confidence <strong>{confidence}/100</strong></span>
        <span>Coverage <strong>{coverage}%</strong></span>
        {range ? <span>Range <strong>{range}</strong></span> : null}
      </div>
      <div className="confidence-track" aria-label={`${headline?.label || 'Score'} confidence ${confidence} out of 100`}><i style={{ width: `${confidence}%` }} /></div>
    </article>
  );
}

export function FactorRow({ factorKey, factor }) {
  const weight = factor?.weight ?? MOMENTUM_WEIGHTS[factorKey] ?? 0;
  const score = Number.isFinite(factor?.score) ? factor.score : null;
  const confidence = Number.isFinite(factor?.confidence) ? Math.round(factor.confidence) : 0;
  const coverage = Number.isFinite(factor?.coveragePct) ? Math.round(factor.coveragePct) : 0;
  const label = factor?.label || LABELS[factorKey] || factorKey;
  return (
    <article className={`factor-row ${Number.isFinite(score) ? 'rated' : 'not-rated'}`}>
      <div className="factor-title"><strong>{label}</strong><span>{weight}% weight</span></div>
      <div className="factor-bar"><i style={{ width: `${Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0}%` }} /></div>
      <b className={Number.isFinite(score) ? scoreTone(score) : 'neutral'}>{Number.isFinite(score) ? Math.round(score) : 'NR'}</b>
      <p>{factor?.detail || 'Not Rated — required point-in-time evidence is unavailable.'}</p>
      <small className="factor-confidence">Confidence {confidence}/100 · coverage {coverage}%{Number.isFinite(factor?.rawScore) ? ` · peer score ${Math.round(factor.rawScore)} before shrinkage` : ''}</small>
    </article>
  );
}

export function MetricCard({ label, value, note }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
