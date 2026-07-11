import { parseAdvisorKhoj } from '@/lib/fallback-sources';

const BASE = 'https://www.advisorkhoj.com/mutual-funds-research/';
const AMC_ALIASES = [
  { match: /ppfas/i, values: ['ppfas', 'parag parikh'] },
  { match: /kotak/i, values: ['kotak'] },
  { match: /axis/i, values: ['axis'] },
  { match: /hdfc/i, values: ['hdfc'] },
  { match: /\bsbi\b|state bank/i, values: ['sbi'] },
  { match: /icici/i, values: ['icici'] },
  { match: /nippon|reliance/i, values: ['nippon', 'reliance'] },
  { match: /bandhan|idfc/i, values: ['bandhan', 'idfc'] },
  { match: /aditya birla|birla sun life/i, values: ['aditya birla', 'birla'] },
  { match: /mirae/i, values: ['mirae'] },
  { match: /motilal/i, values: ['motilal'] },
  { match: /tata/i, values: ['tata'] },
  { match: /quant/i, values: ['quant'] },
  { match: /franklin/i, values: ['franklin'] },
  { match: /invesco/i, values: ['invesco'] },
  { match: /dsp/i, values: ['dsp'] },
  { match: /uti/i, values: ['uti'] }
];

function textOf(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(direct|regular|plan|growth|idcw|dividend|option|fund|scheme|mutual|income distribution cum capital withdrawal|payout|reinvestment)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(token => token.length > 2);
}

function score(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  return [...a].filter(token => b.has(token)).length / Math.max(a.size, b.size);
}

function names(fund) {
  return [...new Set([
    ...(fund.researchAliases || []),
    fund.displayName,
    fund.preferredSchemeName,
    ...(fund.variants || []).map(item => item.schemeName)
  ].filter(Boolean))];
}

function slugs(fund) {
  const bases = names(fund).map(name => String(name)
    .replace(/\bDirect\s*(Plan)?\b|\bRegular\s*(Plan)?\b|\bGrowth\s*(Option)?\b|\bIDCW\b|\bDividend\b|\bPayout\b|\bRe-investment\b|\bIncome Distribution cum capital withdrawal option\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim());
  const candidates = bases.flatMap(base => [
    `${base} Direct Plan Growth`,
    `${base} Growth Option Direct Plan`,
    `${base} Direct Plan Growth Option`,
    `${base} Growth`,
    base
  ]);
  return [...new Set(candidates.map(value => value
    .replace(/&/g, 'and')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')))].filter(Boolean).slice(0, 30);
}

async function fetchPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,*/*',
        'user-agent': 'ManagerLens/1.2 AdvisorKhoj alias resolver'
      }
    });
    if (!response.ok) return { ok: false, url, error: `AdvisorKhoj returned ${response.status}` };
    return { ok: true, url: response.url, html: await response.text() };
  } catch (error) {
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function identity(page, fund) {
  const content = `${decodeURIComponent(page.url)} ${textOf(page.html).slice(0, 12000)}`.toLowerCase();
  const expected = names(fund);
  const fundScore = Math.max(0, ...expected.map(name => score(content, name)));
  const targetGroup = AMC_ALIASES.find(group => group.match.test(fund.fundHouse || ''));
  const targetPresent = targetGroup?.values.some(value => content.includes(value)) || false;
  const foreignPresent = AMC_ALIASES.some(group => group !== targetGroup && group.values.some(value => content.includes(value)));
  const hasFundPageMarkers = /Fund House:|Category:|PERFORMANCE|Scheme Documents|Top 10 Stocks/i.test(page.html);
  return {
    accepted: hasFundPageMarkers && !foreignPresent && (targetPresent || fundScore >= 0.38),
    fundScore,
    targetPresent,
    foreignPresent,
    hasFundPageMarkers
  };
}

export async function repairAdvisorKhojFundMatch(research, fund) {
  if (!research?.ok || research.current?.advisorKhoj) return research;
  const attempts = [];
  for (const slug of slugs(fund)) {
    const requestedUrl = `${BASE}${slug}`;
    const page = await fetchPage(requestedUrl);
    if (!page.ok) {
      attempts.push({ requestedUrl, error: page.error });
      continue;
    }
    const check = identity(page, fund);
    attempts.push({ requestedUrl, returnedUrl: page.url, ...check });
    if (!check.accepted) continue;
    const advisorKhoj = parseAdvisorKhoj(page.html, page.url);
    const sources = [
      ...(research.current?.sources || []).filter(item => item.name !== 'AdvisorKhoj'),
      { name: 'AdvisorKhoj', type: 'Live fund facts, risk metrics and portfolio-document discovery', url: page.url, asOf: advisorKhoj.navDate || new Date().toISOString() }
    ];
    return {
      ...research,
      current: {
        ...research.current,
        advisorKhoj,
        holdings: research.current?.valueResearch?.holdings?.length ? research.current.valueResearch.holdings : advisorKhoj.holdings || [],
        sectors: advisorKhoj.sectors || [],
        turnoverPct: research.current?.turnoverPct ?? advisorKhoj.turnoverPct,
        benchmark: research.current?.benchmark || advisorKhoj.benchmark,
        expenseRatioPct: research.current?.expenseRatioPct ?? advisorKhoj.expenseRatioPct,
        aumCr: research.current?.aumCr ?? advisorKhoj.aumCr,
        riskMetrics: advisorKhoj.riskMetrics || research.current?.riskMetrics,
        sources
      },
      advisorIdentityRejection: undefined,
      advisorIdentityValidation: {
        accepted: true,
        repaired: true,
        requestedUrl,
        returnedUrl: page.url,
        fundScore: check.fundScore,
        documentsAfter: advisorKhoj.officialDocuments?.length || 0
      },
      advisorRepairAttempts: attempts
    };
  }

  return {
    ...research,
    advisorRepairAttempts: attempts.slice(0, 12)
  };
}
