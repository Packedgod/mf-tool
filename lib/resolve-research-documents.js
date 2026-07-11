const DIRECT_DOCUMENT = /\.(?:xlsx?|xlsm|csv|pdf)(?:$|[?#])/i;
const RESEARCH_HINT = /monthly\s+portfolio|portfolio\s+disclosure|portfolio\s+statement|fact\s*sheet|factsheet|scheme\s+portfolio/i;
const MAX_LANDING_PAGES = 5;
const MAX_DIRECT_DOCUMENTS = 12;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function stripHtml(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractLinks(html, base) {
  const result = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      result.push({ url: new URL(decodeHtml(match[1]), base).href, text: stripHtml(match[2]) });
    } catch {}
  }

  for (const match of String(html || '').matchAll(/(?:https?:\\?\/\\?\/|\/)[A-Za-z0-9_~:/?#\[\]@!$&'()*+,;=.%-]+\.(?:xlsx?|xlsm|csv|pdf)(?:\?[A-Za-z0-9_~:/?#\[\]@!$&'()*+,;=.%-]*)?/gi)) {
    try {
      const raw = decodeHtml(match[0]).replace(/\\\//g, '/');
      result.push({ url: new URL(raw, base).href, text: 'Document discovered in page source' });
    } catch {}
  }

  return [...new Map(result.map(item => [item.url, item])).values()];
}

function typeFor(url) {
  if (/\.xlsx?(?:$|[?#])|\.xlsm(?:$|[?#])/i.test(url)) return 'spreadsheet';
  if (/\.csv(?:$|[?#])/i.test(url)) return 'csv';
  if (/\.pdf(?:$|[?#])/i.test(url)) return 'pdf';
  return 'landing-page';
}

async function fetchHtml(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,*/*',
        'user-agent': 'ManagerLens/1.0 AdvisorKhoj document resolver'
      }
    });
    if (!response.ok) throw new Error(`Document landing page returned ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!/html|text/i.test(type)) return { ok: true, direct: true, url: response.url, type };
    return { ok: true, direct: false, url: response.url, html: await response.text(), type };
  } catch (error) {
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function rankDocument(item) {
  let score = 0;
  if (/portfolio/i.test(`${item.text} ${item.url}`)) score += 30;
  if (/monthly/i.test(`${item.text} ${item.url}`)) score += 20;
  if (/\.xlsx?|\.xlsm/i.test(item.url)) score += 35;
  if (/\.pdf/i.test(item.url)) score += 15;
  const date = `${item.text} ${item.url}`.match(/(20\d{2})[-_/ ]?(0?[1-9]|1[0-2])|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ]?(20\d{2})/i);
  if (date) score += 10;
  return score;
}

export async function resolveAdvisorKhojDocuments(research) {
  if (!research?.ok) return research;
  const current = research.current || {};
  const advisor = current.advisorKhoj;
  const initial = advisor?.officialDocuments || [];
  if (!initial.length) return research;

  const direct = initial
    .filter(item => DIRECT_DOCUMENT.test(item.url || ''))
    .map(item => ({ ...item, type: typeFor(item.url) }));
  const landing = initial
    .filter(item => !DIRECT_DOCUMENT.test(item.url || '') && RESEARCH_HINT.test(`${item.text || ''} ${item.url || ''}`))
    .slice(0, MAX_LANDING_PAGES);
  const failures = [];

  const resolvedPages = await Promise.all(landing.map(async item => {
    const page = await fetchHtml(item.url);
    if (!page.ok) {
      failures.push(`${item.url}: ${page.error}`);
      return [];
    }
    if (page.direct) return [{ ...item, url: page.url, type: typeFor(page.url) }];
    return extractLinks(page.html, page.url)
      .filter(link => DIRECT_DOCUMENT.test(link.url) || RESEARCH_HINT.test(`${link.text} ${link.url}`))
      .map(link => ({
        ...link,
        text: `${item.text || 'Portfolio disclosure'} — ${link.text || 'document'}`,
        type: typeFor(link.url)
      }));
  }));

  const candidates = [...direct, ...resolvedPages.flat()];
  const finalDocuments = [...new Map(candidates
    .filter(item => DIRECT_DOCUMENT.test(item.url || ''))
    .sort((a, b) => rankDocument(b) - rankDocument(a))
    .map(item => [item.url, item])).values()].slice(0, MAX_DIRECT_DOCUMENTS);

  if (!finalDocuments.length) {
    return {
      ...research,
      documentResolution: {
        attempted: landing.length,
        directDocuments: direct.length,
        resolvedDocuments: 0,
        failures
      }
    };
  }

  return {
    ...research,
    current: {
      ...current,
      advisorKhoj: {
        ...advisor,
        officialDocuments: finalDocuments
      }
    },
    documentResolution: {
      attempted: landing.length,
      directDocuments: direct.length,
      resolvedDocuments: finalDocuments.length,
      failures
    }
  };
}
