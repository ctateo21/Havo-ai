/**
 * Collier County's purchase estimator inputs.
 *
 * These are current (2026 preliminary roll) rates published by the Collier
 * County Property Appraiser's downloadable millage-rate/parcel data. A live
 * parcel lookup supplies the applicable millage area. There is deliberately
 * no county-wide fallback in this module.
 *
 * The county estimator uses the purchase price as the assessed-value basis
 * (not Havo's statewide 85% fallback basis), then applies the Florida
 * homestead exemptions to the school and non-school levies separately.
 *
 * Source:
 * https://www.collierappraiser.com/Main_Data/DataDownloads.html
 * (int_millage_rates.csv, 2026 millage area 32)
 */
export const COLLIER_OFFICIAL_RATE_YEAR = 2026;
export const COLLIER_OFFICIAL_NON_SCHOOL_EXEMPTION = 51_411;

export interface CollierMillageRates {
  county: number;
  school: number;
  municipal: number;
  other: number;
  taxYear?: number;
}

/**
 * Calculate the documented Collier purchase-estimator result. The estimator
 * page was unavailable for direct script inspection; the supplied PDF and
 * published component rates establish the displayed whole-dollar result
 * (5514.8625 is displayed as 5514), so this implementation intentionally
 * truncates the aggregate amount. Keep this behavior clearly labeled as the
 * documented estimator-compatible calculation, not as a claim about hidden
 * county JavaScript.
 */
export function calculateCollierPurchaseAdValorem(
  purchasePrice: number,
  homestead: boolean,
  rates: CollierMillageRates,
): number {
  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) return 0;

  const schoolTaxable = homestead
    ? Math.max(purchasePrice - 25_000, 0)
    : purchasePrice;
  const additionalExemption = homestead
    ? Math.max(
        0,
        Math.min(
          purchasePrice - 50_000,
          COLLIER_OFFICIAL_NON_SCHOOL_EXEMPTION - 25_000,
        ),
      )
    : 0;
  const nonSchoolTaxable = homestead
    ? Math.max(purchasePrice - 25_000 - additionalExemption, 0)
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