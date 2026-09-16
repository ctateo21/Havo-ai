import { getCountyName, estimateAnnualTax } from "./county-tax-estimator";
import { isCountyEstimatorVerified } from "@shared/county-estimator-policy";

export type CashBuyTaxOccupancy = "primary" | "secondary" | "investment";
export type CashBuyTaxSource =
  | "manual"
  | "official"
  | "estimated"
  | "formula"
  | "default"
  | "unavailable"
  | "zillow";

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

export interface CashBuyFormulaTaxOptions {
  /**
   * Injectable for regression tests; production uses the shared county gate.
   */
  isCountyEstimatorVerified?: (county: string) => boolean;
}

/**
 * Restore the generic planning estimate used by cash-buy before the
 * parcel-specific lookup. This is deliberately a pure fallback writer:
 * manual values (including an explicit $0) are never touched, and the
 * request tuple is stored so a later verified/parcel response can apply the
 * same stale-value guard as an official result.
 */
export function applyCashBuyFormulaTax<T extends CashBuyTaxScenario>(
  scenario: T,
  options: CashBuyFormulaTaxOptions = {},
): T {
  if (scenario.propertyTaxesSource === "manual") return scenario;
  if (scenario.propertyTaxesSource === "unavailable") return scenario;
  if (typeof scenario.address !== "string") return scenario;
  const county = getCountyName(scenario.address);
  const countyIsVerified =
    county != null &&
    (options.isCountyEstimatorVerified ?? isCountyEstimatorVerified)(county);
  if (countyIsVerified) {
    if (
      scenario.propertyTaxesSource === "official" &&
      cashBuyOfficialTaxTupleMatches(scenario)
    ) {
      return scenario;
    }
    return {
      ...scenario,
      propertyTaxes: undefined,
      propertyTaxesSource: "unavailable",
      propertyTaxesRequest: undefined,
    };
  }
  if (
    (scenario.propertyTaxesSource === "official" ||
      scenario.propertyTaxesSource === "estimated" ||
      scenario.propertyTaxesSource === "formula") &&
    cashBuyOfficialTaxTupleMatches(scenario)
  ) {
    return scenario;
  }
  const purchasePrice = scenario.purchasePrice;
  const occupancyType = scenario.occupancyType;
  if (
    typeof purchasePrice !== "number" ||
    !Number.isFinite(purchasePrice) ||
    purchasePrice <= 0 ||
    !occupancyType ||
    typeof scenario.address !== "string" ||
    !scenario.address.trim() ||
    scenario.address.trim().toLowerCase() === "unknown address"
  ) {
    return scenario;
  }
  const annualTax = estimateAnnualTax(
    scenario.address,
    purchasePrice,
    occupancyType === "primary",
  );
  return {
    ...scenario,
    propertyTaxes: annualTax,
    propertyTaxesSource: "estimated",
    propertyTaxesRequest: {
      address: scenario.address,
      purchasePrice,
      occupancyType,
    },
  };
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
 * A cash-buy tax is borrower-visible only when its provenance is manual, or
 * when an official/formula result is tied to the current request tuple. A
 * saved estimate from before request tuples were persisted is treated as
 * stale until the current lookup supplies a tuple. Zero is valid when
 * explicitly manual or official.
 */
export function hasValidatedCashBuyPropertyTax<T extends CashBuyTaxScenario>(
  scenario: T,
): boolean {
  const tax = scenario.propertyTaxes;
  if (typeof tax !== "number" || !Number.isFinite(tax) || tax < 0) return false;
  if (scenario.propertyTaxesSource === "manual") return true;
  if (scenario.propertyTaxesSource === "official") {
    return cashBuyOfficialTaxTupleMatches(scenario);
  }
  if (
    scenario.propertyTaxesSource === "estimated" ||
    scenario.propertyTaxesSource === "formula"
  ) {
    return cashBuyOfficialTaxTupleMatches(scenario);
  }
  return false;
}

/**
 * Clear stale official/formula cash-buy taxes while preserving every manual
 * value, including an explicitly entered $0 bill. This is intentionally the
 * safe hydration/change-path default until a live lookup supplies the request
 * tuple.
 */
export function clearUnvalidatedCashBuyPropertyTax<T extends CashBuyTaxScenario>(
  scenario: T,
): T {
  const source = scenario.propertyTaxesSource;
  const isOfficial = source === "official";
  const isEstimated = source === "estimated" || source === "formula";
  if (
    (!isOfficial && !isEstimated) ||
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
 * estimate or a zero sentinel with no source provenance. A gated formula
 * estimate is still a usable planning value, but remains distinct from
 * official data in the provenance map.
 */
export function hasValidatedPurchasePropertyTax(scenario: {
  annualTaxes?: number;
  userAnswerSources?: Record<string, string>;
}): boolean {
  const source = scenario.userAnswerSources?.annual_taxes;
  return (
    (source === "manual" || source === "official" ||
      source === "estimated" || source === "formula") &&
    typeof scenario.annualTaxes === "number" &&
    Number.isFinite(scenario.annualTaxes) &&
    scenario.annualTaxes >= 0
  );
}