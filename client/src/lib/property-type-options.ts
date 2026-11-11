// Canonical Physical Property Type dropdown options shared by the
// Purchase-with-Loan (estimate.tsx), Purchase-with-Cash (cash-buy.tsx)
// and Refinance (loan-tracker.tsx) flows. Used as the source of truth
// for the Phase 2 insurance policy-type rule — Condo / Townhouse /
// Townhome physical types force HO6 regardless of occupancy.
export const PHYSICAL_PROPERTY_TYPE_OPTIONS = [
  "Single Family Residence",
  "Townhouse",
  "Condominium",
  "Villa",
  "Land",
  "Manufactured Home",
  "Multi-Family",
  "Duplex",
  "Triplex",
  "Quadplex",
  "Other",
] as const;

export type PhysicalPropertyTypeOption =
  typeof PHYSICAL_PROPERTY_TYPE_OPTIONS[number];

/** Map a raw Zillow / property_cache homeType string into one of the
 *  canonical dropdown values. Returns null when the input is empty or
 *  doesn't recognizably map — callers should fall back to
 *  "Single Family Residence" in that case. */
export function zillowToPhysicalPropertyType(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return null;
  if (s.includes("QUAD") || s.includes("FOURPLEX")) return "Quadplex";
  if (s.includes("TRIPLEX")) return "Triplex";
  if (s.includes("DUPLEX")) return "Duplex";
  if (s.includes("MULTI")) return "Multi-Family";
  if (s.includes("TOWN")) return "Townhouse";
  if (s.includes("CONDO") || s === "APARTMENT") return "Condominium";
  if (s.includes("VILLA")) return "Villa";
  if (s.includes("LAND") || s.includes("LOT")) return "Land";
  if (s.includes("MANUFACTURED") || s.includes("MOBILE")) return "Manufactured Home";
  if (s.includes("SINGLE") || s.includes("SFR") || s.includes("HOUSE")) {
    return "Single Family Residence";
  }
  return null;
}
