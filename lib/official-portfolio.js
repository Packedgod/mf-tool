import * as XLSX from 'xlsx';

const MAX_DOCUMENTS = 8;
const MAX_ROWS_PER_SHEET = 5000;
const MONTHS = {
  jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
  apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07',
  aug: '08', august: '08', sep: '09', sept: '09', september: '09', oct: '10', october: '10',
  nov: '11', november: '11', dec: '12', december: '12'
};

function tokenise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(direct|regular|plan|growth|idcw|dividend|option|fund|scheme|mutual)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(token => token.length > 2);
}

function similarity(left, right) {
  const a = new Set(tokenise(left));
  const b = new Set(tokenise(right));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter(token => b.has(token)).length;
  return overlap / Math.max(a.size, b.size);
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const negative = /^\(.*\)$/.test(String(value || '').trim());
  const cleaned = String(value || '').replace(/[%₹,()]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '—') return undefined;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? (negative ? -numeric : numeric) : undefined;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function canonicalName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b(limited|ltd|inc|corporation|corp|company|co)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyHeader(value) {
  const text = cleanText(value).toLowerCase();
  if (/isin/.test(text)) return 'isin';
  if (/industry|sector|classification/.test(text)) return 'sector';
  if (/%.*nav|nav.*%|percentage.*nav|%.*net asset|weight.*%|portfolio.*%|% of net/.test(text)) return 'weight';
  if (/name of (the )?instrument|instrument name|name of issuer|issuer name|company name|security name|particulars|description/.test(text)) return 'name';
  return null;
}

function locateHeader(rows) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 120); rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const mapping = {};
    row.forEach((cell, column) => {
      const type = classifyHeader(cell);
      if (type && mapping[type] === undefined) mapping[type] = column;
    });
    if (mapping.name !== undefined && mapping.weight !== undefined) return { rowIndex, mapping };
  }
  return null;
}

function normaliseSector(value) {
  const text = cleanText(value);
  if (!text) return 'Unclassified';
  if (/bank|finance|financial|insurance/i.test(text)) return 'Financial Services';
  if (/software|information technology|computer|it services/i.test(text)) return 'Information Technology';
  if (/pharma|health|hospital|biotech/i.test(text)) return 'Healthcare';
  if (/automobile|auto component|vehicle/i.test(text)) return 'Automobile and Auto Components';
  if (/fmcg|consumer staple|food|beverage|tobacco/i.test(text)) return 'Fast Moving Consumer Goods';
  if (/retail|consumer service|leisure|travel|restaurant|aviation/i.test(text)) return 'Consumer Services';
  if (/oil|gas|energy|power|coal|petroleum/i.test(text)) return 'Energy';
  if (/metal|mining|steel|aluminium/i.test(text)) return 'Metals & Mining';
  if (/realty|real estate/i.test(text)) return 'Realty';
  if (/telecom|communication/i.test(text)) return 'Telecommunication';
  if (/capital goods|industrial|engineering|construction|infrastructure/i.test(text)) return 'Capital Goods';
  if (/chemical|fertilizer|pesticide/i.test(text)) return 'Chemicals';
  if (/cement/.test(text)) return 'Cement & Cement Products';
  if (/textile|apparel/.test(text)) return 'Textiles & Apparels';
  return text;
}

function validHoldingName(value) {
  const name = cleanText(value);
  if (name.length < 3 || name.length > 180) return false;
  if (/^(total|sub total|subtotal|grand total|equity|debt|cash|net assets|derivative|treps|repo|money market|mutual fund units|exchange traded fund)/i.test(name)) return false;
  if (/aggregate|exposure|market value|percentage to nav|coupon|maturity/i.test(name)) return false;
  return /[A-Za-z]/.test(name);
}

function parseSheet(rows, sheetName) {
  const header = locateHeader(rows);
  if (!header) return [];
  const { rowIndex, mapping } = header;
  const holdings = [];
  let blankRun = 0;

  for (let index = rowIndex + 1; index < Math.min(rows.length, rowIndex + MAX_ROWS_PER_SHEET); index += 1) {
    const row = rows[index] || [];
    const name = cleanText(row[mapping.name]);
    const weight = numberValue(row[mapping.weight]);
    if (!name && weight === undefined) {
      blankRun += 1;
      if (blankRun > 35 && holdings.length) break;
      continue;
    }
    blankRun = 0;
    if (!validHoldingName(name) || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    const sector = normaliseSector(mapping.sector !== undefined ? row[mapping.sector] : 'Unclassified');
    const isin = mapping.isin !== undefined ? cleanText(row[mapping.isin]) : null;
    holdings.push({ name, sector, weight, isin: isin || null, sheetName });
  }

  return holdings;
}

function chooseSheets(workbook, fundName) {
  const scored = workbook.SheetNames.map(name => ({ name, score: similarity(name, fundName) }));
  const strong = scored.filter(item => item.score >= 0.2).sort((a, b) => b.score - a.score);
  if (strong.length) return strong.slice(0, 8).map(item => item.name);
  return workbook.SheetNames.slice(0, 18);
}

function dedupeHoldings(records) {
  const map = new Map();
  for (const holding of records) {
    const key = canonicalName(holding.name);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || holding.weight > existing.weight) map.set(key, holding);
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight);
}

function aggregateSectors(holdings) {
  const map = new Map();
  for (const holding of holdings) {
    if (!holding.sector || holding.sector === 'Unclassified') continue;
    map.set(holding.sector, (map.get(holding.sector) || 0) + holding.weight);
  }
  return [...map.entries()]
    .map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)) }))
    .sort((a, b) => b.weight - a.weight);
}

function parseDocumentDate(document) {
  const input = `${document?.text || ''} ${document?.url || ''}`.toLowerCase();
  let match = input.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[\s_\-]*(20\d{2}|\d{2})\b/i);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    const year = match[2].length === 2 ? `20${match[2]}` : match[2];
    return `${year}-${month}-01`;
  }
  match = input.match(/\b(20\d{2})[\-_\/](0?[1-9]|1[0-2])\b/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-01`;
  match = input.match(/\b(0?[1-9]|1[0-2])[\-_\/](20\d{2})\b/);
  if (match) return `${match[2]}-${String(match[1]).padStart(2, '0')}-01`;
  return null;
}

async function fetchBuffer(url, timeoutMs = 22000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*',
        'user-agent': 'ManagerLens/0.9 AdvisorKhoj-ValueResearch portfolio-history reader'
      }
    });
    if (!response.ok) throw new Error(`Research document returned ${response.status}`);
    return { buffer: Buffer.from(await response.arrayBuffer()), url: response.url, type: response.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

function isWorkbook(document) {
  return /\.xlsx?(?:$|\?)/i.test(document.url || '') || /excel|spreadsheet/i.test(document.type || document.text || '');
}

function isPdf(document) {
  return /\.pdf(?:$|\?)/i.test(document.url || '') || /pdf|factsheet/i.test(document.type || document.text || '');
}

function parseWorkbook(buffer, fundName) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, dense: false });
  const selectedSheets = chooseSheets(workbook, fundName);
  const holdings = [];
  for (const sheetName of selectedSheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    holdings.push(...parseSheet(rows, sheetName));
  }
  return { holdings: dedupeHoldings(holdings), sheetNames: selectedSheets };
}

function likelySector(value) {
  const text = cleanText(value);
  if (!text || text.length > 90) return false;
  return /bank|financial|insurance|software|technology|pharma|health|automobile|auto component|fmcg|consumer|energy|oil|gas|power|metal|mining|realty|telecom|capital goods|industrial|construction|chemical|cement|textile/i.test(text);
}

function parsePdfLines(text, fundName) {
  const raw = String(text || '').replace(/\r/g, '\n');
  const lower = raw.toLowerCase();
  const tokens = tokenise(fundName);
  let start = -1;
  for (const token of tokens.slice(0, 4)) {
    const index = lower.indexOf(token);
    if (index >= 0 && (start < 0 || index < start)) start = index;
  }
  const segment = start >= 0 ? raw.slice(Math.max(0, start - 1500), start + 45000) : raw.slice(0, 60000);
  const lines = segment.split(/\n+/).map(cleanText).filter(Boolean);
  const holdings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trailing = line.match(/^(.*?)(?:\s+|\|)(-?\d{1,2}(?:\.\d{1,4})?)%?$/);
    if (!trailing) continue;
    const weight = Number(trailing[2]);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 25) continue;
    let left = cleanText(trailing[1]);
    left = left.replace(/\bINE[A-Z0-9]{9,12}\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!validHoldingName(left)) continue;

    let sector = 'Unclassified';
    const parts = left.split(/\s{2,}|\s+\|\s+/).map(cleanText).filter(Boolean);
    if (parts.length > 1 && likelySector(parts.at(-1))) {
      sector = normaliseSector(parts.pop());
      left = parts.join(' ');
    } else if (likelySector(lines[index - 1])) {
      sector = normaliseSector(lines[index - 1]);
    }
    if (!validHoldingName(left)) continue;
    holdings.push({ name: left, sector, weight, isin: null, sheetName: 'PDF factsheet' });
  }

  return { holdings: dedupeHoldings(holdings).slice(0, 80), sheetNames: ['PDF factsheet'] };
}

async function parseResearchDocument(document, fundName) {
  const fetched = await fetchBuffer(document.url);
  let parsed;
  if (isWorkbook(document)) {
    parsed = parseWorkbook(fetched.buffer, fundName);
  } else if (isPdf(document)) {
    const module = await import('pdf-parse');
    const pdfParse = module.default || module;
    const pdf = await pdfParse(fetched.buffer);
    parsed = parsePdfLines(pdf.text, fundName);
  } else {
    throw new Error('Unsupported research document type');
  }

  const holdings = parsed.holdings || [];
  const sectors = aggregateSectors(holdings);
  if (holdings.length < 3) throw new Error('No usable holdings table found');
  return {
    asOf: parseDocumentDate(document),
    holdings: holdings.slice(0, 80),
    sectors,
    source: {
      name: isWorkbook(document) ? 'AdvisorKhoj-linked monthly portfolio disclosure' : 'AdvisorKhoj-linked fund factsheet',
      type: isWorkbook(document) ? 'Portfolio workbook linked by AdvisorKhoj' : 'Fund factsheet linked by AdvisorKhoj',
      url: fetched.url,
      asOf: document.text || parseDocumentDate(document) || 'latest available disclosure'
    },
    sheetNames: parsed.sheetNames,
    coverage: { holdings: holdings.length, sectors: sectors.length },
    completePortfolio: holdings.length >= 15
  };
}

function publicSnapshot(provider, holdings, sectors, asOf, url) {
  if (!holdings?.length) return null;
  return {
    asOf: asOf || null,
    holdings: dedupeHoldings(holdings).slice(0, 80),
    sectors: sectors?.length ? sectors : aggregateSectors(holdings),
    source: {
      name: provider,
      type: 'Public fund holdings and portfolio facts',
      url: url || null,
      asOf: asOf || 'current'
    },
    sheetNames: [],
    coverage: { holdings: holdings.length, sectors: sectors?.length || 0 },
    completePortfolio: holdings.length >= 15
  };
}

function distinctSnapshots(snapshots) {
  const sorted = snapshots
    .filter(Boolean)
    .sort((a, b) => String(b.asOf || '').localeCompare(String(a.asOf || '')) || b.holdings.length - a.holdings.length);
  const result = [];
  for (const snapshot of sorted) {
    const sameDate = result.findIndex(item => item.asOf && snapshot.asOf && item.asOf.slice(0, 7) === snapshot.asOf.slice(0, 7));
    if (sameDate >= 0) {
      if (snapshot.holdings.length > result[sameDate].holdings.length) result[sameDate] = snapshot;
      continue;
    }
    const signature = snapshot.holdings.slice(0, 10).map(item => canonicalName(item.name)).sort().join('|');
    if (result.some(item => item.holdings.slice(0, 10).map(row => canonicalName(row.name)).sort().join('|') === signature)) continue;
    result.push(snapshot);
  }
  return result;
}

export async function extractOfficialPortfolioHistory(documents, fundName) {
  const candidates = (documents || []).filter(document => isWorkbook(document) || isPdf(document)).slice(0, MAX_DOCUMENTS);
  const failures = [];
  const snapshots = [];

  const parsed = await Promise.all(candidates.map(async document => {
    try {
      return await parseResearchDocument(document, fundName);
    } catch (error) {
      failures.push(`${document.url}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }));
  snapshots.push(...parsed.filter(Boolean));
  return { ok: snapshots.length > 0, snapshots: distinctSnapshots(snapshots), failures };
}

export async function enrichResearchWithOfficialPortfolio(research, fundName) {
  if (!research?.ok) return research;
  const current = research.current || {};
  const documents = current.advisorKhoj?.officialDocuments || [];
  const history = documents.length
    ? await extractOfficialPortfolioHistory(documents, fundName)
    : { ok: false, snapshots: [], failures: [] };

  const sourceSnapshots = [
    publicSnapshot('Value Research Online', current.valueResearch?.holdings || [], [], current.valueResearch?.navDate, current.valueResearch?.url),
    publicSnapshot('AdvisorKhoj', current.advisorKhoj?.holdings || [], current.advisorKhoj?.sectors || [], current.advisorKhoj?.navDate, current.advisorKhoj?.url),
    ...(history.snapshots || [])
  ];

  if (research.previous?.holdings?.length) {
    sourceSnapshots.push(publicSnapshot(
      'Stored Value Research / AdvisorKhoj snapshot',
      research.previous.holdings,
      research.previous.sectors || [],
      research.previous.portfolioAsOf || research.previous.fetchedAt,
      research.previous.sources?.[0]?.url
    ));
  }

  const snapshots = distinctSnapshots(sourceSnapshots);
  if (!snapshots.length) return { ...research, officialPortfolioFailures: history.failures };

  const latest = snapshots[0];
  const previous = snapshots.find(item => !latest.asOf || !item.asOf || item.asOf.slice(0, 7) !== latest.asOf.slice(0, 7)) || null;
  const sources = [...(current.sources || []), ...snapshots.slice(0, 2).map(item => item.source)].filter(Boolean);
  const comparisonMode = latest.completePortfolio && previous?.completePortfolio ? 'complete-portfolio' : 'top-holdings-proxy';

  return {
    ...research,
    current: {
      ...current,
      holdings: latest.holdings,
      sectors: latest.sectors,
      portfolioAsOf: latest.asOf,
      sources: [...new Map(sources.filter(item => item?.url).map(item => [item.url, item])).values()],
      officialPortfolio: {
        source: latest.source,
        sheetNames: latest.sheetNames,
        coverage: latest.coverage,
        comparisonMode,
        snapshotCount: snapshots.length
      }
    },
    previous: previous ? {
      ...(research.previous || {}),
      holdings: previous.holdings,
      sectors: previous.sectors,
      portfolioAsOf: previous.asOf,
      fetchedAt: previous.asOf || research.previous?.fetchedAt,
      sources: [previous.source]
    } : research.previous,
    portfolioHistory: snapshots.slice(0, 6).map(item => ({
      asOf: item.asOf,
      holdings: item.holdings,
      sectors: item.sectors,
      source: item.source,
      completePortfolio: item.completePortfolio
    })),
    portfolioComparison: {
      mode: comparisonMode,
      currentAsOf: latest.asOf,
      previousAsOf: previous?.asOf || null,
      snapshotCount: snapshots.length,
      currentSource: latest.source,
      previousSource: previous?.source || null
    },
    officialPortfolioFailures: history.failures
  };
}
