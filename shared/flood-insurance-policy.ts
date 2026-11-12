/**
 * Property types whose flood exposure is not represented as a separate
 * borrower-paid flood-insurance line item.
 *
 * Condo, townhome, and villa coverage is assumed to be handled through the
 * association/master policy. Land has no building coverage to estimate.
 */
export function suppressSeparateFloodInsurance(propertyType: unknown): boolean {
  if (typeof propertyType !== "string") return false;

  const normalized = propertyType.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;

  return (
    normalized.includes("condo") ||
    normalized.includes("townhome") ||
    normalized.includes("townhouse") ||
    normalized.includes("villa") ||
    normalized === "land" ||
    normalized === "lot" ||
    normalized.includes("vacantland") ||
    normalized.includes("vacantlot") ||
    normalized.includes("residentialland") ||
    normalized.includes("residentiallot")
  );
}

/** Return the annual amount that may actually be used or persisted. */
export function effectiveAnnualFloodInsurance(
  propertyType: unknown,
  annual: number | null | undefined,
): number {
  if (suppressSeparateFloodInsurance(propertyType)) return 0;
  return typeof annual === "number" && Number.isFinite(annual) ? annual : 0;
}

export interface SavedPurchaseFloodSnapshot {
  annualFloodIns: number | null | undefined;
  monthlyPayment: number | null | undefined;
}

/**
 * Make a saved Purchase payment snapshot coherent when its separate flood
 * line is suppressed. Purchase `monthlyPayment` is a derived total known to
 * include `annualFloodIns / 12`, so the legacy component can be removed once
 * while the annual value is zeroed. An already-zero snapshot is idempotent.
 */
export function sanitizeSavedPurchaseFloodSnapshot(
  propertyType: unknown,
  annualFloodIns: number | null | undefined,
  monthlyPayment: number | null | undefined,
): SavedPurchaseFloodSnapshot {
  if (!suppressSeparateFloodInsurance(propertyType)) {
    return { annualFloodIns, monthlyPayment };
  }

  const canRemoveMonthlyComponent =
    typeof annualFloodIns === "number" &&
    Number.isFinite(annualFloodIns) &&
    annualFloodIns > 0 &&
    typeof monthlyPayment === "number" &&
    Number.isFinite(monthlyPayment);

  return {
    annualFloodIns: 0,
    monthlyPayment: canRemoveMonthlyComponent
      ? Math.max(0, monthlyPayment - annualFloodIns / 12)
      : monthlyPayment,
  };
}

export const FLOOD_HOA_ASSUMPTION_NOTE =
  "Flood insurance is assumed to be included in HOA dues. Verify coverage with the HOA master policy.";