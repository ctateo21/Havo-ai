/**
 * General multi-county property-tax purchase-estimate cache.
 *
 * Stored in Supabase (public.property_tax_cache) via supabaseAdmin REST.
 * non_ad_valorem_cache stays in Neon/Drizzle.
 *
 * Cache validity rules (tested in property-tax-cache.test.ts):
 *   • Millage rows retain the rate components needed to model a new assessed
 *     value at any positive purchase price and must use the shared low-end
 *     purchase-assessment ratio. Legacy percentage rows retain their
 *     sample-price guard.
 *   • Row must not be expired (expires_at > now).
 *   • Caller's purchase price must be within ±20% of sample_price.
 *   • Any rule failure → cache miss → refresh from live API.
 *
 * Cache recomputation (when valid hit):
 *   complete millage rows: school/non-school taxable assessed value × millage
 *     at the shared low-end basis (with distinct Florida exemptions)
 *   legacy rows: round(selectedPct × currentPrice)
 *   annualTotal     = annualAdValorem + nonAdValoremAmtCents/100
 *   (Fixed NAV does NOT scale with price.)
 *
 * Expiry boundary: rolls to the next Nov 1 (annual FL tax/millage
 * refresh boundary) rather than a blind 365-day TTL.
 */

import { supabaseAdmin } from "../supabase";
import { PURCHASE_TAX_LOW_ASSESSMENT_RATIO } from "@shared/property-tax-policy";

// ── Expiry helpers ────────────────────────────────────────────────

/**
 * Returns the next Nov 1 00:00 UTC after `now`.
 * If now is exactly Nov 1 00:00 UTC or later, rolls to the following year.
 *
 * Exported for unit testing.
 */
export function nextTaxRefreshBoundary(now: Date = new Date()): Date {
  const year = now.getUTCFullYear();
  const nov1ThisYear = new Date(Date.UTC(year, 10, 1)); // month 10 = November
  if (now < nov1ThisYear) return nov1ThisYear;
  return new Date(Date.UTC(year + 1, 10, 1));
}

// ── Types ─────────────────────────────────────────────────────────

/** Shape of a property_tax_cache row (Supabase). */
export interface PropertyTaxCacheRow {
  county: string;
  addressNormalized: string;
  addressDisplay: string;
  parcelId: string | null;
  folio: string | null;
  taxDistrict: string | null;
  homesteadAdValoremPct: number;
  nonHomesteadAdValoremPct: number;
  samplePrice: number;
  totalMillage: number | null;
  schoolMillage: number | null;
  nonSchoolMillage: number | null;
  assessmentRatio: number | null;
  homesteadSchoolExemption: number | null;
  homesteadNonSchoolExemption: number | null;
  parcelSource: string | null;
  rateYear: number | null;
  nonAdValoremAmtCents: number;
  nonAdValoremLines: Array<{ authority: string; amount: number }>;
  source: string;
  expiresAt: Date;
  queriedAt?: string;
}

/**
 * A cache row is eligible for purchase-tax reuse only when it was seeded by
 * the official county purchase estimator.  Parcel millage arithmetic,
 * tax-bill-derived rates, and historical formula labels are not estimator
 * output and must not become a successful purchase estimate on a later hit.
 */
export function isOfficialEstimatorCacheSource(source: unknown): boolean {
  if (typeof source !== "string") return false;
  const normalized = source.trim().toLowerCase();
  return (
    normalized === "county-estimator" ||
    normalized.endsWith("-county-estimator")
  );
}

/**
 * Determines whether a cached row is valid for the given purchase price.
 * Returns true only when ALL of:
 *   1. parcelId or folio is non-empty (verified parcel identity)
 *   2. complete millage inputs OR both legacy percentages are > 0
 *   3. source is non-empty
 *   4. row is not expired (expiresAt > now)
 *   5. for legacy percentage rows, samplePrice > 0 and purchasePrice is
 *      within ±20% of samplePrice. Complete millage rows are price-independent.
 *
 * Exported for unit testing.
 */
export function isCacheRowValid(
  row: Pick<
    PropertyTaxCacheRow,
    | "parcelId"
    | "folio"
    | "homesteadAdValoremPct"
    | "nonHomesteadAdValoremPct"
    | "samplePrice"
    | "schoolMillage"
    | "nonSchoolMillage"
    | "assessmentRatio"
    | "homesteadSchoolExemption"
    | "homesteadNonSchoolExemption"
    | "rateYear"
    | "nonAdValoremAmtCents"
    | "source"
    | "expiresAt"
  >,
  purchasePrice: number,
  now: Date = new Date(),
): boolean {
  if (!isOfficialEstimatorCacheSource(row.source)) return false;
  // Must have verified parcel identity
  const hasParcel = (row.parcelId && row.parcelId.trim()) ||
                    (row.folio && row.folio.trim());
  if (!hasParcel) return false;
  const hasExactMillage = hasCompleteMillageInputs(row);
  if (
    hasExactMillage &&
    Math.abs(
      row.assessmentRatio! - PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
    ) > Number.EPSILON
  ) {
    // A complete parcel-millage row still describes a local calculation, not
    // an official estimator output.  It cannot bypass the shared basis guard.
    return false;
  }
  if (!hasExactMillage && (
    !Number.isFinite(row.homesteadAdValoremPct) ||
    row.homesteadAdValoremPct <= 0 ||
    !Number.isFinite(row.nonHomesteadAdValoremPct) ||
    row.nonHomesteadAdValoremPct <= 0
  )) return false;
  if (
    !Number.isInteger(row.nonAdValoremAmtCents) ||
    row.nonAdValoremAmtCents < 0
  ) return false;
  if (!row.source || !row.source.trim()) return false;
  if (!Number.isFinite(row.expiresAt.getTime()) || row.expiresAt <= now) {
    return false;
  }
  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) return false;
  // Complete rate components describe the tax formula, not an observation at
  // sample_price, so they remain valid for every positive purchase price.
  if (hasExactMillage) return true;
  if (!Number.isFinite(row.samplePrice) || row.samplePrice <= 0) return false;

  const ratio = purchasePrice / row.samplePrice;
  if (ratio < 0.8 || ratio > 1.2) return false;
  return true;
}

type MillageInputs = Pick<
  PropertyTaxCacheRow,
  | "schoolMillage"
  | "nonSchoolMillage"
  | "assessmentRatio"
  | "homesteadSchoolExemption"
  | "homesteadNonSchoolExemption"
  | "rateYear"
>;

// Amendment 5 (2024) indexes the SECOND homestead exemption to CPI from
// the 2025 tax year. The first $25,000 (all levies, incl. school) is fixed.
// FL DOR published: 2025 = $25,722, 2026 = $26,411.
// Review each January when DOR publishes the new figure.
export const ADDITIONAL_HOMESTEAD_EXEMPTION_BY_YEAR: Record<number, number> = {
  2025: 25_722,
  2026: 26_411,
};

const loggedUnknownExemptionYears = new Set<number>();

export function additionalHomesteadExemptionForYear(rateYear: number): number {
  const exact = ADDITIONAL_HOMESTEAD_EXEMPTION_BY_YEAR[rateYear];
  if (exact != null) return exact;

  const mostRecentYear = Math.max(
    ...Object.keys(ADDITIONAL_HOMESTEAD_EXEMPTION_BY_YEAR).map(Number),
  );
  if (!loggedUnknownExemptionYears.has(rateYear)) {
    loggedUnknownExemptionYears.add(rateYear);
    console.warn(
      `[property-tax] no indexed homestead exemption for ${rateYear}; ` +
      `using ${mostRecentYear}. Review the FL DOR annual amount.`,
    );
  }
  return ADDITIONAL_HOMESTEAD_EXEMPTION_BY_YEAR[mostRecentYear];
}

export function totalNonSchoolHomesteadExemptionForYear(
  rateYear: number,
): number {
  return 25_000 + additionalHomesteadExemptionForYear(rateYear);
}

/** True only when a row has every component of the Florida rate formula. */
function hasCompleteMillageInputs(row: Partial<MillageInputs>): boolean {
  return (
    Number.isFinite(row.schoolMillage) &&
    (row.schoolMillage as number) >= 0 &&
    Number.isFinite(row.nonSchoolMillage) &&
    (row.nonSchoolMillage as number) >= 0 &&
    (row.schoolMillage as number) + (row.nonSchoolMillage as number) > 0 &&
    Number.isFinite(row.assessmentRatio) &&
    (row.assessmentRatio as number) > 0 &&
    Number.isFinite(row.homesteadSchoolExemption) &&
    (row.homesteadSchoolExemption as number) >= 0 &&
    Number.isFinite(row.homesteadNonSchoolExemption) &&
    (row.homesteadNonSchoolExemption as number) >= 0 &&
    Number.isInteger(row.rateYear) &&
    (row.rateYear as number) >= 2000
  );
}

/**
 * Compute the purchase ad-valorem estimate from cached rates. Complete
 * millage rows use Florida's separate school/non-school homestead exemptions:
 * school taxable value = assessed value − school exemption; non-school taxable
 * value = assessed value − non-school exemption. Non-homestead has no
 * exemption. Legacy percentage rows preserve their original calculation.
 * Fixed NAV does NOT scale with price.
 *
 * Exported for unit testing.
 */
export function computeFromCache(
  row: Pick<
    PropertyTaxCacheRow,
    | "homesteadAdValoremPct"
    | "nonHomesteadAdValoremPct"
    | "nonAdValoremAmtCents"
   > &
   Partial<MillageInputs> &
   Partial<Pick<PropertyTaxCacheRow, "source">>,
  purchasePrice: number,
  homestead: boolean
): { adValoremTax: number; nonAdValoremTax: number; annualTax: number } {
  let adValoremTax: number;
  if (hasCompleteMillageInputs(row)) {
    // Millage arithmetic is retained only as an isolated legacy helper.  It
    // is never accepted as an official estimator cache row (see
    // isCacheRowValid above), and always uses the shared low-end basis.
    const assessedValue = purchasePrice * PURCHASE_TAX_LOW_ASSESSMENT_RATIO;
    const schoolTaxableValue = homestead
      ? Math.max(0, assessedValue - row.homesteadSchoolExemption!)
      : assessedValue;
    const additionalExemption = Math.max(
      0,
      Math.min(
        assessedValue - 50_000,
        additionalHomesteadExemptionForYear(row.rateYear!),
      ),
    );
    const nonSchoolTaxableValue = homestead
      ? Math.max(0, assessedValue - 25_000 - additionalExemption)
      : assessedValue;
    const calculatedTax =
      (schoolTaxableValue * row.schoolMillage! +
        nonSchoolTaxableValue * row.nonSchoolMillage!) / 1000;
    adValoremTax = Math.round(calculatedTax);
  } else {
    const pct = homestead
      ? row.homesteadAdValoremPct
      : row.nonHomesteadAdValoremPct;
    adValoremTax = Math.round(purchasePrice * pct);
  }
  const nonAdValoremTax = Math.round(row.nonAdValoremAmtCents) / 100;
  return { adValoremTax, nonAdValoremTax, annualTax: adValoremTax + nonAdValoremTax };
}

// ── Supabase REST helpers ─────────────────────────────────────────

function rowFromSupabase(r: Record<string, unknown>): PropertyTaxCacheRow {
  return {
    county: String(r.county ?? ""),
    addressNormalized: String(r.address_normalized ?? ""),
    addressDisplay: String(r.address_display ?? ""),
    parcelId: r.parcel_id ? String(r.parcel_id) : null,
    folio: r.folio ? String(r.folio) : null,
    taxDistrict: r.tax_district ? String(r.tax_district) : null,
    homesteadAdValoremPct: parseFloat(String(r.homestead_ad_valorem_pct ?? "0")),
    nonHomesteadAdValoremPct: parseFloat(String(r.non_homestead_ad_valorem_pct ?? "0")),
    samplePrice: r.sample_price != null ? Number(r.sample_price) : 0,
    totalMillage: r.total_millage != null ? parseFloat(String(r.total_millage)) : null,
    schoolMillage: r.school_millage != null ? parseFloat(String(r.school_millage)) : null,
    nonSchoolMillage: r.non_school_millage != null ? parseFloat(String(r.non_school_millage)) : null,
    assessmentRatio: r.assessment_ratio != null ? parseFloat(String(r.assessment_ratio)) : null,
    homesteadSchoolExemption: r.homestead_school_exemption != null
      ? parseFloat(String(r.homestead_school_exemption)) : null,
    homesteadNonSchoolExemption: r.homestead_non_school_exemption != null
      ? parseFloat(String(r.homestead_non_school_exemption)) : null,
    parcelSource: r.parcel_source != null ? String(r.parcel_source) : null,
    rateYear: r.rate_year != null ? Number(r.rate_year) : null,
    nonAdValoremAmtCents: typeof r.non_ad_valorem_amt_cents === "number"
      ? r.non_ad_valorem_amt_cents
      : 0,
    nonAdValoremLines: Array.isArray(r.non_ad_valorem_lines)
      ? (r.non_ad_valorem_lines as Array<{ authority: string; amount: number }>)
      : [],
    source: String(r.source ?? ""),
    expiresAt: new Date(String(r.expires_at ?? "")),
    queriedAt: r.queried_at ? String(r.queried_at) : undefined,
  };
}

/** Read a cache row by county + normalized address. Returns null on miss or error. */
export async function getPropertyTaxCacheRow(
  county: string,
  addressNormalized: string
): Promise<PropertyTaxCacheRow | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("property_tax_cache")
      .select("*")
      .eq("county", county)
      .eq("address_normalized", addressNormalized)
      .maybeSingle();
    if (error) {
      console.error("[ptc] cache read failed:", error.message);
      return null;
    }
    if (!data) return null;
    return rowFromSupabase(data as Record<string, unknown>);
  } catch (e: any) {
    console.error("[ptc] cache read failed:", e?.message);
    return null;
  }
}

export interface WritePropertyTaxCacheParams {
  county: string;
  addressNormalized: string;
  addressDisplay: string;
  parcelId: string | null;
  folio: string | null;
  taxDistrict: string | null;
  homesteadAdValoremPct: number;
  nonHomesteadAdValoremPct: number;
  samplePrice: number;
  totalMillage?: number | null;
  schoolMillage?: number | null;
  nonSchoolMillage?: number | null;
  assessmentRatio?: number | null;
  homesteadSchoolExemption?: number | null;
  homesteadNonSchoolExemption?: number | null;
  parcelSource?: string | null;
  rateYear?: number | null;
  nonAdValoremAmtCents: number;
  nonAdValoremLines: Array<{ authority: string; amount: number }>;
  source: string;
  now?: Date;
}

/** Upsert a cache row (conflict on county + address_normalized). */
export async function writePropertyTaxCache(
  params: WritePropertyTaxCacheParams
): Promise<void> {
  if (!supabaseAdmin) return;
  if (!isOfficialEstimatorCacheSource(params.source)) {
    console.warn(
      `[ptc] refusing non-estimator purchase cache row: ${params.source}`,
    );
    return;
  }
  const now = params.now ?? new Date();
  const expiresAt = nextTaxRefreshBoundary(now);
  try {
    const row = {
      county: params.county,
      address_normalized: params.addressNormalized,
      address_display: params.addressDisplay,
      parcel_id: params.parcelId,
      folio: params.folio,
      tax_district: params.taxDistrict,
      homestead_ad_valorem_pct: String(params.homesteadAdValoremPct),
      non_homestead_ad_valorem_pct: String(params.nonHomesteadAdValoremPct),
      sample_price: params.samplePrice,
      total_millage: params.totalMillage != null ? String(params.totalMillage) : null,
      school_millage: params.schoolMillage != null ? String(params.schoolMillage) : null,
      non_school_millage: params.nonSchoolMillage != null ? String(params.nonSchoolMillage) : null,
      assessment_ratio: params.assessmentRatio != null ? String(params.assessmentRatio) : null,
      homestead_school_exemption: params.homesteadSchoolExemption != null
        ? String(params.homesteadSchoolExemption) : null,
      homestead_non_school_exemption: params.homesteadNonSchoolExemption != null
        ? String(params.homesteadNonSchoolExemption) : null,
      parcel_source: params.parcelSource ?? null,
      rate_year: params.rateYear ?? null,
      non_ad_valorem_amt_cents: params.nonAdValoremAmtCents,
      non_ad_valorem_lines: params.nonAdValoremLines,
      source: params.source,
      queried_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    const { error } = await supabaseAdmin
      .from("property_tax_cache")
      .upsert(row, { onConflict: "county,address_normalized" });
    if (error) {
      console.error("[ptc] cache write failed:", error.message);
    }
  } catch (e: any) {
    console.error("[ptc] cache write failed:", e?.message);
  }
}
