'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useManagerAnalytics from '@/components/analytics/useManagerAnalytics';
import { buildSyntheticProxy, computeMetrics, normaliseSeries } from '@/lib/analytics';
import { calculateManagerScore } from '@/lib/momentum-engine';
import { detailedMomentumSchemeId } from '@/lib/dynamic-proxies';

const usefulMomentum = data => Boolean(
  data?.holdings?.length
  || data?.sectors?.length
  || data?.snapshot?.sectorWeights?.length
);
const usefulNav = data => Boolean(data?.fundSeries?.length >= 3 && data?.proxySeries?.length >= 3);

function deriveSectors(holdings = []) {
  const totals = new Map();
  for (const item of holdings) {
    const sector = String(item?.sector || 'Other').trim() || 'Other';
    const weight = Number(item?.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    totals.set(sector, (totals.get(sector) || 0) + weight);
  }
  return [...totals.entries()]
    .map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)) }))
    .sort((a, b) => b.weight - a.weight);
}

function firstRows(candidates, getter) {
  for (const candidate of candidates) {
    const rows = getter(candidate);
    if (Array.isArray(rows) && rows.length) return rows;
  }
  return [];
}

function mergeSources(candidates) {
  const rows = candidates.flatMap(item => item?.sources || []).filter(item => item?.name || item?.url);
  return [...new Map(rows.map(item => [item.url || `${item.name}-${item.type || ''}`, item])).values()];
}

function mergeMomentum({ live, recovered, official, cached, fundId }) {
  const candidates = [live, recovered, official, cached].filter(Boolean);
  if (!candidates.length) return null;
  const primary = candidates.find(usefulMomentum) || candidates[0];
  const holdings = firstRows(candidates, item => item?.holdings || item?.snapshot?.holdings);
  let sectors = firstRows(candidates, item => item?.sectors || item?.snapshot?.sectorWeights);
  if (!sectors.length && holdings.length) sectors = deriveSectors(holdings);
  const entries = firstRows(candidates, item => item?.entries);
  const exits = firstRows(candidates, item => item?.exits);
  const snapshotCandidates = candidates.map(item => item?.snapshot).filter(Boolean);
  const snapshot = { ...(snapshotCandidates.at(-1) || {}), ...(snapshotCandidates[0] || {}) };
  let snapshotCount = Math.max(0, ...candidates.map(item => Number(item?.coverage?.snapshotCount || item?.snapshot?.snapshotCount || 0)));
  if (!snapshotCount && (holdings.length || sectors.length)) snapshotCount = 1;
  if ((entries.length || exits.length) && snapshotCount < 2) snapshotCount = 2;
  const resolvedPct = Math.max(
    0,
    ...candidates.map(item => Number(item?.coverage?.resolvedPct || 0)),
    holdings.length && sectors.length ? 70 : holdings.length || sectors.length ? 55 : 0
  );

  return {
    ...primary,
    ok: true,
    holdings,
    sectors,
    entries,
    exits,
    sources: mergeSources(candidates),
    snapshot: {
      ...snapshot,
      holdings,
      sectorWeights: sectors,
      snapshotCount,
      comparisonMode: snapshot.comparisonMode || (snapshotCount >= 2 ? 'top-holdings-proxy' : 'current-holdings-baseline'),
      sectorBasis: snapshot.sectorBasis || 'Current disclosed holdings grouped by reported or resolved sector',
      factsheetLabel: snapshot.factsheetLabel || primary?.snapshot?.factsheetLabel || 'Live portfolio sources'
    },
    coverage: {
      ...(primary?.coverage || {}),
      snapshotCount,
      resolvedPct,
      comparisonMode: primary?.coverage?.comparisonMode || snapshot.comparisonMode || (snapshotCount >= 2 ? 'top-holdings-proxy' : 'current-holdings-baseline')
    },
    __fundId: fundId,
    recovery: {
      usedRecoveredRequest: usefulMomentum(recovered),
      usedOfficialFallback: usefulMomentum(official),
      usedCachedDataset: !usefulMomentum(live) && !usefulMomentum(recovered) && !usefulMomentum(official) && usefulMomentum(cached)
    }
  };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function fetchJson(url, { signal, attempts = 2, options = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal, ...options });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`The server returned a non-JSON response (${response.status}).`); }
      if (!response.ok || !data?.ok) throw new Error(data?.detail || data?.error || `Request failed (${response.status}).`);
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;
      if (attempt < attempts - 1) await wait(800 * (attempt + 1), signal);
    }
  }
  throw lastError || new Error('Request failed.');
}

async function requestSeries(payload, signal) {
  return fetchJson('/api/live/series', {
    signal,
    attempts: 3,
    options: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }
  });
}

async function recoverNav(base, signal) {
  const fundPayload = {
    schemeCode: base.selectedFund.preferredSchemeCode,
    startDate: base.analysisStart,
    endDate: base.endDate
  };
  const fundResult = await requestSeries(fundPayload, signal);
  const fundSeries = normaliseSeries(fundResult.data);
  if (fundSeries.length < 3) throw new Error('The selected fund returned insufficient NAV history.');

  let proxySeries = [];
  let proxySource = null;
  if (base.proxyMode === 'custom') {
    const customCode = base.proxyCodeStatus?.schemeCode || base.proxyCodeInput;
    if (!/^\d{4,9}$/.test(String(customCode || '').trim())) throw new Error('The custom proxy AMFI code is not validated.');
    const result = await requestSeries({ schemeCode: customCode, startDate: base.analysisStart, endDate: base.endDate }, signal);
    proxySeries = normaliseSeries(result.data);
    proxySource = result.source;
  } else {
    const components = base.selectedProxy?.components || [];
    if (!components.length) throw new Error('No proxy components are configured for this fund.');
    const settled = await Promise.allSettled(components.map(component => requestSeries({
      queries: component.queries,
      startDate: base.analysisStart,
      endDate: base.endDate
    }, signal)));
    const successful = settled
      .map((result, index) => result.status === 'fulfilled' ? { result: result.value, weight: Number(components[index].weight) || 0 } : null)
      .filter(Boolean)
      .filter(item => normaliseSeries(item.result.data).length >= 3);
    if (!successful.length) {
      const errors = settled.filter(item => item.status === 'rejected').map(item => item.reason?.message).filter(Boolean);
      throw new Error(errors.join(' ') || 'The configured NAV proxy did not return usable history.');
    }
    const weightTotal = successful.reduce((sum, item) => sum + item.weight, 0) || successful.length;
    proxySeries = buildSyntheticProxy(
      successful.map(item => normaliseSeries(item.result.data)),
      successful.map(item => (item.weight || 1) / weightTotal)
    );
    proxySource = successful.map(item => item.result.source);
  }

  if (proxySeries.length < 3) throw new Error('The selected comparison proxy returned insufficient NAV history.');
  return {
    fundSeries,
    proxySeries,
    fundSource: fundResult.source,
    proxySource,
    fetchedAt: new Date().toISOString()
  };
}

export default function useReliableManagerAnalytics(options = {}) {
  const base = useManagerAnalytics(options);
  const selectedFund = base.selectedFund;
  const schemeId = useMemo(() => detailedMomentumSchemeId(selectedFund), [selectedFund]);

  const [cachedMomentum, setCachedMomentum] = useState(null);
  const [officialMomentum, setOfficialMomentum] = useState(null);
  const [recoveredMomentum, setRecoveredMomentum] = useState(null);
  const [momentumRecoveryState, setMomentumRecoveryState] = useState('idle');
  const [momentumRecoveryMessage, setMomentumRecoveryMessage] = useState('');
  const [momentumRetryNonce, setMomentumRetryNonce] = useState(0);
  const momentumControllerRef = useRef(null);

  const proxyIdentity = base.proxyMode === 'custom'
    ? `custom:${base.proxyCodeStatus?.schemeCode || base.proxyCodeInput || ''}`
    : `${base.proxyMode}:${base.selectedProxy?.id || base.selectedProxy?.label || 'proxy'}`;
  const navCacheKey = selectedFund?.id
    ? `managerlens:nav:${selectedFund.id}:${proxyIdentity}:${base.analysisStart}:${base.endDate}`
    : '';
  const [cachedNav, setCachedNav] = useState(null);
  const [recoveredNav, setRecoveredNav] = useState(null);
  const [navRecoveryState, setNavRecoveryState] = useState('idle');
  const [navRecoveryMessage, setNavRecoveryMessage] = useState('');
  const [navRetryNonce, setNavRetryNonce] = useState(0);
  const navControllerRef = useRef(null);

  useEffect(() => {
    setCachedMomentum(null);
    setOfficialMomentum(null);
    setRecoveredMomentum(null);
    setMomentumRecoveryState('idle');
    setMomentumRecoveryMessage('');
    momentumControllerRef.current?.abort();
    if (!selectedFund?.id) return undefined;

    try {
      const saved = window.localStorage.getItem(`managerlens:portfolio:${selectedFund.id}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.__fundId === selectedFund.id && usefulMomentum(parsed)) setCachedMomentum(parsed);
      }
    } catch {}

    if (!schemeId) return undefined;
    const controller = new AbortController();
    momentumControllerRef.current = controller;
    setMomentumRecoveryState('syncing');
    fetchJson(`/api/momentum?schemeId=${encodeURIComponent(schemeId)}&fallback=${Date.now()}`, { signal: controller.signal, attempts: 2 })
      .then(data => {
        if (controller.signal.aborted) return;
        setOfficialMomentum(data);
        setMomentumRecoveryState('ready');
        setMomentumRecoveryMessage('Official portfolio fallback loaded.');
      })
      .catch(error => {
        if (error?.name === 'AbortError') return;
        setMomentumRecoveryState('idle');
        setMomentumRecoveryMessage(error.message);
      });
    return () => controller.abort();
  }, [selectedFund?.id, schemeId]);

  useEffect(() => {
    if (!selectedFund?.id || base.momentumState !== 'error' || usefulMomentum(base.momentumData) || usefulMomentum(officialMomentum)) return undefined;
    momentumControllerRef.current?.abort();
    const controller = new AbortController();
    momentumControllerRef.current = controller;
    setMomentumRecoveryState('syncing');
    const params = new URLSearchParams({
      fundId: selectedFund.id,
      schemeCode: String(selectedFund.preferredSchemeCode),
      recovery: String(Date.now())
    });
    fetchJson(`/api/fund-intelligence?${params}`, { signal: controller.signal, attempts: 2 })
      .then(data => {
        if (controller.signal.aborted) return;
        setRecoveredMomentum(data);
        setMomentumRecoveryState('ready');
        setMomentumRecoveryMessage('Portfolio intelligence recovered after the primary request failed.');
      })
      .catch(error => {
        if (error?.name === 'AbortError') return;
        setMomentumRecoveryState(usefulMomentum(cachedMomentum) ? 'degraded' : 'error');
        setMomentumRecoveryMessage(error.message);
      });
    return () => controller.abort();
  }, [base.momentumState, base.momentumData, officialMomentum, cachedMomentum, selectedFund?.id, selectedFund?.preferredSchemeCode, momentumRetryNonce]);

  const mergedMomentumData = useMemo(() => mergeMomentum({
    live: base.momentumData,
    recovered: recoveredMomentum,
    official: officialMomentum,
    cached: cachedMomentum,
    fundId: selectedFund?.id
  }), [base.momentumData, recoveredMomentum, officialMomentum, cachedMomentum, selectedFund?.id]);

  useEffect(() => {
    if (!selectedFund?.id || !usefulMomentum(mergedMomentumData)) return;
    try { window.localStorage.setItem(`managerlens:portfolio:${selectedFund.id}`, JSON.stringify(mergedMomentumData)); } catch {}
  }, [selectedFund?.id, mergedMomentumData]);

  useEffect(() => {
    navControllerRef.current?.abort();
    setCachedNav(null);
    setRecoveredNav(null);
    setNavRecoveryState('idle');
    setNavRecoveryMessage('');
    if (!navCacheKey) return;
    try {
      const saved = window.localStorage.getItem(navCacheKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (usefulNav(parsed)) setCachedNav(parsed);
      }
    } catch {}
  }, [navCacheKey]);

  useEffect(() => {
    if (!navCacheKey || base.fundSeries.length < 3 || base.proxySeries.length < 3) return;
    const value = {
      fundSeries: base.fundSeries,
      proxySeries: base.proxySeries,
      fundSource: base.fundSource,
      proxySource: base.proxySource,
      fetchedAt: new Date().toISOString()
    };
    try { window.localStorage.setItem(navCacheKey, JSON.stringify(value)); } catch {}
  }, [navCacheKey, base.fundSeries, base.proxySeries, base.fundSource, base.proxySource]);

  useEffect(() => {
    if (!selectedFund || base.navState !== 'error' || (base.fundSeries.length >= 3 && base.proxySeries.length >= 3)) return undefined;
    navControllerRef.current?.abort();
    const controller = new AbortController();
    navControllerRef.current = controller;
    setNavRecoveryState('syncing');
    setNavRecoveryMessage('Retrying the fund and selected NAV proxy with resilient upstream resolution…');
    recoverNav(base, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        setRecoveredNav(data);
        setNavRecoveryState('ready');
        setNavRecoveryMessage('Fund and proxy NAV histories recovered successfully.');
        if (navCacheKey) {
          try { window.localStorage.setItem(navCacheKey, JSON.stringify(data)); } catch {}
        }
      })
      .catch(error => {
        if (error?.name === 'AbortError') return;
        setNavRecoveryState(usefulNav(cachedNav) ? 'degraded' : 'error');
        setNavRecoveryMessage(error.message);
      });
    return () => controller.abort();
  }, [base.navState, base.fundSeries.length, base.proxySeries.length, selectedFund?.id, proxyIdentity, base.analysisStart, base.endDate, navRetryNonce]);

  const baseNav = base.fundSeries.length >= 3 && base.proxySeries.length >= 3
    ? { fundSeries: base.fundSeries, proxySeries: base.proxySeries, fundSource: base.fundSource, proxySource: base.proxySource }
    : null;
  const finalNav = baseNav || (usefulNav(recoveredNav) ? recoveredNav : null) || (usefulNav(cachedNav) ? cachedNav : null);
  const fundSeries = finalNav?.fundSeries || base.fundSeries;
  const proxySeries = finalNav?.proxySeries || base.proxySeries;
  const fundSource = finalNav?.fundSource || base.fundSource;
  const proxySource = finalNav?.proxySource || base.proxySource;

  const navState = baseNav
    ? base.navState
    : usefulNav(recoveredNav)
      ? 'ready'
      : usefulNav(cachedNav)
        ? (base.navState === 'syncing' ? 'syncing' : 'degraded')
        : navRecoveryState === 'syncing'
          ? 'syncing'
          : base.navState;
  const navMessage = baseNav
    ? base.navMessage
    : usefulNav(recoveredNav)
      ? navRecoveryMessage
      : usefulNav(cachedNav)
        ? `The last valid fund and proxy NAV dataset remains available. ${base.navMessage || navRecoveryMessage}`
        : navRecoveryMessage || base.navMessage;

  const baseMetrics = useMemo(() => computeMetrics(fundSeries, proxySeries, base.riskFree), [fundSeries, proxySeries, base.riskFree]);
  const metrics = useMemo(() => {
    const secondary = mergedMomentumData?.fundFacts?.riskMetrics || {};
    return {
      ...baseMetrics,
      alphaPct: Number.isFinite(baseMetrics.alphaPct) ? baseMetrics.alphaPct : secondary.alpha,
      beta: Number.isFinite(baseMetrics.beta) ? baseMetrics.beta : secondary.beta,
      sharpe: Number.isFinite(baseMetrics.sharpe) ? baseMetrics.sharpe : secondary.sharpe,
      volatilityPct: Number.isFinite(baseMetrics.volatilityPct) ? baseMetrics.volatilityPct : secondary.volatility
    };
  }, [baseMetrics, mergedMomentumData]);
  const score = useMemo(() => calculateManagerScore({
    schemeId: schemeId || 'generic',
    snapshot: mergedMomentumData?.snapshot || null,
    market: mergedMomentumData,
    traditional: metrics
  }), [schemeId, mergedMomentumData, metrics]);
  const provisional = score.coveragePct < 60;

  const hasMomentum = usefulMomentum(mergedMomentumData);
  const momentumState = hasMomentum
    ? (base.momentumState === 'syncing' && !usefulMomentum(base.momentumData) ? 'syncing' : 'ready')
    : momentumRecoveryState === 'syncing' || base.momentumState === 'syncing'
      ? 'syncing'
      : momentumRecoveryState === 'error' ? 'error' : base.momentumState;
  const momentumMessage = hasMomentum
    ? `${base.momentumMessage || 'Portfolio intelligence loaded.'}${momentumRecoveryMessage && !usefulMomentum(base.momentumData) ? ` ${momentumRecoveryMessage}` : ''}`
    : momentumRecoveryMessage || base.momentumMessage;

  const refreshAll = useCallback(async args => {
    setMomentumRetryNonce(value => value + 1);
    setNavRetryNonce(value => value + 1);
    return base.refreshAll(args);
  }, [base.refreshAll]);

  return {
    ...base,
    fundSeries,
    proxySeries,
    fundSource,
    proxySource,
    navState,
    navMessage,
    momentumData: mergedMomentumData,
    momentumState,
    momentumMessage,
    metrics,
    score,
    provisional,
    refreshAll
  };
}
