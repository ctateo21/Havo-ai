/**
 * Rules for reusing a completed live carrier quote instead of re-running one.
 * Shared by the server's shared-estimate route and the purchase page so both
 * use one freshness window and one policy-form + occupancy rule.
 */

/** A completed live carrier quote may be reused for 90 days. */
export const LIVE_QUOTE_REUSE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export type Occupancy = "primary" | "secondary" | "investment";
export type PolicyForm = "HO3" | "HO6" | "DP3";

export function normalizeOccupancy(value: unknown): Occupancy | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "primary" || v === "secondary" || v === "investment" ? v : null;
}

export function isPolicyForm(value: unknown): value is PolicyForm {
  return value === "HO3" || value === "HO6" || value === "DP3";
}

/**
 * Whether a completed run may stand in for this scenario's estimate.
 *  - The policy form must match exactly.
 *  - DP3 is a rental form: any DP3 run serves a non-primary DP3 request.
 *  - HO3/HO6 runs are reused only for the same occupancy. A primary quote
 *    never serves an investment/rental scenario, and an HO3 request for an
 *    investment property never matches (HO3 is owner-occupied only).
 *  - A run whose occupancy is unknown is not reused for HO3/HO6.
 */
export function runMatchesScenario(
  run: { policyType: string; occupancy: Occupancy | null },
  request: { policyType: PolicyForm; occupancy: Occupancy | null },
): boolean {
  if (run.policyType !== request.policyType) return false;
  if (request.policyType === "DP3") {
    return request.occupancy !== "primary" && request.occupancy !== "secondary"
      && (run.occupancy == null || run.occupancy === "investment");
  }
  if (!request.occupancy || !run.occupancy) return false;
  if (request.policyType === "HO3" && request.occupancy === "investment") return false;
  return run.occupancy === request.occupancy;
}

/** An investment property never uses an owner-occupied HO3 quote; its
 * dwelling estimate comes from DP3 (rental dwelling) quotes instead. */
export function sharedEstimateRequest(
  policyType: PolicyForm,
  occupancy: Occupancy | null,
): { policyType: PolicyForm; occupancy: Occupancy | null } {
  if (policyType === "HO3" && occupancy === "investment") return { policyType: "DP3", occupancy };
  return { policyType, occupancy };
}

export function isWithinReuseWindow(completedAt: string | Date | null | undefined, now: Date): boolean {
  if (!completedAt) return false;
  const at = completedAt instanceof Date ? completedAt.getTime() : Date.parse(completedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= LIVE_QUOTE_REUSE_MAX_AGE_MS && at <= now.getTime() + 60_000;
}
