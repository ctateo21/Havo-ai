/**
 * Collier County's purchase estimator inputs.
 *
 * Recomputes the verified 2026 browser estimator using that parcel's captured
 * hidden school/non-school ratios. There is no county-wide fallback.
 *
 * The county estimator uses the purchase price as the assessed-value basis
 * (not Havo's statewide 85% fallback basis), then applies the Florida
 * homestead exemptions to the school and non-school levies separately.
 *
 * Source: Collier's public Tax Estimator page, reached through its agreement
 * and search pages. Do not call the site's data endpoints directly.
 */
export const COLLIER_OFFICIAL_RATE_YEAR = 2026;
export const COLLIER_OFFICIAL_NON_SCHOOL_EXEMPTION = 50_000;

export interface CollierMillageRates {
  county: number;
  school: number;
  municipal: number;
  other: number;
  taxYear?: number;
}

/**
 * Four live price/homestead cases verified the flat exemptions and truncation.
 */
export function calculateCollierPurchaseAdValorem(
  purchasePrice: number,
  homestead: boolean,
  rates: CollierMillageRates,
): number {
  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) throw new Error("Collier purchase price is missing or invalid");

  const schoolTaxable = homestead
    ? Math.max(purchasePrice - 25_000, 0)
    : purchasePrice;
  const nonSchoolTaxable = homestead
    ? Math.max(purchasePrice - COLLIER_OFFICIAL_NON_SCHOOL_EXEMPTION, 0)
    : purchasePrice;
  // The first $25,000 school exemption applies only to the school levy;
  // municipal levies are part of the non-school taxable-value calculation.
  const schoolMillage = rates.school;
  const nonSchoolMillage =
    rates.county + rates.municipal + rates.other;
  const tax =
    (schoolTaxable * schoolMillage +
      nonSchoolTaxable * nonSchoolMillage) /
    1000;
  return Math.floor(tax);
}