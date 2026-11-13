import { useState, useEffect, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import ScenarioActions from "@/components/scenario-actions";
import { useAnonymousDraft, useAnonymousAccountDraft } from "@/hooks/use-anonymous-draft";
import { useQuoteAccess } from "@/context/quote-access-context";
import { authedFetch } from "@/lib/authed-fetch";
import { confirmAnonymousAccountDraftSaved, hasPendingAnonymousAccountDraft } from "@/lib/anonymous-account-draft";
import { Home, ArrowLeft, Building2, Landmark } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LiveRatesCard } from "@/components/refi/live-rates-card";
import { StatementAnalyzer } from "@/components/refi/statement-analyzer";
import { ClosingDisclosureAnalyzer } from "@/components/refi/closing-disclosure-analyzer";
import { ManualLoanEntry } from "@/components/refi/manual-loan-entry";
import { FreeClearEntry } from "@/components/refi/free-clear-entry";
import { LoanTracker, type MortgageAnalysis, type LiveRate, type PropertyType } from "@/components/refi/loan-tracker";
import { useQuery } from "@tanstack/react-query";
import {
  getSession, getTrackedLoans, saveTrackedLoans, subscribeAuthChange,
  subscribePersistenceError,
  getSellerScenarios, saveSellerScenarios,
  type TrackedLoan,
} from "@/lib/auth";
import { isCdPurchasePriceLocked } from "@/lib/cd-property-value";
import { notifyNewScenario } from "@/lib/notify-scenario";
import { createOrUpdateSellerScenarioFromRefinance } from "@/lib/seller-from-refinance";
import { useAuth } from "@/context/auth-context";
import PropertyLookupDialog, { type LookedUpProperty } from "@/components/property-lookup-dialog";
import { useToast } from "@/hooks/use-toast";
import { trackEvent } from "@/lib/posthog";
import { mergeStatementRefresh } from "@/lib/refinance-statement-refresh";

const MAX_TRACKED_LOANS = 10;
const DEFAULT_CREDIT_SCORE = 740;

type EntryMethod = "statement" | "closing_disclosure" | "manual" | "free_and_clear";

const ENTRY_METHOD_OPTIONS: { value: EntryMethod; label: string; description: string }[] = [
  { value: "statement", label: "Mortgage Statement", description: "Upload your latest statement" },
  { value: "closing_disclosure", label: "Closing Disclosure", description: "Upload your final CD from closing" },
  { value: "manual", label: "Enter Manually", description: "Type in your loan details" },
  { value: "free_and_clear", label: "Free & Clear", description: "No mortgage on the property" },
];

function analysisToTrackedLoan(
  analysis: MortgageAnalysis,
  propertyType: PropertyType,
  creditScore: number,
  extras?: Partial<TrackedLoan>,
): TrackedLoan {
  const now = new Date().toISOString();
  const loanNumber = typeof analysis.loanNumber === "string" && analysis.loanNumber.trim()
    ? analysis.loanNumber.trim()
    : undefined;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    propertyAddress: analysis.propertyAddress || "Unknown address",
    lender: analysis.lender || "Unknown lender",
    loanBalance: analysis.loanBalance,
    currentRate: analysis.interestRate,
    currentPI: analysis.principalAndInterest,
    monthlyPayment: analysis.monthlyPayment,
    ...(typeof analysis.currentEscrowBalance === "number" && analysis.currentEscrowBalance >= 0
      ? { currentEscrowBalance: analysis.currentEscrowBalance }
      : {}),
    estimatedHomeValue: analysis.estimatedHomeValue,
    estimatedRemainingYears: analysis.estimatedRemainingYears,
    addedAt: now,
    balanceAsOf: now,
    propertyType,
    // Phase 2: populate the dedicated occupancy column on first add so
    // future code paths can stop relying on the legacy `propertyType`
    // field (which historically held the occupancy value). Stored on
    // tracked_loans.occupancy_type via the 2026_05_27 migration.
    occupancyType: propertyType,
    loanType: "conventional",
    loanNumber,
    creditScore,
    // Entry-method provenance + origination details (CD / manual flows).
    entryMethod: "statement",
    ...extras,
    // VA/FHA require primary occupancy — if the manual flow picked one
    // of those but the user then chose secondary/investment in the
    // occupancy dialog, fall back to conventional (same rule the loan
    // card enforces on occupancy changes).
    ...(extras?.loanType && (extras.loanType === "va" || extras.loanType === "fha") && propertyType !== "primary"
      ? { loanType: "conventional" as const }
      : {}),
  };
}

const PROPERTY_OPTIONS: { type: PropertyType; label: string; description: string; icon: React.ReactNode }[] = [
  {
    type: "primary",
    label: "Primary Home",
    description: "Where you live full-time",
    icon: <Home className="h-6 w-6" />,
  },
  {
    type: "secondary",
    label: "Secondary Home",
    description: "Vacation or part-time residence",
    icon: <Landmark className="h-6 w-6" />,
  },
  {
    type: "investment",
    label: "Investment Property",
    description: "Rented out or income-generating",
    icon: <Building2 className="h-6 w-6" />,
  },
];

interface LiveRatesResponse {
  rates: LiveRate[];
  source: string;
  disclaimer: string;
  asOf: string;
}

export default function Refinance() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const address = new URLSearchParams(search).get("address") || "";
  // ?debug=1 re-exposes the manual "Pull from Zillow" button. The normal
  // flow now auto-runs a Zillow lookup whenever a tracked loan is added.
  const debugMode = new URLSearchParams(search).get("debug") === "1";

  const { user } = useAuth();
  const isAuthenticated = !!user;
  const { authorize } = useQuoteAccess();
  const beganAnonymous = useRef(!user || hasPendingAnonymousAccountDraft());
  const promotedDraft = useRef(false);

  const [statementData, setStatementData] = useState<MortgageAnalysis | null>(null);
  const [trackedLoans, setTrackedLoansState] = useAnonymousDraft<TrackedLoan[]>("trackedLoans", () => getTrackedLoans());
  useAnonymousAccountDraft("refinance", trackedLoans);

  const { toast } = useToast();

  // Keep local state in sync with auth cache (login, logout, hydration completes).
  useEffect(() => {
    const unsub = subscribeAuthChange(() => {
      if (!beganAnonymous.current) setTrackedLoansState(getTrackedLoans());
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user || !beganAnonymous.current || promotedDraft.current || !trackedLoans.length) return;
    promotedDraft.current = true;
    const addresses = new Set(trackedLoans.map(loan => loan.propertyAddress.trim().toLowerCase()));
    const merged = [...trackedLoans, ...getTrackedLoans().filter(loan => !addresses.has(loan.propertyAddress.trim().toLowerCase()))];
    setTrackedLoansState(merged);
    void confirmAnonymousAccountDraftSaved("refinance", () => saveTrackedLoans(merged)).catch(() => {
      promotedDraft.current = false;
      toast({ title: "Your draft is still here", description: "We couldn't save it to your account. Use Save Scenario to retry.", variant: "destructive" });
    });
  }, [user, trackedLoans, toast, setTrackedLoansState]);

  // Surface tracked_loans persistence errors (including missing-column
  // warnings from the schema-safe strip-and-retry) as a single toast.
  // Without this, a missing `loan_type` column silently strips on every
  // save, so the user sees their FHA/VA selection "revert" to
  // Conventional after refresh with no explanation.
  const warnedMissingRef = useRef(new Set<string>());
  // Wraps the StatementAnalyzer + LiveRates row so the inline
  // "Analyze Another Mortgage Statement" button in the Loan Dashboard
  // header can scroll it into view.
  const analyzerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const unsub = subscribePersistenceError(e => {
      if (e.table !== "tracked_loans") return;
      const sig = e.message;
      if (warnedMissingRef.current.has(sig)) return;
      warnedMissingRef.current.add(sig);
      toast({
        title: "Refinance didn't fully save",
        description: e.message,
        variant: "destructive",
      });
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wrap setter so any update also persists to Supabase via the auth helper.
  // We surface tracked_loans persistence failures via toast so the user
  // knows when (e.g.) a loan type change didn't actually save — silent
  // .catch() previously hid schema errors and made loan type appear to
  // "revert" on refresh.
  function updateLoans(updater: TrackedLoan[] | ((prev: TrackedLoan[]) => TrackedLoan[])) {
    setTrackedLoansState(prev => {
      const next = typeof updater === "function" ? (updater as (p: TrackedLoan[]) => TrackedLoan[])(prev) : updater;
      if (!getSession()) return next;
      saveTrackedLoans(next).catch((e: any) => {
        toast({
          title: "Refinance change didn't save",
          description: e?.message || "We'll keep your change on screen, but it didn't reach Supabase.",
          variant: "destructive",
        });
      });
      return next;
    });
  }
  const [showZillowLookup, setShowZillowLookup] = useState(false);

  // Refinance only needs estimatedHomeValue from Zillow — the rest of the
  // tracked loan (rate, P&I, balance) still comes from the user's statement.
  function handleZillowApply(p: LookedUpProperty) {
    const homeValue = p.estimatedHomeValue ?? p.zestimate ?? p.listingPrice;
    if (!homeValue || !p.address) {
      toast({ title: "No home value found", description: "Zillow didn't return a valuation for this property.", variant: "destructive" });
      return;
    }
    const key = p.address.trim().toLowerCase();
    const matchCount = trackedLoans.filter(l => l.propertyAddress.trim().toLowerCase() === key).length;
    if (matchCount === 0) {
      // No-op silently is confusing — tell the user why nothing changed.
      toast({
        title: `Zestimate: $${homeValue.toLocaleString()}`,
        description: "Add a tracked loan for this address first (upload your statement), then run the Zillow lookup again to update its home value.",
      });
      return;
    }
    const editableCount = trackedLoans.filter(l =>
      l.propertyAddress.trim().toLowerCase() === key
      && !isCdPurchasePriceLocked(l)
    ).length;
    updateLoans(prev => prev.map(l =>
      l.propertyAddress.trim().toLowerCase() === key && !isCdPurchasePriceLocked(l)
        ? { ...l, estimatedHomeValue: homeValue }
        : l
    ));
    if (editableCount === 0) {
      toast({
        title: "Closing Disclosure value kept",
        description: "This loan uses the CD purchase price as its assumed appraised value. Use the pencil edit if you need to override it.",
      });
      return;
    }
    toast({ title: "Home value updated", description: `${editableCount} loan${editableCount > 1 ? "s" : ""} updated to $${homeValue.toLocaleString()}.` });
  }
  // Property type dialog state
  const [pendingAnalysis, setPendingAnalysis] = useState<MortgageAnalysis | null>(null);
  // Extra tracked-loan fields carried alongside the pending analysis
  // (entry method, origination details from the CD / manual flows).
  const [pendingExtras, setPendingExtras] = useState<Partial<TrackedLoan> | null>(null);
  const [showPropertyTypeDialog, setShowPropertyTypeDialog] = useState(false);
  // Which of the 4 entry options is showing in the analyzer slot.
  const [entryMethod, setEntryMethod] = useAnonymousDraft<EntryMethod>("entryMethod", user ? "statement" : "manual");

  // Single Refinance-wide credit score input. Seeded from the first
  // tracked loan that already has one (so refresh/logout/login restores
  // the value the user previously typed). Falls back to 740.
  // Editing it writes to EVERY tracked loan's creditScore — per spec
  // "use the saved credit score for the relevant refinance scenario".
  // We never overwrite a saved value with blank/null.
  const initialCreditScore =
    trackedLoans.find(l => typeof l.creditScore === "number" && l.creditScore > 0)?.creditScore
    ?? DEFAULT_CREDIT_SCORE;
  const [creditScore, setCreditScore] = useState<number>(initialCreditScore);
  // Keep local input in sync if loans hydrate AFTER first render
  // (e.g. login finishes, Supabase scenarios load).
  useEffect(() => {
    const fromLoans = trackedLoans.find(l => typeof l.creditScore === "number" && l.creditScore > 0)?.creditScore;
    if (fromLoans && fromLoans !== creditScore) setCreditScore(fromLoans);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedLoans.length]);

  // NOTE: Automatic QuoteRUSH pre-warming is disabled. Live carrier
  // quotes now run only when the user explicitly requests them from the
  // Insurance tab's detailed view.

  function handleCreditScoreChange(raw: string) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      // Empty/invalid input — clear UI value but DO NOT wipe saved
      // values on tracked_loans. Per spec: "Do not overwrite credit
      // score with blank/null."
      setCreditScore(0);
      return;
    }
    // Allow free typing: cap the upper bound so the field can't exceed
    // 850, but DO NOT clamp the lower bound here — otherwise typing
    // "6" would jump to 300 and block entry of "678". Only fan-out to
    // tracked loans (autosave) when the value is in the valid range.
    const display = Math.min(850, n);
    setCreditScore(display);
    if (display >= 300) {
      updateLoans(prev => prev.map(l => ({ ...l, creditScore: display })));
    }
  }

  // On blur, snap a partial entry (e.g. "67") up to the 300 floor and
  // persist. Empty/zero is left alone per "do not overwrite with blank".
  function handleCreditScoreBlur() {
    if (creditScore > 0 && creditScore < 300) {
      setCreditScore(300);
      updateLoans(prev => prev.map(l => ({ ...l, creditScore: 300 })));
    }
  }

  const { data: ratesData } = useQuery<LiveRatesResponse>({
    queryKey: ["/api/rates"],
    staleTime: 15 * 60 * 1000,
  });

  // PostHog: dedupe refinance scenario_calculated by property address so
  // re-uploading or re-analyzing the same statement doesn't double-count.
  const phRefinanceCalcFiredRef = useRef<Set<string>>(new Set());
  const handleAnalysisComplete = (analysis: MortgageAnalysis) => {
    setStatementData(analysis);
    const key = (analysis.propertyAddress || "").trim().toLowerCase();
    if (key && !phRefinanceCalcFiredRef.current.has(key)) {
      phRefinanceCalcFiredRef.current.add(key);
      trackEvent("scenario_calculated", { type: "refinance" });
    }
  };

  const handleAnalyzed = async (analysis: MortgageAnalysis, extras?: Partial<TrackedLoan>) => {
    if (!await authorize("refinance", analysis.propertyAddress || address)) return;
    if (trackedLoans.length >= MAX_TRACKED_LOANS) return;
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const incoming = normalize(analysis.propertyAddress || "");
    const duplicate = trackedLoans.find(l => normalize(l.propertyAddress) === incoming);
    if (duplicate) {
      // Re-uploading a statement for an already-tracked property: don't
      // create a second row, but DO refresh the saved loan number when the
      // new statement contains one. Never overwrite an existing loan
      // number with blank/null.
      const refreshed = mergeStatementRefresh(duplicate, analysis);
      const loanNumberChanged = refreshed.loanNumber !== duplicate.loanNumber;
      const escrowBalanceChanged = refreshed.currentEscrowBalance !== duplicate.currentEscrowBalance;
      if (loanNumberChanged || escrowBalanceChanged) {
        updateLoans(prev => prev.map(l =>
          l.id === duplicate.id ? mergeStatementRefresh(l, analysis) : l
        ));
        toast({
          title: "Loan details updated",
          description: `Updated statement details for ${duplicate.propertyAddress}.`,
        });
      }
      // Re-uploading a statement for the same property: still try to
      // backfill the matching seller scenario in case the statement
      // carried a fresher loan balance / home value. The helper's
      // blank-only rule guarantees we never clobber a user edit.
      const refreshedForSeller: TrackedLoan = {
        ...refreshed,
        loanBalance: analysis.loanBalance || duplicate.loanBalance,
        estimatedHomeValue: analysis.estimatedHomeValue || duplicate.estimatedHomeValue,
      };
      syncSellerFromRefinance(refreshedForSeller);
      return;
    }
    // Government-backed loans (VA/FHA — and USDA if ever added) can only
    // be on a primary residence, so skip the occupancy question and
    // commit directly as primary. Everything else asks primary /
    // secondary / investment.
    if (extras?.loanType === "va" || extras?.loanType === "fha") {
      const newLoan = analysisToTrackedLoan(
        analysis, "primary", creditScore || DEFAULT_CREDIT_SCORE, extras,
      );
      await commitNewLoan(newLoan);
      return;
    }
    // Show property type dialog before adding to tracker
    setPendingAnalysis(analysis);
    setPendingExtras(extras ?? null);
    setShowPropertyTypeDialog(true);
  };

  const handlePropertyTypeSelect = async (propertyType: PropertyType) => {
    if (!pendingAnalysis) return;
    const newLoan = analysisToTrackedLoan(
      pendingAnalysis, propertyType, creditScore || DEFAULT_CREDIT_SCORE,
      pendingExtras ?? undefined,
    );
    await commitNewLoan(newLoan);
  };

  // Shared add-loan pipeline: local state → Supabase save (awaited, with
  // toast) → seller mirror → auto Zillow. Used by the occupancy dialog
  // (statement / CD / manual flows) and directly by Free & Clear (which
  // collects occupancy in its own form).
  const commitNewLoan = async (newLoan: TrackedLoan) => {
    if (trackedLoans.length >= MAX_TRACKED_LOANS) return;
    if (!await authorize("refinance", newLoan.propertyAddress)) return;
    const next = [newLoan, ...trackedLoans];
    // Update local state immediately so the loan card renders without
    // waiting for Supabase. We don't go through updateLoans() here
    // because we want to await the save and surface a success/error
    // toast — updateLoans is fire-and-forget.
    setTrackedLoansState(next);
    setPendingAnalysis(null);
    setPendingExtras(null);
    setShowPropertyTypeDialog(false);
    if (!getSession()) {
      toast({ title: "Your refinance estimate is ready", description: "Your draft stays on this device. Create an account to save or send it." });
      return;
    }
    // Persist to tracked_loans FIRST. The schema-safe upsert in auth.ts
    // strips any missing optional columns automatically. We only mirror
    // into Sell-Your-Home and trigger Zillow AFTER the refi save
    // succeeds — otherwise a transient Supabase failure leaves the
    // user with an orphan seller draft and no matching refi row.
    try {
      await confirmAnonymousAccountDraftSaved("refinance", () => saveTrackedLoans(next));
      toast({ title: "Loan saved to your refinance dashboard." });
      // Notify the assigned agent (non-blocking, fire-and-forget).
      notifyNewScenario("Refinance", newLoan.propertyAddress, "Saved a refinance scenario");
      trackEvent("scenario_saved", { type: "refinance" });
    } catch (e: any) {
      toast({
        title: "Couldn't save your loan",
        description: e?.message || "Please try again in a moment.",
        variant: "destructive",
      });
      return;
    }
    // Mirror the freshly tracked loan into a Sell-Your-Home draft so
    // the same property shows up in both dashboard tabs. Helper's
    // source-based merge rule + normalizedPropertyKey dedup guarantee
    // no duplicate seller_scenarios row.
    syncSellerFromRefinance(newLoan);
    // Auto-pull Zillow for the newly tracked address. Failures are
    // silent — the loan is still tracked with the statement value as
    // a fallback.
    autoPullZillowForLoan(newLoan).catch(err => {
      console.warn("[refinance] auto Zillow lookup failed:", err?.message || err);
    });
  };

  // Bridge: pulls the latest seller scenarios from the auth cache,
  // runs the pure merge helper, and persists only when something
  // actually changed. Kept local so it picks up the freshest scenario
  // list every call (the auth cache is mutated in place after a save).
  function syncSellerFromRefinance(
    loan: TrackedLoan,
    photos?: { primaryPhotoUrl?: string; propertyPhotos?: string[] },
  ) {
    if (!getSession()) return;
    try {
      const result = createOrUpdateSellerScenarioFromRefinance({
        trackedLoan: loan,
        scenarios: getSellerScenarios(),
        photos,
      });
      if (result?.changed) {
        saveSellerScenarios(result.scenarios);
      }
    } catch (err: any) {
      // Never let a seller-sync failure break the refinance save —
      // the refinance record is the source of truth and must persist.
      console.warn("[refinance→seller] sync failed:", err?.message || err);
    }
  }

  // Background Zillow auto-pull for a freshly tracked loan. Keyed by
  // propertyAddress so it only updates the matching loan(s) regardless of
  // array order or later additions.
  async function autoPullZillowForLoan(loan: TrackedLoan) {
    const addr = loan.propertyAddress;
    if (!addr || addr === "Unknown address") return;
    const res = await authedFetch("/api/zillow-property-lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addressOrUrl: addr }),
    });
    if (!res.ok) return;
    const body = await res.json();
    const p = body?.property as LookedUpProperty | undefined;
    if (!p) return;
    const homeValue = p.estimatedHomeValue ?? p.zestimate ?? p.listingPrice;
    if (!homeValue) return;
    const key = addr.trim().toLowerCase();
    // Race guard: this lookup started with a snapshot of `loan`. If
    // the user (or another flow) has edited the home value in the
    // meantime, the Zillow value is stale and must NOT overwrite
    // their edit — even though the seller helper's source rule would
    // also block "manual" later, that protection doesn't apply when
    // the value flowed through the refinance pencil (source stays
    // "refinance"). So we gate on the snapshot here.
    const originalHomeValue = loan.estimatedHomeValue;
    const preserveCdPurchasePrice = isCdPurchasePriceLocked(loan);
    const photos = Array.isArray(p.photos) ? p.photos.filter(Boolean) : [];
    // Resolve the race-guard synchronously from the auth cache. We
    // CANNOT use the React state-updater closure for this because the
    // updater runs later during reconciliation, while
    // syncSellerFromRefinance below needs the resolved value NOW —
    // otherwise the seller_scenarios row gets re-synced with the
    // stale statement value and the Zillow value never reaches it.
    const currentLoans = getTrackedLoans();
    const matched = currentLoans.find(
      l => l.propertyAddress.trim().toLowerCase() === key,
    );
    const userEditedSinceStart =
      !!matched && matched.estimatedHomeValue !== originalHomeValue;
    const finalHomeValue = preserveCdPurchasePrice
      ? originalHomeValue
      : userEditedSinceStart
      ? matched!.estimatedHomeValue
      : homeValue;
    if (!preserveCdPurchasePrice && !userEditedSinceStart) {
      updateLoans(prev => prev.map(l => {
        if (l.propertyAddress.trim().toLowerCase() !== key) return l;
        if (l.estimatedHomeValue !== originalHomeValue) return l;
        return { ...l, estimatedHomeValue: homeValue };
      }));
    }
    syncSellerFromRefinance(
      { ...loan, estimatedHomeValue: finalHomeValue },
      {
        primaryPhotoUrl: photos[0],
        propertyPhotos: photos.length > 0 ? photos.slice(0, 8) : undefined,
      },
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-[73px] z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4 h-14 flex items-center gap-4">
          {/* Back routing matches Cash Buy / Seller / Purchase: a
              logged-in user is always inside a dashboard scenario, so
              Back returns to Dashboard → Refinance tab. Only the
              logged-out flow (entered via the six-service picker)
              should land back on /select-service. */}
          <button
            onClick={() => {
              if (isAuthenticated) {
                setLocation("/dashboard?tab=refinance");
              } else {
                setLocation(
                  address
                    ? `/select-service?address=${encodeURIComponent(address)}`
                    : "/select-service"
                );
              }
            }}
            className="text-muted-foreground hover:text-primary transition-colors"
            aria-label={isAuthenticated ? "Back to Refinance dashboard" : "Back to Services"}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <Home className="h-6 w-6 text-primary" />
            <h1 className="text-lg font-semibold">Refinance Calculator</h1>
          </div>
          {address && <span className="text-sm text-muted-foreground hidden sm:block">· {address}</span>}
          {/* Share + Save Scenario — auth-gated. Save persists all
              tracked loans for the current address into
              `tracked_loans` and awaits the Supabase write so the
              success toast only fires after the row(s) actually
              save. (The page also auto-saves on edit via
              updateLoans, but the explicit Save guarantees a
              confirmed round-trip.) */}
          <div className="ml-auto">
            <ScenarioActions
              scenarioType="refinance"
              getPdfData={() => {
                const matched = trackedLoans.filter(
                  l =>
                    !address ||
                    (l.propertyAddress ?? "").trim().toLowerCase() ===
                      address.trim().toLowerCase(),
                );
                const list = matched.length > 0 ? matched : trackedLoans;
                if (list.length === 0) return null;
                const pdfAddress = address || list[0].propertyAddress || "";
                if (!pdfAddress.trim()) return null;
                const fmtUsd = (n: number) =>
                  new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                    maximumFractionDigits: 0,
                  }).format(n || 0);
                const sections = list.map((loan, i) => {
                  const homeValue = loan.estimatedHomeValue ?? 0;
                  const balance = loan.loanBalance ?? 0;
                  const ltv = homeValue > 0 ? (balance / homeValue) * 100 : 0;
                  return {
                    heading:
                      list.length > 1
                        ? `Loan ${i + 1}${loan.lender ? ` — ${loan.lender}` : ""}`
                        : "Current Loan",
                    rows: [
                      { label: "Estimated home value", value: fmtUsd(homeValue) },
                      { label: "Current loan balance", value: fmtUsd(balance) },
                      { label: "Current monthly payment", value: fmtUsd(loan.monthlyPayment ?? 0) },
                      { label: "Current principal & interest", value: fmtUsd(loan.currentPI ?? 0) },
                      { label: "Current interest rate", value: `${(loan.currentRate ?? 0).toFixed(3)}%` },
                      { label: "Current loan-to-value (LTV)", value: `${ltv.toFixed(1)}%` },
                    ],
                  };
                });
                return {
                  address: pdfAddress,
                  sections,
                  disclaimer:
                    "These are estimates only based on your uploaded statement, regional data, and standard assumptions. New-loan rates, terms, and savings shown on screen are illustrative and subject to credit approval and market conditions. Not a binding quote or commitment to lend.",
                };
              }}
              onSave={async () => {
                if (trackedLoans.length === 0) {
                  throw new Error(
                    "Upload your mortgage statement first to create a refinance scenario."
                  );
                }
                // Persist the current full set — saveTrackedLoans
                // mirrors auth.ts auto-save semantics (delete-then-
                // upsert) and now throws on Supabase error.
                await confirmAnonymousAccountDraftSaved("refinance", () => saveTrackedLoans(trackedLoans));
              }}
            />
          </div>
          {/* "Pull from Zillow" is now auto-run after a statement is
              tracked. Button stays available under ?debug=1 for QA. */}
          {debugMode && (
            <div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setShowZillowLookup(true)}
                data-testid="refinance-open-zillow-lookup"
                title="Debug: manually open Zillow lookup"
              >
                <Home className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Pull from Zillow (debug)</span>
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="mb-6">
          <h2 className="text-2xl font-bold mb-2">Calculate Your Mortgage Refinance</h2>
          <p className="text-muted-foreground">Add your loan one of four ways to analyze it and track refinance opportunities.</p>
        </div>

        {/* Entry-method chooser — 4 ways to add a loan */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4" data-testid="selector-entry-method">
          {ENTRY_METHOD_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setEntryMethod(opt.value)}
              data-testid={`btn-entry-${opt.value}`}
              className={`rounded-lg border p-3 text-left transition-colors ${
                entryMethod === opt.value
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:border-primary/50 hover:bg-accent/30"
              }`}
            >
              <p className="font-semibold text-sm">{opt.label}</p>
              <p className="text-xs text-muted-foreground">{opt.description}</p>
            </button>
          ))}
        </div>

        {/* Top row: Analyzer + Rates. The analyzer card is scrolled
            into view by the "Analyze Another Mortgage Statement" button
            in the Loan Dashboard header below. */}
        <div ref={analyzerRef} className="grid lg:grid-cols-3 gap-6 items-stretch mb-6">
          <div className="lg:col-span-2">
            {entryMethod === "statement" && (
              <StatementAnalyzer
                onAnalysisComplete={handleAnalysisComplete}
                onAnalyzed={handleAnalyzed}
                trackedLoanCount={trackedLoans.length}
                maxLoans={MAX_TRACKED_LOANS}
              />
            )}
            {entryMethod === "closing_disclosure" && (
              <ClosingDisclosureAnalyzer
                onAnalyzed={(analysis, extras) => {
                  handleAnalysisComplete(analysis);
                  handleAnalyzed(analysis, extras);
                }}
              />
            )}
            {entryMethod === "manual" && (
              <ManualLoanEntry
                onAnalyzed={(analysis, extras) => {
                  handleAnalysisComplete(analysis);
                  handleAnalyzed(analysis, extras);
                }}
              />
            )}
            {entryMethod === "free_and_clear" && (
              <FreeClearEntry
                creditScore={creditScore || DEFAULT_CREDIT_SCORE}
                onCreateLoan={loan => {
                  // Dedup by address like handleAnalyzed does.
                  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
                  const duplicate = trackedLoans.find(
                    l => normalize(l.propertyAddress) === normalize(loan.propertyAddress),
                  );
                  if (duplicate) {
                    toast({
                      title: "Property already tracked",
                      description: `${duplicate.propertyAddress} is already on your refinance dashboard.`,
                      variant: "destructive",
                    });
                    return;
                  }
                  commitNewLoan(loan);
                }}
              />
            )}
          </div>
          <LiveRatesCard
            onSelectRate={() => {}}
            selectedRate={6.65}
            className="h-full"
          />
        </div>

        {/* Loan Tracker — the Credit Score input and Analyze-Another
            trigger now live inline in this header (used to be in the
            top-right of the page header). */}
        <LoanTracker
          loans={trackedLoans}
          liveRates={ratesData?.rates ?? []}
          creditScore={creditScore}
          onCreditScoreChange={handleCreditScoreChange}
          onCreditScoreBlur={handleCreditScoreBlur}
          allowPerLoanCreditScore={(user?.email || "").trim().toLowerCase().endsWith("@tateoco.com")}
          showDtiCheck={!(user?.email || "").trim().toLowerCase().endsWith("@tateoco.com")}
          onAnalyzeAnotherClick={() => {
            analyzerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          onRemove={id => updateLoans(prev => prev.filter(l => l.id !== id))}
          onUpdate={async (id, updates) => {
            if (updates.propertyAddress && !await authorize("refinance", updates.propertyAddress)) return;
            updateLoans(prev => {
              const next = prev.map(l => l.id === id ? { ...l, ...updates } : l);
              // If this edit touched a value that maps into Sell-Your-Home
              // (home value / loan balance), mirror it to the matching
              // seller scenario. The helper's source-based rule protects
              // any manual seller edits.
              if ("estimatedHomeValue" in updates || "loanBalance" in updates) {
                const updatedLoan = next.find(l => l.id === id);
                if (updatedLoan) syncSellerFromRefinance(updatedLoan);
              }
              return next;
            });
          }}
          maxLoans={MAX_TRACKED_LOANS}
        />
      </main>

      <PropertyLookupDialog
        open={showZillowLookup}
        onOpenChange={setShowZillowLookup}
        initialAddressOrUrl={address}
        applyLabel="Update home value"
        onApply={handleZillowApply}
      />

      <footer className="border-t mt-12 py-6">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>This calculator provides estimates only. Actual rates and terms may vary. Consult with a licensed mortgage professional for personalized advice.</p>
        </div>
      </footer>

      {/* Property type dialog */}
      <Dialog open={showPropertyTypeDialog} onOpenChange={open => { if (!open) { setShowPropertyTypeDialog(false); setPendingAnalysis(null); setPendingExtras(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>What type of property is this?</DialogTitle>
            <DialogDescription>
              {pendingAnalysis?.propertyAddress
                ? `Select the occupancy type for ${pendingAnalysis.propertyAddress}.`
                : "Select the occupancy type for this property."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 pt-2">
            {PROPERTY_OPTIONS.map(({ type, label, description, icon }) => (
              <button
                key={type}
                onClick={() => handlePropertyTypeSelect(type)}
                className="flex items-center gap-4 w-full rounded-lg border p-4 text-left transition-colors hover:bg-accent hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <div className="text-primary shrink-0">{icon}</div>
                <div>
                  <p className="font-semibold text-sm">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
