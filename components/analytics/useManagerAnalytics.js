'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildSyntheticProxy, computeMetrics, normaliseSeries } from '@/lib/analytics';
import { calculateManagerScore } from '@/lib/momentum-engine';
import { detailedMomentumSchemeId, proxyProfileForFund } from '@/lib/dynamic-proxies';

const today = () => new Date().toISOString().slice(0, 10);
const yearsAgo = years => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
};
const validCode = value => /^\d{4,9}$/.test(String(value || '').trim());

async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.detail || data.error || 'Request failed.');
  return data;
}

async function requestSeries(payload) {
  const response = await fetch('/api/live/series', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store'
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.detail || data.error || 'Live NAV series failed.');
  return data;
}

export default function useManagerAnalytics({ initialManagerName = '', initialAmfiCode = '' } = {}) {
  const [managers, setManagers] = useState([]);
  const [managerId, setManagerId] = useState('');
  const [managerSearch, setManagerSearch] = useState('');
  const [managerState, setManagerState] = useState('loading');
  const [managerMessage, setManagerMessage] = useState('Loading the current Indian manager registry…');

  const [exactFunds, setExactFunds] = useState([]);
  const [amcFunds, setAmcFunds] = useState([]);
  const [selectedFundId, setSelectedFundId] = useState('');
  const [fundState, setFundState] = useState('idle');

  const [proxyMode, setProxyMode] = useState('official');
  const [proxyCodeInput, setProxyCodeInput] = useState('');
  const [proxyCode, setProxyCode] = useState('');
  const [proxyCodeStatus, setProxyCodeStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('racecard');
  const [startDate, setStartDate] = useState(yearsAgo(10));
  const [endDate, setEndDate] = useState(today());
  const [riskFree, setRiskFree] = useState(6.5);

  const [fundSeries, setFundSeries] = useState([]);
  const [proxySeries, setProxySeries] = useState([]);
  const [fundSource, setFundSource] = useState(null);
  const [proxySource, setProxySource] = useState(null);
  const [navState, setNavState] = useState('idle');
  const [navMessage, setNavMessage] = useState('Select a manager and fund.');

  const [momentumData, setMomentumData] = useState(null);
  const [momentumState, setMomentumState] = useState('idle');
  const [momentumMessage, setMomentumMessage] = useState('Waiting for a fund selection.');
  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const manager = useMemo(() => managers.find(item => item.id === managerId) || null, [managers, managerId]);
  const allFundOptions = useMemo(() => {
    const map = new Map();
    [...exactFunds, ...amcFunds].forEach(fund => map.set(fund.id, fund));
    return [...map.values()];
  }, [exactFunds, amcFunds]);
  const selectedFund = useMemo(() => allFundOptions.find(item => item.id === selectedFundId) || null, [allFundOptions, selectedFundId]);
  const exactAssignment = useMemo(() => exactFunds.some(item => item.id === selectedFundId), [exactFunds, selectedFundId]);
  const proxyProfiles = useMemo(() => proxyProfileForFund(selectedFund), [selectedFund]);
  const selectedProxy = proxyMode === 'custom' ? null : proxyProfiles[proxyMode] || proxyProfiles.official;
  const proxyName = proxyMode === 'custom'
    ? proxyCodeStatus?.schemeName || (proxyCode ? `AMFI scheme ${proxyCode}` : 'Custom proxy')
    : selectedProxy?.label;
  const detailedSchemeId = useMemo(() => detailedMomentumSchemeId(selectedFund), [selectedFund]);
  const analysisStart = manager?.startDate && manager.startDate > startDate ? manager.startDate : startDate;

  const filteredManagers = useMemo(() => {
    const query = managerSearch.trim().toLowerCase();
    if (!query) return managers;
    return managers.filter(item => [
      item.name,
      ...(item.aliases || []),
      item.amc,
      item.role,
      ...(item.schemeAliases || [])
    ].join(' ').toLowerCase().includes(query));
  }, [managers, managerSearch]);

  const metrics = useMemo(() => computeMetrics(fundSeries, proxySeries, riskFree), [fundSeries, proxySeries, riskFree]);
  const score = useMemo(() => calculateManagerScore({
    schemeId: detailedSchemeId || 'generic',
    snapshot: momentumData?.snapshot || null,
    market: momentumData,
    traditional: metrics
  }), [detailedSchemeId, momentumData, metrics]);
  const provisional = !detailedSchemeId || score.coveragePct < 60;

  useEffect(() => {
    let cancelled = false;
    getJson('/api/universe?view=managers')
      .then(data => {
        if (cancelled) return;
        const list = data.managers || [];
        setManagers(list);
        const desired = String(initialManagerName || '').trim().toLowerCase();
        const selected = list.find(item => item.name.toLowerCase() === desired || item.aliases?.some(alias => alias.toLowerCase() === desired))
          || list.find(item => item.id === 'sankaran-naren')
          || list[0];
        setManagerId(selected?.id || '');
        setManagerState('ready');
        setManagerMessage(`${list.length} source-tracked Indian manager records loaded.`);
      })
      .catch(error => {
        if (!cancelled) {
          setManagerState('error');
          setManagerMessage(error.message);
        }
      });
    return () => { cancelled = true; };
  }, [initialManagerName]);

  useEffect(() => {
    if (!managerId) return undefined;
    let cancelled = false;
    setFundState('loading');
    setExactFunds([]);
    setAmcFunds([]);
    setSelectedFundId('');
    getJson(`/api/universe?view=managerFunds&managerId=${encodeURIComponent(managerId)}`)
      .then(data => {
        if (cancelled) return;
        const exact = data.exactFunds || [];
        const amc = data.amcFunds || [];
        setExactFunds(exact);
        setAmcFunds(amc);
        const combined = [...exact, ...amc];
        const code = String(initialAmfiCode || '').trim();
        const fromCode = combined.find(fund => fund.variants?.some(variant => String(variant.schemeCode) === code));
        const selected = fromCode || exact[0] || amc[0] || null;
        setSelectedFundId(selected?.id || '');
        setFundState('ready');
        setProxyMode('official');
        setActiveTab('racecard');
      })
      .catch(error => {
        if (!cancelled) {
          setFundState('error');
          setNavMessage(error.message);
        }
      });
    return () => { cancelled = true; };
  }, [managerId, initialAmfiCode]);

  const validateProxyCode = useCallback(async () => {
    if (!validCode(proxyCodeInput)) {
      setProxyCodeStatus({ error: 'Enter a valid 4–9 digit AMFI scheme code.' });
      return;
    }
    setProxyCodeStatus({ loading: true });
    try {
      const data = await getJson(`/api/live/code?code=${encodeURIComponent(proxyCodeInput.trim())}`);
      setProxyCodeStatus(data);
      setProxyCode(proxyCodeInput.trim());
      setProxyMode('custom');
    } catch (error) {
      setProxyCodeStatus({ error: error.message });
    }
  }, [proxyCodeInput]);

  const loadNavData = useCallback(async ({ silent = false } = {}) => {
    if (!selectedFund) return;
    if (proxyMode === 'custom' && !validCode(proxyCode)) {
      setNavState('idle');
      setNavMessage('Validate the custom proxy AMFI code before loading.');
      return;
    }
    if (!silent) setNavState('syncing');
    setNavMessage(`Loading ${selectedFund.displayName} and the selected proxy…`);
    try {
      const fundPromise = requestSeries({ schemeCode: selectedFund.preferredSchemeCode, startDate: analysisStart, endDate });
      let proxyPromise;
      if (proxyMode === 'custom') {
        proxyPromise = requestSeries({ schemeCode: proxyCode, startDate: analysisStart, endDate })
          .then(result => ({ result, series: normaliseSeries(result.data) }));
      } else {
        proxyPromise = Promise.all(selectedProxy.components.map(component => requestSeries({
          queries: component.queries,
          startDate: analysisStart,
          endDate
        }))).then(results => ({
          result: results[0],
          results,
          series: buildSyntheticProxy(
            results.map(result => normaliseSeries(result.data)),
            selectedProxy.components.map(component => component.weight)
          )
        }));
      }
      const [fundResult, proxyBundle] = await Promise.all([fundPromise, proxyPromise]);
      const fund = normaliseSeries(fundResult.data);
      const proxy = proxyBundle.series;
      if (fund.length < 3 || proxy.length < 3) throw new Error('Insufficient overlapping NAV history for the selected period.');
      setFundSeries(fund);
      setProxySeries(proxy);
      setFundSource(fundResult.source);
      setProxySource(proxyBundle.result?.source || proxyBundle.results?.map(item => item.source));
      setNavState('ready');
      setNavMessage('Live fund and proxy histories loaded successfully.');
      setLastRefresh(new Date());
    } catch (error) {
      setNavState(fundSeries.length && proxySeries.length ? 'degraded' : 'error');
      setNavMessage(`${fundSeries.length && proxySeries.length ? 'The last valid chart remains visible. ' : ''}${error.message}`);
    }
  }, [selectedFund, proxyMode, proxyCode, selectedProxy, analysisStart, endDate, fundSeries.length, proxySeries.length]);

  const loadMomentumData = useCallback(async ({ silent = false } = {}) => {
    if (!selectedFund) return;
    if (!detailedSchemeId) {
      setMomentumData(null);
      setMomentumState('coverage');
      setMomentumMessage('The fund and manager are available, but detailed holdings, turnover and entry/exit history have not yet been normalised from the latest official factsheet. Momentum factors remain provisional.');
      return;
    }
    if (!silent) setMomentumState('syncing');
    try {
      const data = await getJson(`/api/momentum?schemeId=${encodeURIComponent(detailedSchemeId)}`);
      setMomentumData(data);
      setMomentumState(data.coverage?.resolvedPct >= 60 ? 'ready' : 'degraded');
      setMomentumMessage(`Detailed momentum data resolved for ${Math.round(data.coverage?.resolvedPct || 0)}% of requested symbols.`);
      setLastRefresh(new Date());
    } catch (error) {
      setMomentumState(momentumData ? 'degraded' : 'error');
      setMomentumMessage(`${momentumData ? 'The last valid momentum data remains visible. ' : ''}${error.message}`);
    }
  }, [selectedFund, detailedSchemeId, momentumData]);

  const refreshAll = useCallback(async ({ silent = false } = {}) => {
    await Promise.all([loadNavData({ silent }), loadMomentumData({ silent })]);
  }, [loadNavData, loadMomentumData]);

  useEffect(() => {
    if (!selectedFund) return undefined;
    const timer = window.setTimeout(() => refreshAll({ silent: true }), 250);
    return () => window.clearTimeout(timer);
  }, [selectedFundId, proxyMode, proxyCode, analysisStart, endDate]);

  useEffect(() => {
    if (!autoRefresh || !selectedFund) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshAll({ silent: true });
    }, 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, selectedFund, refreshAll]);

  return {
    managers, manager, managerId, setManagerId, managerSearch, setManagerSearch, filteredManagers,
    managerState, managerMessage, exactFunds, amcFunds, selectedFund, selectedFundId, setSelectedFundId,
    fundState, exactAssignment, proxyMode, setProxyMode, proxyCodeInput, setProxyCodeInput,
    proxyCodeStatus, validateProxyCode, selectedProxy, proxyName, activeTab, setActiveTab,
    startDate, setStartDate, analysisStart, endDate, setEndDate, riskFree, setRiskFree,
    fundSeries, proxySeries, fundSource, proxySource, navState, navMessage,
    momentumData, momentumState, momentumMessage, lastRefresh, autoRefresh, setAutoRefresh,
    metrics, score, provisional, refreshAll
  };
}
