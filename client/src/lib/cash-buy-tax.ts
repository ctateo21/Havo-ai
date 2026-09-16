export type CashBuyTaxOccupancy = "primary" | "secondary" | "investment";
export type CashBuyTaxSource = "manual" | "official" | "default" | "zillow";

export interface CashBuyOfficialTaxRequest {
  address: string;
  purchasePrice: number;
  occupancyType: CashBuyTaxOccupancy;
}

/** The tax-related portion of a CashBuyScenario, kept dependency-free so
 * provenance guards can be tested without importing the browser auth client. */
export interface CashBuyTaxScenario {
  address: string;
  purchasePrice?: number;
  occupancyType?: CashBuyTaxOccupancy;
  propertyTaxes?: number;
  propertyTaxesSource?: CashBuyTaxSource;
  propertyTaxesRequest?: CashBuyOfficialTaxRequest;
}

function cashBuyOfficialTaxTupleMatches(scenario: CashBuyTaxScenario): boolean {
  const request = scenario.propertyTaxesRequest;
  if (!request || typeof request.address !== "string") return false;
  if (
    typeof request.purchasePrice !== "number" ||
    !Number.isFinite(request.purchasePrice) ||
    typeof scenario.purchasePrice !== "number" ||
    !Number.isFinite(scenario.purchasePrice) ||
    request.purchasePrice !== scenario.purchasePrice
  ) {
    return false;
  }
  if (
    request.address.trim().toLowerCase() !== scenario.address.trim().toLowerCase() ||
    request.occupancyType !== scenario.occupancyType
  ) {
    return false;
  }
  return true;
}

/**
 * A cash-buy tax is borrower-visible only when its provenance is manual or
 * when an official result is tied to the current request tuple. In
 * particular, an untagged number, formula estimate, and legacy official
 * marker are unavailable. Zero is valid when explicitly manual or official.
 */
export function hasValidatedCashBuyPropertyTax<T extends CashBuyTaxScenario>(
  scenario: T,
): boolean {
  const tax = scenario.propertyTaxes;
  if (typeof tax !== "number" || !Number.isFinite(tax) || tax < 0) return false;
  if (scenario.propertyTaxesSource === "manual") return true;
  return scenario.propertyTaxesSource === "official" &&
    cashBuyOfficialTaxTupleMatches(scenario);
}

/**
 * Clear stale official cash-buy taxes while preserving every manual value,
 * including an explicitly entered $0 bill. This is intentionally the safe
 * hydration/change-path default until an official lookup writer supplies the
 * request tuple.
 */
export function clearUnvalidatedCashBuyPropertyTax<T extends CashBuyTaxScenario>(
  scenario: T,
): T {
  if (
    scenario.propertyTaxesSource !== "official" ||
    cashBuyOfficialTaxTupleMatches(scenario)
  ) {
    return scenario;
  }
  return {
    ...scenario,
    propertyTaxes: undefined,
    propertyTaxesSource: "default",
    propertyTaxesRequest: undefined,
  };
}

/**
 * Purchase totals and qualification depend on annual property taxes. A
 * persisted numeric value is not enough: legacy rows may contain a formula
 * estimate or a zero sentinel with no source provenance.
 */
export function hasValidatedPurchasePropertyTax(scenario: {
  annualTaxes?: number;
  userAnswerSources?: Record<string, string>;
}): boolean {
  const source = scenario.userAnswerSources?.annual_taxes;
  return (
    (source === "manual" || source === "official") &&
    typeof scenario.annualTaxes === "number" &&
    Number.isFinite(scenario.annualTaxes) &&
    scenario.annualTaxes >= 0
  );
}