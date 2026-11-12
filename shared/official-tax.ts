/** All money crossing the provider boundary is integer cents. Null is missing, never zero. */
export interface TaxSource {
  name: string;
  url: string;
  fetchedAt: string;
  taxYear: number;
  parcelId: string;
  purchasePrice?: number;
  homestead?: boolean;
}
export interface TaxPart {
  cents: number | null;
  reason?: string;
  source?: TaxSource;
  lines?: { name: string; amount: number }[];
}
export interface OfficialTaxBreakdown {
  adValorem: TaxPart;
  nonAdValorem: TaxPart;
  total: TaxPart;
  warnings: string[];
}
export const COUNTY_TAX_WARNINGS: Record<string, string> = {
  pasco: "Pasco's estimator applies a $150,000 non-school homestead exemption (likely the 2027 Amendment 3 amount); the 2026 bill uses $51,411 ($25,000 + $26,411).",
  lee: "Lee's estimator uses a flat $50,000 homestead exemption and prior-year millage; it excludes non-ad valorem.",
  hernando: "Hernando's estimator excludes special assessments. Its county-portion breakdown is inconsistent: at $400,000 with homestead, the county line shows 6.697 mills / $2,343.95 while the breakdown sums to 7.369 mills / $2,579.15. The county-published overall total is retained, not recomputed.",
};
export function composeOfficialTax(adValorem: TaxPart, nonAdValorem: TaxPart, warnings: string[] = []): OfficialTaxBreakdown {
  const valid = (n: number | null) => n !== null && Number.isSafeInteger(n) && n >= 0;
  return {
    adValorem, nonAdValorem, warnings,
    total: valid(adValorem.cents) && valid(nonAdValorem.cents)
      ? { cents: adValorem.cents! + nonAdValorem.cents! }
      : { cents: null, reason: [adValorem.cents === null && adValorem.reason, nonAdValorem.cents === null && nonAdValorem.reason].filter(Boolean).join("; ") || "Official tax component missing" },
  };
}
