/**
 * External, source-backed facts shown on the awareness pages.
 * Every entry records what the number means, where it comes from and how it
 * was checked. Last reviewed: 28 October 2026. Update these when newer
 * editions of the reports are published.
 */
export interface SourcedFact {
  id: string;
  value: string;
  unit: string;
  statement: string;
  scope: string;           // geography and coverage
  definition: string;      // what is and isn't counted
  sourceOrg: string;
  report: string;
  year: number;            // publication year
  dataYear: string;        // year the estimate refers to
  url: string;
  /** "primary" = checked against the publisher's own document; "secondary" = only seen in reports about it. */
  check: "primary" | "secondary";
  note?: string;
}

const UNEP_FWIR_KEY_MESSAGES = "https://wedocs.unep.org/bitstream/handle/20.500.11822/45275/Food-Waste-Index-2024-key-messages.pdf?sequence=4";
const FAO_SDG_1231 = "https://www.fao.org/sustainable-development-goals-data-portal/data/indicators/1231-global-food-losses";
const SOFI_2025 = "https://data.unicef.org/resources/sofi-2025/";

export const FACTS: SourcedFact[] = [
  {
    id: "global-waste", value: "1.05 billion", unit: "tonnes of food wasted in 2022",
    statement: "Households, food service and retail together wasted an estimated 1.05 billion tonnes of food in 2022.",
    scope: "Global; retail, food service and household levels.",
    definition: "Food waste (SDG 12.3.1b) is measured after food reaches retail. Food lost earlier in the supply chain is counted separately as food loss.",
    sourceOrg: "United Nations Environment Programme (UNEP), with WRAP", report: "Food Waste Index Report 2024 — key messages", year: 2024, dataYear: "2022",
    url: UNEP_FWIR_KEY_MESSAGES, check: "primary",
  },
  {
    id: "consumer-share", value: "19%", unit: "of food available to consumers",
    statement: "About one fifth of the food available to consumers was wasted at retail, food service and household level.",
    scope: "Global.", definition: "Share of food available to consumers that ends up as food waste (retail, food service, households).",
    sourceOrg: "UNEP, with WRAP", report: "Food Waste Index Report 2024 — key messages", year: 2024, dataYear: "2022", url: UNEP_FWIR_KEY_MESSAGES, check: "primary",
  },
  {
    id: "households", value: "631 million", unit: "tonnes (60%) wasted by households",
    statement: "Households were the largest source (631 million tonnes), followed by food service (290 million) and retail (131 million).",
    scope: "Global.", definition: "Split of the 2022 food-waste estimate by sector.",
    sourceOrg: "UNEP, with WRAP", report: "Food Waste Index Report 2024 — key messages", year: 2024, dataYear: "2022", url: UNEP_FWIR_KEY_MESSAGES, check: "primary",
  },
  {
    id: "per-person", value: "79 kg", unit: "per person per year, at home",
    statement: "On average each person wasted about 79 kg of food a year at household level.",
    scope: "Global average.", definition: "Household food waste divided by population; national values vary widely.",
    sourceOrg: "UNEP, with WRAP", report: "Food Waste Index Report 2024 — key messages", year: 2024, dataYear: "2022", url: UNEP_FWIR_KEY_MESSAGES, check: "primary",
  },
  {
    id: "food-loss", value: "13.3%", unit: "of food lost after harvest, before retail",
    statement: "An estimated 13.3% of food was lost after harvest — on farms and in transport, storage, wholesale and processing — up slightly from 13.0% in 2015.",
    scope: "Global.", definition: "Food loss (SDG 12.3.1a) covers the supply chain from harvest up to, but not including, retail. It is different from food waste.",
    sourceOrg: "Food and Agriculture Organization of the United Nations (FAO)", report: "SDG Indicators Data Portal — Indicator 12.3.1 Global food losses", year: 2025, dataYear: "2023",
    url: FAO_SDG_1231, check: "primary", note: "Publication year refers to the portal's latest update as accessed in October 2026.",
  },
  {
    id: "emissions", value: "8–10%", unit: "of global greenhouse-gas emissions",
    statement: "Food loss and waste generates an estimated 8–10% of global greenhouse-gas emissions.",
    scope: "Global.", definition: "Emissions associated with food that is lost or wasted across the whole food system. This is an estimate range, not a measured total.",
    sourceOrg: "UNEP, with WRAP", report: "Food Waste Index Report 2024 — key messages", year: 2024, dataYear: "Recent estimates", url: UNEP_FWIR_KEY_MESSAGES, check: "primary",
  },
  {
    id: "hunger", value: "673 million", unit: "people faced hunger in 2024",
    statement: "An estimated 673 million people faced hunger in 2024, and about 2.3 billion experienced moderate or severe food insecurity.",
    scope: "Global.", definition: "Hunger = prevalence of undernourishment (chronic insufficient dietary energy). Food insecurity is a broader measure based on people's experience of access to food.",
    sourceOrg: "FAO, IFAD, UNICEF, WFP and WHO", report: "The State of Food Security and Nutrition in the World 2025 (SOFI 2025)", year: 2025, dataYear: "2024",
    url: SOFI_2025, check: "primary", note: "Values are model-based estimates with uncertainty ranges published in the full report.",
  },
  {
    id: "india-household", value: "≈55 kg", unit: "per person per year, Indian households",
    statement: "India's household food waste is estimated at roughly 55 kg per person per year (about 78 million tonnes in total).",
    scope: "India, household level only.", definition: "Country-level household estimate from the Food Waste Index's modelled and measured data.",
    sourceOrg: "UNEP, with WRAP (country estimate)", report: "Food Waste Index Report 2024 — country data", year: 2024, dataYear: "2022",
    url: "https://www.drishtiias.com/daily-updates/daily-news-analysis/indias-food-waste-conundrum", check: "secondary",
    note: "We could not open the report's country annex to confirm this exact figure; it is shown as reported in secondary summaries. Check the full UNEP report before citing it.",
  },
];

export const HOME_FACT_IDS = ["global-waste", "food-loss", "emissions", "hunger"];

export interface Guidance { title: string; points: string[]; source?: { label: string; url: string } }

export const GUIDANCE: Guidance[] = [
  {
    title: "Why rescue edible surplus food — safely",
    points: [
      "Edible surplus from kitchens, messes, events and shops can feed people instead of becoming waste, which also avoids the emissions of producing food that nobody eats.",
      "Rescue only works when it is safe: cooked food must be kept hot or chilled, collected quickly and used before its safe-use deadline.",
      "Food rescue does not fix the causes of hunger or overproduction. Preventing surplus in the first place is always better than redistributing it.",
    ],
  },
  {
    title: "How donors can prevent waste",
    points: [
      "Plan production from real attendance and sales data, and cook in batches rather than all at once.",
      "Keep unserved food separate from served food from the start, so it remains suitable for donation.",
      "Record preparation times and storage temperatures, list ingredients and allergens, and publish surplus early while there is time to collect it.",
    ],
    source: { label: "FSSAI: Food Safety and Standards (Recovery and Distribution of Surplus Food) Regulations, 2019 — press release", url: "https://www.fssai.gov.in/upload/uploadfiles/files/Press_Release_Gazette_Notification_Surplus_Food_06_08_2019.pdf" },
  },
  {
    title: "How NGOs can redistribute responsibly",
    points: [
      "Request only what you can collect, store and serve before the safe-use deadline.",
      "Check temperature, packaging, smell and appearance at handover. If in doubt, don't serve it.",
      "Pass allergen and ingredient information on to the people you serve.",
    ],
  },
  {
    title: "Food unsafe for people is not automatically safe for animals",
    points: [
      "Spoiled, mouldy or contaminated food can make animals ill too. EDIBELL never re-routes food rejected for people to animals.",
      "Several common human foods are dangerous to pets — including xylitol, grapes and raisins, onions, garlic and chocolate.",
      "Heavily salted, spiced, oily or sugary leftovers and cooked bones are unsuitable for most animals.",
    ],
    source: { label: "ASPCA Animal Poison Control: Official Top 10 Toxins of 2024", url: "https://www.aspca.org/news/official-top-10-toxins-2024" },
  },
  {
    title: "How animal-suitable food is assessed on EDIBELL",
    points: [
      "Donors choose the specific species the food suits and must confirm every item of an animal-feed screening checklist.",
      "Food for dogs or cats must also be confirmed free of onion and garlic.",
      "Plate leftovers and meat or fish scraps are held for an EDIBELL safety review before any animal welfare organization can see them.",
      "Animal welfare organizations see only listings screened for animals, and can request them only for the species the donor marked suitable. Veterinary advice should guide feeding decisions.",
    ],
  },
  {
    title: "How EDIBELL connects organizations",
    points: [
      "Registered donors publish listings with safety, photo and pickup details. Exact addresses are shared only after a donor accepts a request.",
      "NGOs and animal welfare organizations discover eligible food and request a quantity; the donor accepts or declines.",
      "An accepted recipient receives a single-use Pickup Pass QR. The donor scans it at handover, and only that server-verified scan completes the pickup and counts towards impact.",
    ],
  },
];
