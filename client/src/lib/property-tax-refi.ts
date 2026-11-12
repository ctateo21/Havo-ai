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
}

/**
 * Converts a successful current-bill API response into the only four
 * tracked-loan fields the lookup is allowed to update.
 */
export function buildCurrentTaxLookupPatch(
  data: unknown,
  queriedAt = new Date(),
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

  const patch: PropertyTaxLoanPatch = {
    annualPropertyTax: Math.round(result.annualTax * 100) / 100,
    annualPropertyTaxSource: result.source,
    annualPropertyTaxYear: result.taxYear,
    annualPropertyTaxQueriedAt: queriedAt.toISOString(),
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
  };
}