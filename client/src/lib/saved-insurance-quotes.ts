import { normalizeQuoteAddress } from "@shared/quote-address";
import {
  isPolicyForm,
  isWithinReuseWindow,
  normalizeOccupancy,
  runMatchesScenario,
  sharedEstimateRequest,
} from "@shared/live-quote-reuse";

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
  /** Occupancy this run was quoted for (the user's own runs only). */
  occupancy?: string | null;
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

// ── Persisted run status (GET /api/insurance/my-quotes `runs`) ──────────────
export type QuoteRunStatus = "running" | "completed" | "failed" | "agent_follow_up";

export interface QuoteRunState {
  addressNormalized: string;
  policyType: string;
  status: QuoteRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SavedQuoteState {
  results: SavedQuoteResult[];
  runs: QuoteRunState[];
}

/** Poll cadence while a background run is in flight (server polls every 20 s). */
export const QUOTE_RUN_POLL_MS = 12_000;
/** Server poll window; used only to scale the progress bar. */
export const QUOTE_RUN_WINDOW_SECONDS = 12 * 60;
export const RUNNING_QUOTES_TITLE = "Getting your quotes…";
export const RUNNING_QUOTES_DETAIL =
  "We'll email you when your quotes are ready, and they'll be here when you come back.";
export const AGENT_FOLLOW_UP_MESSAGE =
  "An agent will finish your quotes — carrier submission could not be confirmed.";

export async function fetchSavedQuoteState(
  fetcher: (path: string) => Promise<Response>,
): Promise<SavedQuoteState> {
  const response = await fetcher("/api/insurance/my-quotes");
  if (!response.ok) throw new Error("Saved quotes unavailable");
  const body = await response.json();
  return {
    results: Array.isArray(body?.results) ? body.results : [],
    runs: Array.isArray(body?.runs) ? body.runs : [],
  };
}

/** This property's run status; prefers the requested policy type. */
export function findQuoteRunForAddress(
  runs: readonly QuoteRunState[] | null | undefined,
  address: string,
  policyType?: string | null,
): QuoteRunState | null {
  if (!runs?.length || !address.trim()) return null;
  const key = normalizeQuoteAddress(address);
  const matches = runs.filter(run => run.addressNormalized === key);
  if (policyType) return matches.find(run => run.policyType === policyType) ?? null;
  return matches.find(run => run.status === "running") ?? matches[0] ?? null;
}

export function anyQuoteRunRunning(state: SavedQuoteState | null | undefined): boolean {
  return !!state?.runs.some(run => run.status === "running");
}

/** How the live-quote card should present a persisted run. */
export function quoteRunDisplay(run: QuoteRunState | null): "running" | "agent" | "none" {
  if (!run) return "none";
  if (run.status === "running") return "running";
  if (run.status === "failed" || run.status === "agent_follow_up") return "agent";
  return "none";
}

export function quoteRunElapsedSeconds(run: QuoteRunState | null, now = Date.now()): number {
  const started = run?.startedAt ? Date.parse(run.startedAt) : NaN;
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
}

/** Progress fraction for a persisted run, capped at 90% until it finishes. */
export function quoteRunProgress(elapsedSeconds: number): number {
  return Math.min(elapsedSeconds / QUOTE_RUN_WINDOW_SECONDS, 0.9);
}

// ── Shared recent live quote as a general estimate ────────────────────────
export interface SharedLiveQuoteEstimate {
  annual: number;
  monthly: number;
  quotedDate: string;
  source: "recent_live_quote";
}

export type SharedEstimateOccupancy = "primary" | "secondary" | "investment";

export function sharedEstimateNote(quotedDate: string): string {
  const date = formatQuotedDate(quotedDate);
  return date ? `Based on a recent live carrier quote (${date})` : "Based on a recent live carrier quote";
}

export function sharedEstimatePath(
  address: string,
  policyType: string | null | undefined,
  occupancy: string | null | undefined,
): string | null {
  if (!address.trim() || !policyType || !["HO3", "HO6", "DP3"].includes(policyType)) return null;
  const params = new URLSearchParams({ address: address.trim(), policyType });
  if (occupancy === "primary" || occupancy === "secondary" || occupancy === "investment") {
    params.set("occupancy", occupancy);
  } else if (policyType !== "DP3") {
    // HO3/HO6 quotes are reused only for a known matching occupancy.
    return null;
  }
  return `/api/insurance/shared-estimate?${params.toString()}`;
}

export async function fetchSharedLiveQuoteEstimate(
  path: string,
  fetcher: (path: string) => Promise<Response> = p => fetch(p),
): Promise<SharedLiveQuoteEstimate | null> {
  const response = await fetcher(path);
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const e = body?.estimate;
  if (!e || typeof e.annual !== "number" || !(e.annual > 0) || typeof e.quotedDate !== "string") return null;
  return {
    annual: e.annual,
    monthly: typeof e.monthly === "number" ? e.monthly : Math.round((e.annual / 12) * 100) / 100,
    quotedDate: e.quotedDate,
    source: "recent_live_quote",
  };
}

export type InsuranceEstimateSource = "manual" | "own_quote" | "recent_live_quote" | "calculated";

/** Priority: the user's own manual premium, then their own uploaded/live
 * quote, then a recent shared live quote, then the calculated estimate. */
export function resolveGeneralInsuranceEstimate(args: {
  manualAnnual?: number | null;
  ownQuoteAnnual?: number | null;
  shared?: SharedLiveQuoteEstimate | null;
  calculatedAnnual: number;
}): { annual: number; source: InsuranceEstimateSource; note: string | null } {
  const positive = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (positive(args.manualAnnual)) return { annual: args.manualAnnual, source: "manual", note: null };
  if (positive(args.ownQuoteAnnual)) return { annual: args.ownQuoteAnnual, source: "own_quote", note: null };
  if (args.shared && positive(args.shared.annual)) {
    return { annual: args.shared.annual, source: "recent_live_quote", note: sharedEstimateNote(args.shared.quotedDate) };
  }
  return { annual: args.calculatedAnnual, source: "calculated", note: null };
}


// ── Reusing a recent live quote on the purchase page ──────────────────────
export type ReusableLiveQuote =
  | { kind: "own"; annual: number; monthly: number; quotedDate: string; result: SavedQuoteResult }
  /** Another user's run: the number and date only, never carriers/answers. */
  | { kind: "shared"; annual: number; monthly: number; quotedDate: string };

/**
 * A live quote for this address that may be shown instead of re-running:
 * the user's own saved result first, then the shared lowest-premium estimate.
 * Both must be within the shared 90-day window and match the policy form +
 * occupancy rule used by the shared estimate.
 */
export function selectReusableLiveQuote(args: {
  address: string;
  policyType: string | null | undefined;
  occupancy: string | null | undefined;
  own: readonly SavedQuoteResult[] | null | undefined;
  shared: SharedLiveQuoteEstimate | null | undefined;
  now?: Date;
}): ReusableLiveQuote | null {
  const now = args.now ?? new Date();
  if (!args.address.trim() || !isPolicyForm(args.policyType)) return null;
  const request = sharedEstimateRequest(args.policyType, normalizeOccupancy(args.occupancy));
  const key = normalizeQuoteAddress(args.address);
  const ownMatches = (args.own ?? [])
    .filter(r => r.addressNormalized === key && r.quotes.length > 0 && r.quotes[0].annualPremium > 0)
    .filter(r => isWithinReuseWindow(r.completedAt, now))
    .filter(r => runMatchesScenario(
      { policyType: r.policyType, occupancy: normalizeOccupancy(r.occupancy) }, request,
    ))
    .sort((a, b) => a.quotes[0].annualPremium - b.quotes[0].annualPremium
      || (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  const own = ownMatches[0];
  if (own) {
    const best = own.quotes[0];
    return {
      kind: "own",
      annual: best.annualPremium,
      monthly: best.monthlyPremium > 0 ? best.monthlyPremium : Math.round((best.annualPremium / 12) * 100) / 100,
      quotedDate: own.completedAt!,
      result: own,
    };
  }
  const shared = args.shared;
  if (shared && shared.annual > 0 && isWithinReuseWindow(shared.quotedDate, now)) {
    return { kind: "shared", annual: shared.annual, monthly: shared.monthly, quotedDate: shared.quotedDate };
  }
  return null;
}
