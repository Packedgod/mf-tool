const FRESH_MS = 15 * 60 * 1000;

function store() {
  globalThis.__MANAGERLENS_VRO_PORTFOLIO_CACHE__ ??= new Map();
  return globalThis.__MANAGERLENS_VRO_PORTFOLIO_CACHE__;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&rsquo;|&#8217;/gi, '’')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function textOf(html) {
  return decodeHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/li>|<\/h\d>|<\/div>|<\/tr>|<\/td>|<\/th>|<\/a>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function clean(value) {
  return String(value || '').replace(/^[•·\-–—\s]+/, '').replace(/\s+/g, ' ').trim();
}

function flatBlock(text, startMarker, endMarkers) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const start = lower.lastIndexOf(startMarker.toLowerCase());
  if (start < 0) return '';
  const after = start + startMarker.length;
  let end = -1;
  for (const marker of endMarkers) {
    const index = lower.indexOf(marker.toLowerCase(), after);
    if (index >= 0 && (end < 0 || index < end)) end = index;
  }
  return flat.slice(after, end >= 0 ? end : undefined).trim();
}

function validCompany(value) {
  const name = clean(value);
  if (name.length < 2 || name.length > 100 || !/[A-Za-z]/.test(name)) return false;
  return !/^(company|percentage|portfolio|see more|show all|created with|very high|min\.|fund|return|risk|nav|assets)/i.test(name)
    && !/highcharts|expense|turnover|benchmark|investment|withdrawal|cheques/i.test(name);
}

function parseHoldings(text) {
  const section = flatBlock(text, 'Company Percentage of Portfolio', [
    'See More',
    'What is the return',
    'What is the minimum investment',
    'FAQ for'
  ]);
  if (!section) return [];

  const result = [];
  const seen = new Set();
  const pattern = /([A-Za-z][A-Za-z0-9&.,'’()£\-\/ ]{1,90}?)\s+([0-9]{1,2}(?:\.[0-9]{1,4})?)(?=\s+[A-Za-z]|$)/g;
  for (const match of section.matchAll(pattern)) {
    const name = clean(match[1]);
    const weight = Number(match[2]);
    const key = name.toLowerCase();
    if (!validCompany(name) || !Number.isFinite(weight) || weight <= 0 || weight > 25 || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, weight });
    if (result.length >= 20) break;
  }

  if (result.length) return result;
  const rows = String(text || '').split(/\n+/).map(clean).filter(Boolean);
  const markerIndex = rows.findIndex(row => /Company\s+Percentage\s+of\s+Portfolio/i.test(row));
  if (markerIndex < 0) return [];
  for (let index = markerIndex + 2; index < rows.length; index += 1) {
    if (/See More|What is the return|What is the minimum investment/i.test(rows[index])) break;
    const value = rows[index].match(/^([0-9]{1,2}(?:\.[0-9]{1,4})?)%?$/);
    if (!value) continue;
    const name = rows[index - 1];
    const weight = Number(value[1]);
    const key = name.toLowerCase();
    if (!validCompany(name) || !Number.isFinite(weight) || weight <= 0 || weight > 25 || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, weight });
  }
  return result.slice(0, 20);
}

function parseAllocation(text, heading, endHeading, labels) {
  const section = flatBlock(text, heading, [endHeading]);
  const result = [];
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const first = section.match(new RegExp(`([0-9]+(?:\\.[0-9]+)?)%\\s*${escaped}`, 'i'));
    const second = section.match(new RegExp(`${escaped}\\s*([0-9]+(?:\\.[0-9]+)?)%`, 'i'));
    const match = first || second;
    if (match) result.push({ name: label, weight: Number(match[1]) });
  }
  return result;
}

async function fetchPage(url, timeoutMs = 14000) {
  const cached = store().get(url);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,*/*',
        'user-agent': 'ManagerLens/1.2 Value Research exact-portfolio reader'
      }
    });
    if (!response.ok) throw new Error(`Value Research returned ${response.status}`);
    const value = { ok: true, url: response.url, html: await response.text(), fetchedAt: new Date().toISOString() };
    store().set(url, { at: Date.now(), value });
    return value;
  } catch (error) {
    if (cached) return { ...cached.value, stale: true, warning: error instanceof Error ? error.message : String(error) };
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshValueResearchPortfolio(research) {
  if (!research?.ok) return research;
  const current = research.current || {};
  const valueResearch = current.valueResearch;
  if (!valueResearch?.url) return research;

  const page = await fetchPage(valueResearch.url);
  if (!page.ok) {
    return { ...research, exactValueResearchPortfolio: { ok: false, error: page.error } };
  }

  const text = textOf(page.html);
  const holdings = parseHoldings(text);
  const assetAllocation = parseAllocation(text, 'Asset Allocation', 'Market Cap Weightage', ['Equity', 'Debt', 'Real Estate', 'Cash & Cash Eq.', 'Cash']);
  const marketCap = parseAllocation(text, 'Market Cap Weightage', 'Portfolio Breakdown', ['Large', 'Mid', 'Small']);
  const navDate = text.match(/latest declared NAV[\s\S]{0,220}?as of\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i)?.[1]
    || text.match(/As on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i)?.[1]
    || valueResearch.navDate;

  if (!holdings.length) {
    return {
      ...research,
      exactValueResearchPortfolio: {
        ok: false,
        error: 'The exact Company Percentage of Portfolio block was not present in the returned page.',
        url: page.url
      }
    };
  }

  const updatedValueResearch = {
    ...valueResearch,
    url: page.url,
    fetchedAt: page.fetchedAt,
    holdings,
    assetAllocation: assetAllocation.length ? assetAllocation : valueResearch.assetAllocation || [],
    marketCap: marketCap.length ? marketCap : valueResearch.marketCap || [],
    navDate
  };

  return {
    ...research,
    current: {
      ...current,
      valueResearch: updatedValueResearch,
      holdings,
      assetAllocation: updatedValueResearch.assetAllocation,
      marketCap: updatedValueResearch.marketCap,
      portfolioAsOf: navDate || current.portfolioAsOf
    },
    exactValueResearchPortfolio: {
      ok: true,
      url: page.url,
      fetchedAt: page.fetchedAt,
      holdings: holdings.length,
      totalTopHoldingWeight: Number(holdings.reduce((sum, item) => sum + item.weight, 0).toFixed(4)),
      stale: Boolean(page.stale)
    }
  };
}
