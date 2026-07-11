import { parseAdvisorKhoj } from '@/lib/fallback-sources';

const BASE = 'https://www.advisorkhoj.com/mutual-funds-research/';
const AMC_ALIASES = [
  { match: /ppfas/i, values: ['ppfas', 'parag parikh', 'parag-parikh'] },
  { match: /kotak/i, values: ['kotak'] },
  { match: /axis/i, values: ['axis', 'axismf'] },
  { match: /hdfc/i, values: ['hdfc'] },
  { match: /\bsbi\b|state bank/i, values: ['sbi', 'sbimf'] },
  { match: /icici/i, values: ['icici', 'icicipru'] },
  { match: /nippon|reliance/i, values: ['nippon', 'reliance'] },
  { match: /bandhan|idfc/i, values: ['bandhan', 'idfc'] },
  { match: /aditya birla|birla sun life/i, values: ['aditya birla', 'adityabirla', 'birla'] },
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
    .replace(/^-+|-+$/g, '')))].filter(Boolean).slice(0, 35);
}

function targetGroup(fund) {
  return AMC_ALIASES.find(group => group.match.test(fund.fundHouse || '')) || null;
}

function documentIdentity(documents, fund) {
  const target = targetGroup(fund);
  if (!documents?.length || !target) return { valid: true, targetCount: 0, foreignCount: 0 };
  let targetCount = 0;
  let foreignCount = 0;
  for (const document of documents) {
    const source = decodeURIComponent(`${document.url || ''} ${document.text || ''}`).toLowerCase();
    if (target.values.some(value => source.includes(value))) targetCount += 1;
    else if (AMC_ALIASES.some(group => group !== target && group.values.some(value => source.includes(value)))) foreignCount += 1;
  }
  return {
    valid: foreignCount === 0 || targetCount > 0,
    targetCount,
    foreignCount
  };
}

function currentIdentity(advisor, fund) {
  if (!advisor) return { accepted: false, reason: 'missing' };
  const urlSource = decodeURIComponent(advisor.url || '').toLowerCase();
  const target = targetGroup(fund);
  const targetPresent = target?.values.some(value => urlSource.includes(value)) || false;
  const fundScore = Math.max(0, ...names(fund).map(name => score(urlSource, name)));
  const foreignUrl = AMC_ALIASES.some(group => group !== target && group.values.some(value => urlSource.includes(value)));
  const docs = documentIdentity(advisor.officialDocuments, fund);
  return {
    accepted: !foreignUrl && docs.valid && (targetPresent || fundScore >= 0.38),
    targetPresent,
    fundScore,
    foreignUrl,
    ...docs
  };
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
        'user-agent': 'ManagerLens/1.3 AdvisorKhoj alias resolver'
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

function pageIdentity(page, fund) {
  const urlSource = decodeURIComponent(page.url || '').toLowerCase();
  const content = textOf(page.html).slice(0, 16000);
  const target = targetGroup(fund);
  const targetPresent = target?.values.some(value => urlSource.includes(value) || content.toLowerCase().includes(value)) || false;
  const fundScore = Math.max(0, ...names(fund).map(name => Math.max(score(urlSource, name), score(content, name))));
  const foreignUrl = AMC_ALIASES.some(group => group !== target && group.values.some(value => urlSource.includes(value)));
  const hasFundPageMarkers = /Fund House:|Category:|PERFORMANCE|Scheme Documents|Top 10 Stocks/i.test(page.html);
  return {
    accepted: hasFundPageMarkers && !foreignUrl && (targetPresent || fundScore >= 0.38),
    fundScore,
    targetPresent,
    foreignUrl,
    hasFundPageMarkers
  };
}

function mergeAdvisor(research, advisorKhoj, validation, attempts) {
  const sources = [
    ...(research.current?.sources || []).filter(item => item.name !== 'AdvisorKhoj'),
    { name: 'AdvisorKhoj', type: 'Live fund facts, risk metrics and portfolio-document discovery', url: advisorKhoj.url, asOf: advisorKhoj.navDate || new Date().toISOString() }
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
    advisorIdentityValidation: validation,
    advisorRepairAttempts: attempts
  };
}

export async function repairAdvisorKhojFundMatch(research, fund) {
  if (!research?.ok) return research;
  const currentAdvisor = research.current?.advisorKhoj;
  const existingCheck = currentIdentity(currentAdvisor, fund);
  if (existingCheck.accepted) {
    return {
      ...research,
      advisorIdentityValidation: {
        accepted: true,
        repaired: false,
        returnedUrl: currentAdvisor.url,
        ...existingCheck
      }
    };
  }

  const baseResearch = {
    ...research,
    current: {
      ...research.current,
      advisorKhoj: null,
      sectors: research.current?.valueResearch?.sectors || [],
      sources: (research.current?.sources || []).filter(item => item.name !== 'AdvisorKhoj')
    }
  };
  const attempts = [{ existingUrl: currentAdvisor?.url, existingCheck }];

  for (const slug of slugs(fund)) {
    const requestedUrl = `${BASE}${slug}`;
    const page = await fetchPage(requestedUrl);
    if (!page.ok) {
      attempts.push({ requestedUrl, error: page.error });
      continue;
    }
    const check = pageIdentity(page, fund);
    if (!check.accepted) {
      attempts.push({ requestedUrl, returnedUrl: page.url, ...check });
      continue;
    }
    const advisorKhoj = parseAdvisorKhoj(page.html, page.url);
    const docsCheck = documentIdentity(advisorKhoj.officialDocuments, fund);
    attempts.push({ requestedUrl, returnedUrl: page.url, ...check, ...docsCheck });
    if (!docsCheck.valid) continue;
    return mergeAdvisor(baseResearch, advisorKhoj, {
      accepted: true,
      repaired: true,
      requestedUrl,
      returnedUrl: page.url,
      fundScore: check.fundScore,
      targetPresent: check.targetPresent,
      documentsAfter: advisorKhoj.officialDocuments?.length || 0,
      targetDocuments: docsCheck.targetCount,
      foreignDocuments: docsCheck.foreignCount
    }, attempts);
  }

  return {
    ...baseResearch,
    advisorIdentityRejection: {
      rejected: true,
      requestedFund: fund.displayName,
      requestedFundHouse: fund.fundHouse,
      existingUrl: currentAdvisor?.url,
      reason: 'No alias-matched AdvisorKhoj page passed fund and AMC identity checks.'
    },
    advisorRepairAttempts: attempts.slice(0, 15)
  };
}
