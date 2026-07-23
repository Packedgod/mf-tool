const SOURCES = {
  ppfas: {
    label: "PPFAS Mutual Fund — June 2026 factsheet",
    url: "https://amc.ppfas.com/downloads/factsheet/2026/ppfas-mf-factsheet-for-June-2026.pdf?08072026=",
    asOf: "2026-06-30"
  },
  hdfc: {
    label: "HDFC Flexi Cap Fund — June 2026 fund facts",
    url: "https://files.hdfcfund.com/s3fs-public/Others/2026-06/Fund%20Facts%20-%20HDFC%20Flexi%20Cap%20Fund_June%2026.pdf",
    asOf: "2026-06-30"
  },
  sbi: {
    label: "SBI Small Cap Fund — May 2026 factsheet",
    url: "https://www.sbimf.com/docs/default-source/scheme-factsheets/sbi-small-cap-fund-factsheet-may-2026.pdf?sfvrsn=905f0beb_2",
    asOf: "2026-05-31"
  },
  icici: {
    label: "ICICI Prudential Balanced Advantage Fund factsheet",
    url: "https://digitalfactsheet.icicipruamc.com/fact/pdf/icici-prudential-balanced-advantage-fund.pdf",
    asOf: "2026-04-30"
  },
  amfiNav: {
    label: "AMFI official NAVAll feed",
    url: "https://portal.amfiindia.com/spages/NAVAll.txt",
    asOf: "live"
  },
  mfapi: {
    label: "MFapi.in — Indian mutual fund NAV API",
    url: "https://www.mfapi.in/docs/",
    asOf: "live"
  }
};

const INDEX_PROXIES = {
  nifty500: {
    id: "nifty500",
    label: "NIFTY 500 investable proxy",
    quality: "High",
    description: "Closest investable passive proxy to a broad Indian equity benchmark.",
    components: [{
      weight: 1,
      queries: [
        "Motilal Oswal Nifty 500 Index Fund Direct Growth",
        "Franklin India NSE Nifty 500 Index Fund Direct Growth",
        "HDFC Index Fund Nifty 500 Plan Direct Growth",
        "Nifty 500 Index Fund Direct Growth",
        "NIFTY 500 Index Fund Direct Plan Growth"
      ]
    }]
  },
  nifty50: {
    id: "nifty50",
    label: "NIFTY 50 investable proxy",
    quality: "High",
    description: "Large-cap market standard for broad market and defensive comparison.",
    components: [{
      weight: 1,
      queries: [
        "HDFC Nifty 50 Index Fund Direct Growth",
        "UTI Nifty 50 Index Fund Direct Growth",
        "Nifty 50 Index Fund Direct Growth"
      ]
    }]
  },
  smallcap250: {
    id: "smallcap250",
    label: "NIFTY Smallcap 250 investable proxy",
    quality: "High",
    description: "Category-aligned passive small-cap proxy.",
    components: [{
      weight: 1,
      queries: [
        "Motilal Oswal Nifty Smallcap 250 Index Fund Direct Growth",
        "Nifty Smallcap 250 Index Fund Direct Growth",
        "NIFTY Smallcap 250 Index Fund Direct Plan Growth"
      ]
    }]
  },
  liquid: {
    id: "liquid",
    label: "Liquid-fund cash proxy",
    quality: "Medium",
    description: "Cash/defensive yardstick used to test cash deployment and hedging choices.",
    components: [{
      weight: 1,
      queries: [
        "HDFC Liquid Fund Direct Plan Growth",
        "SBI Liquid Fund Direct Growth",
        "Liquid Fund Direct Growth"
      ]
    }]
  },
  balanced5050: {
    id: "balanced5050",
    label: "50% NIFTY 50 + 50% liquid synthetic proxy",
    quality: "Medium-high",
    description: "Transparent synthetic approximation for a moderate hybrid benchmark.",
    components: [
      {
        weight: 0.5,
        queries: [
          "HDFC Nifty 50 Index Fund Direct Growth",
          "UTI Nifty 50 Index Fund Direct Growth",
          "Nifty 50 Index Fund Direct Growth"
        ]
      },
      {
        weight: 0.5,
        queries: [
          "HDFC Liquid Fund Direct Plan Growth",
          "SBI Liquid Fund Direct Growth",
          "Liquid Fund Direct Growth"
        ]
      }
    ]
  }
};

const SCHEMES = {
  ppfasFlexi: {
    id: "ppfas-flexi",
    name: "Parag Parikh Flexi Cap Fund — Direct Growth",
    amc: "PPFAS Mutual Fund",
    category: "Flexi Cap",
    schemeQueries: [
      "Parag Parikh Flexi Cap Fund Direct Growth",
      "Parag Parikh Flexi Cap Direct Growth",
      "Parag Parikh Long Term Equity Fund Direct Growth"
    ],
    benchmarkName: "NIFTY 500 TRI",
    proxies: {
      official: INDEX_PROXIES.nifty500,
      category: INDEX_PROXIES.nifty500,
      broad: INDEX_PROXIES.nifty50,
      defensive: INDEX_PROXIES.liquid
    },
    decisionLevers: [
      { id: "overseas", label: "Overseas allocation", defaultWeightPct: 10.66, description: "Tests the return impact of replacing the overseas sleeve with the selected proxy." },
      { id: "cash", label: "Cash / arbitrage buffer", defaultWeightPct: 5, description: "Tests the effect of deploying or preserving defensive liquidity." }
    ],
    source: SOURCES.ppfas
  },
  hdfcFlexi: {
    id: "hdfc-flexi",
    name: "HDFC Flexi Cap Fund — Direct Growth",
    amc: "HDFC Mutual Fund",
    category: "Flexi Cap",
    schemeQueries: [
      "HDFC Flexi Cap Fund Direct Growth",
      "HDFC Flexi Cap Direct Plan Growth",
      "HDFC Flexi Cap Fund Direct Plan Growth"
    ],
    benchmarkName: "NIFTY 500 TRI",
    proxies: {
      official: INDEX_PROXIES.nifty500,
      category: INDEX_PROXIES.nifty500,
      broad: INDEX_PROXIES.nifty50,
      defensive: INDEX_PROXIES.liquid
    },
    decisionLevers: [
      { id: "financials", label: "Financial-services overweight", defaultWeightPct: 5, description: "Tests a sector overweight reduction and reallocation to the broad proxy." },
      { id: "transition", label: "Manager transition", defaultWeightPct: 100, description: "Compares the manager-tenure window with the immediately preceding window where data allows." }
    ],
    source: SOURCES.hdfc
  },
  sbiSmall: {
    id: "sbi-small",
    name: "SBI Small Cap Fund — Direct Growth",
    amc: "SBI Mutual Fund",
    category: "Small Cap",
    schemeQueries: [
      "SBI Small Cap Fund Direct Growth",
      "SBI Small Cap Direct Plan Growth",
      "SBI Small Cap Fund Direct Plan Growth"
    ],
    benchmarkName: "BSE 250 Small Cap TRI",
    proxies: {
      official: INDEX_PROXIES.smallcap250,
      category: INDEX_PROXIES.smallcap250,
      broad: INDEX_PROXIES.nifty500,
      defensive: INDEX_PROXIES.liquid
    },
    decisionLevers: [
      { id: "cash-deployment", label: "Cash deployment", defaultWeightPct: 6.15, description: "Tests the impact of fully deploying the reported cash/cash-equivalent sleeve." },
      { id: "capacity", label: "Capacity discipline", defaultWeightPct: 10, description: "Tests the trade-off between higher deployment and liquidity risk." }
    ],
    source: SOURCES.sbi
  },
  iciciBaf: {
    id: "icici-baf",
    name: "ICICI Prudential Balanced Advantage Fund — Direct Growth",
    amc: "ICICI Prudential Mutual Fund",
    category: "Balanced Advantage",
    schemeQueries: [
      "ICICI Prudential Balanced Advantage Fund Direct Growth",
      "ICICI Prudential Balanced Advantage Direct Plan Growth",
      "ICICI Prudential Balanced Advantage Fund Direct Plan Growth"
    ],
    benchmarkName: "CRISIL Hybrid 50+50 Moderate Index",
    proxies: {
      official: INDEX_PROXIES.balanced5050,
      category: INDEX_PROXIES.balanced5050,
      broad: INDEX_PROXIES.nifty50,
      defensive: INDEX_PROXIES.liquid
    },
    decisionLevers: [
      { id: "net-equity", label: "Net equity allocation", defaultWeightPct: 11.8, description: "Tests a move from 53.2% net equity to 65.0% net equity." },
      { id: "hedging", label: "Derivative hedging", defaultWeightPct: 10, description: "Tests how improved downside capture changes terminal NAV." }
    ],
    source: SOURCES.icici
  }
};

const MANAGERS = [
  { id: "rajeev-thakkar", name: "Rajeev Thakkar", amc: "PPFAS Mutual Fund", role: "CIO — Equity / lead manager", startDate: "2013-05-24", startLabel: "Since inception", schemeId: SCHEMES.ppfasFlexi.id, style: "Valuation-driven, low-turnover flexi-cap process with domestic and overseas sleeves.", decisions: ["Valuation discipline", "Overseas allocation", "Cash/arbitrage buffer", "Concentration control"], source: SOURCES.ppfas },
  { id: "raj-mehta", name: "Raj Mehta", amc: "PPFAS Mutual Fund", role: "Equity co-manager", startDate: "2025-09-01", startLabel: "Since 1 Sep 2025", schemeId: SCHEMES.ppfasFlexi.id, style: "Co-management within the PPFAS valuation and low-turnover investment framework.", decisions: ["Succession continuity", "Stock-selection contribution", "Portfolio concentration", "Execution discipline"], source: SOURCES.ppfas },
  { id: "raunak-onkar", name: "Raunak Onkar", amc: "PPFAS Mutual Fund", role: "Overseas-securities manager", startDate: "2013-05-24", startLabel: "Since inception", schemeId: SCHEMES.ppfasFlexi.id, style: "Dedicated overseas sleeve management within a domestic flexi-cap mandate.", decisions: ["Overseas stock selection", "Currency-sensitive exposure", "Domestic-vs-global allocation", "Valuation spread"], source: SOURCES.ppfas },
  { id: "tejas-soman", name: "Tejas Soman", amc: "PPFAS Mutual Fund", role: "Debt sleeve manager", startDate: "2025-09-01", startLabel: "Since 1 Sep 2025", schemeId: SCHEMES.ppfasFlexi.id, style: "Liquidity and debt-sleeve management supporting the equity strategy.", decisions: ["Liquidity management", "Duration choice", "Cash-buffer efficiency", "Credit quality"], source: SOURCES.ppfas },
  { id: "aishwarya-dhar", name: "Aishwarya Dhar", amc: "PPFAS Mutual Fund", role: "Debt sleeve manager", startDate: "2025-09-01", startLabel: "Since 1 Sep 2025", schemeId: SCHEMES.ppfasFlexi.id, style: "Debt and liquidity implementation within the PPFAS multi-sleeve process.", decisions: ["Cash allocation", "Debt carry", "Liquidity risk", "Implementation cost"], source: SOURCES.ppfas },
  { id: "mansi-kariya", name: "Mansi Kariya", amc: "PPFAS Mutual Fund", role: "Debt sleeve manager", startDate: "2023-12-22", startLabel: "Since 22 Dec 2023", schemeId: SCHEMES.ppfasFlexi.id, style: "Debt-sleeve and liquidity support for a predominantly equity strategy.", decisions: ["Liquidity reserve", "Debt allocation", "Carry trade-off", "Risk control"], source: SOURCES.ppfas },
  { id: "amit-ganatra", name: "Amit Ganatra", amc: "HDFC Mutual Fund", role: "Lead equity manager", startDate: "2026-02-01", startLabel: "Since 1 Feb 2026", schemeId: SCHEMES.hdfcFlexi.id, style: "Institutional flexi-cap process with a recent lead-manager transition.", decisions: ["Post-transition alpha", "Financial-services exposure", "Low turnover", "Style continuity"], source: SOURCES.hdfc },
  { id: "dhruv-muchhal", name: "Dhruv Muchhal", amc: "HDFC Mutual Fund", role: "Dedicated overseas manager", startDate: "2023-06-22", startLabel: "Since 22 Jun 2023", schemeId: SCHEMES.hdfcFlexi.id, style: "Overseas sleeve management inside HDFC's institutional flexi-cap process.", decisions: ["Overseas allocation", "Currency exposure", "Global stock selection", "Benchmark fit"], source: SOURCES.hdfc },
  { id: "r-srinivasan", name: "R. Srinivasan", amc: "SBI Mutual Fund", role: "Lead small-cap manager", startDate: "2013-11-01", startLabel: "Since Nov 2013", schemeId: SCHEMES.sbiSmall.id, style: "Long-tenured, capacity-aware small-cap specialist process.", decisions: ["Capacity controls", "Cash deployment", "Small-cap liquidity", "Cycle persistence"], source: SOURCES.sbi },
  { id: "rajat-chandak", name: "Rajat Chandak", amc: "ICICI Prudential Mutual Fund", role: "Equity / allocation manager", startDate: "2015-09-01", startLabel: "Since Sep 2015", schemeId: SCHEMES.iciciBaf.id, style: "Dynamic equity allocation within a model-heavy balanced-advantage process.", decisions: ["Net equity", "Equity selection", "Valuation model", "Hedging intensity"], source: SOURCES.icici },
  { id: "hab-dolwai", name: "Hab Dolwai", amc: "ICICI Prudential Mutual Fund", role: "Equity / allocation manager", startDate: "2018-01-01", startLabel: "Since Jan 2018", schemeId: SCHEMES.iciciBaf.id, style: "Equity and allocation co-management within a multi-sleeve balanced-advantage framework.", decisions: ["Net equity", "Stock selection", "Hedge calibration", "Cycle positioning"], source: SOURCES.icici },
  { id: "manish-banthia", name: "Manish Banthia", amc: "ICICI Prudential Mutual Fund", role: "Debt manager", startDate: "2009-11-01", startLabel: "Since Nov 2009", schemeId: SCHEMES.iciciBaf.id, style: "Long-tenured debt-sleeve management supporting dynamic allocation.", decisions: ["Duration", "Credit quality", "Debt carry", "Equity-debt spread"], source: SOURCES.icici },
  { id: "akhil-kakkar", name: "Akhil Kakkar", amc: "ICICI Prudential Mutual Fund", role: "Debt co-manager", startDate: "2024-06-01", startLabel: "Since Jun 2024", schemeId: SCHEMES.iciciBaf.id, style: "Debt co-management inside the balanced-advantage allocation system.", decisions: ["Debt carry", "Duration", "Liquidity", "Allocation implementation"], source: SOURCES.icici },
  { id: "srishti-sharma", name: "Srishti Sharma", amc: "ICICI Prudential Mutual Fund", role: "Derivatives / equity manager", startDate: "2021-04-01", startLabel: "Since Apr 2021", schemeId: SCHEMES.iciciBaf.id, style: "Derivative and equity implementation within the balanced-advantage process.", decisions: ["Hedging", "Derivative efficiency", "Net exposure", "Implementation cost"], source: SOURCES.icici }
];

const SCHEME_LIST = Object.values(SCHEMES);
const SCHEME_BY_ID = Object.fromEntries(SCHEME_LIST.map((scheme) => [scheme.id, scheme]));

function getManagerById(id) {
  return MANAGERS.find((manager) => manager.id === id) || MANAGERS[0];
}

function getSchemeById(id) {
  return SCHEME_BY_ID[id] || SCHEME_LIST[0];
}

export { SOURCES, INDEX_PROXIES, SCHEMES, SCHEME_LIST, MANAGERS, getManagerById, getSchemeById };
