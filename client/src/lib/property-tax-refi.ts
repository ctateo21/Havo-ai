import type { OfficialTaxBreakdown } from "@shared/official-tax";
import { parseOfficialTaxBreakdown } from "./official-property-tax";

export type AnnualPropertyTaxSource =
  | "manual"
  | "tax-collector-bill-scrape"
  | "manatee-arcgis";

export interface PropertyTaxLoanPatch {
  annualPropertyTax: number;
  annualPropertyTaxSource: AnnualPropertyTaxSource;
  annualPropertyTaxYear?: number;
  annualPropertyTaxQueriedAt?: string;
  annualPropertyTaxSourceLabel?: string;
  annualPropertyTaxAdValorem?: number;
  annualPropertyTaxNonAdValorem?: number;
  annualPropertyTaxCounty?: string;
  annualPropertyTaxBreakdown?: OfficialTaxBreakdown | null;
}

/** No client clock or legacy lookup timestamp can stand in for county evidence. */
export function currentBillFetchedAt(breakdown?: OfficialTaxBreakdown | null): string | undefined {
  const sources = [breakdown?.adValorem.source, breakdown?.nonAdValorem.source, breakdown?.total.source];
  const dates = sources.flatMap(source => source && Number.isFinite(Date.parse(source.fetchedAt))
    ? [source.fetchedAt] : []);
  // Oldest component determines freshness; each component retains its own timestamp.
  return dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

/** Persistence guard: never attach evidence to a manual or mismatched amount. */
export function savedCurrentBillBreakdown(value: unknown, source: unknown, annual: unknown) {
  if (source !== "tax-collector-bill-scrape" && source !== "manatee-arcgis") return undefined;
  const breakdown = parseOfficialTaxBreakdown(value);
  return breakdown?.total.cents != null && typeof annual === "number"
    && breakdown.total.cents === Math.round(annual * 100) ? breakdown : undefined;
}

/** Undefined omits the new column on legacy saves; null explicitly clears evidence. */
export function currentBillEvidenceToRow(loan: {
  annualPropertyTax?: number;
  annualPropertyTaxSource?: AnnualPropertyTaxSource;
  annualPropertyTaxBreakdown?: OfficialTaxBreakdown | null;
}) {
  if (loan.annualPropertyTaxSource !== "manual" && loan.annualPropertyTaxBreakdown === undefined) return {};
  const breakdown = savedCurrentBillBreakdown(
    loan.annualPropertyTaxBreakdown, loan.annualPropertyTaxSource, loan.annualPropertyTax);
  return {
    annual_property_tax_breakdown: breakdown ?? null,
    annual_property_tax_queried_at: currentBillFetchedAt(breakdown) ?? null,
  };
}

/** Converts a successful current-bill API response into tax-only fields. */
export function buildCurrentTaxLookupPatch(
  data: unknown,
): PropertyTaxLoanPatch | null {
  if (!data || typeof data !== "object") return null;
  const result = data as Record<string, unknown>;
  if (result.state !== "ready") return null;
  if (
    typeof result.annualTax !== "number" ||
    !Number.isFinite(result.annualTax) ||
    result.annualTax < 0
  ) {
    return null;
  }
  if (
    result.source !== "tax-collector-bill-scrape" &&
    result.source !== "manatee-arcgis"
  ) {
    return null;
  }
  if (
    typeof result.taxYear !== "number" ||
    !Number.isInteger(result.taxYear) ||
    result.taxYear < 2000
  ) {
    return null;
  }

  const breakdown = parseOfficialTaxBreakdown(result.breakdown);
  // A present but incomplete official breakdown cannot be replaced by a legacy number.
  if (result.breakdown != null && breakdown?.total.cents == null) return null;
  const patch: PropertyTaxLoanPatch = {
    annualPropertyTax: breakdown?.total.cents != null
      ? breakdown.total.cents / 100 : Math.round(result.annualTax * 100) / 100,
    annualPropertyTaxSource: result.source,
    annualPropertyTaxYear: result.taxYear,
    annualPropertyTaxQueriedAt: currentBillFetchedAt(breakdown),
    annualPropertyTaxBreakdown: breakdown ?? null,
    annualPropertyTaxSourceLabel: undefined,
    annualPropertyTaxAdValorem: undefined,
    annualPropertyTaxNonAdValorem: undefined,
    annualPropertyTaxCounty: undefined,
  };
  if (typeof result.sourceLabel === "string" && result.sourceLabel.trim()) {
    patch.annualPropertyTaxSourceLabel = result.sourceLabel.trim();
  }
  if (typeof result.adValoremTax === "number" && Number.isFinite(result.adValoremTax)) {
    patch.annualPropertyTaxAdValorem = result.adValoremTax;
  }
  if (typeof result.nonAdValoremTax === "number" && Number.isFinite(result.nonAdValoremTax)) {
    patch.annualPropertyTaxNonAdValorem = result.nonAdValoremTax;
  }
  if (typeof result.county === "string" && result.county.trim()) {
    patch.annualPropertyTaxCounty = result.county.trim();
  }
  if (breakdown) {
    patch.annualPropertyTaxAdValorem = breakdown.adValorem.cents! / 100;
    patch.annualPropertyTaxNonAdValorem = breakdown.nonAdValorem.cents! / 100;
  }
  return patch;
}

/** Builds a manual-entry patch without touching any refinance inputs. */
export function buildManualPropertyTaxPatch(
  annualAmount: number,
): PropertyTaxLoanPatch | null {
  if (!Number.isFinite(annualAmount) || annualAmount < 0) return null;
  return {
    annualPropertyTax: Math.round(annualAmount * 100) / 100,
    annualPropertyTaxSource: "manual",
    annualPropertyTaxYear: undefined,
    annualPropertyTaxQueriedAt: undefined,
    annualPropertyTaxBreakdown: null,
    annualPropertyTaxSourceLabel: undefined,
    annualPropertyTaxAdValorem: undefined,
    annualPropertyTaxNonAdValorem: undefined,
    annualPropertyTaxCounty: undefined,
  };
}