import type { QuoteRushParams } from "./quoterush";

/** Importer sample documents these keys. Never spread untrusted property/AI data. */
export const HOME_FIELD_RULES = {
  StructureType: ["Single Family", "Duplex (2 Family)", "Triplex (3 Family)", "Quadplex (4 Family)", "Rowhouse (Townhouse Center)", "Rowhouse (Townhouse End)", "Bi-Level", "Tri-Level"],
  Stories: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
  Pool: ["None", "Inground - small < 300 sq ft", "Inground - med 300-600 sq ft", "Inground - large > 600 sq ft", "Above Ground", "Indoor"],
  FullBathCount: "area",
  ScreenedEnclosureSquareFeet: "area",
  ScreenedCoverage: "money",
  ProtectionClass: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
  BCEG: ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"],
} as const;
export type HomeField = keyof typeof HOME_FIELD_RULES;
export type HomeEvidence = {
  value: string; source: "property data" | "OpenRouter"; confidence: number;
  estimated: boolean; fetchedAt: string;
};
export type HomeFields = Partial<Record<HomeField, HomeEvidence>>;

export function validateHomeValue(key: HomeField, value: unknown): string | null {
  const rule = HOME_FIELD_RULES[key];
  if (value == null || typeof value === "object") return null;
  const text = String(value).trim();
  if (Array.isArray(rule)) return (rule as readonly string[]).includes(text) ? text : null;
  const numeric = text.replace(/[$,]/g, "");
  if (!/^\d+$/.test(numeric) || Number(numeric) > 1000000) return null;
  return rule === "money" ? `$${Number(numeric).toLocaleString("en-US")}` : String(Number(numeric));
}

export function parseHomeEstimates(text: string, now = new Date()): HomeFields {
  const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const output: HomeFields = {};
  for (const key of Object.keys(HOME_FIELD_RULES) as HomeField[]) {
    const entry = json?.[key];
    const value = validateHomeValue(key, entry?.value);
    if (value === null || typeof entry?.confidence !== "number" ||
      entry.confidence < 0 || entry.confidence > 1) continue;
    output[key] = {value, source:"OpenRouter", confidence:entry.confidence,
      estimated:true, fetchedAt:now.toISOString()};
  }
  return output;
}

export function homeFieldNotes(fields: HomeFields): string[] {
  return Object.entries(fields).map(([key, fact]) =>
    `${key}: ${fact.value} — ${fact.estimated ? "estimated, " : ""}${fact.source}; confidence ${Math.round(fact.confidence * 100)}%`);
}

export const APPLY_DEFAULT_NOTES = [
  "Agency defaults — verify: Families 1; Electrical Circuit Breakers; Heat Electric; Plumbing PVC; roof renovation Full.",
  "Agency defaults — verify: Burglar/Fire Alarm None; station Within 5 Miles; hydrant Within 1000 Feet; Sprinklers None; BusinessOnPremises No; FireExtinguisher true.",
  "Agency coverage defaults: B 2%, C 25%, D 10%, liability $300,000; HO3 medical $5,000; LossAssessment $1,000; roof settlement Replacement Cost. User deductibles and occupancy take precedence.",
  "Agency default — verify: GatedCommunity Single Entry. Water heater location importer field requires QuoteRush confirmation.",
];

export function importerHomeExtras(p: QuoteRushParams): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(HOME_FIELD_RULES) as HomeField[]) {
    const value = validateHomeValue(key, p.homeFields?.[key]?.value);
    if (value !== null) fields[key] = value;
  }
  return {
    Families: String(({"Duplex (2 Family)":2,"Triplex (3 Family)":3,"Quadplex (4 Family)":4} as Record<string,number>)[String(fields.StructureType)] ?? 1),
    ...(fields.Pool==="None" ? {PoolScreenedEnclosure:false}:{}),
    ElectricalType: "Circuit Breakers",
    PrimaryHeatSource: "Electric",
    PlumbingType: "PVC",
    AdditionalLawOrdinance: "25%",
    OptionalPersonalPropertyReplacementCost: true,
    Sprinklers: "None",
    GatedCommunity: "Single Entry",
    BusinessOnPremises: "No",
    ...(p.policyType === "HO6" ? {} : {LossAssessment: "$1,000"}),
    underwriting: {FireExtinguisher: true},
    ...fields,
  };
}
