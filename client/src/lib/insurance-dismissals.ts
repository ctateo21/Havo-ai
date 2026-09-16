const INSURANCE_DISMISSED_PREFIX = "dashboard:insurance-dismissed:";

export function readDismissedInsuranceKeys(
  userId: string | null | undefined,
): Set<string> {
  if (!userId || typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(INSURANCE_DISMISSED_PREFIX + userId);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function writeDismissedInsuranceKeys(
  userId: string | null | undefined,
  keys: Set<string>,
): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      INSURANCE_DISMISSED_PREFIX + userId,
      JSON.stringify(Array.from(keys)),
    );
  } catch {
    // Dismissal remains in React state for this session when storage is unavailable.
  }
}

export function isInsuranceAddressDismissed(
  dismissedKeys: Set<string>,
  address: string,
  normalizedKey?: string | null,
): boolean {
  const addressKey = address.trim().toLowerCase();
  return Boolean(
    (normalizedKey && dismissedKeys.has(normalizedKey)) ||
    (addressKey && dismissedKeys.has(addressKey)),
  );
}