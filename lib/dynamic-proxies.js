import { INDEX_PROXIES } from "@/lib/manager-data";

const MIDCAP_150 = {
  id: "midcap150",
  label: "NIFTY Midcap 150 investable proxy",
  quality: "High",
  description: "Category-aligned passive mid-cap comparison standard.",
  components: [{
    weight: 1,
    queries: [
      "Motilal Oswal Nifty Midcap 150 Index Fund Direct Growth",
      "Nifty Midcap 150 Index Fund Direct Growth",
      "NIFTY Midcap 150 Index Fund Direct Plan Growth"
    ]
  }]
};

const NIFTY_100 = {
  id: "nifty100",
  label: "NIFTY 100 investable proxy",
  quality: "High",
  description: "Broad large-cap comparison standard.",
  components: [{
    weight: 1,
    queries: [
      "Nippon India Index Fund Nifty 100 Plan Direct Growth",
      "Nifty 100 Index Fund Direct Growth",
      "NIFTY 100 Index Fund Direct Plan Growth"
    ]
  }]
};

const GOLD = {
  id: "gold",
  label: "Gold ETF fund proxy",
  quality: "Medium-high",
  description: "Investable domestic gold comparison standard.",
  components: [{
    weight: 1,
    queries: [
      "HDFC Gold ETF Fund of Fund Direct Growth",
      "Nippon India Gold Savings Fund Direct Growth",
      "Gold Fund Direct Growth"
    ]
  }]
};

const MULTI_ASSET = {
  id: "multiasset",
  label: "60% NIFTY 500 + 25% liquid + 15% gold synthetic proxy",
  quality: "Medium-high",
  description: "Transparent multi-asset proxy where the official benchmark is not directly investable.",
  components: [
    { weight: 0.6, queries: INDEX_PROXIES.nifty500.components[0].queries },
    { weight: 0.25, queries: INDEX_PROXIES.liquid.components[0].queries },
    { weight: 0.15, queries: GOLD.components[0].queries }
  ]
};

function containsAny(text, words) {
  return words.some(word => text.includes(word));
}

export function proxyProfileForFund(fund) {
  const text = [fund?.category, fund?.displayName, fund?.preferredSchemeName].join(" ").toLowerCase();
  let official = INDEX_PROXIES.nifty500;
  let category = INDEX_PROXIES.nifty500;
  let broad = INDEX_PROXIES.nifty50;
  let defensive = INDEX_PROXIES.liquid;

  if (containsAny(text, ["small cap", "smallcap"])) {
    official = INDEX_PROXIES.smallcap250;
    category = INDEX_PROXIES.smallcap250;
    broad = INDEX_PROXIES.nifty500;
  } else if (containsAny(text, ["mid cap", "midcap"])) {
    official = MIDCAP_150;
    category = MIDCAP_150;
    broad = INDEX_PROXIES.nifty500;
  } else if (containsAny(text, ["large cap", "bluechip", "large & mid", "large and mid"])) {
    official = NIFTY_100;
    category = NIFTY_100;
    broad = INDEX_PROXIES.nifty50;
  } else if (containsAny(text, ["balanced advantage", "dynamic asset allocation", "aggressive hybrid", "equity savings", "hybrid"])) {
    official = INDEX_PROXIES.balanced5050;
    category = INDEX_PROXIES.balanced5050;
    broad = INDEX_PROXIES.nifty50;
  } else if (containsAny(text, ["multi asset", "multi-asset"])) {
    official = MULTI_ASSET;
    category = MULTI_ASSET;
    broad = INDEX_PROXIES.nifty500;
  } else if (containsAny(text, ["gold", "silver", "commodity"])) {
    official = GOLD;
    category = GOLD;
    broad = INDEX_PROXIES.nifty50;
  } else if (containsAny(text, ["liquid", "overnight", "money market", "ultra short", "low duration", "short duration", "corporate bond", "gilt", "banking and psu", "debt", "income fund", "credit risk", "floater"])) {
    official = INDEX_PROXIES.liquid;
    category = INDEX_PROXIES.liquid;
    broad = INDEX_PROXIES.liquid;
    defensive = INDEX_PROXIES.liquid;
  }

  return {
    official,
    category,
    broad,
    defensive,
    custom: null
  };
}

export function detailedMomentumSchemeId(fund) {
  const text = [fund?.canonicalName, fund?.displayName, fund?.preferredSchemeName].join(" ").toLowerCase();
  if (text.includes("parag parikh flexi cap")) return "ppfas-flexi";
  if (text.includes("hdfc flexi cap")) return "hdfc-flexi";
  if (text.includes("sbi small cap")) return "sbi-small";
  if (text.includes("icici prudential balanced advantage")) return "icici-baf";
  return null;
}

export { MIDCAP_150, NIFTY_100, GOLD, MULTI_ASSET };
