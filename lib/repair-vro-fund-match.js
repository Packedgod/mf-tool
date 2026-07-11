import { canonicalSchemeName, normaliseAmc } from '@/lib/manager-registry';
import { parseValueResearch } from '@/lib/fallback-sources';
import { repairAdvisorKhojFundMatch } from '@/lib/repair-advisorkhoj-match';

const VRO_HOME = 'https://www.valueresearchonline.com/funds/';
const STYLE_GROUPS = [
  ['midcap', 'mid cap', 'emerging equity'],
  ['smallcap', 'small cap'],
  ['largecap', 'large cap', 'bluechip', 'top 100'],
  ['flexicap', 'flexi cap'],
  ['equity savings'],
  ['balanced advantage', 'dynamic asset allocation'],
  ['multi asset', 'multi-asset'],
  ['business cycle'],
  ['focused'],
  ['value', 'contra'],
  ['gilt'],
  ['liquid'],
  ['corporate bond'],
  ['short term', 'short duration'],
  ['money market']
];
const GLOBAL_THEME = /\b(global|overseas|international|foreign|fof|fund of funds?|omni fof)\b/i;

function clean(value) {
  return canonicalSchemeName(value)
    .replace(/\b(fund|scheme|direct|regular|plan|growth|idcw|dividend|option|payout|reinvestment|income distribution cum capital withdrawal)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactFundName(value) {
  return String(value || '')
    .replace(/\s+-\s+(?:Direct|Regular)\s+Plan[\s\S]*$/i, '')
    .replace(/\s+-\s+(?:Growth|IDCW|Dividend)[\s\S]*$/i, '')
    .replace(/\b(?:Direct|Regular)\s+Plan\b[\s\S]*$/i, '')
    .replace(/\b(?:IDCW|Dividend|Payout|Re-investment|Income Distribution cum capital withdrawal)\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return clean(value).split(' ').filter(token => token.length > 1);
}

function score(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter(token => b.has(token)).length;
  const containment = [...a].every(token => b.has(token)) || [...b].every(token => a.has(token));
  return overlap / Math.max(a.size, b.size) + (containment ? 0.12 : 0);
}

function styleGroup(value) {
  const text = ` ${clean(value)} `;
  return STYLE_GROUPS.findIndex(group => group.some(alias => text.includes(` ${alias} `)));
}

function incompatibleStyle(left, right) {
  const a = styleGroup(left);
  const b = styleGroup(right);
  if (a >= 0 && b < 0) return true;
  return a >= 0 && b >= 0 && a !== b;
}

function incompatibleTheme(left, right) {
  return !GLOBAL_THEME.test(left || '') && GLOBAL_THEME.test(right || '');
}

function expectedNames(fund) {
  const raw = [
    fund.displayName,
    fund.preferredSchemeName,
    fund.canonicalName,
    ...(fund.researchAliases || []),
    ...(fund.variants || []).map(item => item.schemeName)
  ].filter(Boolean);
  return [...new Set([...raw, ...raw.map(compactFundName)].filter(Boolean))];
}

function identityScore(value, fund) {
  return Math.max(0, ...expectedNames(fund).map(name =>
    incompatibleStyle(name, value) || incompatibleTheme(name, value) ? 0 : score(name, value)
  ));
}

function links(html, base) {
  const result = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const text = String(match[2]).replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
      result.push({ url: new URL(match[1].replace(/&amp;/gi, '&'), base).href, text });
    } catch {}
  }
  return result;
}

async function fetchText(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,*/*',
        'user-agent': 'ManagerLens/1.5 Value Research fund identity resolver'
      }
    });
    if (!response.ok) throw new Error(`Value Research returned ${response.status}`);
    return { ok: true, url: response.url, html: await response.text() };
  } catch (error) {
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function currentIdentity(research, fund) {
  const current = research?.current?.valueResearch;
  if (!current) return { valid: false, score: 0, value: '' };
  const value = `${current.fundName || ''} ${current.url || ''}`;
  const matchScore = identityScore(value, fund);
  const generated = research.registryMatch;
  const styleMismatch = expectedNames(fund).every(name => incompatibleStyle(name, value) || incompatibleTheme(name, value));
  const weakFuzzy = generated?.type === 'fuzzy' && Number(generated.score || 0) < 0.78;
  return {
    valid: !styleMismatch && !weakFuzzy && matchScore >= 0.52,
    score: matchScore,
    value,
    weakFuzzy,
    styleMismatch
  };
}

async function discoverPage(fund) {
  const home = await fetchText(VRO_HOME);
  if (!home.ok) return { ok: false, error: home.error, stage: 'fund-house-directory' };
  const targetAmc = normaliseAmc(fund.fundHouse);
  const houses = links(home.html, home.url)
    .filter(item => /\/funds\/selector\/fund-house\/\d+\//i.test(item.url))
    .map(item => {
      const amc = normaliseAmc(item.text);
      const amcScore = amc === targetAmc ? 2 : score(amc, targetAmc);
      return { ...item, score: amcScore };
    })
    .sort((a, b) => b.score - a.score);
  const house = houses[0];
  if (!house || house.score < 0.35) return { ok: false, error: 'Value Research fund-house selector was not matched.', stage: 'fund-house-match' };

  const selectorUrl = new URL(house.url);
  selectorUrl.searchParams.set('end-type', '1');
  selectorUrl.searchParams.set('exclude', 'fmps,suspended-plans');
  selectorUrl.searchParams.set('plan-type', 'direct');
  const selector = await fetchText(selectorUrl.href, 22000);
  if (!selector.ok) return { ok: false, error: selector.error, stage: 'fund-selector' };

  const allCandidates = links(selector.html, selector.url)
    .filter(item => {
      try { return /\/funds\/\d+\/[^/]+\/$/i.test(new URL(item.url).pathname); } catch { return false; }
    })
    .map(item => {
      const identity = `${item.text} ${decodeURIComponent(new URL(item.url).pathname.replace(/[-/]+/g, ' '))}`;
      return { ...item, identity, score: identityScore(identity, fund) };
    })
    .sort((a, b) => b.score - a.score);
  const best = allCandidates.find(item => item.score >= 0.52);
  if (!best) {
    return {
      ok: false,
      error: 'No sufficiently close Value Research fund page was found.',
      stage: 'fund-page-match',
      candidates: allCandidates.slice(0, 8).map(item => ({ text: item.text, url: item.url, score: item.score }))
    };
  }
  return { ok: true, url: best.url, label: best.text, score: best.score, houseUrl: house.url };
}

export async function repairValueResearchFundMatch(inputResearch, fund) {
  if (!inputResearch?.ok) return inputResearch;
  const research = await repairAdvisorKhojFundMatch(inputResearch, fund);
  const currentCheck = currentIdentity(research, fund);
  if (currentCheck.valid) {
    return {
      ...research,
      valueResearchIdentity: { repaired: false, accepted: true, score: currentCheck.score, url: research.current?.valueResearch?.url }
    };
  }

  const discovery = await discoverPage(fund);
  if (!discovery.ok) {
    return {
      ...research,
      current: {
        ...research.current,
        valueResearch: null,
        holdings: research.current?.advisorKhoj?.holdings || [],
        sectors: research.current?.advisorKhoj?.sectors || [],
        sources: (research.current?.sources || []).filter(item => item.name !== 'Value Research Online')
      },
      valueResearchIdentity: {
        repaired: false,
        accepted: false,
        previousScore: currentCheck.score,
        previousUrl: research.current?.valueResearch?.url,
        error: discovery.error,
        stage: discovery.stage,
        candidates: discovery.candidates || []
      }
    };
  }

  const page = await fetchText(discovery.url, 20000);
  if (!page.ok) {
    return {
      ...research,
      valueResearchIdentity: { repaired: false, accepted: false, error: page.error, discoveredUrl: discovery.url }
    };
  }
  const parsed = parseValueResearch(page.html, page.url);
  const previousVro = research.current?.valueResearch || {};
  const valueResearch = {
    ...previousVro,
    ...parsed,
    managers: parsed.managers?.length ? parsed.managers : previousVro.managers || [],
    turnoverPct: parsed.turnoverPct ?? previousVro.turnoverPct,
    expenseRatioPct: parsed.expenseRatioPct ?? previousVro.expenseRatioPct,
    aumCr: parsed.aumCr ?? previousVro.aumCr,
    benchmark: parsed.benchmark || previousVro.benchmark,
    nav: parsed.nav ?? previousVro.nav,
    navDate: parsed.navDate || previousVro.navDate,
    assetAllocation: parsed.assetAllocation?.length ? parsed.assetAllocation : previousVro.assetAllocation || [],
    marketCap: parsed.marketCap?.length ? parsed.marketCap : previousVro.marketCap || []
  };
  const sources = [
    ...(research.current?.sources || []).filter(item => item.name !== 'Value Research Online'),
    { name: 'Value Research Online', type: 'Live manager, holdings, turnover and fund facts', url: page.url, asOf: valueResearch.navDate || new Date().toISOString() }
  ];
  return {
    ...research,
    current: {
      ...research.current,
      valueResearch,
      managers: valueResearch.managers?.length ? valueResearch.managers : research.current?.managers || [],
      holdings: valueResearch.holdings?.length ? valueResearch.holdings : research.current?.advisorKhoj?.holdings || [],
      assetAllocation: valueResearch.assetAllocation || [],
      marketCap: valueResearch.marketCap || [],
      turnoverPct: valueResearch.turnoverPct ?? research.current?.turnoverPct,
      benchmark: valueResearch.benchmark || research.current?.benchmark,
      expenseRatioPct: valueResearch.expenseRatioPct ?? research.current?.expenseRatioPct,
      aumCr: valueResearch.aumCr ?? research.current?.aumCr,
      sources
    },
    registryMatch: { key: clean(discovery.label || fund.displayName), score: discovery.score, type: 'live-selector' },
    valueResearchIdentity: {
      repaired: true,
      accepted: true,
      previousScore: currentCheck.score,
      previousUrl: previousVro.url,
      score: discovery.score,
      url: page.url
    }
  };
}
