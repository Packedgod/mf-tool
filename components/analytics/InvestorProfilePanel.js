'use client';

import { useState } from 'react';
import { DEFAULT_INVESTOR_PROFILE } from '@/components/analytics/useDisplayedManagerAnalytics';

const FIELDS = [
  {
    key: 'riskTolerance',
    label: 'Risk tolerance',
    help: 'How much short-term value swing you accept in exchange for return.',
    options: [
      ['conservative', 'Conservative'],
      ['moderate', 'Moderate'],
      ['aggressive', 'Aggressive']
    ]
  },
  {
    key: 'horizon',
    label: 'Investment horizon',
    help: 'How long the money can stay invested before you need it.',
    options: [
      ['short', 'Under 3 years'],
      ['medium', '3–6 years'],
      ['long', 'Over 6 years']
    ]
  },
  {
    key: 'goal',
    label: 'Primary goal',
    help: 'What this specific investment is meant to achieve.',
    options: [
      ['growth', 'Wealth growth'],
      ['retirement', 'Retirement'],
      ['income', 'Income'],
      ['preservation', 'Capital preservation'],
      ['tax', 'Tax saving'],
      ['emergency', 'Emergency reserve']
    ]
  },
  {
    key: 'liquidityNeed',
    label: 'Liquidity need',
    help: 'How likely you are to need this money back at short notice.',
    options: [
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High']
    ]
  },
  {
    key: 'taxBracket',
    label: 'Tax bracket',
    help: 'Used only to weigh equity versus non-equity taxation treatment.',
    options: [
      ['low', 'Up to 20%'],
      ['high', '30% and above']
    ]
  },
  {
    key: 'mode',
    label: 'Investment mode',
    help: 'Staggered contributions suit volatile schemes better than single-date entries.',
    options: [
      ['sip', 'SIP / staggered'],
      ['lumpsum', 'Lump sum']
    ]
  }
];

export default function InvestorProfilePanel({ profile, onChange }) {
  const [open, setOpen] = useState(false);
  const active = profile || DEFAULT_INVESTOR_PROFILE;
  const configured = Boolean(profile);

  const update = (key, value) => onChange({ ...active, [key]: value });

  return (
    <section className={`investor-profile ${configured ? 'configured' : 'unset'}`}>
      <header>
        <div>
          <span className="eyebrow">Investor profile</span>
          <h2>{configured ? 'Investor Fit is scored against your profile' : 'Set a profile to unlock Investor Fit'}</h2>
          <p>
            {configured
              ? 'Suitability is personal. These answers drive the Investor Fit pillar and the final recommendation gate.'
              : 'Investor Fit stays Not Rated until you tell the tool who the investment is for. Nothing is sent anywhere — the profile is stored in this browser only.'}
          </p>
        </div>
        <div className="investor-profile-actions">
          <button type="button" className="primary" onClick={() => { if (!configured) onChange(DEFAULT_INVESTOR_PROFILE); setOpen(value => !value); }}>
            {configured ? (open ? 'Hide profile' : 'Edit profile') : 'Set up profile'}
          </button>
          {configured ? <button type="button" className="ghost" onClick={() => { onChange(null); setOpen(false); }}>Clear</button> : null}
        </div>
      </header>

      {configured && !open ? (
        <ul className="investor-profile-summary">
          {FIELDS.map(field => (
            <li key={field.key}>
              <span>{field.label}</span>
              <strong>{field.options.find(([value]) => value === active[field.key])?.[1] || '—'}</strong>
            </li>
          ))}
          <li>
            <span>Max tolerable fall</span>
            <strong>{active.maxDrawdownPct}%</strong>
          </li>
        </ul>
      ) : null}

      {open ? (
        <div className="investor-profile-form">
          {FIELDS.map(field => (
            <label key={field.key} className="investor-field">
              <span className="investor-field-label">{field.label}</span>
              <select value={active[field.key]} onChange={event => update(field.key, event.target.value)}>
                {field.options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
              <small>{field.help}</small>
            </label>
          ))}
          <label className="investor-field investor-field-range">
            <span className="investor-field-label">Maximum tolerable fall — {active.maxDrawdownPct}%</span>
            <input
              type="range"
              min="5"
              max="60"
              step="1"
              value={active.maxDrawdownPct}
              onChange={event => update('maxDrawdownPct', Number(event.target.value))}
            />
            <small>The largest peak-to-trough drop you could hold through without selling.</small>
          </label>
        </div>
      ) : null}
    </section>
  );
}
