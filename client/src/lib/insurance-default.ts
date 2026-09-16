/**
 * Shared default-homeowners-insurance helper.
 *
 * The 0.75% formula remains the fallback when a property has no usable
 * year-built/construction answers. General-estimate screens use the
 * age/construction helper below before live carrier quotes.
 *
 * Manual overrides and real carrier quotes always win.
 *
 * Callers are expected to check for `homeownersInsurance` /
 * `annualPremium` / `insurance_source === "manual" | "quote"` before
 * falling back to a planning estimate.
 */

export const DEFAULT_HOMEOWNERS_INSURANCE_PERCENT = 0.0075;
export const FRAME_CONSTRUCTION_SURCHARGE_PERCENT = 0.0015;

export interface BaselineHomeownersInsuranceRateInput {
  yearBuilt?: number | null;
  /** Frame is the only construction class with the additive 0.15% surcharge. */
  isFrameConstruction?: boolean;
  /** Test seam; production callers use the current calendar year. */
  asOfYear?: number;
}

/**
 * General-estimate baseline before live carrier quotes.
 *
 * Home-age bands are intentionally additive with the frame surcharge:
 * a default-factor $300,000 frame home is exactly $450/year above the
 * same block/concrete home.
 */
export function getBaselineHomeownersInsuranceRate(
  input: BaselineHomeownersInsuranceRateInput,
): number {
  const asOfYear = Number.isInteger(input.asOfYear)
    ? Number(input.asOfYear)
    : new Date().getFullYear();
  const yearBuilt =
    typeof input.yearBuilt === "number" && Number.isFinite(input.yearBuilt)
      ? Math.round(input.yearBuilt)
      : null;
  const age = yearBuilt == null
    ? null
    : Math.max(0, asOfYear - yearBuilt);

  let ageRate = DEFAULT_HOMEOWNERS_INSURANCE_PERCENT;
  if (age != null) {
    if (age < 5) ageRate = 0.0040;
    else if (age <= 10) ageRate = 0.0050;
    else if (age <= 20) ageRate = 0.0055;
    else if (age <= 25) ageRate = 0.0060;
    else if (age <= 50) ageRate = 0.0075;
    else ageRate = 0.0090;
  }

  return ageRate + (
    input.isFrameConstruction
      ? FRAME_CONSTRUCTION_SURCHARGE_PERCENT
      : 0
  );
}

/**
 * Coverage A multiplier per policy type (spec: insurance-ho6-half-coverage-and-premium).
 *
 * HO6 (condo/townhome) policies insure only the interior of the unit
 * — the master condo association policy covers the structure shell —
 * so both Coverage A AND the resulting annual premium are cut in half
 * versus an HO3 / DP3 single-family policy of the same property value.
 *
 * The premium reduction is *implicit*: premium = coverageA × 0.75%,
 * so halving coverageA halves the premium for free. Callers that
 * derive premium from `propertyValue` directly (without going through
 * `coverageA`) must still apply this multiplier — use the
 * `calculateInsuranceDefaults` helper below to stay consistent.
 *
 * Unknown / null policy types default to 1.0 (HO3 behavior) so legacy
 * rows and unauthenticated quick-quote flows keep working unchanged.
 */
export const INSURANCE_POLICY_COVERAGE_MULTIPLIER = {
  HO3: 1.0,
  DP3: 1.0,
  HO6: 0.5,
} as const;

export type InsurancePolicyTypeForCoverage =
  keyof typeof INSURANCE_POLICY_COVERAGE_MULTIPLIER;

export function getInsuranceCoverageMultiplier(
  policyType: string | null | undefined,
): number {
  if (!policyType) return 1.0;
  const key = policyType as InsurancePolicyTypeForCoverage;
  return INSURANCE_POLICY_COVERAGE_MULTIPLIER[key] ?? 1.0;
}

export type DefaultHomeownersInsuranceSource = "default_0_75_percent";

export interface DefaultHomeownersInsuranceResult {
  /** Annual premium in dollars (rounded to nearest $1). */
  annualInsurance: number;
  /** Monthly premium in dollars (rounded to nearest $1). */
  monthlyInsurance: number;
  /** Provenance tag so consumers can distinguish from manual/quote values. */
  source: DefaultHomeownersInsuranceSource;
}

/**
 * Compute the default annual + monthly homeowners insurance estimate
 * from a property value. Returns zeros when `propertyValue` is missing,
 * non-positive, or non-finite — callers can treat that as "no estimate
 * available" and fall back to blank.
 */
export function calculateDefaultHomeownersInsurance(
  propertyValue: number | null | undefined,
): DefaultHomeownersInsuranceResult {
  const value = typeof propertyValue === "number" && Number.isFinite(propertyValue) && propertyValue > 0
    ? propertyValue
    : 0;
  const annual = Math.round(value * DEFAULT_HOMEOWNERS_INSURANCE_PERCENT);
  const monthly = Math.round(annual / 12);
  return { annualInsurance: annual, monthlyInsurance: monthly, source: "default_0_75_percent" };
}

export interface InsuranceDefaultsInput {
  propertyValue: number | null | undefined;
  policyType?: string | null | undefined;
}

export interface InsuranceDefaultsResult {
  /** Coverage A in dollars (propertyValue × coverageMultiplier, rounded). */
  coverageA: number;
  /** Annual premium in dollars (coverageA × 0.75%, rounded). */
  annualPremium: number;
  /** Monthly premium (annualPremium / 12, rounded to nearest cent). */
  monthlyPremium: number;
  /** 1.0 for HO3/DP3/unknown, 0.5 for HO6. */
  coverageMultiplier: number;
  /** Provenance tag for premium so callers can stamp `premium_source`. */
  source: DefaultHomeownersInsuranceSource;
}

/**
 * Spec: insurance-ho6-half-coverage-and-premium.
 *
 * Single canonical formula for default Coverage A + premium across
 * Insurance overview, detail, simulator, and auto-create flows.
 * HO6 → coverageA = propertyValue × 0.5 → premium also halves.
 * HO3 / DP3 / unknown → coverageA = propertyValue × 1.0.
 */
export function calculateInsuranceDefaults(
  input: InsuranceDefaultsInput,
): InsuranceDefaultsResult {
  const raw = input.propertyValue;
  const value = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
  const multiplier = getInsuranceCoverageMultiplier(input.policyType);
  const coverageA = Math.round(value * multiplier);
  const annualPremium = Math.round(coverageA * DEFAULT_HOMEOWNERS_INSURANCE_PERCENT);
  const monthlyPremium = Math.round((annualPremium / 12) * 100) / 100;
  return {
    coverageA,
    annualPremium,
    monthlyPremium,
    coverageMultiplier: multiplier,
    source: "default_0_75_percent",
  };
}
