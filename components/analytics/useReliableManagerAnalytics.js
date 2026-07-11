'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useManagerAnalytics from '@/components/analytics/useManagerAnalytics';
import { detailedMomentumSchemeId } from '@/lib/dynamic-proxies';

const useful = data => Boolean(
  data?.holdings?.length
  || data?.sectors?.length
  || data?.snapshot?.sectorWeights?.length
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
  const rows = candidates.flatMap(item => item?.sources || []).filter(item => item?.name || item?.url);
  return [...new Map(rows.map(item => [item.url || `${item.name}-${item.type || ''}`, item])).values()];
}

function mergeMomentum({ live, recovered, official, cached, fundId }) {
  const candidates = [recovered, live, official, cached].filter(Boolean);
  if (!candidates.length) return null;
  const primary = candidates.find(useful) || candidates[0];
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
      usedRecoveredRequest: useful(recovered),
      usedOfficialFallback: useful(official),
      usedCachedDataset: !useful(recovered) && !useful(live) && !useful(official) && useful(cached)
    }
  };
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`The server returned a non-JSON response (${response.status}).`); }
  if (!response.ok || !data?.ok) throw new Error(data?.detail || data?.error || `Request failed (${response.status}).`);
  return data;
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

async function fetchWithRetry(url, signal, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fetchJson(url, signal); }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;
      if (attempt < attempts - 1) await wait(900 * (attempt + 1), signal);
    }
  }
  throw lastError;
}

export default function useReliableManagerAnalytics(options = {}) {
  const base = useManagerAnalytics(options);
  const [recoveredData, setRecoveredData] = useState(null);
  const [officialData, setOfficialData] = useState(null);
  const [cachedData, setCachedData] = useState(null);
  const [recoveryState, setRecoveryState] = useState('idle');
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const controllerRef = useRef(null);
  const selectedFund = base.selectedFund;
  const schemeId = useMemo(() => detailedMomentumSchemeId(selectedFund), [selectedFund]);

  useEffect(() => {
    controllerRef.current?.abort();
    setRecoveredData(null);
    setOfficialData(null);
    setCachedData(null);
    setRecoveryMessage('');
    if (!selectedFund?.id) return undefined;

    try {
      const saved = window.localStorage.getItem(`managerlens:portfolio:${selectedFund.id}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.__fundId === selectedFund.id && useful(parsed)) setCachedData(parsed);
      }
    } catch {}

    const controller = new AbortController();
    controllerRef.current = controller;
    const params = new URLSearchParams({
      fundId: selectedFund.id,
      schemeCode: String(selectedFund.preferredSchemeCode),
      uiRecovery: String(Date.now())
    });
    setRecoveryState('syncing');

    const livePromise = fetchWithRetry(`/api/fund-intelligence?${params}`, controller.signal, 2)
      .then(data => {
        if (!controller.signal.aborted) setRecoveredData(data);
        return data;
      });
    const officialPromise = schemeId
      ? fetchWithRetry(`/api/momentum?schemeId=${encodeURIComponent(schemeId)}&uiRecovery=${Date.now()}`, controller.signal, 2)
        .then(data => {
          if (!controller.signal.aborted) setOfficialData(data);
          return data;
        })
      : Promise.resolve(null);

    Promise.allSettled([livePromise, officialPromise]).then(results => {
      if (controller.signal.aborted) return;
      const fulfilled = results.some(item => item.status === 'fulfilled' && useful(item.value));
      if (fulfilled) {
        setRecoveryState('ready');
        setRecoveryMessage('Portfolio tables were verified through an independent recovery request.');
      } else {
        const errors = results.filter(item => item.status === 'rejected').map(item => item.reason?.message).filter(Boolean);
        setRecoveryState(cachedData ? 'degraded' : 'error');
        setRecoveryMessage(errors.join(' ') || 'No recovery dataset was returned.');
      }
    });

    return () => controller.abort();
  }, [selectedFund?.id, selectedFund?.preferredSchemeCode, schemeId, recoveryNonce]);

  const mergedMomentumData = useMemo(() => mergeMomentum({
    live: base.momentumData,
    recovered: recoveredData,
    official: officialData,
    cached: cachedData,
    fundId: selectedFund?.id
  }), [base.momentumData, recoveredData, officialData, cachedData, selectedFund?.id]);

  useEffect(() => {
    if (!selectedFund?.id || !useful(mergedMomentumData)) return;
    try {
      window.localStorage.setItem(`managerlens:portfolio:${selectedFund.id}`, JSON.stringify(mergedMomentumData));
    } catch {}
  }, [selectedFund?.id, mergedMomentumData]);

  useEffect(() => {
    if (!selectedFund || !['sectors', 'timing'].includes(base.activeTab)) return;
    if (!useful(mergedMomentumData) || base.momentumState === 'error') setRecoveryNonce(value => value + 1);
  }, [base.activeTab, selectedFund?.id]);

  const refreshAll = useCallback(async args => {
    setRecoveryNonce(value => value + 1);
    return base.refreshAll(args);
  }, [base.refreshAll]);

  const hasPortfolio = useful(mergedMomentumData);
  const momentumState = hasPortfolio
    ? (base.momentumState === 'ready' || recoveryState === 'ready' ? 'ready' : 'degraded')
    : (recoveryState === 'syncing' || base.momentumState === 'syncing' ? 'syncing' : base.momentumState || recoveryState);
  const momentumMessage = hasPortfolio
    ? `${base.momentumMessage || 'Portfolio intelligence loaded.'}${recoveryMessage ? ` ${recoveryMessage}` : ''}`
    : recoveryMessage || base.momentumMessage;

  return {
    ...base,
    momentumData: mergedMomentumData,
    momentumState,
    momentumMessage,
    refreshAll
  };
}
