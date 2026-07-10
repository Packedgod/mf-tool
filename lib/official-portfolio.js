import * as XLSX from 'xlsx';

const MAX_DOCUMENTS = 3;
const MAX_ROWS_PER_SHEET = 5000;

function tokenise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(direct|regular|plan|growth|idcw|dividend|option|fund|scheme)\b/g, ' ')
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
  const cleaned = String(value || '').replace(/[%₹,()]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '—') return undefined;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function classifyHeader(value) {
  const text = cleanText(value).toLowerCase();
  if (/isin/.test(text)) return 'isin';
  if (/industry|sector|classification/.test(text)) return 'sector';
  if (/%.*nav|nav.*%|percentage.*nav|%.*net asset|weight.*%|portfolio.*%/.test(text)) return 'weight';
  if (/name of (the )?instrument|instrument name|name of issuer|issuer name|company name|security name|particulars/.test(text)) return 'name';
  return null;
}

function locateHeader(rows) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 80); rowIndex += 1) {
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
  if (/retail|consumer service|leisure|travel|restaurant/i.test(text)) return 'Consumer Services';
  if (/oil|gas|energy|power|coal/i.test(text)) return 'Energy';
  if (/metal|mining|steel|aluminium/i.test(text)) return 'Metals & Mining';
  if (/realty|real estate/i.test(text)) return 'Realty';
  if (/telecom|communication/i.test(text)) return 'Telecommunication';
  if (/capital goods|industrial|engineering|construction|infrastructure/i.test(text)) return 'Capital Goods';
  if (/chemical|fertilizer|pesticide/i.test(text)) return 'Chemicals';
  return text;
}

function validHoldingName(value) {
  const name = cleanText(value);
  if (name.length < 3 || name.length > 180) return false;
  if (/^(total|sub total|subtotal|grand total|equity|debt|cash|net assets|derivative|treps|repo|money market)/i.test(name)) return false;
  if (/aggregate|exposure|market value|percentage to nav/i.test(name)) return false;
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
      if (blankRun > 25 && holdings.length) break;
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
  const strong = scored.filter(item => item.score >= 0.25).sort((a, b) => b.score - a.score);
  if (strong.length) return strong.slice(0, 5).map(item => item.name);
  return workbook.SheetNames.slice(0, 12);
}

function dedupeHoldings(records) {
  const map = new Map();
  for (const holding of records) {
    const key = `${holding.name.toLowerCase()}::${holding.sector.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing || holding.weight > existing.weight) map.set(key, holding);
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight);
}

function aggregateSectors(holdings) {
  const map = new Map();
  for (const holding of holdings) {
    if (holding.sector === 'Unclassified') continue;
    map.set(holding.sector, (map.get(holding.sector) || 0) + holding.weight);
  }
  return [...map.entries()]
    .map(([sector, weight]) => ({ sector, weight: Number(weight.toFixed(4)) }))
    .sort((a, b) => b.weight - a.weight);
}

async function fetchBuffer(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*',
        'user-agent': 'ManagerLens/0.8 official-portfolio-reader'
      }
    });
    if (!response.ok) throw new Error(`Official document returned ${response.status}`);
    return { buffer: Buffer.from(await response.arrayBuffer()), url: response.url, type: response.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

function isWorkbook(document) {
  return /\.xlsx?(?:$|\?)/i.test(document.url || '') || /excel|spreadsheet/i.test(document.type || document.text || '');
}

export async function extractOfficialPortfolio(documents, fundName) {
  const candidates = (documents || []).filter(isWorkbook).slice(0, MAX_DOCUMENTS);
  const failures = [];

  for (const document of candidates) {
    try {
      const fetched = await fetchBuffer(document.url);
      const workbook = XLSX.read(fetched.buffer, { type: 'buffer', cellDates: false, dense: false });
      const selectedSheets = chooseSheets(workbook, fundName);
      const holdings = [];
      for (const sheetName of selectedSheets) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
        holdings.push(...parseSheet(rows, sheetName));
      }
      const unique = dedupeHoldings(holdings);
      const sectors = aggregateSectors(unique);
      if (unique.length >= 3) {
        return {
          ok: true,
          holdings: unique.slice(0, 50),
          sectors,
          source: {
            name: 'Official AMC monthly portfolio disclosure',
            type: 'Official holdings workbook discovered through AdvisorKhoj',
            url: fetched.url,
            asOf: document.text || 'latest available disclosure'
          },
          sheetNames: selectedSheets,
          coverage: { holdings: unique.length, sectors: sectors.length }
        };
      }
      failures.push(`${document.url}: no usable holdings table`);
    } catch (error) {
      failures.push(`${document.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: false, holdings: [], sectors: [], failures };
}

export async function enrichResearchWithOfficialPortfolio(research, fundName) {
  if (!research?.ok) return research;
  const current = research.current || {};
  if ((current.holdings || []).length >= 3 && (current.sectors || []).length >= 2) return research;
  const documents = current.advisorKhoj?.officialDocuments || [];
  if (!documents.length) return research;

  const official = await extractOfficialPortfolio(documents, fundName);
  if (!official.ok) return { ...research, officialPortfolioFailures: official.failures };

  const sources = [...(current.sources || []), official.source];
  return {
    ...research,
    current: {
      ...current,
      holdings: official.holdings,
      sectors: official.sectors,
      sources,
      officialPortfolio: {
        source: official.source,
        sheetNames: official.sheetNames,
        coverage: official.coverage
      }
    }
  };
}
