/** Calendar date only: keep dates independent of browser time-of-day. */
export function insuranceEffectiveDate(now = new Date()): string {
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 14));
  return date.toISOString().slice(0, 10);
}
export const ROOF_MATERIALS = ["Architectural Shingles", "Metal", "Tile", "Other"] as const;
