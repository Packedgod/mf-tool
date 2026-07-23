'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useReliableManagerAnalytics from '@/components/analytics/useReliableManagerAnalytics';
import { calculateManagerLensScores } from '@/lib/scoring-v2';

const PROFILE_STORAGE_KEY = 'managerlens.investorProfile.v1';

export const DEFAULT_INVESTOR_PROFILE = {
  riskTolerance: 'moderate',
  horizon: 'long',
  goal: 'growth',
  maxDrawdownPct: 30,
  liquidityNeed: 'low',
  taxBracket: 'high',
  mode: 'sip'
};

function hasNav(data) {
  return Boolean(data?.fundSeries?.length >= 3 && data?.proxySeries?.length >= 3);
}

function hasMomentumPayload(payload) {
  return Boolean(
    payload?.holdings?.length
    || payload?.sectors?.length
    || payload?.snapshot?.sectorWeights?.length
  );
}

function deriveSectors(holdings = []) {
  const map = new Map();
  for (const item of holdings) {
    const weight = Number(item?.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const sector = String(item?.sector || 'Sector classification pending').trim();
    map.set(sector, (map.get(sector) || 0) + weight);
  }
  return [...map.entries()]
    .map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)) }))
    .sort((a, b) => b.weight - a.weight);
}

function mergePayload(primary, fallback, fundId) {
  if (!primary && !fallback) return null;
  const holdings = primary?.holdings?.length
    ? primary.holdings
    : primary?.snapshot?.holdings?.length
      ? primary.snapshot.holdings
      : fallback?.holdings?.length
        ? fallback.holdings
        : fallback?.snapshot?.holdings || [];
  let sectors = primary?.sectors?.length
    ? primary.sectors
    : primary?.snapshot?.sectorWeights?.length
      ? primary.snapshot.sectorWeights
      : fallback?.sectors?.length
        ? fallback.sectors
        : fallback?.snapshot?.sectorWeights || [];
  if (!sectors.length && holdings.length) sectors = deriveSectors(holdings);
  const entries = primary?.entries?.length ? primary.entries : fallback?.entries || [];
  const exits = primary?.exits?.length ? primary.exits : fallback?.exits || [];
  const primarySnapshot = primary?.snapshot || {};
  const fallbackSnapshot = fallback?.snapshot || {};
  const comparisonMode = primary?.coverage?.comparisonMode
    || primarySnapshot.comparisonMode
    || fallback?.coverage?.comparisonMode
    || fallbackSnapshot.comparisonMode
    || 'current-holdings-baseline';
  let snapshotCount = Math.max(
    Number(primary?.coverage?.snapshotCount || primarySnapshot.snapshotCount || 0),
    Number(fallback?.coverage?.snapshotCount || fallbackSnapshot.snapshotCount || 0),
    holdings.length ? 1 : 0
  );
  if ((entries.length || exits.length) && snapshotCount < 2 && comparisonMode !== 'reported-one-month-allocation-change') snapshotCount = 2;
  const resolvedPct = Math.max(
    Number(primary?.coverage?.resolvedPct || 0),
    Number(fallback?.coverage?.resolvedPct || 0),
    holdings.length && sectors.length ? 70 : holdings.length || sectors.length ? 55 : 0
  );

  return {
    ...(fallback || {}),
    ...(primary || {}),
    ok: true,
    holdings,
    sectors,
    entries,
    exits,
    snapshot: {
      ...fallbackSnapshot,
      ...primarySnapshot,
      holdings,
      sectorWeights: sectors,
      snapshotCount,
      comparisonMode
    },
    coverage: {
      ...(fallback?.coverage || {}),
      ...(primary?.coverage || {}),
      snapshotCount,
      resolvedPct,
      comparisonMode
    },
    sources: [...new Map([
      ...(primary?.sources || []),
      ...(fallback?.sources || [])
    ].map(item => [item?.url || `${item?.name}-${item?.type}`, item])).values()].filter(Boolean),
    __fundId: fundId
  };
}

export default function useDisplayedManagerAnalytics(options = {}) {
  const data = useReliableManagerAnalytics(options);
  const selectedFund = data.selectedFund;
  const [guardSnapshot, setGuardSnapshot] = useState(null);
  const [guardError, setGuardError] = useState('');
  const [guardExpired, setGuardExpired] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setGuardSnapshot(null);
    setGuardError('');
    setGuardExpired(false);
    if (!selectedFund?.id) return undefined;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      if (requestId !== requestRef.current) return;
      setGuardExpired(true);
      controller.abort();
    }, 35000);

    const params = new URLSearchParams({
      fundId: selectedFund.id,
      schemeCode: String(selectedFund.preferredSchemeCode || ''),
      displayName: selectedFund.displayName || '',
      fundHouse: selectedFund.fundHouse || '',
      category: selectedFund.category || '',
      preferredSchemeName: selectedFund.preferredSchemeName || selectedFund.displayName || '',
      canonicalName: selectedFund.canonicalName || selectedFund.displayName || '',
      uiGuard: String(Date.now())
    });

    fetch(`/api/fund-snapshot?${params}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
      .then(async response => {
        const text = await response.text();
        let payload;
        try { payload = JSON.parse(text); }
        catch { throw new Error(`Momentum snapshot returned a non-JSON response (${response.status}).`); }
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.detail || payload?.error || `Momentum snapshot failed (${response.status}).`);
        }
        return payload;
      })
      .then(payload => {
        if (controller.signal.aborted || requestId !== requestRef.current) return;
        setGuardSnapshot(payload);
        setGuardExpired(false);
      })
      .catch(error => {
        if (requestId !== requestRef.current) return;
        if (error?.name === 'AbortError' && !guardExpired) return;
        setGuardError(error?.message || 'Momentum snapshot could not be loaded.');
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    selectedFund?.id,
    selectedFund?.preferredSchemeCode,
    selectedFund?.displayName,
    selectedFund?.fundHouse
  ]);

  const momentumData = useMemo(
    () => mergePayload(data.momentumData, guardSnapshot, selectedFund?.id),
    [data.momentumData, guardSnapshot, selectedFund?.id]
  );
  const navReady = hasNav(data);
  const momentumReady = hasMomentumPayload(momentumData);
  const hardFailure = !momentumReady && (guardExpired || (guardError && data.momentumState === 'error'));

  const [investorProfile, setInvestorProfileState] = useState(null);
  useEffect(() => {
    const stored = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (stored) setInvestorProfileState({ ...DEFAULT_INVESTOR_PROFILE, ...JSON.parse(stored) });
  }, []);
  const setInvestorProfile = useCallback(next => {
    setInvestorProfileState(next);
    if (next) window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  }, []);

  // Recomputed here rather than reused from the reliable hook so that scoring sees the
  // guard-snapshot merge, which is where holdings and sector books often arrive.
  const score = useMemo(() => calculateManagerLensScores({
    fund: selectedFund,
    manager: data.manager,
    snapshot: momentumData?.snapshot || null,
    market: momentumData,
    traditional: data.metrics,
    peerData: data.peerData,
    selectedProxy: data.selectedProxy,
    investorProfile
  }), [selectedFund, data.manager, momentumData, data.metrics, data.peerData, data.selectedProxy, investorProfile]);

  return {
    ...data,
    score,
    provisional: score.headlines.fundQuality.status !== 'full',
    investorProfile,
    setInvestorProfile,
    momentumData,
    navState: navReady ? 'ready' : data.navState,
    navMessage: navReady
      ? `Fund and ${data.proxyName || 'selected proxy'} NAV histories are loaded and available for comparison.`
      : data.navMessage,
    momentumState: momentumReady ? 'ready' : hardFailure ? 'error' : data.momentumState,
    momentumMessage: momentumReady
      ? `${momentumData.holdings?.length || 0} holdings and ${momentumData.sectors?.length || momentumData.snapshot?.sectorWeights?.length || 0} sectors synchronised for the selected fund.`
      : hardFailure
        ? guardError || 'Momentum synchronisation reached its time limit without a validated portfolio snapshot.'
        : data.momentumMessage
  };
}
