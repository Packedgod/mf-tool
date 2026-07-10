export const MOMENTUM_WEIGHTS = {
  sectorBias: 15,
  sectorMomentum: 15,
  entryTiming: 10,
  exitTiming: 10,
  exitPeakProximity: 10,
  turnoverEfficiency: 8,
  cycleFit: 7,
  alphaInformationRatio: 8,
  sharpeDownside: 6,
  drawdownControl: 4,
  persistence: 4,
  managerValueAdd: 3
};

export const SECTOR_MARKET_SYMBOLS = {
  "Financial Services": "^CNXFIN",
  "Banks": "^NSEBANK",
  "Automobile and Auto Components": "^CNXAUTO",
  "Information Technology": "^CNXIT",
  "Healthcare": "^CNXPHARMA",
  "Pharmaceuticals & Biotechnology": "^CNXPHARMA",
  "Capital Goods": "^CNXINFRA",
  "Construction": "^CNXINFRA",
  "Metals & Mining": "^CNXMETAL",
  "Oil, Gas & Consumable Fuels": "^CNXENERGY",
  "Energy": "^CNXENERGY",
  "Power": "^CNXENERGY",
  "Fast Moving Consumer Goods": "^CNXFMCG",
  "Consumer Services": "^CNXCONSUM",
  "Consumer Durables": "^CNXCONSUM",
  "Realty": "^CNXREALTY",
  "Telecommunication": "^CNXINFRA",
  "Chemicals": "^CNXCOMMODITIES",
  "Retailing": "^CNXCONSUM"
};

const HDFC_SECTOR_HISTORY = [
  { sector: "Financial Services", values: [39.0, 38.7, 39.3, 37.7, 37.3, 36.0] },
  { sector: "Automobile and Auto Components", values: [12.5, 11.8, 11.9, 11.0, 11.0, 11.3] },
  { sector: "Healthcare", values: [7.5, 6.7, 8.2, 10.2, 10.1, 10.6] },
  { sector: "Information Technology", values: [6.2, 6.3, 6.9, 7.3, 6.1, 5.7] },
  { sector: "Consumer Services", values: [2.3, 2.1, 3.9, 4.4, 5.0, 5.6] },
  { sector: "Construction", values: [1.5, 1.4, 3.3, 3.6, 3.9, 4.1] },
  { sector: "Metals & Mining", values: [3.8, 3.9, 3.4, 3.3, 3.2, 3.0] },
  { sector: "Telecommunication", values: [2.4, 2.2, 3.1, 3.2, 3.1, 3.0] },
  { sector: "Oil, Gas & Consumable Fuels", values: [1.4, 1.5, 1.5, 3.2, 3.0, 2.8] },
  { sector: "Services", values: [1.1, 0.9, 1.9, 2.2, 2.4, 2.8] }
];

export const MOMENTUM_SNAPSHOTS = {
  "ppfas-flexi": {
    asOf: "2026-06-30",
    factsheetUrl: "https://amc.ppfas.com/downloads/factsheet/2026/ppfas-mf-factsheet-for-June-2026.pdf?08072026=",
    factsheetLabel: "PPFAS Mutual Fund — June 2026 factsheet",
    turnover: { equityPct: 17.48, totalPct: 43.26, interpretation: "excluding and including equity arbitrage respectively" },
    sectorWeights: [
      { sector: "Financial Services", weight: 27.01 },
      { sector: "Information Technology", weight: 17.40 },
      { sector: "Energy", weight: 13.00 },
      { sector: "Fast Moving Consumer Goods", weight: 7.46 },
      { sector: "Automobile and Auto Components", weight: 6.41 },
      { sector: "Healthcare", weight: 4.50 },
      { sector: "Realty", weight: 4.17 },
      { sector: "Telecommunication", weight: 2.96 }
    ],
    holdings: [
      { name: "HDFC Bank", symbol: "HDFCBANK.NS", weight: 8.33, sector: "Financial Services" },
      { name: "Power Grid", symbol: "POWERGRID.NS", weight: 6.23, sector: "Energy" },
      { name: "ITC", symbol: "ITC.NS", weight: 6.07, sector: "Fast Moving Consumer Goods" },
      { name: "ICICI Bank", symbol: "ICICIBANK.NS", weight: 5.52, sector: "Financial Services" },
      { name: "Coal India", symbol: "COALINDIA.NS", weight: 5.35, sector: "Energy" },
      { name: "Bajaj Holdings", symbol: "BAJAJHLDNG.NS", weight: 4.63, sector: "Financial Services" },
      { name: "Kotak Mahindra Bank", symbol: "KOTAKBANK.NS", weight: 4.23, sector: "Financial Services" },
      { name: "Mahindra & Mahindra", symbol: "M&M.NS", weight: 3.56, sector: "Automobile and Auto Components" },
      { name: "HCL Technologies", symbol: "HCLTECH.NS", weight: 3.44, sector: "Information Technology" },
      { name: "Axis Bank", symbol: "AXISBANK.NS", weight: 3.16, sector: "Financial Services" },
      { name: "Infosys", symbol: "INFY.NS", weight: 2.98, sector: "Information Technology" },
      { name: "Bharti Airtel", symbol: "BHARTIARTL.NS", weight: 2.94, sector: "Telecommunication" },
      { name: "Maruti Suzuki", symbol: "MARUTI.NS", weight: 2.84, sector: "Automobile and Auto Components" },
      { name: "TCS", symbol: "TCS.NS", weight: 2.51, sector: "Information Technology" },
      { name: "Alphabet", symbol: "GOOGL", weight: 4.46, sector: "Information Technology" },
      { name: "Meta Platforms", symbol: "META", weight: 2.20, sector: "Information Technology" },
      { name: "Amazon", symbol: "AMZN", weight: 2.19, sector: "Consumer Services" },
      { name: "Microsoft", symbol: "MSFT", weight: 1.81, sector: "Information Technology" }
    ],
    sectorHistory: [],
    entries: [],
    exits: [],
    coverageNote: "Current official holdings, industry allocation and turnover are available. Entry/exit timing awaits a second archived monthly portfolio snapshot."
  },
  "hdfc-flexi": {
    asOf: "2026-05-31",
    factsheetUrl: "https://files.hdfcfund.com/s3fs-public/Others/2026-06/Fund%20Facts%20-%20HDFC%20Flexi%20Cap%20Fund_June%2026.pdf",
    factsheetLabel: "HDFC Flexi Cap Fund — June 2026 fund facts",
    turnover: { equityPct: 8.91, totalPct: 10.08, interpretation: "equity and total turnover" },
    sectorWeights: HDFC_SECTOR_HISTORY.map(item => ({ sector: item.sector, weight: item.values.at(-1) })),
    sectorHistory: HDFC_SECTOR_HISTORY,
    holdings: [
      { name: "ICICI Bank", symbol: "ICICIBANK.NS", weight: 8.83, sector: "Financial Services" },
      { name: "Axis Bank", symbol: "AXISBANK.NS", weight: 6.84, sector: "Financial Services" },
      { name: "HDFC Bank", symbol: "HDFCBANK.NS", weight: 6.48, sector: "Financial Services" },
      { name: "State Bank of India", symbol: "SBIN.NS", weight: 4.22, sector: "Financial Services" },
      { name: "SBI Life", symbol: "SBILIFE.NS", weight: 3.76, sector: "Financial Services" },
      { name: "Larsen & Toubro", symbol: "LT.NS", weight: 3.55, sector: "Construction" },
      { name: "Kotak Mahindra Bank", symbol: "KOTAKBANK.NS", weight: 3.43, sector: "Financial Services" },
      { name: "Bharti Airtel", symbol: "BHARTIARTL.NS", weight: 2.96, sector: "Telecommunication" },
      { name: "Maruti Suzuki", symbol: "MARUTI.NS", weight: 2.91, sector: "Automobile and Auto Components" },
      { name: "Cipla", symbol: "CIPLA.NS", weight: 2.89, sector: "Healthcare" }
    ],
    entries: [
      { name: "Lenskart Solutions", symbol: null, sector: "Retailing", effectiveDate: "2026-05-01" },
      { name: "TVS Motor", symbol: "TVSMOTOR.NS", sector: "Automobile and Auto Components", effectiveDate: "2026-05-01" },
      { name: "ICICI Prudential AMC", symbol: null, sector: "Financial Services", effectiveDate: "2026-05-01" },
      { name: "Neuland Laboratories", symbol: "NEULANDLAB.NS", sector: "Healthcare", effectiveDate: "2026-05-01" },
      { name: "Nippon Life India AMC", symbol: "NAM-INDIA.NS", sector: "Financial Services", effectiveDate: "2026-05-01" },
      { name: "Hexaware Technologies", symbol: "HEXT.NS", sector: "Information Technology", effectiveDate: "2026-05-01" },
      { name: "ABB India", symbol: "ABB.NS", sector: "Capital Goods", effectiveDate: "2026-05-01" }
    ],
    exits: [
      { name: "Multi Commodity Exchange", symbol: "MCX.NS", sector: "Financial Services", effectiveDate: "2026-05-31" },
      { name: "Tata Consultancy Services", symbol: "TCS.NS", sector: "Information Technology", effectiveDate: "2026-05-31" },
      { name: "Cohance Lifesciences", symbol: "COHANCE.NS", sector: "Healthcare", effectiveDate: "2026-05-31" }
    ],
    increasedExposure: [
      "InterGlobe Aviation", "Britannia Industries", "ICICI Bank", "Aster DM Healthcare", "PB Fintech", "Larsen & Toubro", "Maruti Suzuki", "Hindustan Petroleum", "Eternal", "Kalpataru Projects", "Ashok Leyland", "Max Healthcare", "Reliance Industries", "Eicher Motors"
    ],
    decreasedExposure: ["Bank of Baroda", "Bajaj Auto", "Infosys", "ONGC", "Tata Steel"],
    coverageNote: "Official factsheet includes six-month sector trends, turnover and a complete monthly entry/exit list."
  },
  "sbi-small": {
    asOf: "2026-05-31",
    factsheetUrl: "https://www.sbimf.com/docs/default-source/scheme-factsheets/sbi-small-cap-fund-factsheet-may-2026.pdf?sfvrsn=905f0beb_2",
    factsheetLabel: "SBI Small Cap Fund — May 2026 factsheet",
    turnover: { equityPct: 10, totalPct: 97, interpretation: "0.10x equity and 0.97x total annual turnover converted to percentage" },
    sectorWeights: [
      { sector: "Financial Services", weight: 15.96 },
      { sector: "Automobile and Auto Components", weight: 14.51 },
      { sector: "Capital Goods", weight: 12.25 },
      { sector: "Chemicals", weight: 9.35 },
      { sector: "Consumer Durables", weight: 8.03 },
      { sector: "Fast Moving Consumer Goods", weight: 7.09 },
      { sector: "Consumer Services", weight: 6.95 },
      { sector: "Construction", weight: 5.16 },
      { sector: "Healthcare", weight: 2.81 },
      { sector: "Information Technology", weight: 2.26 },
      { sector: "Realty", weight: 0.77 }
    ],
    holdings: [
      { name: "Ather Energy", symbol: "ATHERENERG.NS", weight: 5.18, sector: "Automobile and Auto Components" },
      { name: "Navin Fluorine", symbol: "NAVINFLUOR.NS", weight: 3.11, sector: "Chemicals" },
      { name: "Honeywell Automation", symbol: "HONAUT.NS", weight: 2.83, sector: "Capital Goods" },
      { name: "Kalpataru Projects", symbol: "KPIL.NS", weight: 2.76, sector: "Construction" },
      { name: "ZF Commercial Vehicle", symbol: "ZFCVINDIA.NS", weight: 2.75, sector: "Automobile and Auto Components" },
      { name: "City Union Bank", symbol: "CUB.NS", weight: 2.69, sector: "Financial Services" },
      { name: "Belrise Industries", symbol: "BELRISE.NS", weight: 2.52, sector: "Automobile and Auto Components" },
      { name: "KIMS", symbol: "KIMS.NS", weight: 2.50, sector: "Healthcare" },
      { name: "Sundram Fasteners", symbol: "SUNDRMFAST.NS", weight: 2.30, sector: "Automobile and Auto Components" },
      { name: "SBFC Finance", symbol: "SBFC.NS", weight: 2.25, sector: "Financial Services" },
      { name: "Kajaria Ceramics", symbol: "KAJARIACER.NS", weight: 2.01, sector: "Consumer Durables" },
      { name: "KPR Mill", symbol: "KPRMILL.NS", weight: 1.99, sector: "Fast Moving Consumer Goods" }
    ],
    sectorHistory: [],
    entries: [],
    exits: [],
    coverageNote: "Current official holdings, sector allocation and turnover are available. Exit timing requires successive monthly factsheet snapshots."
  },
  "icici-baf": {
    asOf: "2026-04-30",
    factsheetUrl: "https://digitalfactsheet.icicipruamc.com/fact/pdf/icici-prudential-balanced-advantage-fund.pdf",
    factsheetLabel: "ICICI Prudential Balanced Advantage Fund — April 2026 factsheet",
    turnover: { equityPct: 306, totalPct: 306, interpretation: "official annual equity portfolio turnover ratio of 3.06 times" },
    netEquityPct: 53.2,
    grossEquityPct: 72.27,
    sectorWeights: [
      { sector: "Financial Services", weight: 17.05 },
      { sector: "Automobile and Auto Components", weight: 9.54 },
      { sector: "Information Technology", weight: 5.92 },
      { sector: "Retailing", weight: 4.69 },
      { sector: "Energy", weight: 5.10 },
      { sector: "Construction", weight: 3.90 },
      { sector: "Consumer Durables", weight: 1.62 },
      { sector: "Healthcare", weight: 1.23 },
      { sector: "Capital Goods", weight: 0.88 },
      { sector: "Realty", weight: 0.57 }
    ],
    holdings: [
      { name: "ICICI Bank", symbol: "ICICIBANK.NS", weight: 3.97, sector: "Financial Services" },
      { name: "HDFC Bank", symbol: "HDFCBANK.NS", weight: 3.65, sector: "Financial Services" },
      { name: "State Bank of India", symbol: "SBIN.NS", weight: 1.88, sector: "Financial Services" },
      { name: "Axis Bank", symbol: "AXISBANK.NS", weight: 1.74, sector: "Financial Services" },
      { name: "TCS", symbol: "TCS.NS", weight: 0.64, sector: "Information Technology" },
      { name: "Infosys", symbol: "INFY.NS", weight: 2.95, sector: "Information Technology" },
      { name: "Reliance Industries", symbol: "RELIANCE.NS", weight: 3.27, sector: "Energy" },
      { name: "Eternal", symbol: "ETERNAL.NS", weight: 1.70, sector: "Retailing" },
      { name: "InterGlobe Aviation", symbol: "INDIGO.NS", weight: 1.44, sector: "Consumer Services" },
      { name: "Bharti Airtel", symbol: "BHARTIARTL.NS", weight: 1.32, sector: "Telecommunication" }
    ],
    sectorHistory: [],
    entries: [],
    exits: [],
    coverageNote: "Current official sector allocation, holdings, net-equity level and turnover are available. Monthly entry/exit history is not disclosed on this factsheet page."
  }
};

export const CYCLE_PROFILES = {
  "ppfas-flexi": { label: "Stayer / defensive compounder", riskOn: 62, rotation: 82, riskOff: 88, neutral: 78 },
  "hdfc-flexi": { label: "All-weather anchor", riskOn: 76, rotation: 84, riskOff: 72, neutral: 82 },
  "sbi-small": { label: "Risk-on sprinter", riskOn: 94, rotation: 74, riskOff: 38, neutral: 66 },
  "icici-baf": { label: "Defensive tactician", riskOn: 58, rotation: 86, riskOff: 94, neutral: 80 }
};

export function getMomentumSnapshot(schemeId) {
  return MOMENTUM_SNAPSHOTS[schemeId] || null;
}
