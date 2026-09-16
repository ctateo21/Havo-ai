/**
 * Purchase property-tax integration.
 *
 * Purchase ad valorem is intentionally sourced only from a county's official
 * purchase estimator.  Parcel layers, current tax bills, and millage
 * calculations are useful data for other flows, but are not a county
 * purchase-estimator result and must never be presented as one.
 *
 * Refinance/current-owner tax bills remain in current-tax-bill.ts and are not
 * routed through this module.
 */

import {
  type CountySlug,
} from "./parcel-resolver";
import { runCountyEstimator } from "./county-estimator-runner";
import { PURCHASE_TAX_LOW_ASSESSMENT_RATIO } from "@shared/property-tax-policy";
import {
  totalNonSchoolHomesteadExemptionForYear,
} from "./property-tax-cache";

/**
 * The public route shape remains stable, but unavailable purchase estimates
 * use null for ad valorem and totals.  Zero is a valid tax amount for a
 * genuinely zero-valued calculation and therefore cannot represent provider
 * failure.
 */
export interface PurchaseTaxResult {
  adValoremTax: number | null;
  nonAdValoremTax: number;
  annualTax: number | null;
  monthlyTax: number | null;
  source: string;
  fromGeneralCache: boolean;
  parcelId?: string;
  folio?: string;
  taxDistrict?: string;
  millageRate?: number;
  nonAdValoremLines?: Array<{ authority: string; amount: number }>;
  nonAdValoremPending?: boolean;
  operationalError?: string;
}

function unavailablePurchaseResult(params: {
  county: CountySlug;
  error?: string;
  parcelId?: string;
}): PurchaseTaxResult {
  return {
    adValoremTax: null,
    nonAdValoremTax: 0,
    annualTax: null,
    monthlyTax: null,
    source: `${params.county}-county-estimator-unavailable`,
    fromGeneralCache: false,
    parcelId: params.parcelId,
    nonAdValoremLines: [],
    nonAdValoremPending: false,
    operationalError:
      params.error ??
      `Official ${params.county} purchase estimator output is unavailable.`,
  };
}

function resultFromOfficialEstimator(params: {
  county: CountySlug;
  adValoremCents: number;
  parcelId?: string;
}): PurchaseTaxResult {
  const adValoremTax = params.adValoremCents / 100;
  return {
    adValoremTax,
    nonAdValoremTax: 0,
    annualTax: adValoremTax,
    monthlyTax: Math.round((adValoremTax / 12) * 100) / 100,
    source: "county-estimator",
    fromGeneralCache: false,
    parcelId: params.parcelId,
    nonAdValoremLines: [],
    nonAdValoremPending: false,
  };
}

async function runOfficialPurchaseEstimator(params: {
  county: CountySlug;
  address: string;
  purchasePrice: number;
  isPrimaryResidence: boolean;
}): Promise<PurchaseTaxResult> {
  const result = await runCountyEstimator({
    county: params.county,
    address: params.address,
    purchasePrice: params.purchasePrice,
    homestead: params.isPrimaryResidence,
  });
  if (result.status !== "ok") {
    return unavailablePurchaseResult({
      county: params.county,
      error: result.error,
    });
  }
  return resultFromOfficialEstimator({
    county: params.county,
    adValoremCents: result.adValoremCents,
  });
}

/**
 * Retained as a pure arithmetic helper for callers that need to describe the
 * statewide low-end basis.  It is not a purchase-estimator data source and
 * is deliberately not called by any purchase route.
 */
export function deriveCountyAssessmentBasis(params: {
  county: CountySlug;
  purchasePrice: number;
  justValue?: number;
  assessedValue?: number;
  rateYear: number;
}): {
  assessmentRatio: number;
  homesteadNonSchoolExemption: number;
  valueBasis: "low-end-purchase-value";
} {
  return {
    assessmentRatio: PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
    homesteadNonSchoolExemption:
      totalNonSchoolHomesteadExemptionForYear(params.rateYear),
    valueBasis: "low-end-purchase-value",
  };
}

/**
 * Retained for backwards-compatible unit consumers.  This is not used to
 * produce a successful route response; callers needing a purchase result
 * must use an official estimator through the functions below.
 */
export function computePinellasAdValorem(params: {
  purchasePrice: number;
  justValue: number;
  isPrimaryResidence: boolean;
  billMillage: number;
  billMills: Array<{ authority: string; mills: number }> | null;
  rateYear: number;
}): number {
  const SCHOOL_MILLS = 6.293;
  const SCHOOL_EXEMPTION = 25_000;
  const NON_SCHOOL_EXEMPTION =
    totalNonSchoolHomesteadExemptionForYear(params.rateYear);
  const estimatedJustValue =
    PURCHASE_TAX_LOW_ASSESSMENT_RATIO * params.purchasePrice;
  const schoolTaxable = params.isPrimaryResidence
    ? Math.max(estimatedJustValue - SCHOOL_EXEMPTION, 0)
    : estimatedJustValue;
  const nonSchoolTaxable = params.isPrimaryResidence
    ? Math.max(estimatedJustValue - NON_SCHOOL_EXEMPTION, 0)
    : estimatedJustValue;

  if (params.billMills?.length) {
    const schoolMills = params.billMills
      .filter((line) => /SCHOOL/i.test(line.authority))
      .reduce((sum, line) => sum + line.mills, 0);
    const nonSchoolMills = params.billMills
      .filter((line) => !/SCHOOL/i.test(line.authority))
      .reduce((sum, line) => sum + line.mills, 0);
    return Math.round(
      (schoolTaxable * schoolMills + nonSchoolTaxable * nonSchoolMills) / 1000,
    );
  }

  const nonSchoolMills = Math.max(params.billMillage - SCHOOL_MILLS, 0);
  return Math.round(
    (schoolTaxable * SCHOOL_MILLS + nonSchoolTaxable * nonSchoolMills) / 1000,
  );
}

/**
 * Hillsborough's old rate API path is intentionally not used here.  A rate
 * payload plus local arithmetic is not an official estimator output.
 */
export async function getHillsboroughPurchaseTax(params: {
  address: string;
  purchasePrice: number;
  isPrimaryResidence: boolean;
  now?: Date;
}): Promise<PurchaseTaxResult> {
  return runOfficialPurchaseEstimator({
    county: "hillsborough",
    address: params.address,
    purchasePrice: params.purchasePrice,
    isPrimaryResidence: params.isPrimaryResidence,
  });
}

export async function getPinellasPurchaseTax(params: {
  address: string;
  purchasePrice: number;
  isPrimaryResidence: boolean;
  now?: Date;
}): Promise<{
  adValorem: number | null;
  nonAdValorem: number;
  nonAdValoremLines: Array<{ authority: string; amount: number }>;
  nonAdValoremPending: boolean;
  source: string;
  parcelId: string | null;
  millageRate: number | null;
  fromGeneralCache: boolean;
}> {
  const result = await runOfficialPurchaseEstimator({
    county: "pinellas",
    address: params.address,
    purchasePrice: params.purchasePrice,
    isPrimaryResidence: params.isPrimaryResidence,
  });
  return {
    adValorem: result.adValoremTax,
    nonAdValorem: result.nonAdValoremTax,
    nonAdValoremLines: result.nonAdValoremLines ?? [],
    nonAdValoremPending: result.nonAdValoremPending ?? false,
    source: result.source,
    parcelId: result.parcelId ?? null,
    millageRate: result.millageRate ?? null,
    fromGeneralCache: result.fromGeneralCache,
  };
}

/**
 * Shared route target for the other supported counties.  It never resolves a
 * parcel or scrapes a bill as a substitute for the official purchase
 * estimator.  Those integrations remain available to the separate current
 * bill/refinance path.
 */
export async function getCountyPurchaseTax(params: {
  county: CountySlug;
  address: string;
  purchasePrice: number;
  isPrimaryResidence: boolean;
  now?: Date;
}): Promise<PurchaseTaxResult> {
  return runOfficialPurchaseEstimator({
    county: params.county,
    address: params.address,
    purchasePrice: params.purchasePrice,
    isPrimaryResidence: params.isPrimaryResidence,
  });
}

export async function getManateePurchaseTax(params: {
  address: string;
  purchasePrice: number;
  isPrimaryResidence: boolean;
  now?: Date;
}): Promise<{
  adValorem: number | null;
  nonAdValorem: number;
  nonAdValoremLines: Array<{ authority: string; amount: number }>;
  source: string;
  parcelId: string | null;
  fromGeneralCache: boolean;
}> {
  const result = await runOfficialPurchaseEstimator({
    county: "manatee",
    address: params.address,
    purchasePrice: params.purchasePrice,
    isPrimaryResidence: params.isPrimaryResidence,
  });
  return {
    adValorem: result.adValoremTax,
    nonAdValorem: result.nonAdValoremTax,
    nonAdValoremLines: result.nonAdValoremLines ?? [],
    source: result.source,
    parcelId: result.parcelId ?? null,
    fromGeneralCache: result.fromGeneralCache,
  };
}
