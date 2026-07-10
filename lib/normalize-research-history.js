const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12'
};

export function normalizeResearchDate(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  let match = input.match(/^(20\d{2})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = input.match(/^(\d{1,2})-([A-Za-z]{3,9})-(20\d{2})$/);
  if (match) {
    const month = MONTHS[match[2].slice(0, 4).toLowerCase()] || MONTHS[match[2].slice(0, 3).toLowerCase()];
    if (month) return `${match[3]}-${month}-${String(match[1]).padStart(2, '0')}`;
  }
  match = input.match(/^(\d{1,2})[-/](\d{1,2})[-/](20\d{2})$/);
  if (match) return `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  match = input.match(/\b([A-Za-z]{3,9})[\s_-]+(20\d{2}|\d{2})\b/);
  if (match) {
    const month = MONTHS[match[1].slice(0, 4).toLowerCase()] || MONTHS[match[1].slice(0, 3).toLowerCase()];
    const year = match[2].length === 2 ? `20${match[2]}` : match[2];
    if (month) return `${year}-${month}-01`;
  }
  return null;
}

function signature(snapshot) {
  return (snapshot?.holdings || []).slice(0, 12).map(item => String(item.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).sort().join('|');
}

export function normalizeResearchHistory(research) {
  if (!research?.ok || !research.portfolioHistory?.length) return research;
  const deduped = [];
  for (const item of research.portfolioHistory) {
    const normalized = { ...item, asOf: normalizeResearchDate(item.asOf || item.source?.asOf) || item.asOf || null };
    const month = normalized.asOf?.slice(0, 7);
    const existingIndex = deduped.findIndex(row => month && row.asOf?.slice(0, 7) === month);
    if (existingIndex >= 0) {
      if ((normalized.holdings?.length || 0) > (deduped[existingIndex].holdings?.length || 0)) deduped[existingIndex] = normalized;
      continue;
    }
    if (deduped.some(row => signature(row) && signature(row) === signature(normalized))) continue;
    deduped.push(normalized);
  }
  deduped.sort((a, b) => String(b.asOf || '').localeCompare(String(a.asOf || '')) || (b.holdings?.length || 0) - (a.holdings?.length || 0));
  const latest = deduped[0];
  const previous = deduped.find(item => !latest.asOf || !item.asOf || item.asOf.slice(0, 7) !== latest.asOf.slice(0, 7));
  if (!latest) return research;
  const mode = latest.completePortfolio && previous?.completePortfolio ? 'complete-portfolio' : 'top-holdings-proxy';

  return {
    ...research,
    current: {
      ...research.current,
      holdings: latest.holdings || research.current?.holdings || [],
      sectors: latest.sectors || research.current?.sectors || [],
      portfolioAsOf: latest.asOf,
      officialPortfolio: {
        ...(research.current?.officialPortfolio || {}),
        source: latest.source,
        comparisonMode: mode,
        snapshotCount: deduped.length,
        coverage: { holdings: latest.holdings?.length || 0, sectors: latest.sectors?.length || 0 }
      }
    },
    previous: previous ? {
      ...(research.previous || {}),
      holdings: previous.holdings || [],
      sectors: previous.sectors || [],
      portfolioAsOf: previous.asOf,
      fetchedAt: previous.asOf,
      sources: previous.source ? [previous.source] : []
    } : research.previous,
    portfolioHistory: deduped,
    portfolioComparison: {
      mode,
      currentAsOf: latest.asOf,
      previousAsOf: previous?.asOf || null,
      snapshotCount: deduped.length,
      currentSource: latest.source,
      previousSource: previous?.source || null
    }
  };
}
