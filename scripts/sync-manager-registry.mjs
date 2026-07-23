import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse/lib/pdf-parse.js';

const AMFI_MEMBER_URLS = [
  'https://www.amfiindia.com/member',
  'https://www.amfiindia.com/mutual-fund-members'
];
const OUTPUT = path.resolve('data/manager-registry.generated.js');
const MAX_SITEMAPS_PER_SITE = 4;
const MAX_FACTSHEETS_PER_SITE = 3;
const REQUEST_TIMEOUT_MS = 15000;

const FALLBACK_OFFICIAL_SITES = [
  'https://amc.ppfas.com',
  'https://www.hdfcfund.com',
  'https://www.sbimf.com',
  'https://www.icicipruamc.com',
  'https://mutualfund.adityabirlacapital.com',
  'https://www.axismf.com',
  'https://bandhanmutual.com',
  'https://www.barodabnpparibasmf.in',
  'https://www.bajajamc.com',
  'https://www.canararobeco.com',
  'https://www.dspim.com',
  'https://www.edelweissmf.com',
  'https://www.franklintempletonindia.com',
  'https://growwmf.in',
  'https://www.assetmanagement.hsbc.co.in',
  'https://www.invescomutualfund.com',
  'https://www.itiamc.com',
  'https://www.jmfinancialmf.com',
  'https://www.kotakmf.com',
  'https://www.licmf.com',
  'https://www.mahindramanulife.com',
  'https://www.miraeassetmf.co.in',
  'https://www.motilaloswalmf.com',
  'https://www.navimutualfund.com',
  'https://mf.nipponindiaim.com',
  'https://www.njmutualfund.com',
  'https://www.oldbridge.com',
  'https://www.pgimindiamf.com',
  'https://quantmutual.com',
  'https://www.quantumamc.com',
  'https://www.samcomf.com',
  'https://www.shriramamc.in',
  'https://www.sundarammutual.com',
  'https://www.tatamutualfund.com',
  'https://www.taurusmutualfund.com',
  'https://www.trustmf.com',
  'https://www.unionmf.com',
  'https://www.utimf.com',
  'https://mf.whiteoakamc.com',
  'https://www.zerodhafundhouse.com',
  'https://www.jioblackrockamc.com'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xml,text/plain,application/pdf,*/*',
        'user-agent': 'ManagerLens official-disclosure synchroniser/0.1'
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/pdf,*/*',
        'user-agent': 'ManagerLens official-disclosure synchroniser/0.1'
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function externalLinks(html, baseUrl) {
  const links = [];
  const regex = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html))) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') links.push(url.href);
    } catch {}
  }
  return [...new Set(links)];
}

function officialDomainsFromAmfi(html, baseUrl) {
  const amfiHost = new URL(baseUrl).hostname.replace(/^www\./, '');
  return externalLinks(html, baseUrl)
    .map(link => {
      try {
        const url = new URL(link);
        return url.hostname.replace(/^www\./, '') === amfiHost ? null : `${url.protocol}//${url.host}`;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(site => !/facebook|linkedin|twitter|youtube|instagram|google/i.test(site));
}

async function discoverOfficialSites() {
  const sites = new Set(FALLBACK_OFFICIAL_SITES);
  for (const url of AMFI_MEMBER_URLS) {
    try {
      const { text } = await fetchText(url);
      officialDomainsFromAmfi(text, url).forEach(site => sites.add(site));
      if (sites.size > FALLBACK_OFFICIAL_SITES.length) break;
    } catch (error) {
      console.warn(`AMFI member discovery failed for ${url}: ${error.message}`);
    }
  }
  return [...sites];
}

function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(match => match[1].trim());
}

function factsheetCandidate(url) {
  return /fact[-_ ]?sheet|fund[-_ ]?facts|monthly[-_ ]?portfolio|portfolio[-_ ]?disclosure/i.test(url) && /\.pdf(?:$|\?)/i.test(url);
}

async function discoverFactsheets(site) {
  const found = new Set();
  const sitemapQueue = [];

  try {
    const { text: robots } = await fetchText(`${site}/robots.txt`, 8000);
    for (const match of robots.matchAll(/^sitemap:\s*(.+)$/gim)) sitemapQueue.push(match[1].trim());
  } catch {}

  sitemapQueue.push(`${site}/sitemap.xml`, `${site}/sitemap_index.xml`);

  const visited = new Set();
  for (const sitemap of sitemapQueue.slice(0, MAX_SITEMAPS_PER_SITE)) {
    if (visited.has(sitemap)) continue;
    visited.add(sitemap);
    try {
      const { text } = await fetchText(sitemap, 12000);
      const urls = sitemapUrls(text);
      urls.filter(factsheetCandidate).forEach(url => found.add(url));
      for (const nested of urls.filter(url => /sitemap/i.test(url)).slice(0, 2)) {
        try {
          const { text: nestedText } = await fetchText(nested, 12000);
          sitemapUrls(nestedText).filter(factsheetCandidate).forEach(url => found.add(url));
        } catch {}
      }
    } catch {}
  }

  if (!found.size) {
    try {
      const { text: home } = await fetchText(site, 10000);
      externalLinks(home, site).filter(factsheetCandidate).forEach(url => found.add(url));
    } catch {}
  }

  return [...found]
    .sort((a, b) => b.localeCompare(a))
    .slice(0, MAX_FACTSHEETS_PER_SITE);
}

function cleanName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;|,\-–—]+|[\s:;|,\-–—]+$/g, '')
    .trim();
}

function probableScheme(line) {
  const clean = cleanName(line);
  if (clean.length < 8 || clean.length > 140) return false;
  if (!/fund|scheme|etf/i.test(clean)) return false;
  if (/fund manager|manager since|benchmark|riskometer|disclaimer|mutual fund investments/i.test(clean)) return false;
  return true;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

// Factsheet tenure lines are written a dozen different ways across AMCs. Everything is
// normalised to a month-precision ISO date; a day-level value would imply a precision the
// documents mostly do not carry.
function parseTenureDate(value) {
  const text = cleanName(value);
  if (!text) return null;

  const dmy = text.match(/\b(\d{1,2})[\s\-\/.]*(?:st|nd|rd|th)?[\s\-\/.]+([A-Za-z]{3,9}|\d{1,2})[\s\-\/.]+(\d{4})\b/);
  if (dmy) {
    const monthToken = dmy[2].toLowerCase();
    const month = /^\d+$/.test(monthToken) ? Number(monthToken) - 1 : MONTHS[monthToken.slice(0, 3)];
    if (Number.isInteger(month) && month >= 0 && month <= 11) {
      return `${dmy[3]}-${String(month + 1).padStart(2, '0')}-01`;
    }
  }

  // Month-first phrasing ("Nov 21, 2016") is as common as day-first in these documents.
  const mdy = text.match(/\b([A-Za-z]{3,9})[\s.]+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{4})\b/);
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase().slice(0, 3)];
    if (Number.isInteger(month)) return `${mdy[3]}-${String(month + 1).padStart(2, '0')}-01`;
  }

  const monthYear = text.match(/\b([A-Za-z]{3,9})[\s,\-]+(\d{4})\b/);
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase().slice(0, 3)];
    if (Number.isInteger(month)) return `${monthYear[2]}-${String(month + 1).padStart(2, '0')}-01`;
  }

  return null;
}

// "Managing the scheme since <date>" and its variants, including the common "since
// inception" phrasing which conveys tenure without naming a date.
function extractTenure(text) {
  // Up to a few words may sit between the verb and the date marker ("Managed by the fund
  // w.e.f. ..."), and the date itself may be dot-separated, so the tail is length-bounded
  // rather than stopped at the first period.
  const match = String(text || '').match(
    /manag(?:ing|ed)\b[\w\s]{0,30}?\b(?:since|from|w\.?\s?e\.?\s?f\.?)\s*[:\-–—]?\s*([^;|)]{0,32})/i
  );
  if (!match) return null;
  const tail = match[1] || '';
  if (/inception/i.test(tail)) return { since: null, sinceInception: true };
  const since = parseTenureDate(tail);
  return since ? { since, sinceInception: false } : null;
}

const HONORIFICS = /^(?:mr|mrs|ms|miss|dr|shri|smt|sri|prof)\.?\s+/i;

function probableManagerName(value) {
  // The trailing \b matters: without it "and" matches inside surnames such as "Andani"
  // and silently truncates the name to its first word.
  let clean = cleanName(value)
    .replace(/\b(?:and|co-manager|for equity|for debt|overseas securities|effective from)\b.*$/i, '')
    .trim();

  // PDF text extraction keeps the field label glued to the value ("Name: Mr. Raj Mehta"),
  // which previously became part of the manager's stored name.
  clean = cleanName(clean.replace(/^(?:name|fund manager(?:s)?|managed by|manager)\s*[:\-–—]\s*/i, ''));
  while (HONORIFICS.test(clean)) clean = cleanName(clean.replace(HONORIFICS, ''));

  // Trim any tenure or qualification clause that ran on from the name.
  clean = cleanName(clean.replace(/\s*[,(\-–—]?\s*(?:manag(?:ing|ed)|total experience|experience|b\.?\s?tech|m\.?b\.?a|c\.?f\.?a|c\.?a\b).*$/i, ''));

  if (clean.length < 4 || clean.length > 60) return null;
  if (/benchmark|scheme|fund|portfolio|risk|return|nav|since inception|equity|debt|hybrid/i.test(clean)) return null;
  // A person's name carries no digits, and needs at least a given name and a surname.
  if (/\d/.test(clean)) return null;
  if (!/^[A-Za-z][A-Za-z.'\- ]*$/.test(clean)) return null;
  if (clean.split(/\s+/).filter(part => part.length > 1).length < 2) return null;
  return clean;
}

function extractAssignments(text, source) {
  const lines = String(text || '').split(/\r?\n/).map(cleanName).filter(Boolean);
  const records = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const managerMatch = line.match(/(?:fund manager(?:s)?|managed by|fund management team)\s*[:\-–—]?\s*(.+)$/i);
    if (!managerMatch) continue;

    const managerText = managerMatch[1] || lines[index + 1] || '';
    const names = managerText.split(/\s*(?:,|&|\/|\band\b)\s*/i).map(probableManagerName).filter(Boolean);
    if (!names.length) continue;

    // The tenure clause usually trails the manager name or sits on one of the next few
    // lines, so a small window is searched rather than the current line alone.
    const tenure = extractTenure(lines.slice(index, index + 4).join(' '));

    let schemeName = null;
    for (let cursor = index - 1; cursor >= Math.max(0, index - 24); cursor -= 1) {
      if (probableScheme(lines[cursor])) {
        schemeName = lines[cursor];
        break;
      }
    }
    if (!schemeName) continue;

    for (const name of names) {
      records.push({
        id: `${name}-${new URL(source.url).hostname}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        name,
        amc: source.host,
        role: 'Fund manager',
        schemeAliases: [schemeName],
        managingSince: tenure?.since || null,
        managingSinceInception: tenure?.sinceInception || false,
        verified: true,
        confidence: 0.82,
        sourceType: 'Official AMC factsheet — automated extraction',
        source: { label: source.label, url: source.url, asOf: source.asOf }
      });
    }
  }

  return records;
}

function mergeRecords(records) {
  const map = new Map();
  for (const record of records) {
    const key = `${record.name.toLowerCase()}::${record.amc.toLowerCase()}`;
    const previous = map.get(key);
    if (!previous) {
      map.set(key, record);
      continue;
    }
    // The earliest dated tenure across a manager's factsheets is the one that reflects how
    // long they have actually run money at the AMC.
    const since = [previous.managingSince, record.managingSince].filter(Boolean).sort()[0] || null;
    map.set(key, {
      ...previous,
      schemeAliases: [...new Set([...(previous.schemeAliases || []), ...(record.schemeAliases || [])])],
      managingSince: since,
      managingSinceInception: previous.managingSinceInception || record.managingSinceInception,
      confidence: Math.max(previous.confidence || 0, record.confidence || 0),
      source: record.source
    });
  }
  return [...map.values()].filter(record => record.confidence >= 0.8 && record.schemeAliases.length);
}

function asOfFromUrl(url) {
  const match = url.match(/(20\d{2})[-_/](0?[1-9]|1[0-2])|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ]?(20\d{2})/i);
  return match ? match[0] : new Date().toISOString().slice(0, 10);
}

async function main() {
  const sites = await discoverOfficialSites();
  const records = [];
  let sourcesScanned = 0;

  for (const site of sites) {
    const factsheets = await discoverFactsheets(site);
    if (!factsheets.length) continue;
    console.log(`${site}: ${factsheets.length} candidate factsheet(s)`);

    for (const url of factsheets) {
      try {
        const buffer = await fetchBuffer(url, 20000);
        const parsed = await pdf(buffer);
        const source = {
          host: new URL(site).hostname.replace(/^www\./, ''),
          label: `${new URL(site).hostname} official factsheet`,
          url,
          asOf: asOfFromUrl(url)
        };
        records.push(...extractAssignments(parsed.text, source));
        sourcesScanned += 1;
      } catch (error) {
        console.warn(`Failed ${url}: ${error.message}`);
      }
      await sleep(180);
    }
  }

  const merged = mergeRecords(records);
  const generatedAt = new Date().toISOString();
  const output = `// Auto-generated by scripts/sync-manager-registry.mjs.\nexport const GENERATED_MANAGER_REGISTRY = ${JSON.stringify(merged, null, 2)};\n\nexport const GENERATED_REGISTRY_META = ${JSON.stringify({ generatedAt, officialSourcesScanned: sourcesScanned, records: merged.length, officialSitesDiscovered: sites.length }, null, 2)};\n`;
  await fs.writeFile(OUTPUT, output, 'utf8');
  console.log(`Wrote ${merged.length} high-confidence manager records from ${sourcesScanned} official factsheets.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
