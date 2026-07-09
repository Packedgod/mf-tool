export type SourceConfidence = "high" | "medium" | "low";

export type ManagerScheme = {
  schemeName: string;
  schemeQuery: string;
  benchmarkQuery: string;
  role: string;
  category: string;
  decisionFocus: string;
  sourceLinks: string[];
};

export type ManagerProfile = {
  id: string;
  name: string;
  amc: string;
  style: string;
  managerStartDate?: string;
  confidence: SourceConfidence;
  thesis: string;
  decisionsToTrack: string[];
  schemes: ManagerScheme[];
};

export const managerUniverse: ManagerProfile[] = [
  {
    id: "rajeev-thakkar",
    name: "Rajeev Thakkar",
    amc: "PPFAS Mutual Fund",
    style: "Value-conscious flexi-cap, lower-beta compounding and overseas allocation discipline",
    managerStartDate: "2013-05-28",
    confidence: "high",
    thesis: "Track whether valuation discipline, lower beta and overseas allocation create alpha without giving up too much upside capture.",
    decisionsToTrack: [
      "Overseas allocation versus domestic equity proxy",
      "Lower beta defensive posture during drawdowns",
      "Turnover discipline and long holding periods",
      "Cash/arbitrage/debt buffer versus fully invested benchmark"
    ],
    schemes: [
      {
        schemeName: "Parag Parikh Flexi Cap Fund - Direct Growth",
        schemeQuery: "Parag Parikh Flexi Cap Direct Growth",
        benchmarkQuery: "Nifty 500 Index Fund Direct Growth",
        role: "Lead equity manager / CIO-led process",
        category: "Flexi Cap",
        decisionFocus: "Overseas sleeve, beta control, concentrated quality/value allocation",
        sourceLinks: ["AMFI", "MFapi", "AMC factsheet", "Value Research", "Morningstar"]
      }
    ]
  },
  {
    id: "amit-ganatra",
    name: "Amit Ganatra",
    amc: "HDFC Mutual Fund",
    style: "Large institutional flexi-cap process with financial-services exposure and succession watch",
    managerStartDate: "2026-02-01",
    confidence: "medium",
    thesis: "Track how the recent lead-manager transition affects benchmark-relative alpha, risk and sector concentration.",
    decisionsToTrack: [
      "Financial-services overweight versus broad market",
      "Post-transition alpha persistence",
      "Downside capture after manager change",
      "Low turnover versus active opportunity capture"
    ],
    schemes: [
      {
        schemeName: "HDFC Flexi Cap Fund - Direct Growth",
        schemeQuery: "HDFC Flexi Cap Direct Growth",
        benchmarkQuery: "Nifty 500 Index Fund Direct Growth",
        role: "Lead equity manager",
        category: "Flexi Cap",
        decisionFocus: "Sector overweight, transition risk, process durability",
        sourceLinks: ["AMFI", "MFapi", "AMC factsheet", "Value Research", "Morningstar"]
      }
    ]
  },
  {
    id: "r-srinivasan",
    name: "R. Srinivasan",
    amc: "SBI Mutual Fund",
    style: "Small-cap specialist with capacity discipline and long-tenure process ownership",
    managerStartDate: "2013-11-01",
    confidence: "medium",
    thesis: "Track whether capacity controls, cash deployment and small-cap selection improve risk-adjusted alpha.",
    decisionsToTrack: [
      "Cash deployment versus small-cap benchmark",
      "Capacity restriction impact",
      "Small-cap drawdown control",
      "Alpha persistence across market cycles"
    ],
    schemes: [
      {
        schemeName: "SBI Small Cap Fund - Direct Growth",
        schemeQuery: "SBI Small Cap Direct Growth",
        benchmarkQuery: "Nifty Smallcap 250 Index Fund Direct Growth",
        role: "Lead small-cap manager",
        category: "Small Cap",
        decisionFocus: "Capacity control, cash use, small-cap selection",
        sourceLinks: ["AMFI", "MFapi", "AMC factsheet", "Value Research", "Morningstar"]
      }
    ]
  },
  {
    id: "rajat-chandak-hab-dolwai",
    name: "Rajat Chandak / Hab Dolwai",
    amc: "ICICI Prudential AMC",
    style: "Dynamic asset-allocation and balanced-advantage process with equity/debt/derivative decisions",
    managerStartDate: "2015-09-01",
    confidence: "high",
    thesis: "Track whether net-equity changes and hedging calls reduce drawdowns while preserving participation.",
    decisionsToTrack: [
      "Net-equity raise or reduction",
      "Hedging effectiveness during down markets",
      "Equity-debt spread capture",
      "Multi-manager process consistency"
    ],
    schemes: [
      {
        schemeName: "ICICI Prudential Balanced Advantage Fund - Direct Growth",
        schemeQuery: "ICICI Prudential Balanced Advantage Direct Growth",
        benchmarkQuery: "ICICI Prudential Nifty 50 Index Direct Growth",
        role: "Equity / dynamic allocation managers",
        category: "Balanced Advantage",
        decisionFocus: "Net equity, hedging, equity-debt allocation",
        sourceLinks: ["AMFI", "MFapi", "AMC factsheet", "Value Research", "Morningstar"]
      }
    ]
  }
];

export const sourceCoverage = [
  {
    source: "MFapi.in",
    live: true,
    use: "Indian scheme search, latest NAV and historical NAV",
    limitation: "Does not provide fund-manager roster, holdings, TER or turnover."
  },
  {
    source: "AMFI",
    live: true,
    use: "Official latest NAV cross-check and scheme identity validation",
    limitation: "NAV feed does not carry manager-level decision data."
  },
  {
    source: "Yahoo Finance",
    live: true,
    use: "Global symbol search, price history and selected fund profile modules where available",
    limitation: "Unofficial endpoints can be brittle and coverage for Indian mutual funds is inconsistent."
  },
  {
    source: "Google Finance",
    live: false,
    use: "Launch/search links for manual public verification",
    limitation: "No official free public API is available for reliable automated extraction."
  },
  {
    source: "FMP",
    live: true,
    use: "Optional global ETF/fund holdings, sector and country allocation with API key",
    limitation: "Requires FMP_API_KEY and is stronger for global ETFs/funds than Indian MF manager rosters."
  },
  {
    source: "AMC factsheets / Value Research / Morningstar",
    live: "connector-needed",
    use: "Manager roster, tenure, holdings, turnover, TER and portfolio decisions",
    limitation: "For full live automation, use licensed API access or a permitted factsheet parser."
  }
];

export const whatIfTemplates = [
  {
    id: "passive-replacement",
    name: "What if the manager simply followed the benchmark?",
    description: "Compares current fund NAV path against a normalised benchmark/peer proxy over the same manager-aware period."
  },
  {
    id: "no-alpha",
    name: "What if alpha was zero?",
    description: "Removes active return over the benchmark and estimates how much terminal NAV came from active decisions."
  },
  {
    id: "fee-drag",
    name: "What if expense drag changed?",
    description: "Tests how a TER increase or decrease would change terminal NAV over the selected period."
  },
  {
    id: "downside-control",
    name: "What if downside capture improved?",
    description: "Models a defensive manager call by reducing losses on benchmark-negative days."
  },
  {
    id: "upside-participation",
    name: "What if upside capture improved?",
    description: "Models a more aggressive participation call on benchmark-positive days."
  },
  {
    id: "allocation-shift",
    name: "What if allocation weight changed?",
    description: "Tests a manager decision such as cash deployment, overseas sleeve shift, sector overweight or equity exposure change."
  }
];
