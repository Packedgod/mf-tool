// Pure maths over already-fetched fundamentals. Kept separate from lib/fundamentals.js so
// the scoring engine, which runs on the client, never pulls the server-only fetchers (and
// their filesystem-backed journals) into the browser bundle.

// Weight-averages a fundamental across holdings, ignoring rows that lack the field.
// Returns the value plus the share of portfolio weight the average actually covers.
export function weightedFundamental(holdings, field, { trim = true } = {}) {
  const rows = (holdings || [])
    .map(item => ({ weight: Number(item.weight), value: Number(item.fundamentals?.[field]) }))
    .filter(row => Number.isFinite(row.weight) && row.weight > 0 && Number.isFinite(row.value));
  if (!rows.length) return { value: undefined, coverageWeight: 0, n: 0 };

  const usable = trim
    ? rows.filter(row => row.value > -1000 && row.value < 1000)
    : rows;
  if (!usable.length) return { value: undefined, coverageWeight: 0, n: 0 };

  const totalWeight = usable.reduce((sum, row) => sum + row.weight, 0);
  const portfolioWeight = (holdings || []).reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
  return {
    value: usable.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight,
    coverageWeight: portfolioWeight ? totalWeight / portfolioWeight * 100 : 0,
    n: usable.length
  };
}
