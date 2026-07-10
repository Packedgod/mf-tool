'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const PAGE_SIZE = 80;

function formatNav(value) {
  return Number.isFinite(value) ? `₹${value.toFixed(4)}` : '—';
}

function initials(name) {
  return String(name || 'MF').split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
}

export default function UniversePage() {
  const [view, setView] = useState('funds');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [managerOnly, setManagerOnly] = useState(false);
  const [funds, setFunds] = useState([]);
  const [managers, setManagers] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState('loading');
  const [message, setMessage] = useState('Loading the AMFI market universe…');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 280);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setOffset(0);
    setFunds([]);
  }, [debouncedQuery, managerOnly]);

  useEffect(() => {
    let cancelled = false;
    async function loadFunds() {
      if (view !== 'funds') return;
      setState('loading');
      setMessage('Refreshing all live AMFI schemes…');
      try {
        const params = new URLSearchParams({
          view: 'funds',
          q: debouncedQuery,
          managerOnly: String(managerOnly),
          limit: String(PAGE_SIZE),
          offset: String(offset)
        });
        const response = await fetch(`/api/universe?${params}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.detail || data.error || 'Universe request failed.');
        if (cancelled) return;
        setFunds(previous => offset === 0 ? data.results : [...previous, ...data.results]);
        setTotal(data.total);
        setStats(data.stats);
        setState(data.stale ? 'degraded' : 'ready');
        setMessage(data.stale ? 'Using the most recent cached AMFI universe.' : `Loaded ${data.total} matching fund families.`);
      } catch (error) {
        if (!cancelled) {
          setState('error');
          setMessage(error.message);
        }
      }
    }
    loadFunds();
    return () => { cancelled = true; };
  }, [view, debouncedQuery, managerOnly, offset]);

  useEffect(() => {
    let cancelled = false;
    async function loadManagers() {
      if (view !== 'managers') return;
      setState('loading');
      setMessage('Loading the verified manager registry…');
      try {
        const response = await fetch(`/api/universe?view=managers&q=${encodeURIComponent(debouncedQuery)}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.detail || data.error || 'Manager registry request failed.');
        if (cancelled) return;
        setManagers(data.managers);
        setStats(current => current || data.stats);
        setState('ready');
        setMessage(`Loaded ${data.managers.length} verified manager records.`);
      } catch (error) {
        if (!cancelled) {
          setState('error');
          setMessage(error.message);
        }
      }
    }
    loadManagers();
    return () => { cancelled = true; };
  }, [view, debouncedQuery]);

  const coverage = useMemo(() => {
    if (!stats?.fundFamilies) return 0;
    return stats.verifiedFundFamilies / stats.fundFamilies * 100;
  }, [stats]);

  return (
    <div className="universe-page">
      <header className="universe-topbar">
        <div>
          <span className="universe-eyebrow">ManagerLens market universe</span>
          <h1>Every live mutual fund. One searchable field.</h1>
          <p>AMFI scheme codes update automatically. Manager assignments appear only when backed by an official AMC source.</p>
        </div>
        <Link href="/" className="back-to-tool">Back to analytics</Link>
      </header>

      <section className="universe-stats">
        <article><span>Scheme variants</span><strong>{stats?.schemeVariants?.toLocaleString() || '—'}</strong><small>Direct, regular, growth and IDCW codes</small></article>
        <article><span>Fund families</span><strong>{stats?.fundFamilies?.toLocaleString() || '—'}</strong><small>Grouped underlying funds</small></article>
        <article><span>Fund houses</span><strong>{stats?.fundHouses?.toLocaleString() || '—'}</strong><small>Detected from the AMFI feed</small></article>
        <article><span>Manager coverage</span><strong>{Number.isFinite(coverage) ? `${coverage.toFixed(1)}%` : '—'}</strong><small>Officially verified fund families</small></article>
      </section>

      <section className="universe-controls">
        <div className="universe-tabs">
          <button className={view === 'funds' ? 'active' : ''} onClick={() => { setView('funds'); setOffset(0); }}>All funds</button>
          <button className={view === 'managers' ? 'active' : ''} onClick={() => setView('managers')}>Fund managers</button>
        </div>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder={view === 'funds' ? 'Search fund, AMC, category or manager' : 'Search manager, AMC or fund'} />
        {view === 'funds' ? <label className="verified-toggle"><input type="checkbox" checked={managerOnly} onChange={event => setManagerOnly(event.target.checked)} /><span>Verified managers only</span></label> : null}
      </section>

      <div className={`universe-status ${state}`}><span>{state}</span><p>{message}</p></div>

      {view === 'funds' ? (
        <section className="fund-universe-grid">
          {funds.map(fund => {
            const leadManager = fund.managers?.[0];
            const href = `/?amfiCode=${encodeURIComponent(fund.preferredSchemeCode)}${leadManager ? `&managerName=${encodeURIComponent(leadManager.name)}` : ''}`;
            return (
              <article className="universe-fund-card" key={fund.id}>
                <div className="fund-card-head">
                  <span className="fund-house-mark">{initials(fund.fundHouse)}</span>
                  <div><span>{fund.fundHouse}</span><h2>{fund.displayName}</h2></div>
                </div>
                <div className="fund-card-meta"><span>{fund.category}</span><span>AMFI {fund.preferredSchemeCode}</span><span>{fund.variants.length} variants</span></div>
                <div className="fund-card-nav"><span>Latest NAV</span><strong>{formatNav(fund.latestNav)}</strong><small>{fund.navDate || 'Date unavailable'}</small></div>
                <div className={`manager-coverage ${fund.managers?.length ? 'verified' : 'pending'}`}>
                  {fund.managers?.length ? (
                    <><span>Verified manager{fund.managers.length > 1 ? 's' : ''}</span><strong>{fund.managers.map(manager => manager.name).join(', ')}</strong><small>{fund.managers.map(manager => manager.role).filter(Boolean).join(' · ')}</small></>
                  ) : (
                    <><span>Manager source pending</span><strong>Official AMC factsheet enrichment required</strong><small>The fund remains fully selectable by AMFI code; no manager name is guessed.</small></>
                  )}
                </div>
                <div className="fund-card-actions"><Link href={href}>Open in ManagerLens</Link><details><summary>View scheme variants</summary><div>{fund.variants.map(variant => <p key={variant.schemeCode}><b>{variant.schemeCode}</b><span>{variant.schemeName}</span></p>)}</div></details></div>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="manager-universe-grid">
          {managers.map(manager => (
            <article className="universe-manager-card" key={manager.id}>
              <span className="manager-large-avatar">{initials(manager.name)}</span>
              <div className="manager-universe-copy"><span>{manager.amc}</span><h2>{manager.name}</h2><p>{manager.role || 'Fund manager'}</p></div>
              <div className="manager-fund-aliases"><span>Verified fund assignments</span>{manager.schemeAliases?.map(alias => <b key={alias}>{alias}</b>)}</div>
              <div className="manager-source-note"><span>{manager.sourceType || 'Official AMC source'}</span><small>Confidence {Math.round((manager.confidence || 0) * 100)}%</small></div>
              <Link href={`/?managerName=${encodeURIComponent(manager.name)}`}>Open manager analytics</Link>
            </article>
          ))}
        </section>
      )}

      {view === 'funds' && funds.length < total ? <button className="load-more-funds" onClick={() => setOffset(value => value + PAGE_SIZE)} disabled={state === 'loading'}>{state === 'loading' ? 'Loading…' : `Load more (${funds.length} of ${total})`}</button> : null}

      <section className="universe-method-note">
        <h3>Why fund coverage and manager coverage are different</h3>
        <p>AMFI publishes a complete live scheme and NAV feed, so the app can include every active scheme code automatically. AMFI and MFapi do not provide a complete current manager-to-scheme roster. Manager assignments therefore come from official AMC factsheets and are admitted only after source and confidence checks. The synchronisation pipeline expands this registry without altering the analytics model.</p>
      </section>
    </div>
  );
}
