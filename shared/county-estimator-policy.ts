/**
 * Counties that have passed the official purchase-estimator known-answer
 * gate.  Keep this registry empty until a county has a captured answer and
 * its live runner has matched that answer.
 */
export const ESTIMATOR_VERIFIED_COUNTIES = Object.freeze(
  [] as string[],
);

/**
 * A county is eligible for the strict estimator path only when it is
 * explicitly listed in the verified registry.  Normalize here so callers do
 * not accidentally bypass the gate with casing or surrounding whitespace.
 */
export function isCountyEstimatorVerified(county: string): boolean {
  return ESTIMATOR_VERIFIED_COUNTIES.includes(county.trim().toLowerCase());
}