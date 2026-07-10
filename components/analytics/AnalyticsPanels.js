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

export function FactorRow({ factorKey, factor }) {
  const weight = MOMENTUM_WEIGHTS[factorKey] || 0;
  const score = Number.isFinite(factor?.score) ? factor.score : 50;
  return (
    <article className="factor-row">
      <div className="factor-title"><strong>{LABELS[factorKey]}</strong><span>{weight}% weight</span></div>
      <div className="factor-bar"><i style={{ width: `${Math.max(0, Math.min(100, score))}%` }} /></div>
      <b className={scoreTone(score)}>{Math.round(score)}</b>
      <p>{factor?.detail || 'Official portfolio or transaction history is not normalised yet. A neutral provisional value is used and coverage is reduced.'}</p>
    </article>
  );
}

export function MetricCard({ label, value, note }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
