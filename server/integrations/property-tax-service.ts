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
import {
  runCountyEstimator,
  type CountyEstimatorRequest,
  type CountyEstimatorResult,
} from "./county-estimator-runner";
import { PURCHASE_TAX_LOW_ASSESSMENT_RATIO } from "@shared/property-tax-policy";
import {
  isCountyEstimatorVerified,
} from "@shared/county-estimator-policy";
import {
  totalNonSchoolHomesteadExemptionForYear,
} from "./property-tax-cache";

// 2025 effective county tax rates as a share of purchase price. These rates
// already represent the selected low-end estimate; do not apply the shared
// 85% purchase-assessment ratio to them a second time. They are the
// pre-estimator-removal fallback contract and intentionally do not use a
// parcel's current value or a paid tax-bill lookup.
export const COUNTY_FORMULA_RATES: Record<string, { h: number; nh: number }> = {
  hillsborough: { h: 0.0141, nh: 0.0155 },
  pinellas: { h: 0.01517, nh: 0.0185 },
  pasco: { h: 0.0141, nh: 0.0172 },
  manatee: { h: 0.01197, nh: 0.0146 },
  sarasota: { h: 0.0105, nh: 0.0128 },
  hernando: { h: 0.01197, nh: 0.0146 },
  lee: { h: 0.01148, nh: 0.014 },
  // 2025 Collier parcel millage is roughly 11.05 mills. New-purchase
  // reassessment at the shared 85% model is about 0.94% before homestead.
  collier: { h: 0.00825, nh: 0.00939 },
  polk: { h: 0.01263, nh: 0.0154 },
};

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
  estimatorVerified: boolean;
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
    estimatorVerified: true,
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
    estimatorVerified: true,
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
  forceUnavailable?: boolean;
  runEstimator?: (
    request: CountyEstimatorRequest,
  ) => Promise<CountyEstimatorResult>;
}): Promise<PurchaseTaxResult> {
  const result = await (params.runEstimator ?? runCountyEstimator)({
    county: params.county,
    address: params.address,
    purchasePrice: params.purchasePrice,
    homestead: params.isPrimaryResidence,
    ...(params.forceUnavailable ? { __forceUnavailable: true } : {}),
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

function formulaPurchaseResult(params: {
  county: CountySlug;
  purchasePrice: number;
  isPrimaryResidence: boolean;
}): PurchaseTaxResult {
  const rates = COUNTY_FORMULA_RATES[params.county];
  if (!rates) {
    throw new Error(`No purchase-tax formula rate is configured for ${params.county}.`);
  }
  const adValoremTax = Math.round(
    params.purchasePrice *
      (params.isPrimaryResidence ? rates.h : rates.nh),
  );
  return {
    adValoremTax,
    nonAdValoremTax: 0,
    annualTax: adValoremTax,
    monthlyTax: Math.round((adValoremTax / 12) * 100) / 100,
    source: `${params.county}-formula-fallback`,
    fromGeneralCache: false,
    estimatorVerified: false,
    nonAdValoremLines: [],
    nonAdValoremPending: false,
  };
}

interface PurchaseTaxRequest {
  county: CountySlug;
  address: string;
  purchasePrice: number;
  isPrimaryResidence: boolean;
}

interface PurchaseTaxExecutionOptions {
  /**
   * Only the focused test helper sets this override. Production requests
   * always consult the shared verified-county registry.
   */
  estimatorVerifiedOverride?: boolean;
  forceEstimatorUnavailable?: boolean;
  runEstimator?: (
    request: CountyEstimatorRequest,
  ) => Promise<CountyEstimatorResult>;
}

async function getPurchaseTax(
  params: PurchaseTaxRequest,
  options: PurchaseTaxExecutionOptions = {},
): Promise<PurchaseTaxResult> {
  const estimatorVerified =
    options.estimatorVerifiedOverride ??
    isCountyEstimatorVerified(params.county);

  if (!estimatorVerified) {
    return formulaPurchaseResult(params);
  }

  return runOfficialPurchaseEstimator({
    ...params,
    forceUnavailable: options.forceEstimatorUnavailable,
    runEstimator: options.runEstimator,
  });
}

/**
 * Test-only gate injection. It marks one request as verified without mutating
 * ESTIMATOR_VERIFIED_COUNTIES, allowing failure behavior to be tested while
 * the production registry remains empty.
 */
export async function getCountyPurchaseTaxForTest(
  params: PurchaseTaxRequest,
  options: {
    forceEstimatorUnavailable?: boolean;
    runEstimator?: (
      request: CountyEstimatorRequest,
    ) => Promise<CountyEstimatorResult>;
  } = {},
): Promise<PurchaseTaxResult> {
  return getPurchaseTax(params, {
    estimatorVerifiedOverride: true,
    forceEstimatorUnavailable: options.forceEstimatorUnavailable,
    runEstimator: options.runEstimator,
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
  return getPurchaseTax({
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
  estimatorVerified: boolean;
}> {
  const result = await getPurchaseTax({
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
    estimatorVerified: result.estimatorVerified,
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
  return getPurchaseTax(params);
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
  estimatorVerified: boolean;
}> {
  const result = await getPurchaseTax({
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
    estimatorVerified: result.estimatorVerified,
  };
}
