/**
 * Hillsborough County Property Appraiser purchase-tax math.
 *
 * This is the low end of the public Tax Estimator
 * (https://gis.hcpafl.org/PropertySearch/TaxEstimator.aspx), copied from
 * viewmodel/taxEstimatorVM.js (asset version v20260605A):
 *
 *   taxable base = purchase price × 0.85
 *   no homestead: base × (school + non-school) mills / 1000
 *   homestead:    school tax on (base − $25,000)
 *                 non-school tax on (base − $50,000) once base is at least $75,000
 *
 * The page shows that low figure and a high figure at 100% of price.
 * Havo uses the low figure only. The 85% factor is applied once here.
 *
 * The page does not include non-ad valorem. Callers add the tax-collector
 * bill separately and must not also add the API's nonAdValoremTaxes field.
 *
 * Florida DOR indexes the second homestead exemption ($26,411 for 2026).
 * The county page still uses a flat $25,000 second exemption. Matching the
 * page is intentional: that is the number an underwriter sees on the
 * official site. The difference is recorded on the audit object.
 */

export const HCPA_ESTIMATOR_PAGE =
  "https://gis.hcpafl.org/PropertySearch/TaxEstimator.aspx";
export const HCPA_ESTIMATOR_SCRIPT =
  "https://gis.hcpafl.org/PropertySearch/viewmodel/taxEstimatorVM.js?v20260605A";
export const HCPA_LOW_ASSESSMENT_RATIO = 0.85;

export interface HcpaLowEndInput {
  purchasePrice: number;
  homestead: boolean;
  schoolMills: number;
  nonSchoolMills: number;
}

/** Round the way the county page does: JavaScript Number#toFixed(2). */
export function hcpaRoundCents(value: number): number {
  return Number(value.toFixed(2));
}

export function hcpaOfficialLowEndAdValorem(input: HcpaLowEndInput): number | null {
  const { purchasePrice, homestead, schoolMills, nonSchoolMills } = input;
  if (
    !(purchasePrice > 0) ||
    !Number.isFinite(purchasePrice) ||
    !Number.isFinite(schoolMills) ||
    !Number.isFinite(nonSchoolMills) ||
    schoolMills < 0 ||
    nonSchoolMills < 0 ||
    schoolMills + nonSchoolMills <= 0
  ) {
    return null;
  }

  const taxable = purchasePrice * HCPA_LOW_ASSESSMENT_RATIO;
  const schoolRate = schoolMills * 0.001;
  const nonSchoolRate = nonSchoolMills * 0.001;

  let result: number;
  if (!homestead) {
    result = taxable * (schoolRate + nonSchoolRate);
  } else {
    let schoolTaxes = (taxable - 25_000) * schoolRate;
    if (schoolTaxes < 0) schoolTaxes = 0;

    let nonSchoolTaxes: number;
    if (taxable < 50_000) {
      nonSchoolTaxes = (taxable - 25_000) * nonSchoolRate;
    } else if (taxable < 75_000) {
      nonSchoolTaxes = ((taxable - 25_000) - (taxable - 50_000)) * nonSchoolRate;
    } else {
      nonSchoolTaxes = (taxable - 50_000) * nonSchoolRate;
    }
    if (nonSchoolTaxes < 0) nonSchoolTaxes = 0;
    result = schoolTaxes + nonSchoolTaxes;
  }

  return hcpaRoundCents(result);
}
