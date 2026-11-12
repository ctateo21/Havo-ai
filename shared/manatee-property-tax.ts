export const MANATEE_RATES_SOURCE = "manatee-official-rates";
export const MANATEE_RATES_LABEL = "Calculated from Manatee County official 2026 rates and exemptions (no official purchase-price estimator)";
export function manateeAdValoremCents(price: number, homestead: boolean, school: number, nonSchool: number): number {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(school) || school <= 0 || !Number.isFinite(nonSchool) || nonSchool <= 0)
    throw new Error("Manatee official rates or purchase price unavailable");
  return Math.round((Math.max(0, price - (homestead ? 25000 : 0)) * school +
    Math.max(0, price - (homestead ? 50000 : 0)) * nonSchool) / 10);
}
