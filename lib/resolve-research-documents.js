const DIRECT_DOCUMENT = /\.(?:xlsx?|xlsm|csv|pdf)(?:$|[?#])/i;
const RESEARCH_HINT = /monthly\s+portfolio|portfolio\s+disclosure|portfolio\s+statement|fact\s*sheet|factsheet|scheme\s+portfolio/i;
const GENERIC_DOCUMENT = /all[\s_-]*schemes|monthly[\s_-]*portfolio[\s_-]*(report|statement)|complete[\s_-]*portfolio/i;
const MAX_LANDING_PAGES = 5;
const MAX_DIRECT_DOCUMENTS = 10;
const BRAND_GROUPS = [
  { match: /parag parikh|ppfas/i, values: ['ppfas', 'parag parikh'] },
  { match: /kotak/i, values: ['kotak'] },
  { match: /axis/i, values: ['axis', 'axismf'] },
  { match: /hdfc/i, values: ['hdfc'] },
  { match: /\bsbi\b/i, values: ['sbi', 'sbimf'] },
  { match: /icici/i, values: ['icici', 'icicipru'] },
  { match: /nippon|reliance/i, values: ['nippon', 'reliance'] },
  { match: /bandhan|idfc/i, values: ['bandhan', 'idfc'] },
  { match: /aditya birla|birla/i, values: ['aditya birla', 'adityabirla', 'birla'] },
  { match: /mirae/i, values: ['mirae'] },
  { match: /motilal/i, values: ['motilal'] },
  { match: /tata/i, values: ['tata'] },
  { match: /quant/i, values: ['quant'] },
  { match: /franklin/i, values: ['franklin'] },
  { match: /invesco/i, values: ['invesco'] },
  { match: /dsp/i, values: ['dsp'] },
  { match: /uti/i, values: ['uti'] }
];
const STYLE_GROUPS = [
  ['flexi cap', 'flexicap'],
  ['small cap', 'smallcap'],
  ['mid cap', 'midcap', 'emerging equity'],
  ['large cap', 'largecap', 'bluechip', 'top 100'],
  ['balanced advantage', 'dynamic asset allocation'],
  ['equity savings'],
  ['multi asset', 'multi-asset'],
  ['business cycle'],
  ['focused'],
  ['value', 'contra']
];

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

function normalise(value) {
  return decodeURIComponent(String(value || '')).toLowerCase().replace(/[+_%-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(value) {
  return normalise(value)
    .replace(/\b(direct|regular|plan|growth|idcw|dividend|option|fund|scheme|mutual|monthly|portfolio|disclosure|report|as on|as of)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(token => token.length > 2);
}

function similarity(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter(token => b.has(token)).length;
  return overlap / Math.max(a.size, b.size);
}

function brandGroup(value) {
  return BRAND_GROUPS.find(group => group.match.test(value || '')) || null;
}

function styleSet(value) {
  const text = ` ${normalise(value)} `;
  return new Set(STYLE_GROUPS.map((group, index) => group.some(alias => text.includes(` ${alias} `)) ? index : -1).filter(index => index >= 0));
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
        'user-agent': 'ManagerLens/1.2 AdvisorKhoj document resolver'
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

function documentMatch(item, fundName) {
  const source = normalise(`${item.text || ''} ${item.url || ''}`);
  const generic = GENERIC_DOCUMENT.test(source);
  const match = similarity(source, fundName);
  const targetBrand = brandGroup(fundName);
  const sourceBrand = brandGroup(source);
  const targetPresent = targetBrand?.values.some(value => source.includes(value)) || false;
  const foreignBrand = Boolean(sourceBrand && targetBrand && sourceBrand !== targetBrand && !targetPresent);
  const fundStyles = styleSet(fundName);
  const documentStyles = styleSet(source);
  const styleMatch = !documentStyles.size || [...documentStyles].some(style => fundStyles.has(style));
  const styleConflict = Boolean(documentStyles.size && fundStyles.size && !styleMatch);
  return { generic, match, source, targetBrand, sourceBrand, targetPresent, foreignBrand, styleMatch, styleConflict };
}

function rankDocument(item, fundName) {
  const match = documentMatch(item, fundName);
  let score = match.match * 120;
  if (match.targetPresent) score += 30;
  if (match.styleMatch && !match.styleConflict) score += 25;
  if (match.generic) score += 40;
  if (/portfolio/i.test(match.source)) score += 20;
  if (/monthly/i.test(match.source)) score += 12;
  if (/\.xlsx?|\.xlsm/i.test(item.url)) score += 30;
  if (/\.pdf/i.test(item.url)) score += 10;
  if (/(20\d{2})[-_/ ]?(0?[1-9]|1[0-2])|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ]?(20\d{2})/i.test(match.source)) score += 8;
  return score;
}

function eligibleDocument(item, fundName) {
  const match = documentMatch(item, fundName);
  if (match.foreignBrand || match.styleConflict) return false;
  if (match.targetPresent && match.styleMatch) return true;
  if (match.generic && !match.foreignBrand) return true;
  return match.match >= 0.55;
}

export async function resolveAdvisorKhojDocuments(research, fundName = '') {
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

  const allDirect = [...direct, ...resolvedPages.flat()].filter(item => DIRECT_DOCUMENT.test(item.url || ''));
  const eligible = allDirect.filter(item => eligibleDocument(item, fundName));
  const ranked = eligible.sort((a, b) => rankDocument(b, fundName) - rankDocument(a, fundName));
  const finalDocuments = [...new Map(ranked.map(item => [item.url, item])).values()].slice(0, MAX_DIRECT_DOCUMENTS);

  if (!finalDocuments.length) {
    return {
      ...research,
      current: {
        ...current,
        advisorKhoj: advisor ? { ...advisor, officialDocuments: [] } : advisor
      },
      documentResolution: {
        attempted: landing.length,
        directDocuments: direct.length,
        resolvedDocuments: 0,
        rejectedAsOtherFunds: allDirect.length,
        failures
      }
    };
  }

  return {
    ...research,
    current: {
      ...current,
      advisorKhoj: { ...advisor, officialDocuments: finalDocuments }
    },
    documentResolution: {
      attempted: landing.length,
      directDocuments: direct.length,
      resolvedDocuments: finalDocuments.length,
      rejectedAsOtherFunds: Math.max(0, allDirect.length - eligible.length),
      selected: finalDocuments.slice(0, 5).map(item => ({
        url: item.url,
        text: item.text,
        score: Number(rankDocument(item, fundName).toFixed(2))
      })),
      failures
    }
  };
}
