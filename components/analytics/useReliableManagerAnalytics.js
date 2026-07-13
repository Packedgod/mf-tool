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

const usefulNav = data => Boolean(
  data?.fundSeries?.length >= 3
  && data?.proxySeries?.length >= 3
);

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
  const rows = candidates
    .flatMap(item => item?.sources || [])
    .filter(item => item?.name || item?.url);
  return [...new Map(rows.map(item => [item.url || `${item.name}-${item.type || ''}`, item])).values()];
}

function mergeMomentum({ live, baseLive, official, cached, fundId }) {
  const candidates = [live, baseLive, official, cached].filter(Boolean);
  if (!candidates.length) return null;

  const primary = candidates.find(usefulMomentum) || candidates[0];
  const holdings = firstRows(candidates, item => item?.holdings || item?.snapshot?.holdings);
  let sectors = firstRows(candidates, item => item?.sectors || item?.snapshot?.sectorWeights);
  if (!sectors.length && holdings.length) sectors = deriveSectors(holdings);
  const entries = firstRows(candidates, item => item?.entries);
  const exits = firstRows(candidates, item => item?.exits);
  const snapshots = candidates.map(item => item?.snapshot).filter(Boolean);
  const snapshot = { ...(snapshots.at(-1) || {}), ...(snapshots[0] || {}) };

  let snapshotCount = Math.max(
    0,
    ...candidates.map(item => Number(item?.coverage?.snapshotCount || item?.snapshot?.snapshotCount || 0))
  );
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
      comparisonMode: primary?.coverage?.comparisonMode
        || snapshot.comparisonMode
        || (snapshotCount >= 2 ? 'top-holdings-proxy' : 'current-holdings-baseline')
    },
    __fundId: fundId,
    recovery: {
      usedIndependentLiveRequest: usefulMomentum(live),
      usedPrimaryHookRequest: usefulMomentum(baseLive),
      usedOfficialFallback: usefulMomentum(official),
      usedCachedDataset: !usefulMomentum(live) && !usefulMomentum(baseLive) && !usefulMomentum(official) && usefulMomentum(cached)
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
      try { data = JSON.parse(text); }
      catch { throw new Error(`The server returned a non-JSON response (${response.status}).`); }
      if (!response.ok || !data?.ok) {
        throw new Error(data?.detail || data?.error || `Request failed (${response.status}).`);
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;
      if (attempt < attempts - 1) await wait(850 * (attempt + 1), signal);
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

async function loadNavBundle(base, signal) {
  const fundResult = await requestSeries({
    schemeCode: base.selectedFund.preferredSchemeCode,
    startDate: base.analysisStart,
    endDate: base.endDate
  }, signal);
  const fundSeries = normaliseSeries(fundResult.data);
  if (fundSeries.length < 3) throw new Error('The selected fund returned insufficient NAV history.');

  let proxySeries = [];
  let proxySource = null;

  if (base.proxyMode === 'custom') {
    const code = base.proxyCodeStatus?.schemeCode || base.proxyCodeInput;
    if (!/^\d{4,9}$/.test(String(code || '').trim())) {
      throw new Error('Validate the custom proxy AMFI code before loading it.');
    }
    const result = await requestSeries({
      schemeCode: code,
      startDate: base.analysisStart,
      endDate: base.endDate
    }, signal);
    proxySeries = normaliseSeries(result.data);
    proxySource = result.source;
  } else {
    const components = base.selectedProxy?.components || [];
    if (!components.length) throw new Error('No comparison proxy components are configured for the selected fund.');

    const settled = await Promise.allSettled(components.map(component => requestSeries({
      queries: component.queries,
      startDate: base.analysisStart,
      endDate: base.endDate
    }, signal)));

    const successful = settled
      .map((result, index) => result.status === 'fulfilled'
        ? { result: result.value, weight: Number(components[index].weight) || 0 }
        : null)
      .filter(Boolean)
      .filter(item => normaliseSeries(item.result.data).length >= 3);

    if (!successful.length) {
      const errors = settled
        .filter(item => item.status === 'rejected')
        .map(item => item.reason?.message)
        .filter(Boolean);
      throw new Error(errors.join(' ') || 'The configured comparison proxy returned no usable NAV history.');
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
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState(null);

  const proxyIdentity = base.proxyMode === 'custom'
    ? `custom:${base.proxyCodeStatus?.schemeCode || base.proxyCodeInput || ''}`
    : `${base.proxyMode}:${base.selectedProxy?.id || base.selectedProxy?.label || 'proxy'}`;

  const navCacheKey = selectedFund?.id
    ? `managerlens:nav:${selectedFund.id}:${proxyIdentity}:${base.analysisStart}:${base.endDate}`
    : '';
  const momentumCacheKey = selectedFund?.id ? `managerlens:portfolio:${selectedFund.id}` : '';

  const [authoritativeNav, setAuthoritativeNav] = useState(null);
  const [cachedNav, setCachedNav] = useState(null);
  const [navLoadState, setNavLoadState] = useState('idle');
  const [navLoadMessage, setNavLoadMessage] = useState('Select a fund.');
  const [navNonce, setNavNonce] = useState(0);
  const navControllerRef = useRef(null);

  const [authoritativeMomentum, setAuthoritativeMomentum] = useState(null);
  const [officialMomentum, setOfficialMomentum] = useState(null);
  const [cachedMomentum, setCachedMomentum] = useState(null);
  const [momentumLoadState, setMomentumLoadState] = useState('idle');
  const [momentumLoadMessage, setMomentumLoadMessage] = useState('Select a fund.');
  const [momentumNonce, setMomentumNonce] = useState(0);
  const momentumControllerRef = useRef(null);

  useEffect(() => {
    navControllerRef.current?.abort();
    setAuthoritativeNav(null);
    setCachedNav(null);
    setNavLoadMessage('Loading the selected fund and comparison proxy…');
    if (!selectedFund || !navCacheKey) {
      setNavLoadState('idle');
      return undefined;
    }

    try {
      const saved = window.localStorage.getItem(navCacheKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (usefulNav(parsed)) setCachedNav(parsed);
      }
    } catch {}

    const controller = new AbortController();
    navControllerRef.current = controller;
    setNavLoadState('syncing');

    loadNavBundle(base, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        setAuthoritativeNav(data);
        setNavLoadState('ready');
        setNavLoadMessage('Live fund and proxy NAV histories loaded successfully.');
        setLastSuccessfulRefresh(new Date());
        try { window.localStorage.setItem(navCacheKey, JSON.stringify(data)); } catch {}
      })
      .catch(error => {
        if (error?.name === 'AbortError') return;
        setNavLoadState(current => usefulNav(cachedNav) ? 'degraded' : 'error');
        setNavLoadMessage(error.message);
      });

    return () => controller.abort();
  }, [selectedFund?.id, selectedFund?.preferredSchemeCode, proxyIdentity, base.analysisStart, base.endDate, navNonce]);

  useEffect(() => {
    momentumControllerRef.current?.abort();
    setAuthoritativeMomentum(null);
    setOfficialMomentum(null);
    setCachedMomentum(null);
    setMomentumLoadMessage('Loading manager holdings, sectors and portfolio changes…');
    if (!selectedFund || !momentumCacheKey) {
      setMomentumLoadState('idle');
      return undefined;
    }

    try {
      const saved = window.localStorage.getItem(momentumCacheKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.__fundId === selectedFund.id && usefulMomentum(parsed)) setCachedMomentum(parsed);
      }
    } catch {}

    const controller = new AbortController();
    momentumControllerRef.current = controller;
    setMomentumLoadState('syncing');

    const params = new URLSearchParams({
      fundId: selectedFund.id,
      schemeCode: String(selectedFund.preferredSchemeCode),
      authoritative: String(Date.now())
    });

    const livePromise = fetchJson(`/api/fund-intelligence?${params}`, {
      signal: controller.signal,
      attempts: 2
    }).then(data => {
      if (!controller.signal.aborted) setAuthoritativeMomentum(data);
      return data;
    });

    const officialPromise = schemeId
      ? fetchJson(`/api/momentum?schemeId=${encodeURIComponent(schemeId)}&authoritative=${Date.now()}`, {
        signal: controller.signal,
        attempts: 2
      }).then(data => {
        if (!controller.signal.aborted) setOfficialMomentum(data);
        return data;
      })
      : Promise.resolve(null);

    Promise.allSettled([livePromise, officialPromise]).then(results => {
      if (controller.signal.aborted) return;
      const usable = results.some(result => result.status === 'fulfilled' && usefulMomentum(result.value));
      if (usable || usefulMomentum(base.momentumData)) {
        setMomentumLoadState('ready');
        setMomentumLoadMessage('Live manager holdings, sector positioning and timing coverage loaded successfully.');
        setLastSuccessfulRefresh(new Date());
      } else {
        const errors = results
          .filter(result => result.status === 'rejected')
          .map(result => result.reason?.message)
          .filter(Boolean);
        setMomentumLoadState(usefulMomentum(cachedMomentum) ? 'degraded' : 'error');
        setMomentumLoadMessage(errors.join(' ') || 'No validated portfolio dataset was returned.');
      }
    });

    return () => controller.abort();
  }, [selectedFund?.id, selectedFund?.preferredSchemeCode, schemeId, momentumNonce]);

  const mergedMomentumData = useMemo(() => mergeMomentum({
    live: authoritativeMomentum,
    baseLive: base.momentumData,
    official: officialMomentum,
    cached: cachedMomentum,
    fundId: selectedFund?.id
  }), [authoritativeMomentum, base.momentumData, officialMomentum, cachedMomentum, selectedFund?.id]);

  useEffect(() => {
    if (!momentumCacheKey || !usefulMomentum(mergedMomentumData)) return;
    try { window.localStorage.setItem(momentumCacheKey, JSON.stringify(mergedMomentumData)); } catch {}
  }, [momentumCacheKey, mergedMomentumData]);

  const baseNav = base.fundSeries.length >= 3 && base.proxySeries.length >= 3
    ? {
      fundSeries: base.fundSeries,
      proxySeries: base.proxySeries,
      fundSource: base.fundSource,
      proxySource: base.proxySource
    }
    : null;

  const finalNav = usefulNav(authoritativeNav)
    ? authoritativeNav
    : baseNav
      ? baseNav
      : usefulNav(cachedNav)
        ? cachedNav
        : null;

  const fundSeries = finalNav?.fundSeries || [];
  const proxySeries = finalNav?.proxySeries || [];
  const fundSource = finalNav?.fundSource || null;
  const proxySource = finalNav?.proxySource || null;

  const hasNav = fundSeries.length >= 3 && proxySeries.length >= 3;
  const navState = hasNav
    ? (usefulNav(authoritativeNav) || baseNav ? 'ready' : 'degraded')
    : navLoadState;
  const navMessage = hasNav
    ? (usefulNav(authoritativeNav)
      ? navLoadMessage
      : baseNav
        ? 'Live fund and proxy NAV histories loaded successfully.'
        : `The last valid fund and proxy NAV dataset remains visible. ${navLoadMessage}`)
    : navLoadMessage;

  const hasMomentum = usefulMomentum(mergedMomentumData);
  const momentumState = hasMomentum
    ? (usefulMomentum(authoritativeMomentum) || usefulMomentum(base.momentumData) || usefulMomentum(officialMomentum) ? 'ready' : 'degraded')
    : momentumLoadState;
  const momentumMessage = hasMomentum
    ? (momentumState === 'ready'
      ? 'Live manager holdings, sector positioning and timing coverage loaded successfully.'
      : `The last valid portfolio dataset remains visible. ${momentumLoadMessage}`)
    : momentumLoadMessage;

  const metricsBase = useMemo(
    () => computeMetrics(fundSeries, proxySeries, base.riskFree),
    [fundSeries, proxySeries, base.riskFree]
  );

  const metrics = useMemo(() => {
    const secondary = mergedMomentumData?.fundFacts?.riskMetrics || {};
    return {
      ...metricsBase,
      alphaPct: Number.isFinite(metricsBase.alphaPct) ? metricsBase.alphaPct : secondary.alpha,
      beta: Number.isFinite(metricsBase.beta) ? metricsBase.beta : secondary.beta,
      sharpe: Number.isFinite(metricsBase.sharpe) ? metricsBase.sharpe : secondary.sharpe,
      volatilityPct: Number.isFinite(metricsBase.volatilityPct) ? metricsBase.volatilityPct : secondary.volatility
    };
  }, [metricsBase, mergedMomentumData]);

  const score = useMemo(() => calculateManagerScore({
    schemeId: schemeId || 'generic',
    snapshot: mergedMomentumData?.snapshot || null,
    market: mergedMomentumData,
    traditional: metrics
  }), [schemeId, mergedMomentumData, metrics]);

  const refreshAll = useCallback(async () => {
    setNavNonce(value => value + 1);
    setMomentumNonce(value => value + 1);
  }, []);

  useEffect(() => {
    if (!base.autoRefresh || !selectedFund) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setNavNonce(value => value + 1);
        setMomentumNonce(value => value + 1);
      }
    }, 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [base.autoRefresh, selectedFund?.id]);

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
    provisional: score.coveragePct < 60,
    lastRefresh: lastSuccessfulRefresh || base.lastRefresh,
    refreshAll
  };
}
