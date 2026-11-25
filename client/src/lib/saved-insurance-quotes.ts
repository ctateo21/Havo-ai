import { normalizeQuoteAddress } from "@shared/quote-address";

/** One carrier row as returned by GET /api/insurance/my-quotes. */
export interface SavedQuote {
  siteName: string;
  annualPremium: number;
  monthlyPremium: number;
  coverageA: number;
  hurricaneDeductible: string;
  aop: string;
  quoteUrl: string | null;
  quoteDate: string;
  rank: number;
}

export interface SavedQuoteResult {
  addressNormalized: string;
  policyType: string;
  leadId: number | null;
  completedAt: string | null;
  stale: boolean;
  bestCarrier: string | null;
  bestAnnual: number | null;
  quotes: SavedQuote[];
}

export const SAVED_QUOTES_QUERY_KEY = ["/api/insurance/my-quotes"] as const;
export const ESTIMATE_MODEL_VERSION = "havo-insurance-estimate-v1";
export const STALE_QUOTE_MESSAGE = "Prices may have changed. Re-run quotes.";
export const GUEST_LIVE_QUOTE_PROMPT = "Create an account to get live carrier quotes and save them";
export const REBUILD_EXPLANATION_SUMMARY = "How we estimated rebuild cost";
export const COVERAGE_DETAILS_SUMMARY = "Coverage details & assumptions";

/** Both explainer sections render collapsed until the user opens them. */
export const EXPLAINERS_OPEN_BY_DEFAULT = { rebuild: false, coverageDetails: false } as const;

/** Newest saved result for this address; prefers the requested policy type. */
export function findSavedQuoteForAddress(
  results: readonly SavedQuoteResult[] | null | undefined,
  address: string,
  policyType?: string | null,
): SavedQuoteResult | null {
  if (!results?.length || !address.trim()) return null;
  const key = normalizeQuoteAddress(address);
  const matches = results
    .filter(r => r.addressNormalized === key && r.quotes.length > 0)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  if (policyType) {
    const exact = matches.find(r => r.policyType === policyType);
    if (exact) return exact;
  }
  return matches[0] ?? null;
}

export function formatQuotedDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export interface InsuranceCardSummary {
  status: "Quoted" | "Estimate" | "Not started";
  annual: number | null;
  monthly: number | null;
  carrier: string | null;
  quotedDate: string | null;
  stale: boolean;
}

/** Dashboard card: a saved live quote wins over the estimate. */
export function insuranceCardSummary(
  estimateAnnual: number | null | undefined,
  hasScenario: boolean,
  saved: SavedQuoteResult | null,
): InsuranceCardSummary {
  const best = saved?.quotes[0];
  if (saved && best && best.annualPremium > 0) {
    return {
      status: "Quoted",
      annual: best.annualPremium,
      monthly: best.monthlyPremium > 0 ? best.monthlyPremium : best.annualPremium / 12,
      carrier: best.siteName || saved.bestCarrier,
      quotedDate: formatQuotedDate(saved.completedAt) || null,
      stale: saved.stale,
    };
  }
  const annual = typeof estimateAnnual === "number" && Number.isFinite(estimateAnnual) ? estimateAnnual : null;
  return {
    status: hasScenario ? "Estimate" : "Not started",
    annual,
    monthly: annual != null ? annual / 12 : null,
    carrier: null,
    quotedDate: null,
    stale: false,
  };
}

/** Estimate sent with qr-start so the run can be compared to Havo's model. */
export function quoteEstimatePayload(
  manualAnnualPremium: number | null | undefined,
  calculatedMid: number,
  county: string | null | undefined,
): { annual: number; monthly: number; county?: string; modelVersion: string } | null {
  const annual = manualAnnualPremium ?? Math.round(calculatedMid);
  if (!Number.isFinite(annual) || annual <= 0) return null;
  return {
    annual,
    monthly: Math.round((annual / 12) * 100) / 100,
    ...(county?.trim() ? { county: county.trim() } : {}),
    modelVersion: ESTIMATE_MODEL_VERSION,
  };
}

export async function fetchSavedQuoteResults(
  fetcher: (path: string) => Promise<Response>,
): Promise<SavedQuoteResult[]> {
  const response = await fetcher("/api/insurance/my-quotes");
  if (!response.ok) throw new Error("Saved quotes unavailable");
  const body = await response.json();
  return Array.isArray(body?.results) ? body.results : [];
}
