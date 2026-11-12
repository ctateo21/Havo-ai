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
  getPropertyTaxCacheRow,
  isCacheRowValid,
  totalNonSchoolHomesteadExemptionForYear,
  writePropertyTaxCache,
  type PropertyTaxCacheRow,
} from "./property-tax-cache";
import {
  HCPA_ESTIMATOR_PAGE,
  HCPA_LOW_ASSESSMENT_RATIO,
  hcpaOfficialLowEndAdValorem,
} from "./hillsborough-estimator";
import {
  fetchHcpaRatesForPin,
  lookupPIN,
} from "./hillsborough-tax";
import type { CurrentTaxBillResponse } from "./current-tax-bill";

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
  sourceLabel?: string;
  taxYear?: number | null;
  capturedAt?: string;
  homestead?: boolean;
  audit?: PurchaseTaxAudit;
}

export interface PurchaseTaxAudit {
  county: string;
  address: string;
  purchasePrice: number;
  homestead: boolean;
  capturedAt: string;
  fromCache: boolean;
  cacheCapturedAt?: string;
  estimatorUrl?: string;
  parcelId?: string | null;
  folio?: string | null;
  taxDistrict?: string | null;
  schoolMills?: number | null;
  nonSchoolMills?: number | null;
  assessmentRatio?: number | null;
  adValoremTax: number | null;
  nonAdValoremTax: number | null;
  nonAdValoremPending: boolean;
  nonAdValoremLines: Array<{ authority: string; amount: number }>;
  billYear?: number | null;
  billState?: string;
  exemptionNote: string;
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

const HCPA_EXEMPTION_NOTE =
  "Matches the Hillsborough Tax Estimator page (taxEstimatorVM.js v20260605A): " +
  "low end is 85% of purchase price, $25,000 school exemption, and a flat " +
  "$25,000 additional non-school exemption. Save Our Homes is not applied. " +
  "FL DOR's indexed second exemption for 2026 is $26,411; the county page " +
  "still uses $25,000, and Havo follows the page.";

export interface HillsboroughPurchaseDeps {
  lookupPin?: typeof lookupPIN;
  fetchRates?: typeof fetchHcpaRatesForPin;
  resolveBill?: (
    address: string,
    now?: Date,
  ) => Promise<CurrentTaxBillResponse>;
  readCache?: typeof getPropertyTaxCacheRow;
  writeCache?: typeof writePropertyTaxCache;
  now?: Date;
}

function hillsboroughAddressKey(address: string): string {
  return address.trim().toUpperCase().replace(/\s+/g, " ");
}

function millsFromCache(row: PropertyTaxCacheRow): {
  school: number;
  nonSchool: number;
} | null {
  if (
    row.schoolMillage == null ||
    row.nonSchoolMillage == null ||
    !(row.schoolMillage + row.nonSchoolMillage > 0)
  ) {
    return null;
  }
  return { school: row.schoolMillage, nonSchool: row.nonSchoolMillage };
}

/**
 * Official Hillsborough purchase estimate.
 *
 * Ad valorem is the low end of the Property Appraiser Tax Estimator.
 * Non-ad valorem comes only from the tax collector bill. The estimator
 * API's own nonAdValoremTaxes field is ignored: the public page says the
 * estimator does not include those charges.
 *
 * A complete yearly total is returned only when the bill was parsed.
 * If the bill cannot be retrieved, ad valorem is still reported and the
 * yearly total stays null so a missing CDD is not shown as $0.
 */
export async function getHillsboroughPurchaseTax(
  params: {
    address: string;
    purchasePrice: number;
    isPrimaryResidence: boolean;
    now?: Date;
  },
  deps: HillsboroughPurchaseDeps = {},
): Promise<PurchaseTaxResult> {
  const now = deps.now ?? params.now ?? new Date();
  const lookup = deps.lookupPin ?? lookupPIN;
  const fetchRates = deps.fetchRates ?? fetchHcpaRatesForPin;
  const resolveBill = deps.resolveBill ?? (await import("./current-tax-bill")).resolveCurrentTaxBill;
  const readCache = deps.readCache ?? getPropertyTaxCacheRow;
  const writeCache = deps.writeCache ?? writePropertyTaxCache;
  const addressKey = hillsboroughAddressKey(params.address);

  const unavailable = (error: string, partial?: {
    adValoremTax?: number | null;
    parcelId?: string;
    folio?: string | null;
    taxDistrict?: string;
    schoolMills?: number;
    nonSchoolMills?: number;
  }): PurchaseTaxResult => ({
    adValoremTax: partial?.adValoremTax ?? null,
    nonAdValoremTax: 0,
    annualTax: null,
    monthlyTax: null,
    source: "hillsborough-county-estimator-unavailable",
    fromGeneralCache: false,
    parcelId: partial?.parcelId,
    folio: partial?.folio ?? undefined,
    taxDistrict: partial?.taxDistrict,
    millageRate: partial?.schoolMills != null && partial.nonSchoolMills != null
      ? partial.schoolMills + partial.nonSchoolMills
      : undefined,
    nonAdValoremLines: [],
    nonAdValoremPending: partial?.adValoremTax != null,
    operationalError: error,
    homestead: params.isPrimaryResidence,
    capturedAt: now.toISOString(),
    audit: {
      county: "hillsborough",
      address: params.address,
      purchasePrice: params.purchasePrice,
      homestead: params.isPrimaryResidence,
      capturedAt: now.toISOString(),
      fromCache: false,
      estimatorUrl: HCPA_ESTIMATOR_PAGE,
      parcelId: partial?.parcelId ?? null,
      folio: partial?.folio ?? null,
      taxDistrict: partial?.taxDistrict ?? null,
      schoolMills: partial?.schoolMills ?? null,
      nonSchoolMills: partial?.nonSchoolMills ?? null,
      assessmentRatio: HCPA_LOW_ASSESSMENT_RATIO,
      adValoremTax: partial?.adValoremTax ?? null,
      nonAdValoremTax: null,
      nonAdValoremPending: partial?.adValoremTax != null,
      nonAdValoremLines: [],
      exemptionNote: HCPA_EXEMPTION_NOTE,
    },
  });

  let cached: PropertyTaxCacheRow | null = null;
  try {
    cached = await readCache("hillsborough", addressKey);
  } catch {
    cached = null;
  }
  const cachedMills = cached &&
    isCacheRowValid(cached, params.purchasePrice, now) &&
    cached.source === "hillsborough-county-estimator"
    ? millsFromCache(cached)
    : null;

  let schoolMills: number;
  let nonSchoolMills: number;
  let taxDistrict: string | null = null;
  let parcelId: string | undefined;
  let folio: string | null = null;
  let fromCache = false;
  let cacheCapturedAt: string | undefined;

  if (cachedMills && cached) {
    schoolMills = cachedMills.school;
    nonSchoolMills = cachedMills.nonSchool;
    taxDistrict = cached.taxDistrict;
    parcelId = cached.parcelId ?? undefined;
    folio = cached.folio;
    fromCache = true;
    cacheCapturedAt = cached.queriedAt;
  } else {
    let found: { pin: string; folio: string | null } | null;
    try {
      found = await lookup(params.address);
    } catch (error: any) {
      return unavailable(
        `Hillsborough Property Appraiser search failed: ${error?.message ?? "unknown error"}. Enter the yearly tax manually.`,
      );
    }
    if (!found) {
      return unavailable(
        "Hillsborough Property Appraiser did not return this address. Enter the yearly tax manually.",
      );
    }
    let rates;
    try {
      rates = await fetchRates(found.pin);
    } catch (error: any) {
      return unavailable(
        `Hillsborough Tax Estimator request failed: ${error?.message ?? "unknown error"}. Enter the yearly tax manually.`,
        { parcelId: found.pin, folio: found.folio },
      );
    }
    if (!rates) {
      return unavailable(
        "Hillsborough Tax Estimator did not return millage for this parcel. Enter the yearly tax manually.",
        { parcelId: found.pin, folio: found.folio },
      );
    }
    schoolMills = rates.schoolTaxRate;
    nonSchoolMills = rates.nonschoolTaxRate;
    taxDistrict = rates.taxDistrict || null;
    parcelId = found.pin;
    folio = found.folio;
  }

  const adValorem = hcpaOfficialLowEndAdValorem({
    purchasePrice: params.purchasePrice,
    homestead: params.isPrimaryResidence,
    schoolMills,
    nonSchoolMills,
  });
  if (adValorem == null) {
    return unavailable(
      "Hillsborough Tax Estimator millage could not be applied to this price. Enter the yearly tax manually.",
      { parcelId, folio, taxDistrict: taxDistrict ?? undefined, schoolMills, nonSchoolMills },
    );
  }

  let bill: CurrentTaxBillResponse;
  let nav: number | null;
  let navPending: boolean;
  if (fromCache && cached) {
    nav = Math.round(cached.nonAdValoremAmtCents) / 100;
    navPending = false;
    bill = {
      state: "ready",
      annualTax: 0,
      monthlyTax: 0,
      taxYear: cached.rateYear ?? now.getUTCFullYear(),
      nonAdValoremTax: nav,
      source: "tax-collector-bill-scrape",
      county: "hillsborough",
      parcelId: parcelId ?? "",
    };
  } else {
    try {
      bill = await resolveBill(params.address, now);
    } catch (error: any) {
      bill = {
        state: "unavailable",
        manualEntryRequired: true,
        county: "hillsborough",
        reason: "bill-scrape-unavailable",
        operationalError: error?.message,
      };
    }
    nav = null;
    navPending = true;
    if (bill.state === "ready") {
      const amount = bill.nonAdValoremTax;
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
        nav = amount;
        navPending = false;
      }
    }
  }
  const billReason = bill.state === "unavailable"
    ? bill.operationalError ?? bill.reason
    : bill.state === "pending"
      ? "tax collector bill is still loading"
      : null;

  const capturedAt = fromCache && cacheCapturedAt ? cacheCapturedAt : now.toISOString();
  const sourceLabel = navPending
    ? `Hillsborough County Property Appraiser estimator (low end)${fromCache ? `, rates captured ${capturedAt.slice(0, 10)}` : ""}. Non-ad valorem is pending: ${billReason}. Yearly total is not shown.`
    : `Hillsborough County Property Appraiser estimator (low end)${fromCache ? `, rates captured ${capturedAt.slice(0, 10)}` : ""} + Hillsborough Tax Collector non-ad valorem${bill.state === "ready" && bill.taxYear ? `, ${bill.taxYear} bill` : ""}.`;

  if (!fromCache && nav != null && parcelId) {
    const otherHomestead = hcpaOfficialLowEndAdValorem({
      purchasePrice: params.purchasePrice,
      homestead: !params.isPrimaryResidence,
      schoolMills,
      nonSchoolMills,
    });
    const homesteadDollars = params.isPrimaryResidence ? adValorem : otherHomestead;
    const nonHomesteadDollars = params.isPrimaryResidence ? otherHomestead : adValorem;
    if (homesteadDollars != null && nonHomesteadDollars != null) {
      await writeCache({
        county: "hillsborough",
        addressNormalized: addressKey,
        addressDisplay: params.address.trim(),
        parcelId,
        folio,
        taxDistrict,
        homesteadAdValoremPct: homesteadDollars / params.purchasePrice,
        nonHomesteadAdValoremPct: nonHomesteadDollars / params.purchasePrice,
        samplePrice: Math.round(params.purchasePrice),
        totalMillage: schoolMills + nonSchoolMills,
        schoolMillage: schoolMills,
        nonSchoolMillage: nonSchoolMills,
        assessmentRatio: HCPA_LOW_ASSESSMENT_RATIO,
        homesteadSchoolExemption: 25_000,
        homesteadNonSchoolExemption: 50_000,
        parcelSource: "hcpa-tax-estimator",
        rateYear: now.getUTCFullYear(),
        nonAdValoremAmtCents: Math.round(nav * 100),
        nonAdValoremLines: [],
        source: "hillsborough-county-estimator",
        now,
      });
    }
  }

  const yearly = navPending || nav == null ? null : hcpaRoundSum(adValorem, nav);

  return {
    adValoremTax: adValorem,
    nonAdValoremTax: navPending ? 0 : (nav ?? 0),
    annualTax: yearly,
    monthlyTax: yearly == null ? null : Math.round((yearly / 12) * 100) / 100,
    source: navPending
      ? "hillsborough-county-estimator-unavailable"
      : "hillsborough-county-estimator",
    fromGeneralCache: fromCache,
    parcelId,
    folio: folio ?? undefined,
    taxDistrict: taxDistrict ?? undefined,
    millageRate: schoolMills + nonSchoolMills,
    nonAdValoremLines: [],
    nonAdValoremPending: navPending,
    operationalError: navPending
      ? `Ad valorem low-end estimate is $${adValorem.toFixed(2)}. The tax collector non-ad valorem bill was not retrieved (${billReason}). The yearly total is unavailable until that bill is attached. Nothing was substituted. Tyler bill lookups require APIFY_TOKEN in production.`
      : undefined,
    sourceLabel,
    taxYear: bill.state === "ready" ? bill.taxYear : null,
    capturedAt,
    homestead: params.isPrimaryResidence,
    audit: {
      county: "hillsborough",
      address: params.address,
      purchasePrice: params.purchasePrice,
      homestead: params.isPrimaryResidence,
      capturedAt: now.toISOString(),
      fromCache,
      cacheCapturedAt,
      estimatorUrl: HCPA_ESTIMATOR_PAGE,
      parcelId: parcelId ?? null,
      folio,
      taxDistrict,
      schoolMills,
      nonSchoolMills,
      assessmentRatio: HCPA_LOW_ASSESSMENT_RATIO,
      adValoremTax: adValorem,
      nonAdValoremTax: navPending ? null : nav,
      nonAdValoremPending: navPending,
      nonAdValoremLines: [],
      billYear: bill.state === "ready" ? bill.taxYear : null,
      billState: bill.state,
      exemptionNote: HCPA_EXEMPTION_NOTE,
    },
  };
}

function hcpaRoundSum(adValorem: number, nav: number): number {
  return Number((adValorem + nav).toFixed(2));
}

/**
 * Why a county's official purchase estimator is not wired.
 * These are shown to the user. They are not tax amounts.
 */
export const COUNTY_ESTIMATOR_BLOCKERS: Record<Exclude<CountySlug, "hillsborough">, string> = {
  pinellas:
    "Pinellas publishes a purchase estimator at pcpao.gov, but it is a multi-step Drupal form and its result already includes the parcel's latest non-ad valorem. It stays on manual entry until a known-answer run matches that page without double-counting CDD.",
  manatee:
    "Manatee does not publish a standalone purchase-price estimator. The parcel page has an estimate widget that was not verified against a known answer. Manual entry is required.",
  pasco:
    "Pasco's estimate is a link inside a property record, not a verified purchase-price calculator. Manual entry is required.",
  hernando:
    "Hernando's estimator is a Blazor app that takes a tax district and a market value, not an address, and it excludes special assessments. It was not driven reliably. Manual entry is required.",
  sarasota:
    "Sarasota's tax estimator page is behind reCAPTCHA, so an official figure could not be captured. Manual entry is required.",
  lee:
    "Lee County's old estimator URL is gone. The property-search site has a tutorial video and no verified calculate endpoint. Manual entry is required.",
  collier:
    "Collier publishes parcel search, not a purchase-price tax estimator. A millage file would be a formula, so it is not used. Manual entry is required.",
  polk:
    "Polk's tax estimator requires JavaScript on polkflpa.gov and was not verified against a known answer. The tax collector bill can still be used for a refinance. Manual entry is required for a purchase.",
};

export async function getCountyPurchaseTax(params: {
  county: CountySlug;
  address: string;
  purchasePrice: number;
  isPrimaryResidence: boolean;
  now?: Date;
}): Promise<PurchaseTaxResult> {
  if (params.county === "hillsborough") {
    return getHillsboroughPurchaseTax(params);
  }
  const reason = COUNTY_ESTIMATOR_BLOCKERS[params.county];
  return {
    adValoremTax: null,
    nonAdValoremTax: 0,
    annualTax: null,
    monthlyTax: null,
    source: `${params.county}-county-estimator-unavailable`,
    fromGeneralCache: false,
    nonAdValoremLines: [],
    nonAdValoremPending: false,
    operationalError: reason,
    homestead: params.isPrimaryResidence,
    sourceLabel: reason,
    audit: {
      county: params.county,
      address: params.address,
      purchasePrice: params.purchasePrice,
      homestead: params.isPrimaryResidence,
      capturedAt: (params.now ?? new Date()).toISOString(),
      fromCache: false,
      adValoremTax: null,
      nonAdValoremTax: null,
      nonAdValoremPending: false,
      nonAdValoremLines: [],
      exemptionNote: "No official estimator result. No formula was substituted.",
    },
  };
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
