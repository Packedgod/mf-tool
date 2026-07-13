'use client';

import useReliableManagerAnalytics from '@/components/analytics/useReliableManagerAnalytics';

function hasNav(data) {
  return Boolean(data?.fundSeries?.length >= 3 && data?.proxySeries?.length >= 3);
}

function hasMomentum(data) {
  return Boolean(
    data?.momentumData?.holdings?.length
    || data?.momentumData?.sectors?.length
    || data?.momentumData?.snapshot?.sectorWeights?.length
  );
}

export default function useDisplayedManagerAnalytics(options = {}) {
  const data = useReliableManagerAnalytics(options);
  const navReady = hasNav(data);
  const momentumReady = hasMomentum(data);

  return {
    ...data,
    navState: navReady ? 'ready' : data.navState,
    navMessage: navReady
      ? `Fund and ${data.proxyName || 'selected proxy'} NAV histories are loaded and available for comparison.`
      : data.navMessage,
    momentumState: momentumReady ? 'ready' : data.momentumState,
    momentumMessage: momentumReady
      ? `${data.momentumData.holdings?.length || 0} holdings and ${data.momentumData.sectors?.length || data.momentumData.snapshot?.sectorWeights?.length || 0} sectors loaded for the selected fund.`
      : data.momentumMessage
  };
}
