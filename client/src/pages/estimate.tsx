import { useMemo, useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import ScenarioActions from "@/components/scenario-actions";
import { useQuoteAccess } from "@/context/quote-access-context";
import { useAnonymousDraft, useAnonymousAccountDraft } from "@/hooks/use-anonymous-draft";
import { confirmAnonymousAccountDraftSaved } from "@/lib/anonymous-account-draft";
import { useQuickPropertyTax } from "@/hooks/use-quick-property-tax";
import { PropertyTaxRow } from "@/components/property-tax-row";
import { officialTaxRequestKey, resolvePurchasePropertyTaxSource } from "@/lib/official-property-tax";
import {MortgageCompliance} from "@/components/mortgage-compliance";
import { buildScenarioFileName } from "@/lib/scenario-pdf";
import { getCountyName } from "@/lib/county-tax-estimator";
import { getConventionalAmiRateDiscount } from "@/lib/ami-discount";
import { buildFeeWorksheet, money as feeMoney, type FeeSection } from "@/lib/fee-worksheet";
import { formatAprParenthetical } from "@/lib/apr-disclosure";
import {
  calculateDiscountPointsCost,
  DISCOUNT_POINTS_STEPS,
  getDiscountPointsRateReduction,
  snapDiscountPoints,
} from "@/lib/discount-points";
import {
  resolvePurchaseLenderInfo,
  type PurchaseLenderInfo,
} from "@/lib/lender-info";
import {
  buildInitialFeesWorksheetFileName,
  createInitialFeesWorksheetPdfBlob,
  type InitialFeesWorksheetPdfMeta,
} from "@/lib/ifw-pdf";
import { checkLoanLimit, canDowngradeFromJumbo, CONFORMING_LOAN_LIMIT_2026, FHA_FLOOR_LIMIT_2026 } from "@/lib/loan-limits";
import { FeeWorksheetDialog } from "@/components/fee-worksheet-dialog";
import { useQuery } from "@tanstack/react-query";
import { useSearch, useLocation } from "wouter";
import { Helmet } from "react-helmet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import {
  Home,
  Building2,
  Shield,
  UserCheck,
  ArrowLeft,
  Save,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  XCircle,
  AlertCircle,
  DollarSign,
  Pencil,
  MapPin,
  Plus,
  X,
  FileDown,
  Info,
  AlertTriangle,
  Minus,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  ClipboardList,
  LayoutDashboard,
  Loader2,
  Camera,
} from "lucide-react";
import {
  Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext,
} from "@/components/ui/carousel";
import { getSession, getPurchaseScenarios, savePurchaseScenarios } from "@/lib/auth";
import { trackEvent } from "@/lib/posthog";
import { getStoredReferralSource } from "@/components/referral-source-dialog";
import {
  calculateDefaultHomeownersInsurance,
  getBaselineHomeownersInsuranceRate,
} from "@/lib/insurance-default";
import { getDefaultInsurancePolicyType } from "@/lib/insurance-policy-type";
import { useAuth } from "@/context/auth-context";
import { apiRequest } from "@/lib/queryClient";
import { ScheduleShowingButton } from "@/components/ui/schedule-showing-button";
import PropertyLookupDialog, { type LookedUpProperty } from "@/components/property-lookup-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGooglePlaces } from "@/hooks/use-google-places";
import { scrollToTop } from "@/lib/scroll";
import LeadCaptureDialog from "@/components/ui/lead-capture-dialog";
import { useToast } from "@/hooks/use-toast";
import { authedFetch } from "@/lib/authed-fetch";
import { jsPDF } from "jspdf";
import { InsuranceEstimateForm, type InsurancePolicyType, type ResidenceUse, type RentalTerm } from "@/components/insurance/insurance-estimate-form";
import {
  effectiveAnnualFloodInsurance,
  FLOOD_HOA_ASSUMPTION_NOTE,
  suppressSeparateFloodInsurance,
} from "@shared/flood-insurance-policy";

// ─── Calculation helpers ────────────────────────────────────────────────────

function calcPI(loanAmount: number, annualRate: number, termMonths = 360): number {
  if (loanAmount <= 0 || annualRate <= 0) return 0;
  const r = annualRate / 12;
  return loanAmount * (r * Math.pow(1 + r, termMonths)) / (Math.pow(1 + r, termMonths) - 1);
}

/** Minimum FICO required for a Conventional loan. Below this, the loan
 *  type is not offered (Fannie/Freddie won't price it). */
const CONVENTIONAL_MIN_FICO = 620;
/** Hard cap on the down-payment percentage selectable in either the
 *  Page 3 Loan Details slider or the Page 4 See My Estimate slider.
 *  Above this, the loan amount drops below 25% LTV which the
 *  downstream pricing/qualification logic isn't designed for. */
const MAX_DOWN_PAYMENT_PCT = 75;
/** Clamp a down-payment percentage into the valid window. Used by
 *  every code path that mutates `inputs.downPaymentPct` so a stale
 *  >75 value from a saved scenario can never resurface after the
 *  user changes loan type / occupancy / mortgage-status. */
function clampDownPaymentPct(pct: number, min: number): number {
  return Math.min(Math.max(pct, min), MAX_DOWN_PAYMENT_PCT);
}

/** Conventional PMI — credit-keyed annual factor, applied uniformly
 *  across LTV bands (per current pricing matrix). Returns monthly PMI
 *  dollars; $0 when LTV ≤ 80% or when the score is below the program
 *  minimum (in which case Conventional shouldn't be selectable anyway). */
function calcConventionalPMI(loanAmount: number, purchasePrice: number, creditScore: number): number {
  const ltv = loanAmount / purchasePrice;
  if (ltv <= 0.8) return 0;
  if (creditScore < CONVENTIONAL_MIN_FICO) return 0;
  let annualFactor: number;
  if      (creditScore >= 760) annualFactor = 0.0019;
  else if (creditScore >= 740) annualFactor = 0.0029;
  else if (creditScore >= 720) annualFactor = 0.0036;
  else if (creditScore >= 700) annualFactor = 0.0045;
  else if (creditScore >= 680) annualFactor = 0.0061;
  else if (creditScore >= 660) annualFactor = 0.0098;
  else if (creditScore >= 640) annualFactor = 0.0104;
  else                         annualFactor = 0.0117; // 620–639
  return (loanAmount * annualFactor) / 12;
}

function calcFHAMIP(loanAmount: number): number {
  return (loanAmount * 0.0055) / 12;
}

function calcVAFundingFeeAmt(baseLoan: number, vaDisability: boolean | null, vaLoanUse: "first" | "second" | null): number {
  if (vaDisability === true) return 0;
  const rate = vaLoanUse === "second" ? 0.033 : 0.0215;
  return Math.round(baseLoan * rate * 100) / 100;
}

function getMaxSellerConcessions(
  loanType: "conventional" | "jumbo" | "fha" | "va" | "usda" | "dscr" | "bank_statement",
  occupancy: "primary" | "secondary" | "investment",
  downPaymentPct: number,
  purchasePrice: number,
): number {
  if (loanType === "fha" || loanType === "usda") return purchasePrice * 0.06;
  if (loanType === "va") return purchasePrice * 0.04;
  // DSCR is investment-only by program rules, so it always uses the
  // conventional investment cap (2%) regardless of the selected
  // occupancy in the UI.
  if (loanType === "dscr") return purchasePrice * 0.02;
  // Bank statement follows the conventional table (handled by the
  // conventional branch below — no early return needed).
  // Conventional
  if (occupancy === "secondary" || occupancy === "investment") return purchasePrice * 0.02;
  // Primary conventional
  if (downPaymentPct < 10) return purchasePrice * 0.03;
  if (downPaymentPct < 20) return purchasePrice * 0.06;
  return purchasePrice * 0.09;
}

function getDTILimits(loanType: "conventional" | "jumbo" | "fha" | "va" | "usda" | "dscr" | "bank_statement"): { housingMax: number; totalMax: number } {
  switch (loanType) {
    case "fha":           return { housingMax: 0.47, totalMax: 0.57 };
    case "usda":          return { housingMax: 0.36, totalMax: 0.43 };
    case "va":            return { housingMax: Infinity, totalMax: Infinity };
    case "dscr":          return { housingMax: Infinity, totalMax: Infinity };
    case "bank_statement":return { housingMax: Infinity, totalMax: Infinity };
    default:              return { housingMax: 0.45, totalMax: 0.50 };
  }
}

// Qualification thresholds — the buyer "Likely Qualifies" (green) only when
// BOTH housing DTI and total DTI are strictly below these per-loan-type
// values; otherwise the estimate flags "Needs Review" (red). These are the
// underwriting-guideline targets used purely to color the qualification
// status (distinct from the hard lender maxes in getDTILimits).
function getQualThresholds(loanType: "conventional" | "jumbo" | "fha" | "va" | "usda" | "dscr" | "bank_statement"): { housingGreen: number; totalGreen: number } {
  switch (loanType) {
    case "fha":            return { housingGreen: 0.45, totalGreen: 0.53 };
    case "va":             return { housingGreen: 0.40, totalGreen: 0.50 };
    case "usda":           return { housingGreen: 0.35, totalGreen: 0.40 };
    case "dscr":           return { housingGreen: Infinity, totalGreen: Infinity };
    case "bank_statement": return { housingGreen: Infinity, totalGreen: Infinity };
    default:               return { housingGreen: 0.43, totalGreen: 0.45 }; // conventional
  }
}

function calcInsuranceEstimate(
  purchasePrice: number,
  impactWindows: boolean,
  roofAttachment: string,
  swr: boolean
): number {
  let base = purchasePrice * 0.0075;
  if (impactWindows) base *= 0.85;
  if (swr) base *= 0.95;
  const roofMultiplier: Record<string, number> = {
    toenails: 1.0,
    clips: 0.92,
    "single-wraps": 0.88,
    "double-wraps": 0.82,
  };
  base *= roofMultiplier[roofAttachment] ?? 1.0;
  return Math.round(base);
}

// ─── Insurance engine ────────────────────────────────────────────────────────

type InsRegionKey = "keys" | "sefl" | "swfl" | "tampa" | "nefljax" | "central" | "ncfl";

const INS_REGIONS: Record<InsRegionKey, { name: string; counties: string; low: number; high: number; tier: string; tierColor: string; note: string }> = {
  keys:    { name: "Keys / Barrier Islands",    counties: "Monroe, barrier islands",                 low: 0.0495, high: 0.0665, tier: "Extreme",  tierColor: "bg-red-100 text-red-800",      note: "Extreme hurricane surge risk. Most major carriers have exited this market." },
  sefl:    { name: "SE FL Coastal",             counties: "Miami-Dade, Broward, Palm Beach",         low: 0.0233, high: 0.0407, tier: "High",     tierColor: "bg-orange-100 text-orange-800", note: "Hurricane exposure and high rebuild costs define this market." },
  swfl:    { name: "SW FL Coastal",             counties: "Lee, Collier, Charlotte, Manatee, Sarasota", low: 0.0134, high: 0.0207, tier: "High",  tierColor: "bg-orange-100 text-orange-800", note: "Post-Hurricane Ian reinsurance pricing continues to elevate rates." },
  tampa:   { name: "Tampa Bay Area",            counties: "Hillsborough, Pinellas, Pasco",           low: 0.0110, high: 0.0170, tier: "Mod-High", tierColor: "bg-yellow-100 text-yellow-800",  note: "Growing storm risk recognition and significant flood zone coverage push rates above Central FL." },
  nefljax: { name: "NE FL / Jacksonville",      counties: "Duval, Clay, St. Johns, Flagler",         low: 0.0080, high: 0.0127, tier: "Moderate", tierColor: "bg-blue-100 text-blue-800",     note: "Moderate coastal exposure with better carrier availability than South Florida." },
  central: { name: "Central FL Inland",         counties: "Orange, Osceola, Polk, Seminole",         low: 0.0078, high: 0.0122, tier: "Moderate", tierColor: "bg-blue-100 text-blue-800",     note: "Good carrier availability and shielded from direct coastal wind." },
  ncfl:    { name: "North-Central FL Inland",   counties: "Alachua, Marion, Sumter, Lake, Columbia", low: 0.0054, high: 0.0080, tier: "Low",      tierColor: "bg-green-100 text-green-800",   note: "Consistently the lowest rates in Florida — 60+ miles from the coast." },
};

const INS_COUNTY_TO_REGION: Record<string, InsRegionKey> = {
  "monroe": "keys",
  "miami-dade": "sefl", "broward": "sefl", "palm beach": "sefl", "st. lucie": "sefl", "martin": "sefl",
  "lee": "swfl", "collier": "swfl", "charlotte": "swfl", "manatee": "swfl", "sarasota": "swfl",
  "hillsborough": "tampa", "pinellas": "tampa", "pasco": "tampa", "hernando": "tampa",
  "duval": "nefljax", "clay": "nefljax", "st. johns": "nefljax", "st johns": "nefljax", "flagler": "nefljax", "nassau": "nefljax",
  "okaloosa": "nefljax", "santa rosa": "nefljax", "escambia": "nefljax",
  "orange": "central", "osceola": "central", "polk": "central", "seminole": "central", "lake": "central", "volusia": "central",
  "brevard": "central", "indian river": "central",
  "alachua": "ncfl", "marion": "ncfl", "sumter": "ncfl", "columbia": "ncfl", "putnam": "ncfl",
  "leon": "ncfl", "gadsden": "ncfl", "wakulla": "ncfl",
};

function getInsRegionFromAddress(address: string): InsRegionKey {
  const county = getCountyName(address);
  if (county && INS_COUNTY_TO_REGION[county]) return INS_COUNTY_TO_REGION[county];
  return "tampa";
}

const INS_ROOF_ADJ  = [0.90, 1.00, 1.20, 1.38];
const INS_WIND_ADJ  = [1.14, 1.00, 0.82];
const INS_HURR_ADJ  = [1.10, 1.05, 1.00];
const INS_CLAIM_ADJ = [1.00, 1.14, 1.26, 1.40];

function validInsuranceYearBuilt(value: unknown): number | null {
  const year = Number(value);
  const currentYear = new Date().getFullYear();
  return Number.isFinite(year) && year >= 1800 && year <= currentYear
    ? Math.round(year)
    : null;
}

function legacyInsuranceYearIndex(yearBuilt: number): number {
  if (yearBuilt >= 2002) return 0;
  if (yearBuilt >= 1990) return 1;
  if (yearBuilt >= 1970) return 2;
  return 3;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Where the current purchasePrice value came from. Used to label the
 *  purchase-price field while Zillow/cache is loading and to keep
 *  user-typed values from being overwritten by background fetches. */
type PurchasePriceSource =
  | "default"
  | "user"
  | "zillow_listing"
  | "zillow_zestimate"
  | "zillow_sold"
  | "zillow_cache";

interface Inputs {
  qualificationInputsConfirmed?:boolean;
  occupancy: "primary" | "secondary" | "investment";
  propertyUseSelected?: boolean;
  purchasePrice: number;
  /** Provenance of `purchasePrice`. Defaults to "default" on a new scenario. */
  purchasePriceSource?: PurchasePriceSource;
  downPaymentPct: number;
  /** UX mode for the down-payment control on Page 3 + Page 4.
   *  "percent" (default): pct is canonical, $ amount is derived
   *  on every render. "amount": $ amount is canonical (stored in
   *  `downPaymentAmount`) and pct is derived. Persisted so the
   *  user's choice survives reload/login and stays in sync with
   *  the Page 3 controls in `pages/mortgage-new.tsx`. */
  downPaymentMode?: "percent" | "amount";
  /** Canonical down-payment dollar amount. Always mirrors
   *  `purchasePrice * downPaymentPct / 100` in "percent" mode and
   *  is the user-edited source of truth in "amount" mode. */
  downPaymentAmount?: number;
  sellerConcessions: number;
  /** UX mode for the seller-concessions control on Page 3. Persisted so
   *  the user's choice survives reload / login. The canonical numeric
   *  value remains `sellerConcessions` in dollars — every downstream
   *  calculation (cash-to-close, summaries, etc.) keeps reading dollars,
   *  so this flag only affects how the Page 3 slider is rendered and
   *  edited. Defaults to "percent" for new scenarios. */
  sellerConcessionsMode?: "percent" | "amount";
  loanType: "conventional" | "jumbo" | "fha" | "va" | "usda" | "dscr" | "bank_statement";
  creditScore: number;
  interestRate: number;
  annualTaxes: number;
  hoaMonthly: number;
  cddAnnual: number;
  annualHOIns: number;
  annualFloodIns: number;
  monthlyDebts: number;
  monthlyIncome: number;
  /** Provenance for `monthlyIncome`. Once the user types a value the
   *  AMI-prefill effect must not overwrite it. See PurchaseScenario
   *  in lib/auth.ts for the persisted column. */
  monthlyIncomeSource?: "manual" | "ami_default" | "default";
  /** Generic per-field provenance map. Persisted to
   *  `purchase_scenarios.user_answer_sources` (jsonb). Only fields that
   *  have other in-app writers need an entry — e.g. `annual_ho_ins`
   *  has a default-sync effect that must skip "manual"/"simulator". */
  userAnswerSources?: Record<string, string>;
  reserves: number;
  impactWindows: boolean;
  roofAttachment: string;
  swr: boolean;
  hasMortgage: boolean | null;
  isVeteran: boolean | null;
  vaDisability: boolean | null;
  /** Follow-up to `vaDisability === true`: is the rating 100%?
   *  Strictly boolean — there is no "not sure" / unknown state. When the
   *  user has not answered (or has not been asked because they don't
   *  receive VA disability), this is null. A `true` value combined with
   *  `occupancy === "primary"` may qualify for an exemption. Tax amounts
   *  still require official data or an explicitly manual bill. */
  vaDisabilityRating100: boolean | null;
  vaLoanUse: "first" | "second" | null;
  currentLoanFHA: boolean | null;
  hasRentalIncome: boolean | null;
  monthlyRentalIncome: number;
  rentalType: "annual" | "short-term" | null;
  /** Page-3 "Property Type" dropdown value (e.g. "Single Family Residence",
   *  "Townhouse", "Condominium"). Defaults to "Single Family Residence". */
  propertyType?: string;
  /** Where `propertyType` came from. Once "manual", a later Zillow
   *  scrape must NOT overwrite it. */
  propertyTypeSource?: "manual" | "zillow" | "default";
  /** Page-2 Additional Info: does the borrower have deferred student
   *  loans? When true, the balance below feeds an assumed monthly DTI
   *  payment. Defaults to false (controlled Yes/No buttons). */
  hasDeferredStudentLoans?: boolean;
  /** Total deferred student loan balance in dollars (Page 2). Used to
   *  derive a monthly DTI add-on via `deferredStudentLoanFactor(loanType)`.
   *  Preserved when the user toggles "No" so they can flip back without
   *  retyping; the calc only uses it when `hasDeferredStudentLoans === true`. */
  deferredStudentLoanBalance?: number;
  /** Page 4 Discount Points buydown. Percent of the base loan amount
   *  the buyer pays up-front to reduce the interest rate. Allowed
   *  steps: 0 / 0.5 / 1 / 1.5 / 2 / 2.5 / 3. Default 0. Off-grid
   *  values are snapped to the nearest 0.5 increment on write. */
  discountPointsPct: number;
  /** FHA Down Payment Assistance (DPA). Only asked/applied when
   *  `loanType === "fha"`. null = not answered yet. Answers are
   *  mirrored into `userAnswerSources` (dpa_enabled / dpa_pct /
   *  dpa_second) so they persist without a schema migration. */
  dpaEnabled?: boolean | null;
  /** DPA program size as % of purchase price. 3.5% covers the full
   *  FHA down payment; 5% covers the down payment (3.5%) plus 1.5%
   *  of the purchase price toward closing costs. */
  dpaPct?: 3.5 | 5 | null;
  /** How the DPA second lien is structured:
   *  - "amortizing": fully amortizing 2nd repaid over 10 years at
   *    (final first-mortgage rate + 2%).
   *  - "silent": no payments; borrower must keep the home 10 years
   *    and owes the full amount back on refinance. */
  dpaSecondType?: "amortizing" | "silent" | null;
}

/** Enforce the property-type flood policy at every state-boundary where a
 * scenario can be selected, restored, or updated asynchronously. Calculations
 * also apply the policy independently, so a stale snapshot can never flash a
 * flood charge before React state catches up. */
function enforceFloodInsurancePolicy(inputs: Inputs): Inputs {
  const annualFloodIns = effectiveAnnualFloodInsurance(
    inputs.propertyType,
    inputs.annualFloodIns,
  );
  return annualFloodIns === inputs.annualFloodIns
    ? inputs
    : { ...inputs, annualFloodIns };
}


/** Lender-side DTI assumption for deferred student loans. Conventional
 *  (and Bank Statement, when it uses DTI) assumes 1% of the deferred
 *  balance per month; FHA/VA/USDA assume 0.5%. DSCR is income-less so
 *  the add-on is skipped entirely. */
function deferredStudentLoanFactor(
  loanType: "conventional" | "jumbo" | "fha" | "va" | "usda" | "dscr" | "bank_statement",
): number {
  switch (loanType) {
    case "conventional":
    case "jumbo":
    case "bank_statement":
      return 0.01;
    case "fha":
    case "va":
    case "usda":
      return 0.005;
    case "dscr":
    default:
      return 0;
  }
}

// Canonical Page-3 Property Type dropdown options + Zillow normalizer.
// Kept local to this file since Page 3 is the only consumer for now.
const PROPERTY_TYPE_OPTIONS = [
  "Single Family Residence",
  "Townhouse",
  "Condominium",
  "Villa",
  "Manufactured Home",
  "Multi-Family",
  "Duplex",
  "Triplex",
  "Quadplex",
  "Land",
  "Other",
] as const;

function zillowToDropdownPropertyType(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return null;
  if (s.includes("QUAD") || s.includes("FOURPLEX")) return "Quadplex";
  if (s.includes("TRIPLEX")) return "Triplex";
  if (s.includes("DUPLEX")) return "Duplex";
  if (s.includes("MULTI")) return "Multi-Family";
  if (s.includes("TOWN")) return "Townhouse";
  if (s.includes("CONDO") || s === "APARTMENT") return "Condominium";
  if (s.includes("VILLA")) return "Villa";
  if (s.includes("MANUFACTURED") || s.includes("MOBILE")) return "Manufactured Home";
  if (s.includes("LAND") || s.includes("LOT")) return "Land";
  if (s.includes("SINGLE") || s.includes("SFR") || s.includes("HOUSE")) {
    return "Single Family Residence";
  }
  return null;
}

const FALLBACK_RATES = { conventional: 6.82, jumbo: 6.82, fha: 6.17, va: 6.25, usda: 6.38, dscr: 6.82, bank_statement: 6.82 };

interface PlaceMeta {
  placeId?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  county?: string;
  lat?: number;
  lng?: number;
}

interface Scenario {
  id: string;
  address: string;
  savedInputs: Inputs | null;
  placeMeta?: PlaceMeta;
  /** Per-scenario dashboard auto-save status. "idle" means no pending
   *  change. "saving" is set while the debounced auto-save effect is
   *  about to write. "saved" is set right after a successful write
   *  (auto-clears to "idle" after a short delay). "error" stays sticky
   *  until the next successful save. Per-id so saves on one tab never
   *  leak a "Saving…" label onto another tab. */
  saveStatus?: "idle" | "saving" | "saved" | "error";
  /** Status of the background Zillow/cache lookup for this scenario.
   *  - "loading":            request in flight (cache check or scrape).
   *  - "loaded_from_cache":  served from Supabase property_cache.
   *  - "loaded_from_zillow": fresh Apify scrape applied.
   *  - "error":              lookup failed; defaults remain in use.
   *  Legacy values ("applied"/"unavailable") are kept as aliases so older
   *  code paths and any persisted state still render correctly. */
  zillowStatus?:
    | "loading"
    | "applied"
    | "unavailable"
    | "loaded_from_cache"
    | "loaded_from_zillow"
    | "error";
  /**
   * Snapshot of the inputs we auto-populated when this scenario was first
   * created (defaults / carried-over values). When the Zillow scrape
   * returns, a field is only overwritten if its current value still equals
   * the baseline — i.e., the user hasn't manually touched it.
   */
  baselineInputs?: Inputs;
  /** Property photos fetched from the Zillow/cache lookup for this scenario. */
  propertyPhotos?: string[];
  /** Primary (hero) photo URL for the property, when available. */
  primaryPhotoUrl?: string;
}

function makeDefaultInputs(price = 350000): Inputs {
  return {
    occupancy: "primary", purchasePrice: price, purchasePriceSource: "default", downPaymentPct: 5, downPaymentMode: "percent", downPaymentAmount: Math.round(price * 0.05), sellerConcessions: 0, sellerConcessionsMode: "percent",
    propertyType: "Single Family Residence", propertyTypeSource: "default",
    hasDeferredStudentLoans: false, deferredStudentLoanBalance: 0,
    discountPointsPct: 0,
    dpaEnabled: null, dpaPct: null, dpaSecondType: null,
    loanType: "conventional", creditScore: 780,
    interestRate: FALLBACK_RATES.conventional,
    annualTaxes: 0, hoaMonthly: 0, cddAnnual: 0,
    userAnswerSources: { annual_taxes: "unavailable" },
    annualHOIns: calculateDefaultHomeownersInsurance(price).annualInsurance, annualFloodIns: 2000,
    monthlyDebts: 0, monthlyIncome: 8000, monthlyIncomeSource: "default", reserves: 35000,
    impactWindows: false, roofAttachment: "toenails", swr: false,
    hasMortgage: null, currentLoanFHA: null, hasRentalIncome: null, monthlyRentalIncome: 0, rentalType: null,
    isVeteran: null, vaDisability: null, vaDisabilityRating100: null, vaLoanUse: null,
  };
}

function shortLabel(addr: string): string {
  const parts = addr.split(",")[0].trim().split(" ");
  return parts.slice(0, 3).join(" ");
}

function creditAdjustment(score: number): number {
  if (score >= 780) return -0.10;
  if (score >= 760) return  0;
  if (score >= 740) return  0.05;
  if (score >= 720) return  0.20;
  if (score >= 700) return  0.30;
  if (score >= 680) return  0.55;
  if (score >= 660) return  0.75;
  if (score >= 640) return  1.00;
  return 1.50;
}

function fhaCreditAdjustment(score: number): number {
  if (score >= 740) return -0.350;
  if (score >= 720) return -0.150;
  if (score >= 700) return  0;
  if (score >= 680) return  0.05;
  if (score >= 660) return  0.50;
  if (score >= 640) return  0.900;
  return 1.250;
}

function adjustedRate(base: number, score: number): number {
  return Math.round((base + creditAdjustment(score)) * 1000) / 1000;
}

function occupancyRateAdj(occupancy: "primary" | "secondary" | "investment", downPct: number): number {
  if (occupancy === "secondary") {
    if (downPct < 15)  return 1.50;
    if (downPct < 20)  return 1.00;
    if (downPct < 25)  return 0.75;
    if (downPct < 35)  return 0.50;
    return 0.25;
  }
  if (occupancy === "investment") {
    if (downPct < 25)  return 1.00;
    if (downPct < 30)  return 0.75;
    if (downPct < 35)  return 0.50;
    return 0.25;
  }
  return 0;
}

/** Condo detection for the Conventional condo pricing add-on. Matches
 *  every condo variant (Condo / Condominium / Condo Unit / Attached
 *  Condo / Condominium Unit) case-insensitively — all of them contain
 *  the substring "condo". Townhouse is intentionally NOT matched: the
 *  condo rate add-on applies to condos only. */
function isCondoRateAdjPropertyType(propertyType?: string | null): boolean {
  if (!propertyType) return false;
  return propertyType.toLowerCase().includes("condo");
}

function fullRate(
  base: number,
  score: number,
  occupancy: "primary" | "secondary" | "investment",
  downPct: number,
  loanType?: string,
  monthlyIncome?: number | null,
  annualAMI?: number | null,
  propertyType?: string | null,
  loanAmount?: number | null,
): number {
  // FHA, VA, and USDA share the same credit-score adjustment table
  // (`fhaCreditAdjustment`). Conventional / DSCR / Bank Statement
  // use the separate `creditAdjustment` table.
  const adj = (loanType === "fha" || loanType === "va" || loanType === "usda")
    ? fhaCreditAdjustment(score)
    : creditAdjustment(score);
  let rate = base + adj + occupancyRateAdj(occupancy, downPct);
  // Conventional pricing concession: drop the final rate by 10 bps
  // (0.100%). DSCR shares Conventional's pricing engine per spec
  // ("DSCR should use the same Conventional base rate and pricing
  // adjustments"), so it gets the same -10 bps. FHA / VA / USDA /
  // Bank Statement are untouched. Applied once here in the single
  // rate engine used by Purchase Page 3, Page 4, and every effect
  // that recalculates `inputs.interestRate`, so it can never be
  // double-applied.
  // Jumbo prices identically to Conventional for now (per spec).
  if (loanType === "conventional" || loanType === "jumbo" || loanType === "dscr") rate -= 0.1;
  // AMI-based Conventional rate discount (Primary + Conventional
  // only). Applied AFTER the -0.100% concession per spec. The
  // helper itself gates on loanType / occupancy / AMI presence, so
  // FHA/VA/USDA/DSCR/BankStmt/Secondary/Investment all receive
  // discountPercent === 0. Because every code path that writes
  // `interestRate` goes through this single function, the discount
  // is applied exactly once — Page 3 and Page 4 always agree.
  const amiDiscount = getConventionalAmiRateDiscount({
    monthlyIncome: monthlyIncome ?? undefined,
    annualAMI: annualAMI ?? undefined,
    loanType,
    occupancy,
  });
  rate -= amiDiscount.discountPercent;
  // Conventional condo pricing add-on: +0.300%. Internal only — there
  // is NO user-facing line item, label, tooltip, or explanation for
  // this. Applied AFTER the base rate, credit, occupancy, the -0.100%
  // Conventional concession, and the AMI discount, but BEFORE the
  // discount-points buydown (which runs downstream on the stored
  // `inputs.interestRate`). Gated strictly on Conventional, so FHA /
  // VA / USDA / DSCR / Bank Statement never receive it.
  if ((loanType === "conventional" || loanType === "jumbo") && isCondoRateAdjPropertyType(propertyType)) {
    rate += 0.3;
  }
  if (loanType === "dscr") {
    console.debug("[dscr-pricing] conventional rate used", base);
    console.debug("[dscr-pricing] final DSCR rate", Math.round((rate) * 1000) / 1000);
  }
  if (amiDiscount.eligible) {
    console.debug("[ami-discount] applied", amiDiscount.discountPercent, "incomePctOfAMI=", amiDiscount.incomePercentOfAmi);
  }
  // Round once at the engine boundary so both the payment math and
  // the displayed rate use the same 3-decimal value (avoids
  // 6.774999% style float artifacts).
  // Small loan balance add-on:
  // loans under $250k carry a +0.25%
  // rate increase to offset lower yield.
  if (loanAmount && loanAmount > 0 &&
      loanAmount < 250_000) {
    rate += 0.25;
  }
  return Math.round(rate * 1000) / 1000;
}

// ─── SliderInput component ───────────────────────────────────────────────────

interface SliderInputProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  prefix?: string;
  suffix?: string;
  disabled?: boolean;
  decimals?: number;
  compact?: boolean;
}

function formatWithCommas(n: number, decimals = 0): string {
  if (decimals > 0) return n.toFixed(decimals);
  return Math.round(n).toLocaleString("en-US");
}

function SliderInput({ label, value, onChange, min, max, step = 1, prefix, suffix, disabled, decimals = 0, compact = false }: SliderInputProps) {
  const [text, setText] = useState(formatWithCommas(value, decimals));
  const isFocused = useRef(false);

  // Sync display from parent only when not being edited
  useEffect(() => {
    if (!isFocused.current) {
      setText(formatWithCommas(value, decimals));
    }
  }, [value, decimals]);

  function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
    isFocused.current = true;
    setText(decimals > 0 ? value.toFixed(decimals) : String(Math.round(value)));
    e.target.select();
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setText(raw);
    const n = parseFloat(raw.replace(/,/g, ""));
    if (!isNaN(n)) {
      const rounded = decimals > 0 ? parseFloat(n.toFixed(decimals)) : Math.round(n);
      onChange(Math.min(max, Math.max(min, rounded)));
    }
  }

  function handleBlur() {
    isFocused.current = false;
    const n = parseFloat(text.replace(/,/g, ""));
    if (!isNaN(n)) {
      const rounded = decimals > 0 ? parseFloat(n.toFixed(decimals)) : Math.round(n);
      const clamped = Math.min(max, Math.max(min, rounded));
      onChange(clamped);
      setText(formatWithCommas(clamped, decimals));
    } else {
      setText(formatWithCommas(value, decimals));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  }

  const valueInput = (
    <div className="flex items-center gap-0.5 bg-muted rounded-md px-2 py-1 min-w-[88px] md:justify-end">
      {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
      <input
        className="w-full bg-transparent text-xs font-semibold text-right text-foreground outline-none min-w-0"
        value={text}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        inputMode="decimal"
        disabled={disabled}
      />
      {suffix && <span className="text-xs text-muted-foreground ml-0.5">{suffix}</span>}
    </div>
  );

  if (compact) {
    return (
      <div className={`w-[132px] ${disabled ? "opacity-40 pointer-events-none" : ""}`}>
        {valueInput}
      </div>
    );
  }

  // Standard slider layout (global spec): label on its own row,
  // then a 3fr/1fr grid below with the slider on the left and the
  // editable value pill on the right. Caller can pass label="" to
  // suppress the label row entirely (used by wrappers that already
  // render their own label, e.g. renderSellerConcessions). On
  // mobile we stack value below slider so neither feels cramped.
  return (
    <div className={`space-y-1.5 ${disabled ? "opacity-40 pointer-events-none" : ""}`}>
      {label ? (
        <Label className="text-xs text-muted-foreground">{label}</Label>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-[3fr_1fr] items-center gap-2 md:gap-3">
        <Slider
          className="w-full"
          min={min}
          max={max}
          step={step}
          value={[Math.min(max, Math.max(min, value))]}
          onValueChange={([v]) => onChange(v)}
          disabled={disabled}
        />
        {valueInput}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

/**
 * Wrapper used by the Property Estimate (step 4) summary's pencil/edit
 * buttons. When `editing` is true, the wrapped step Card is rendered inside
 * a Dialog overlay on top of the estimate so the user never leaves step 4
 * or loses their address / Zillow cache / active scenario tab. When false,
 * children pass through unchanged so the questionnaire flow (steps 1-3)
 * renders normally. All form fields inside the wrapped Card continue to
 * bind to the active scenario's `inputs`/`setInputs`, so edits flow
 * through the existing recalculation + debounced auto-save effects with
 * no separate save path.
 */
function StepEditWrapper({
  editing,
  title,
  onClose,
  children,
}: {
  editing: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!editing) return <>{children}</>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
        <Button onClick={onClose} className="w-full mt-2">Done</Button>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Property photo carousel for the Purchase / `/estimate` flow.
 * Mirrors the Cash Buy PhotoCarousel (client/src/pages/cash-buy.tsx)
 * so behaviour stays consistent across surfaces:
 *   - "loading"  → spinner with text
 *   - "loaded" + 0 photos → friendly placeholder (NOT shown while loading)
 *   - 1 photo    → single image
 *   - 2+ photos  → carousel with prev/next arrows
 * Photos are deduped via the primary+rest merge.
 */
function PhotoCarousel({
  photos, primary, status,
}: {
  photos: string[]; primary?: string; status: "idle" | "loading" | "loaded" | "error";
}) {
  const [failedPhotos, setFailedPhotos] = useState<string[]>([]);
  const all = useMemo(() => {
    const list = [primary, ...photos].filter((p): p is string => !!p);
    return Array.from(new Set(list)).filter(src => !failedPhotos.includes(src));
  }, [photos, primary, failedPhotos]);

  if (status === "loading" && all.length === 0) {
    return (
      <div className="rounded-xl border bg-muted/40 aspect-[16/9] flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading property photos…
      </div>
    );
  }
  if (all.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-muted/30 aspect-[16/9] flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
        <Camera className="h-5 w-5" />
        <span>No photos found for this property.</span>
      </div>
    );
  }
  if (all.length === 1) {
    return (
      <div className="rounded-xl overflow-hidden border bg-muted/20">
        <img src={all[0]} alt="Property exterior" onError={() => setFailedPhotos(p => [...p, all[0]])} className="w-full aspect-[16/9] object-cover" />
      </div>
    );
  }
  return (
    <Carousel className="w-full">
      <CarouselContent>
        {all.map((src, i) => (
          <CarouselItem key={`${i}-${src}`}>
            <div className="rounded-xl overflow-hidden border bg-muted/20">
              <img src={src} alt="Property photo" onError={() => setFailedPhotos(p => [...p, src])} className="w-full aspect-[16/9] object-cover" />
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  );
}

export default function Estimate() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(search);
  const address = params.get("address") || "Unknown Address";
  const servicesAll = params.get("services") === "all";
  const fromDashboard = params.get("from") === "dashboard";
  // Debug flag (?debug=1) re-exposes admin-only escape hatches that were
  // removed from the normal user UI now that Zillow auto-pulls and the
  // dashboard auto-saves. Keeps these reachable for QA without polluting
  // the real user flow.
  const debugMode = params.get("debug") === "1";

  const { toast } = useToast();

  // ── Auth & multi-scenario state ─────────────────────────────────────────────
  // SOURCE OF TRUTH: the auth context, which subscribes to Supabase session
  // changes. The previous local `useState` was set only once on mount, and
  // because Supabase session hydration is async, a logged-in user landing
  // here before hydration finished would be treated as a guest forever —
  // which is what caused the lead-capture dialog (with "Who are you working
  // with?") to re-appear when adding a new property estimate.
  const { user: authUser } = useAuth();
  const purchaseLenderInfo = useMemo(
    () => resolvePurchaseLenderInfo(authUser),
    [authUser?.email, authUser?.name],
  );
  // Local-only flag for guests who completed the lead-capture flow but did
  // not create a real account. Persisted across reloads via localStorage.
  const isAuthenticated = !!authUser;
  const { authorize, requireAccount } = useQuoteAccess();
  // Seed scenarios from the user's saved dashboard properties so all of them appear as subtabs
  // when navigating from the dashboard (or anywhere else, for logged-in users).
  const initialScenariosRef = useRef<{ list: Scenario[]; activeId: string; freshSeededId: string | null } | null>(null);
  if (initialScenariosRef.current === null) {
    const fallback = { list: [{ id: "sc0", address, savedInputs: null }], activeId: "sc0", freshSeededId: "sc0" as string | null };
    const hasSession = typeof window !== "undefined"
      && getSession() !== null;
    if (!hasSession) {
      initialScenariosRef.current = fallback;
    } else {
      const saved = getPurchaseScenarios();
      const list: Scenario[] = saved.map(s => ({
        id: `sc_${s.id}`,
        address: s.address,
        savedInputs: null,
        propertyPhotos: s.propertyPhotos,
        primaryPhotoUrl: s.primaryPhotoUrl,
      }));
      const key = address.trim().toLowerCase();
      const match = list.find(s => s.address.trim().toLowerCase() === key);
      if (match) {
        // Reopening a saved property — NOT a fresh URL seed; don't auto-zillow.
        initialScenariosRef.current = { list, activeId: match.id, freshSeededId: null };
      } else if (address && address !== "Unknown Address") {
        // A genuinely-new address arrived via the URL — auto-zillow eligible.
        const newScenario: Scenario = { id: "sc0", address, savedInputs: null };
        initialScenariosRef.current = { list: [newScenario, ...list], activeId: newScenario.id, freshSeededId: newScenario.id };
      } else {
        initialScenariosRef.current = list.length ? { list, activeId: list[0].id, freshSeededId: null } : fallback;
      }
    }
  }
  const [scenarios, setScenarios] = useAnonymousDraft<Scenario[]>("scenarios", initialScenariosRef.current.list);
  const [activeScenarioId, setActiveScenarioId] = useAnonymousDraft("activeScenarioId", initialScenariosRef.current.activeId);

  // Fire a background Zillow lookup once on mount for a new address, or for
  // a saved property whose older record has no photos yet. Saved photos are
  // hydrated above and avoid the request entirely.
  const initialZillowFiredRef = useRef(false);
  const initialDraftSavedRef = useRef(false);
  // PostHog: fire 'scenario_calculated' once per scenario id when the
  // user reaches Page 4 (results). Re-fires for a different scenario.
  const phPurchaseCalcFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (initialZillowFiredRef.current) return;
    const initial = initialScenariosRef.current;
    const targetId = initial?.freshSeededId ?? initial?.activeId;
    if (!targetId) return;
    const active = scenarios.find(s => s.id === targetId);
    if (!active || !active.address || active.address === "Unknown Address") return;
    const hasPhotos = Boolean(
      active.primaryPhotoUrl ||
      active.propertyPhotos?.some(photo => typeof photo === "string" && photo.length > 0),
    );
    const hasYearBuilt =
      validInsuranceYearBuilt(inputs.userAnswerSources?.insurance_year_built) != null;
    if (hasPhotos && hasYearBuilt) return;
    initialZillowFiredRef.current = true;
    baselineByIdRef.current[active.id] = { ...inputs };
    setScenarios(prev =>
      prev.map(s => s.id === active.id && !s.baselineInputs ? { ...s, baselineInputs: { ...inputs } } : s)
    );
    triggerZillowLookup(active.id, active.address);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist a DRAFT purchase scenario for any URL-seeded address as soon as
  // a logged-in session is available. Runs on mount AND re-runs whenever
  // auth hydrates (so a session that becomes available after first paint
  // still saves the draft). Idempotent via `initialDraftSavedRef` + the
  // existing-address dedupe. This is the path exercised by:
  //   Dashboard → Purchase with Loan → Add Property → select address
  //     → setLocation("/estimate?address=X&from=dashboard")
  //     → estimate.tsx mounts here.
  useEffect(() => {
    if (initialDraftSavedRef.current) return;
    const freshId = initialScenariosRef.current?.freshSeededId;
    const active = freshId ? scenarios.find(s => s.id === freshId) : null;
    const sessionId = getSession()?.id ?? null;
    const authed = !!sessionId || isAuthenticated;
    console.debug("[purchase-live-test] authenticated", authed);
    console.debug("[purchase-live-test] auth user id", sessionId);
    console.debug("[purchase-live-test] address selected", active?.address ?? null);
    console.debug("[purchase-live-test] generated scenario id", active?.id ?? null);
    if (!authed) {
      console.debug("[purchase-live-test] save function called", false, "reason: not-authenticated-yet");
      return;
    }
    if (!active || !active.address || active.address === "Unknown Address") {
      console.debug("[purchase-live-test] save function called", false, "reason: no-fresh-active-address");
      return;
    }
    const existingSaved = getPurchaseScenarios();
    const dupKey = active.address.trim().toLowerCase();
    const alreadySaved = existingSaved.some(
      s => s.address.trim().toLowerCase() === dupKey,
    );
    if (alreadySaved) {
      console.debug("[purchase-live-test] save function called", false, "reason: already-saved");
      initialDraftSavedRef.current = true;
      return;
    }
    initialDraftSavedRef.current = true;
    console.debug("[purchase-live-test] save function called", true);
    console.debug("[purchase-live-test] target table", "purchase_scenarios");
    savePurchaseScenarios([
      ...existingSaved,
      { id: active.id, address: active.address, savedAt: new Date().toISOString() },
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authUser]);

  const [showAddressPrompt, setShowAddressPrompt] = useState(false);
  const [showZillowLookup, setShowZillowLookup] = useState(false);

  // Apply Zillow lookup results: update purchase price + HOA on the active
  // scenario; if Zillow returned a different formatted address, navigate so
  // the URL stays the source of truth for `address`.
  async function handleZillowApply(p: LookedUpProperty) {
    if (p.address && !await authorize("purchase", p.address)) return;
    setInputs(prev => ({
      ...prev,
      purchasePrice: p.purchasePrice ?? p.listingPrice ?? p.zestimate ?? prev.purchasePrice,
      purchasePriceSource:
        (p.purchasePrice ?? p.listingPrice ?? p.zestimate) != null
          ? inferPriceSource(p, p.purchasePrice ?? p.listingPrice ?? p.zestimate ?? null, false)
          : prev.purchasePriceSource,
      hoaMonthly: p.hoaMonthly ?? prev.hoaMonthly,
    }));
    if (p.address && p.address.trim().toLowerCase() !== address.trim().toLowerCase()) {
      setLocation(`/estimate?address=${encodeURIComponent(p.address)}`);
    }
  }
  // Addresses we've already fired the background Zillow fetch for in this
  // session — keyed by `${scenarioId}|${normalizedAddress}` so the same
  // address in different scenarios still works, but the same scenario won't
  // double-fetch.
  const zillowFetchedKeysRef = useRef<Set<string>>(new Set());
  // Mirror of activeScenarioId for the async completion path. The async
  // callback may resolve long after the user has switched tabs, so we read
  // the *current* active id from this ref. The ref is updated SYNCHRONOUSLY
  // at every tab-switch site (via `setActive` below) so there is no
  // post-render window where it points at a stale tab.
  const activeScenarioIdRef = useRef(activeScenarioId);
  // Map of scenarioId -> baseline inputs snapshot. Backed by a ref so the
  // async Zillow callback can read the correct baseline without depending
  // on React state-update timing.
  const baselineByIdRef = useRef<Record<string, Inputs>>({});

  // Synchronous setter used at every tab-switch site so the ref always
  // matches the active tab the user is actually looking at.
  function setActive(nextId: string) {
    activeScenarioIdRef.current = nextId;
    setActiveScenarioId(nextId);
  }

  // Ref-backed flag that suppresses the `[address]` URL→scenario sync
  // effect for the next URL change. Set synchronously by code paths
  // (add/switch/remove) that already own the address for the active
  // scenario, so the effect doesn't corrupt the wrong tab during the
  // wouter intermediate render. See the comment on that effect below.
  const skipNextAddressSyncRef = useRef(false);

  // Pure merge: produce next inputs from current+baseline+Zillow, honoring
  // the "don't overwrite user edits" rule by comparing current vs baseline.
  // When purchasePrice is replaced, also stamp its source so the UI can
  // label it (e.g. "Source: Zillow sold price").
  function mergeZillowIntoInputs(
    current: Inputs,
    baseline: Inputs | undefined,
    zPrice: number | null,
    zHoa: number | null,
    priceSource: PurchasePriceSource | null = null,
    zPropertyType: string | null = null,
  ): Inputs {
    const next: Inputs = { ...current };
    // Treat the field as user-edited if the source is "user" (explicit)
    // or if the current value diverges from the baseline default.
    const userEditedPrice =
      current.purchasePriceSource === "user" ||
      (baseline != null && current.purchasePrice !== baseline.purchasePrice);
    if (zPrice != null && !userEditedPrice) {
      next.purchasePrice = zPrice;
      if (priceSource) next.purchasePriceSource = priceSource;
    }
    if (zHoa != null && (!baseline || current.hoaMonthly === baseline.hoaMonthly)) {
      next.hoaMonthly = zHoa;
    }
    // Property Type: apply Zillow value only when the user hasn't
    // picked one manually. Mirrors the manual-vs-zillow rule used by
    // purchasePrice above so a manual override survives refresh scrapes.
    if (current.propertyTypeSource !== "manual") {
      const mapped = zillowToDropdownPropertyType(zPropertyType);
      if (mapped) {
        next.propertyType = mapped;
        next.propertyTypeSource = "zillow";
      }
    }
    return enforceFloodInsurancePolicy(next);
  }

  // Given a LookedUpProperty + cache flag + the resolved zPrice, infer
  // which Zillow field actually populated the purchase price so the UI
  // can show a precise source label.
  function inferPriceSource(
    p: LookedUpProperty,
    zPrice: number | null,
    fromCache: boolean,
  ): PurchasePriceSource {
    if (fromCache) return "zillow_cache";
    if (zPrice == null) return "zillow_zestimate";
    if (p.isSold && p.soldPrice != null && p.soldPrice === zPrice) return "zillow_sold";
    if (p.listingPrice != null && p.listingPrice === zPrice) return "zillow_listing";
    return "zillow_zestimate";
  }

  // Fire the background Zillow lookup for a specific scenario by id. Never
  // touches any other scenario, even if the user switches tabs mid-flight.
  // All state mutation at completion goes through functional updaters so the
  // dirty-check is deterministic against the latest state.
  function triggerZillowLookup(scenarioId: string, addr: string) {
    if (!addr || addr === "Unknown Address") return;
    const key = `${scenarioId}|${addr.trim().toLowerCase()}`;
    if (zillowFetchedKeysRef.current.has(key)) return;
    zillowFetchedKeysRef.current.add(key);

    setScenarios(prev =>
      prev.map(s => s.id === scenarioId ? { ...s, zillowStatus: "loading" } : s)
    );

    (async () => {
      try {
        const res = await apiRequest("POST", "/api/zillow-property-lookup", { addressOrUrl: addr });
        const body = await res.json();
        const p = body?.property as LookedUpProperty | undefined;
        const fromCache: boolean = body?.cached === true;
        if (!p) {
          setScenarios(prev =>
            prev.map(s => s.id === scenarioId ? { ...s, zillowStatus: "error" } : s)
          );
          return;
        }
        const zPrice = p.purchasePrice ?? p.listingPrice ?? p.zestimate ?? null;
        const zHoa = p.hoaMonthly ?? null;
        const priceSource = inferPriceSource(p, zPrice, fromCache);
        const nextStatus = fromCache ? "loaded_from_cache" : "loaded_from_zillow";
        // Resolve active-ness from the ref so a tab switch mid-flight
        // doesn't cause us to mirror this update onto a different tab.
        const isActive = activeScenarioIdRef.current === scenarioId;

        // Photo normalization — server returns `p.photos: string[]` already
        // deduped + filtered by the expanded `pickPhotos` extractor. Apply
        // the data-safety rule: only overwrite the saved photo array when
        // the fresh result is non-empty (the backend already preserves cached
        // photos through empty scrapes, so an empty here means "really none").
        const freshPhotos = Array.isArray(p.photos)
          ? p.photos.filter((x): x is string => typeof x === "string" && x.length > 0)
          : [];
        const freshPrimary = freshPhotos[0] ?? undefined;

        // Update the scenario's saved snapshot using ONLY the latest state
        // visible to the functional updater.
        setScenarios(prev =>
          prev.map(s => {
            if (s.id !== scenarioId) return s;
            // For an inactive tab, the canonical "current" is its savedInputs.
            // For the active tab, savedInputs is whatever was last snapshotted
            // (typically stale) — the live `inputs` state is the source of
            // truth and is merged separately below.
            const baseSnapshot = s.savedInputs ?? s.baselineInputs ?? null;
            // Photo merge: always prefer a non-empty fresh array; otherwise
            // keep whatever was already on the scenario (don't blank out).
            const nextPhotos = freshPhotos.length > 0 ? freshPhotos : s.propertyPhotos;
            const nextPrimary = freshPrimary ?? s.primaryPhotoUrl;
            if (!baseSnapshot) return {
              ...s,
              zillowStatus: nextStatus,
              ...(nextPhotos ? { propertyPhotos: nextPhotos } : {}),
              ...(nextPrimary ? { primaryPhotoUrl: nextPrimary } : {}),
            };
            const mergedBase = mergeZillowIntoInputs(baseSnapshot, s.baselineInputs, zPrice, zHoa, priceSource, (p as any).propertyType ?? null);
            const yearBuilt = validInsuranceYearBuilt(p.yearBuilt);
            const yearBuiltIsManual =
              mergedBase.userAnswerSources?.insurance_year_built_source === "manual";
            const merged = yearBuilt == null || yearBuiltIsManual
              ? mergedBase
              : {
                  ...mergedBase,
                  userAnswerSources: {
                    ...(mergedBase.userAnswerSources ?? {}),
                    insurance_year_built: String(yearBuilt),
                  },
                };
            return {
              ...s,
              savedInputs: merged,
              zillowStatus: nextStatus,
              ...(nextPhotos ? { propertyPhotos: nextPhotos } : {}),
              ...(nextPrimary ? { primaryPhotoUrl: nextPrimary } : {}),
            };
          })
        );
        const yearBuilt = validInsuranceYearBuilt(p.yearBuilt);
        if (freshPhotos.length > 0 || yearBuilt != null) {
          const stored = getPurchaseScenarios();
          const addressKey = addr.trim().toLowerCase();
          const storedIndex = stored.findIndex(
            scenario => scenario.address.trim().toLowerCase() === addressKey,
          );
          const existing = storedIndex >= 0
            ? stored[storedIndex]
            : {
                id: scenarioId.startsWith("sc_") ? scenarioId.slice(3) : scenarioId,
                address: addr,
                savedAt: new Date().toISOString(),
              };
          const withPhotos = {
            ...existing,
            ...(freshPhotos.length > 0
              ? {
                  propertyPhotos: freshPhotos,
                  primaryPhotoUrl: freshPrimary,
                }
              : {}),
            ...(yearBuilt != null &&
                existing.userAnswerSources?.insurance_year_built_source !== "manual"
              ? {
                  userAnswerSources: {
                    ...(existing.userAnswerSources ?? {}),
                    insurance_year_built: String(yearBuilt),
                  },
                }
              : {}),
          };
          const nextStored = storedIndex >= 0
            ? stored.map((scenario, index) => index === storedIndex ? withPhotos : scenario)
            : [...stored, withPhotos];
          savePurchaseScenarios(nextStored);
        }

        // Mirror into live `inputs` only if this scenario is still active
        // RIGHT NOW. Baseline comes from the ref-backed map so we don't
        // depend on React state timing or nest setter side effects.
        if (isActive) {
          const baseline = baselineByIdRef.current[scenarioId];
          setInputs(curr => {
            const merged = mergeZillowIntoInputs(curr, baseline, zPrice, zHoa, priceSource, (p as any).propertyType ?? null);
            return yearBuilt == null ||
              merged.userAnswerSources?.insurance_year_built_source === "manual"
              ? merged
              : {
                  ...merged,
                  userAnswerSources: {
                    ...(merged.userAnswerSources ?? {}),
                    insurance_year_built: String(yearBuilt),
                  },
                };
          });
          if (
            yearBuilt != null &&
            inputsRef.current.userAnswerSources?.insurance_year_built_source !== "manual"
          ) {
            setInsuranceYearBuilt(yearBuilt);
            setInsYearIdx(legacyInsuranceYearIndex(yearBuilt));
          }
          if (zPrice != null) {
            toast({
              title: fromCache ? "Property data loaded from saved records" : "Zillow data applied",
              description: `Updated estimated price to ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(zPrice)}.`,
            });
          }
        }
      } catch (err: any) {
        console.warn(`[zillow-auto] lookup failed for ${addr}:`, err?.message || err);
        setScenarios(prev =>
          prev.map(s => s.id === scenarioId ? { ...s, zillowStatus: "error" } : s)
        );
      }
    })();
  }

  const [newScenarioAddress, setNewScenarioAddress] = useState("");
  // Holds the latest auto-add handler so the autocomplete selection callback
  // always sees current state when it fires.
  const autoAddRef = useRef<((addr: string, meta?: PlaceMeta) => void) | null>(null);
  // Idempotency prevents duplicate selection events (and any rapid
  // re-selection of the same suggestion) from creating duplicate tabs.
  const lastAddedPlaceKeyRef = useRef<string | null>(null);
  const [leadDialogForScenario, setLeadDialogForScenario] = useState(false);

  // Keep `autoAddRef` pointing at the latest confirmNewScenario closure
  // so the Google Autocomplete listener (attached once when the dialog opens)
  // always sees current inputs/scenarios when it fires.
  useEffect(() => {
    autoAddRef.current = (addr, meta) => {
      // Key on placeId when available, otherwise on the normalized address.
      const key = (meta?.placeId || addr.trim().toLowerCase());
      if (lastAddedPlaceKeyRef.current === key) return;
      lastAddedPlaceKeyRef.current = key;
      setNewScenarioAddress(addr);
      // Pass `addr` explicitly so we don't depend on the async state update.
      confirmNewScenario(meta, addr);
    };
  });

  // Reset the idempotency key whenever the Add Property dialog opens so
  // re-adding the same address in a later session still works.
  useEffect(() => {
    if (showAddressPrompt) lastAddedPlaceKeyRef.current = null;
  }, [showAddressPrompt]);

  const { bindInputRef: newScenarioInputRef } = useGooglePlaces({
    enabled: showAddressPrompt,
    onPlaceSelected: place => {
      const formatted = place.formatted_address;
      if (!formatted || formatted.length < 6 || !formatted.includes(",")) return;

      const components = place.address_components || [];
      const get = (type: string) =>
        components.find(component => component.types.includes(type));
      const streetNumber = get("street_number")?.long_name || "";
      const route = get("route")?.long_name || "";
      const subpremise = get("subpremise")?.long_name || "";
      const meta: PlaceMeta = {
        placeId: place.place_id,
        street: [
          [streetNumber, route].filter(Boolean).join(" "),
          subpremise ? `Unit ${subpremise}` : "",
        ].filter(Boolean).join(" ") || undefined,
        city: get("locality")?.long_name || get("sublocality")?.long_name,
        state: get("administrative_area_level_1")?.short_name,
        zip: get("postal_code")?.long_name,
        county: get("administrative_area_level_2")?.long_name,
        lat: place.geometry?.location?.lat?.(),
        lng: place.geometry?.location?.lng?.(),
      };
      setNewScenarioAddress(formatted);
      autoAddRef.current?.(formatted, meta);
    },
  });

  // Keep active scenario's address in sync when URL changes (inline edit).
  // Defensive: never overwrite an existing valid address with empty/placeholder.
  //
  // CRITICAL: wouter's `setLocation` uses `useSyncExternalStore`, which is
  // intentionally NOT batched with React 18's queued updates. That means
  // when `confirmNewScenario` / `switchScenario` / `removeScenario` call
  // `setScenarios` + `setActive` + `setLocation` together, React renders
  // ONCE for the URL change with the OLD scenarios + OLD activeScenarioId
  // still in place — and only then flushes the queued scenario/active
  // updates. If this effect runs in that intermediate render, it
  // overwrites the OLD active scenario's address with the NEW URL value,
  // corrupting the previously-saved tab (the original "first tab now
  // shows the new address" bug).
  //
  // Those three code paths already set each scenario's `address` field
  // explicitly, so they don't need this effect at all — they set the
  // skip-ref synchronously just before calling `setLocation`. Only the
  // genuine inline-address-edit path (which calls `setLocation` without
  // mutating scenarios first) goes through here.
  useEffect(() => {
    if (!address || address === "Unknown Address") return;
    if (skipNextAddressSyncRef.current) {
      skipNextAddressSyncRef.current = false;
      return;
    }
    setScenarios(prev =>
      prev.map(s => s.id === activeScenarioId ? { ...s, address } : s)
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // Reorder property tabs via drag-and-drop. Operates on the full scenario
  // objects (keyed by id), so address + savedInputs stay glued to the right
  // property; activeScenarioId is unchanged so the active tab follows its
  // scenario after the move.
  const [draggingScenarioId, setDraggingScenarioId] = useState<string | null>(null);
  function moveScenario(fromId: string, toId: string) {
    if (fromId === toId) return;
    setScenarios(prev => {
      const fromIdx = prev.findIndex(s => s.id === fromId);
      const toIdx = prev.findIndex(s => s.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }

  function switchScenario(targetId: string) {
    if (targetId === activeScenarioId) return;
    const target = scenarios.find(s => s.id === targetId);
    if (!target) return;
    // Snapshot current inputs into active scenario
    setScenarios(prev =>
      prev.map(s => s.id === activeScenarioId ? { ...s, savedInputs: inputs } : s)
    );
    const targetInputs = enforceFloodInsurancePolicy(
      target.savedInputs ?? inputsForAddress(target.address),
    );
    resetInsuranceQuestionnaire(targetInputs);
    setActive(targetId);
    skipNextAddressSyncRef.current = true;
    setLocation(`/estimate?address=${encodeURIComponent(target.address)}`);
    setInputs(targetInputs);
    const hasPhotos = Boolean(
      target.primaryPhotoUrl ||
      target.propertyPhotos?.some(photo => typeof photo === "string" && photo.length > 0),
    );
    const hasYearBuilt =
      validInsuranceYearBuilt(targetInputs.userAnswerSources?.insurance_year_built) != null;
    if (!hasPhotos || !hasYearBuilt) triggerZillowLookup(target.id, target.address);
  }

  function removeScenario(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (scenarios.length === 1) return;
    const idx = scenarios.findIndex(s => s.id === id);
    const removed = scenarios[idx];
    const remaining = scenarios.filter(s => s.id !== id);
    setScenarios(remaining);

    // Also remove the corresponding entry from the dashboard so it doesn't
    // immediately get re-added by the auto-save effect on the next render.
    if (removed && getSession()) {
      try {
        const key = removed.address.trim().toLowerCase();
        const next = getPurchaseScenarios().filter(s => s.address.trim().toLowerCase() !== key);
        savePurchaseScenarios(next);
      } catch (err) {
        console.warn("Failed to remove scenario from dashboard:", err);
      }
    }

    // Free any baseline ref entry for the removed scenario.
    delete baselineByIdRef.current[id];
    if (id === activeScenarioId) {
      const next = remaining[Math.max(0, idx - 1)];
      const nextInputs = enforceFloodInsurancePolicy(
        next.savedInputs ?? inputsForAddress(next.address),
      );
      resetInsuranceQuestionnaire(nextInputs);
      setActive(next.id);
      skipNextAddressSyncRef.current = true;
      setLocation(`/estimate?address=${encodeURIComponent(next.address)}`);
      setInputs(nextInputs);
    }
  }

  function requestAddScenario() {
    if (scenarios.length >= 5) {
      toast({ title: "Maximum 5 scenarios", description: "Remove a tab to add a new property." });
      return;
    }
    setShowAddressPrompt(true);
  }

  async function confirmNewScenario(meta?: PlaceMeta, addrOverride?: string) {
    // Prefer the explicitly passed value (from the autocomplete callback) over
    // React state, which may not have flushed yet when this runs.
    const addr = (addrOverride ?? newScenarioAddress).trim();
    // Defensive: reject empty / obviously-partial addresses so a half-typed
    // entry (or an empty autocomplete callback) can't overwrite anything.
    // A real Google formatted_address always has at least one comma
    // ("123 Main St, Tampa, FL 33602").
    if (!addr) return;
    if (addr.length < 6 || !addr.includes(",")) {
      toast({
        title: "Address looks incomplete",
        description: "Please pick a full address from the suggestions (street, city, state).",
        variant: "destructive",
      });
      return;
    }
    if (!await authorize("purchase", addr)) return;
    // Don't add a duplicate tab for an address we already have open.
    const dupKey = addr.toLowerCase();
    const dup = scenarios.find(s => s.address.trim().toLowerCase() === dupKey);
    if (dup) {
      toast({ title: "Already added", description: "Switching to that property." });
      const targetInputs = enforceFloodInsurancePolicy(
        dup.savedInputs ?? inputsForAddress(dup.address),
      );
      resetInsuranceQuestionnaire(targetInputs);
      setInputs(targetInputs);
      setActive(dup.id);
      skipNextAddressSyncRef.current = true;
      setLocation(`/estimate?address=${encodeURIComponent(dup.address)}${fromDashboard ? "&from=dashboard" : ""}`);
      setNewScenarioAddress("");
      setShowAddressPrompt(false);
      return;
    }
    // Collision-safe id — Date.now() can collide if Google double-fires within
    // the same millisecond. randomUUID is available in all modern browsers.
    const newId = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      ? `sc_${crypto.randomUUID()}`
      : `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Carry over the current borrower/purchase inputs so the user
    // doesn't re-enter everything for the new property. They can
    // still tweak anything on the new tab.
    //
    // Reset `purchasePriceSource` to "default" for the new scenario:
    // the carried-over price is a starting estimate for a different
    // property, not a user edit for THIS property. Without this reset
    // the merge guard would mistakenly treat the inherited "user" source
    // as sticky and refuse to apply the new tab's Zillow/cache price.
    const carriedInputs: Inputs = { ...inputs, purchasePriceSource: "default" };
    // Seed the ref-backed baseline map BEFORE the async Zillow fetch, so the
    // async callback can read the correct baseline regardless of React
    // state-update timing.
    baselineByIdRef.current[newId] = { ...carriedInputs };
    setScenarios(prev => [
      ...prev.map(s => s.id === activeScenarioId ? { ...s, savedInputs: inputs } : s),
      {
        id: newId,
        address: addr,
        savedInputs: carriedInputs,
        placeMeta: meta,
        // Snapshot the carried inputs so we can later tell whether the user
        // has manually edited any field before Zillow data arrives.
        baselineInputs: { ...carriedInputs },
      },
    ]);
    resetInsuranceQuestionnaire(carriedInputs);
    setActive(newId);
    // Persist a DRAFT purchase scenario row to Supabase immediately on
    // address-add for authenticated users. Without this, the only save
    // path was the debounced (800ms) auto-save effect — so a user who
    // added an address and then navigated away, logged out, or closed
    // the tab within 800ms would lose the row entirely (bug:
    // purchase-with-loan-save-persistence-fix). The draft uses the
    // same id (`newId`) the tab is using locally. The auto-save effect
    // matches by address (not id), so it will find this draft and
    // merge derived/calc fields into the same row — no duplicates.
    {
      const sessionId = getSession()?.id ?? null;
      const authed = !!sessionId || isAuthenticated;
      console.debug("[purchase-live-test] authenticated", authed);
      console.debug("[purchase-live-test] auth user id", sessionId);
      console.debug("[purchase-live-test] address selected", addr);
      console.debug("[purchase-live-test] generated scenario id", newId);
      if (!authed) {
        console.debug("[purchase-live-test] save function called", false, "reason: not-authenticated");
      } else {
        const existingSaved = getPurchaseScenarios();
        const dupKey = addr.trim().toLowerCase();
        const alreadySaved = existingSaved.some(
          s => s.address.trim().toLowerCase() === dupKey,
        );
        if (alreadySaved) {
          console.debug("[purchase-live-test] save function called", false, "reason: already-saved");
        } else {
          console.debug("[purchase-live-test] save function called", true);
          console.debug("[purchase-live-test] target table", "purchase_scenarios");
          savePurchaseScenarios([
            ...existingSaved,
            { id: newId, address: addr, savedAt: new Date().toISOString() },
          ]);
        }
      }
    }
    // Mirror the reset carriedInputs into live state. Without this, live
    // `inputs.purchasePriceSource` would still carry the prior tab's
    // "user" marker, causing `mergeZillowIntoInputs` to skip applying the
    // new tab's Zillow/cache price on the active tab. This keeps the
    // active merge, the source label, and the new-scenario snapshot all
    // consistent with the new-tab baseline.
    setInputs(carriedInputs);
    // The new scenario object already carries `address: addr`, so the
    // URL→active-scenario sync effect must NOT run here — otherwise it
    // would fire during wouter's pre-batch intermediate render (with
    // activeScenarioId still pointing at the OLD tab) and overwrite the
    // previous tab's address with the new one.
    skipNextAddressSyncRef.current = true;
    setLocation(`/estimate?address=${encodeURIComponent(addr)}${fromDashboard ? "&from=dashboard" : ""}`);
    // Keep inputs as-is (carry over). Only let flood re-fetch for the new address.
    floodLoadedRef.current = null;
    // Kick off the background Zillow scrape for this new scenario — the user
    // can keep using the app while it loads. We pass the stable id so the
    // result lands on the right tab even if the user switches in the
    // meantime.
    triggerZillowLookup(newId, addr);
    setNewScenarioAddress("");
    setShowAddressPrompt(false);

    // Notify the assigned agent in FollowUpBoss (non-blocking)
    const sessionUser = getSession();
    if (sessionUser) {
      const fullName = (sessionUser.name || "").trim();
      const spaceIdx = fullName.indexOf(" ");
      const firstName = spaceIdx > 0 ? fullName.slice(0, spaceIdx) : (fullName || sessionUser.email.split("@")[0]);
      const lastName = spaceIdx > 0 ? fullName.slice(spaceIdx + 1) : "-";
      authedFetch("/api/leads/notify-new-scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email: sessionUser.email,
          phone: sessionUser.phone || "",
          agent: sessionUser.agent || "Team",
          address: addr,
          scenarioType: "Purchase",
          scenarioDetails: buildScenarioDetails(),
          referral: getStoredReferralSource() ?? undefined,
        }),
      }).catch(err => console.warn("Failed to notify agent of new scenario:", err));
    }
    trackEvent("scenario_saved", { type: "purchase" });
  }

  // Share dialog.
  //
  // `from=dashboard` historically jumped straight to step 4 (the
  // estimate results). That's correct when the user is RE-OPENING a
  // property they already filled out — but for a BRAND-NEW property
  // it skipped Pages 1-3 entirely and showed Page 4 populated with
  // hard-coded defaults (income $8k, credit 780, reserves $35k, etc.)
  // as if those were the user's real answers. So we only honor the
  // jump-to-step-4 shortcut when this exact address has a saved
  // Purchase scenario. New addresses always start on Page 1 so the
  // user actually answers the borrower questions.
  const [step, setStep] = useAnonymousDraft<number>("step", () => {
    if (!fromDashboard) return 1;
    if (typeof window === "undefined") return 1;
    const hasSession =
      getSession() !== null;
    if (!hasSession) return 1;
    const key = address.trim().toLowerCase();
    if (!key || key === "unknown address") return 1;
    const hasSavedForThis = getPurchaseScenarios().some(
      s => s.address.trim().toLowerCase() === key,
    );
    console.debug(
      "[purchase-new-scenario] route start page",
      hasSavedForThis ? 4 : 1,
      hasSavedForThis ? "(existing saved scenario)" : "(new property)",
    );
    return hasSavedForThis ? 4 : 1;
  });
  // Which questionnaire page is currently being edited from the Property
  // Estimate (step 4) summary. `null` = not editing. When set, that step's
  // Card is rendered inside a Dialog overlay on top of the estimate so the
  // user never leaves step 4. Closing the dialog (or switching scenarios)
  // resets to null. All form fields inside continue to bind to the active
  // scenario's `inputs`/`setInputs`, so edits flow through the existing
  // calculation + debounced auto-save effects (no separate save path).
  const [editingPage, setEditingPage] = useState<1 | 2 | 3 | null>(null);
  // Close any open edit dialog when the user switches scenario tabs so
  // the dialog can't bleed across scenarios while inputs swap underneath.
  useEffect(() => { setEditingPage(null); }, [activeScenarioId]);

  // PostHog: scenario_calculated (purchase). Fires once per scenario id the
  // first time the user reaches Page 4 for that scenario. Re-fires for a
  // newly-created scenario.
  useEffect(() => {
    if (step !== 4 || !activeScenarioId) return;
    if (phPurchaseCalcFiredRef.current.has(activeScenarioId)) return;
    phPurchaseCalcFiredRef.current.add(activeScenarioId);
    trackEvent("scenario_calculated", { type: "purchase" });
  }, [step, activeScenarioId]);
  const [answersOpen, setAnswersOpen] = useState(false);

  async function generateEstimatePDF() {
    if (!calcRef.current.taxComplete) {
      toast({ title: "Complete property taxes first", description: "Enter the annual bill before downloading a complete mortgage estimate.", variant: "destructive" });
      return;
    }
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const W = doc.internal.pageSize.getWidth();
    const margin = 48;
    const col2 = W / 2 + 8;
    let y = margin;

    function addPage() {
      doc.addPage();
      y = margin;
    }
    function checkPage(needed = 60) {
      if (y + needed > doc.internal.pageSize.getHeight() - margin) addPage();
    }
    function hLine(yy = y) {
      doc.setDrawColor(220, 220, 220);
      doc.line(margin, yy, W - margin, yy);
    }
    function sectionHeader(title: string) {
      checkPage(40);
      doc.setFillColor(23, 55, 94);
      doc.roundedRect(margin, y, W - margin * 2, 22, 3, 3, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text(title.toUpperCase(), margin + 10, y + 15);
      doc.setTextColor(30, 30, 30);
      y += 30;
    }
    function row(label: string, value: string, sub?: string) {
      checkPage(sub ? 36 : 22);
      doc.setFontSize(9.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(80, 80, 80);
      doc.text(label, margin + 4, y + 12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 30, 30);
      doc.text(value, W - margin - 4, y + 12, { align: "right" });
      if (sub) {
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(130, 130, 130);
        doc.text(sub, W - margin - 4, y + 22, { align: "right" });
      }
      y += sub ? 34 : 22;
      doc.setDrawColor(235, 235, 235);
      doc.line(margin, y, W - margin, y);
    }
    function metricBox(label: string, value: string, x: number, boxY: number, color?: [number, number, number]) {
      const bw = (W - margin * 2) / 3 - 6;
      doc.setFillColor(248, 249, 252);
      doc.roundedRect(x, boxY, bw, 52, 4, 4, "F");
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 100, 100);
      doc.text(label, x + bw / 2, boxY + 16, { align: "center" });
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      const [r, g, b] = color ?? [23, 55, 94];
      doc.setTextColor(r, g, b);
      doc.text(value, x + bw / 2, boxY + 38, { align: "center" });
      doc.setTextColor(30, 30, 30);
    }

    // ── Header ──────────────────────────────────────────────────────────
    doc.setFillColor(23, 55, 94);
    doc.rect(0, 0, W, 70, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text("Havo", margin, 35);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text("Home Cost & Qualification Estimate", margin, 52);
    const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    doc.setFontSize(9);
    doc.text(dateStr, W - margin, 35, { align: "right" });
    doc.text(address, W - margin, 52, { align: "right" });
    doc.setTextColor(30, 30, 30);
    y = 90;

    // ── Qualification status bar ─────────────────────────────────────────
    const qualColor: [number, number, number] = !calc.taxVerified ? [89, 103, 122] : calc.qualifies ? [22, 163, 74] : [220, 38, 38];
    doc.setFillColor(...qualColor);
    doc.roundedRect(margin, y, W - margin * 2, 28, 4, 4, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    const qualText = !calc.taxVerified ? "Planning estimate — property taxes not yet verified" : calc.qualifies ? "Likely Qualifies" : "Needs Review";
    doc.text(qualText, W / 2, y + 19, { align: "center" });
    doc.setTextColor(30, 30, 30);
    y += 38;
    doc.setFontSize(8);
    doc.text("Based on debt-to-income only. Not a prequalification or approval.",margin,y);
    y+=14;

    // ── Key metrics ──────────────────────────────────────────────────────
    const bw = (W - margin * 2) / 3 - 6;
    const mx = [margin, margin + bw + 6, margin + (bw + 6) * 2];
    const dtiColor: [number, number, number] = calc.totalGreen !== Infinity && calc.dti >= calc.totalGreen ? [220, 38, 38] : [22, 163, 74];
    metricBox("Monthly Payment", fmt(calc.totalHousing), mx[0], y);
    metricBox("Total DTI", fmtPct(calc.dti), mx[1], y, dtiColor);
    metricBox("Cash to Close", fmt(calc.cashToClose), mx[2], y);
    y += 62;

    // ── Inputs summary ────────────────────────────────────────────────────
    sectionHeader("Loan Parameters");
    const half = (W - margin * 2) / 2 - 6;
    const leftX = margin;
    const rightX = margin + half + 6;
    const paramRows: Array<{ label: string; value: string; italicSuffix?: string }> = [
      { label: "Purchase Price", value: fmt(inputs.purchasePrice) },
      { label: "Loan Type", value: inputs.loanType.toUpperCase() },
      { label: "Down Payment", value: `${fmt(calc.downPaymentAmt)} (${Number(calc.effectiveDownPaymentPct).toFixed(1)}%)` },
      {
        label: "Interest Rate",
        value: `${calc.finalRate.toFixed(3)}%`,
        italicSuffix: aprPct !== null ? formatAprParenthetical(aprPct) : undefined,
      },
      { label: "Occupancy", value: inputs.occupancy.charAt(0).toUpperCase() + inputs.occupancy.slice(1) },
      { label: "Credit Score", value: String(inputs.creditScore) },
    ];
    const startY = y;
    paramRows.forEach(({ label, value, italicSuffix }, i) => {
      const px = i % 2 === 0 ? leftX : rightX;
      const py = startY + Math.floor(i / 2) * 26;
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 100, 100);
      doc.text(label, px + 4, py + 12);
      if (italicSuffix) {
        doc.setFont("helvetica", "italic");
        doc.text(italicSuffix, px + 4 + doc.getTextWidth(label + " "), py + 12);
      }
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 30, 30);
      doc.text(value, px + half - 4, py + 12, { align: "right" });
    });
    y = startY + Math.ceil(paramRows.length / 2) * 26 + 8;

    // ── Real Estate ───────────────────────────────────────────────────────
    sectionHeader("Real Estate");
    row("Purchase Price", fmt(inputs.purchasePrice));
    row("Down Payment", `${fmt(calc.downPaymentAmt)} (${Number(calc.effectiveDownPaymentPct).toFixed(1)}%)`);
    row("Loan Amount", fmt(calc.loanAmount), inputs.loanType === "fha" ? `includes 1.75% financing fee (${fmt(calc.fhaUFMIP)}) · LTV ${fmtPct(calc.ltv)}` : `LTV ${fmtPct(calc.ltv)}`);
    row(
      "Estimated Closing Costs (Itemized IFW)",
      fmt(calc.closingCosts),
      inputs.loanType === "dscr" ? `Incl. DSCR Origination Charge 1.00% (${fmt(calc.dscrOriginationAmount)})` : undefined,
    );
    if (inputs.sellerConcessions > 0) row("Seller Concessions", `− ${fmt(inputs.sellerConcessions)}`);
    if (calc.dpaActive) {
      row("DPA Covers Down Payment", `− ${fmt(calc.dpaDownPaymentCredit)}`, `${calc.dpaPct}% assistance program`);
      if (calc.dpaClosingCostCredit > 0) row("DPA Closing-Cost Credit (1.5%)", `− ${fmt(calc.dpaClosingCostCredit)}`);
      if (calc.dpaExtraPointsCost > 0) row("DPA Discount Points (2 pts)", fmt(calc.dpaExtraPointsCost), "Included in closing costs");
    }
    row("Estimated Cash to Close", fmt(calc.cashToClose));

    // ── Mortgage ──────────────────────────────────────────────────────────
    checkPage(20);
    sectionHeader("Monthly Mortgage Breakdown");
    row("Principal & Interest", fmt(calc.pi), `${calc.finalRate.toFixed(3)}% / 30 yr`);
    row("Property Taxes", `${fmt(calc.monthlyTax)}/mo`, `${fmt(inputs.annualTaxes)}/yr (${taxSource()})`);
    if (quickTax.result && taxSource() !== "manual") {
      const tax = quickTax.result;
      const evidence = [
        tax.label,
        `${tax.sourceName}: ${tax.sourceUrl ?? "Source URL not supplied"}`,
        `Tax year ${tax.taxYear ?? "unknown"}; rates year ${tax.ratesYear ?? "unknown"}; district ${tax.district ?? "not supplied"}; parcel ${tax.parcelId ?? "see component sources"}.`,
        `Non-ad valorem: ${tax.navPending ? "pending — amount may increase" : tax.nav ?? "unavailable"}.`,
        ...(!calc.taxVerified ? ["Planning estimate — not an official county bill."] : []),
        ...[tax.breakdown?.adValorem, tax.breakdown?.nonAdValorem].flatMap(part => part?.source ? [
          `${part.source.name}: ${part.source.url}; parcel ${part.source.parcelId}; tax year ${part.source.taxYear}; fetched ${new Date(part.source.fetchedAt).toLocaleString("en-US",{timeZone:"America/New_York"})} (America/New_York).`,
        ] : []),
        ...(tax.breakdown?.warnings ?? []),
      ];
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 100, 100);
      for (const text of evidence) for (const line of doc.splitTextToSize(text, W - margin * 2 - 8) as string[]) {
        checkPage(14); doc.text(line, margin + 4, y + 10); y += 12;
      }
      y += 8;
    }
    row("Homeowners Insurance", `${fmt(calc.monthlyHOIns)}/mo`);
    if (!suppressSeparateFloodInsurance(inputs.propertyType)) {
      row("Flood Insurance", `${fmt(calc.monthlyFlood)}/mo`);
    } else {
      row(
        "Flood Insurance",
        fmt(0),
        inputs.propertyType === "Land"
          ? "No separate building flood premium; verify requirements"
          : FLOOD_HOA_ASSUMPTION_NOTE,
      );
    }
    if (inputs.hoaMonthly > 0) row("HOA", fmt(inputs.hoaMonthly));
    if (inputs.cddAnnual > 0) row("CDD", `${fmt(calc.monthlyCDD)}/mo`);
    if (calc.mortgageInsurance > 0) {
      const miLabel = inputs.loanType === "fha" ? "FHA MIP" : "PMI";
      row(miLabel, fmt(calc.mortgageInsurance));
    }
    if (calc.dpaActive && calc.dpaSecondType === "amortizing") {
      row("DPA 2nd Mortgage", fmt(calc.dpaSecondMonthly), `${fmt(calc.dpaAmount)} @ ${calc.dpaSecondRate.toFixed(3)}% / 10 yr`);
    }
    if (calc.dpaActive && calc.dpaSecondType === "silent") {
      row("DPA Silent 2nd", fmt(0), `${fmt(calc.dpaAmount)} — no payments; due in full on refinance; keep home 10 yrs`);
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setFillColor(23, 55, 94);
    doc.rect(margin, y, W - margin * 2, 24, "F");
    doc.setTextColor(255, 255, 255);
    doc.text("Total Monthly Payment", margin + 8, y + 16);
    doc.text(fmt(calc.totalHousing), W - margin - 8, y + 16, { align: "right" });
    doc.setTextColor(30, 30, 30);
    y += 32;

    // ── Qualification ─────────────────────────────────────────────────────
    checkPage(20);
    sectionHeader("Qualification Analysis");
    row("Monthly Income", fmt(inputs.monthlyIncome));
    if (inputs.hasRentalIncome && calc.rentalIncomeQualifying > 0)
      row("Rental Income (75%)", fmt(calc.rentalIncomeQualifying));
    row("Total Qualifying Income", fmt(calc.qualifyingIncome));
    row("Required Monthly Income", fmt(calc.requiredIncome));
    const hDTIMax = calc.housingGreen === Infinity ? "No limit" : `Target < ${fmtPct(calc.housingGreen)}`;
    const tDTIMax = calc.totalGreen === Infinity ? "No limit" : `Target < ${fmtPct(calc.totalGreen)}`;
    row("Housing DTI", fmtPct(calc.housingDTI), hDTIMax);
    row("Total DTI", fmtPct(calc.dti), tDTIMax);
    row("Required Reserves (1-3 mo PITI)", fmt(calc.requiredReserves));
    row("Available Reserves", fmt(calc.availableReserves));
    row(
      "Monthly Debts",
      fmt(calc.totalMonthlyDebts),
      calc.deferredStudentLoanMonthly > 0
        ? `Incl. ${fmt(calc.deferredStudentLoanMonthly)}/mo deferred student loan`
        : undefined,
    );

    // ── Initial Fees Worksheet + APR ─────────────────────────────────────
    // Rendered from the SAME shared feeWorksheet model as the on-screen
    // popup so the PDF can never drift from what the buyer sees.
    if (feeWorksheet) {
      const feeRow = (label: string, amount: number, note?: string) =>
        row(label, feeMoney(amount), note);
      const subtotalRow = (label: string, amount: number) => {
        checkPage(24);
        doc.setFontSize(9.5);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(30, 30, 30);
        doc.text(label, margin + 4, y + 12);
        doc.text(feeMoney(amount), W - margin - 4, y + 12, { align: "right" });
        y += 22;
        doc.setDrawColor(210, 210, 210);
        doc.line(margin, y, W - margin, y);
      };
      const groupHeading = (heading: string) => {
        checkPage(22);
        doc.setFontSize(8.5);
        doc.setFont("helvetica", "bolditalic");
        doc.setTextColor(100, 100, 100);
        doc.text(heading, margin + 4, y + 12);
        y += 18;
      };
      const renderFeeSection = (section: FeeSection) => {
        sectionHeader(section.title);
        (section.groups ?? []).forEach((g) => {
          groupHeading(g.heading);
          g.lines.forEach((l) => feeRow(l.label, l.amount, l.note));
        });
        section.lines.forEach((l) => feeRow(l.label, l.amount, l.note));
        subtotalRow(`Total ${section.title}`, section.subtotal);
        y += 8;
      };

      addPage();
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(23, 55, 94);
      doc.text("Initial Fees Worksheet", margin, y + 6);
      y += 18;
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 30, 30);
      doc.text(purchaseLenderInfo.companyName, margin, y + 6);
      doc.text(purchaseLenderInfo.loanOfficerName, W / 2, y + 6);
      y += 12;
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(90, 90, 90);
      doc.text(`Company NMLS #${purchaseLenderInfo.companyNmls}`, margin, y + 6);
      doc.text(purchaseLenderInfo.loanOfficerTitle, W / 2, y + 6);
      y += 11;
      doc.text(purchaseLenderInfo.addressLine1, margin, y + 6);
      doc.text(`Individual MLO NMLS #${purchaseLenderInfo.loanOfficerNmls}`, W / 2, y + 6);
      y += 11;
      doc.text(purchaseLenderInfo.addressLine2, margin, y + 6);
      y += 16;
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(110, 110, 110);
      doc.text("Interest Rate", margin, y + 10);
      doc.setFont("helvetica", "italic");
      doc.text(
        formatAprParenthetical(feeWorksheet.aprPct),
        margin + doc.getTextWidth("Interest Rate "),
        y + 10,
      );
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 30, 30);
      doc.text(`${calc.finalRate.toFixed(3)}%`, W - margin, y + 10, { align: "right" });
      y += 12;
      y += 10;

      renderFeeSection(feeWorksheet.lenderFees);
      renderFeeSection(feeWorksheet.thirdPartyFees);
      renderFeeSection(feeWorksheet.govFees);
      renderFeeSection(feeWorksheet.prepaids);
      subtotalRow("Total Estimated Closing Costs", feeWorksheet.totalClosingCosts);
      y += 8;
      renderFeeSection(feeWorksheet.monthlyHousing);

      // Funds to close (A − B)
      sectionHeader("Estimated Funds to Close");
      feeWorksheet.fundsToClose.lines.forEach((l) => feeRow(l.label, l.amount, l.note));
      subtotalRow("Total Funds from Borrower (A)", feeWorksheet.fundsToClose.fundsFromBorrower);
      if (feeWorksheet.fundsToClose.credits.length > 0) {
        groupHeading("Credits");
        feeWorksheet.fundsToClose.credits.forEach((l) => feeRow(l.label, l.amount, l.note));
        subtotalRow("Total Credits (B)", feeWorksheet.fundsToClose.totalCredits);
      }
      subtotalRow("Estimated Cash to Close (A − B)", feeWorksheet.fundsToClose.estimatedCash);
      y += 10;

      doc.setFontSize(8);
      doc.setFont("helvetica", "italic");
      doc.setTextColor(120, 120, 120);
      const wsDisclaimer =
        "All fees and the APR shown are estimates for illustration only and are not a Loan Estimate or a commitment to lend. " +
        "Actual fees, rates, and APR vary by lender, property, and closing date — request an official Loan Estimate from your lender.";
      doc.splitTextToSize(wsDisclaimer, W - margin * 2).forEach((line: string) => {
        checkPage(12);
        doc.text(line, margin, y + 10);
        y += 11;
      });
      doc.setTextColor(30, 30, 30);
    }

    // ── Footer ─────────────────────────────────────────────────────────────
    const totalPages = (doc as any).internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      const pageH = doc.internal.pageSize.getHeight();
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(160, 160, 160);
      hLine(pageH - 30);
      doc.text("Havo · sales@havofl.com · (813) 214-8356 · This estimate is for informational purposes only.", margin, pageH - 16);
      doc.text(`Page ${i} of ${totalPages}`, W - margin, pageH - 16, { align: "right" });
    }

    const logoResponse=await fetch("/equal-housing-opportunity.png");
    if(!logoResponse.ok)throw new Error("Equal Housing logo unavailable");
    const logo=new Uint8Array(await logoResponse.arrayBuffer());
    for(let i=1;i<=totalPages;i++){
      doc.setPage(i);const h=doc.internal.pageSize.getHeight();
      doc.setFillColor(255,255,255);doc.rect(0,h-58,W,58,"F");
      doc.addImage(logo,"PNG",margin,h-54,28,28);
      doc.setTextColor(60,60,60);doc.setFontSize(7);
      doc.text("Christian Tateo NMLS #1223755 · Barrett Financial Group NMLS #181106",margin+34,h-43);
      doc.text("Estimate only, not a loan offer or commitment to lend.",margin+34,h-31);
    }
    doc.save(buildScenarioFileName("purchase", address));
  }

  // Lead capture dialog
  const [leadDialogOpen, setLeadDialogOpen] = useState(false);
  const [leadDialogAction, setLeadDialogAction] = useState<"share" | "save">("share");
  const [leadScenarioDetails, setLeadScenarioDetails] = useState<string | undefined>();

  function buildScenarioDetails(): string {
    const { purchasePrice, loanType } = inputs;
    const c = calc;
    const money = (n: number) => "$" + Math.round(n).toLocaleString();
    const loanLabel = loanType === "conventional" ? "Conventional" : loanType === "jumbo" ? "Jumbo" : loanType === "fha" ? "FHA" : loanType === "va" ? "VA" : loanType === "usda" ? "USDA" : loanType === "dscr" ? "DSCR" : loanType === "bank_statement" ? "Bank Statement" : (loanType as string).toUpperCase();
    return [
      `Purchase Price: ${money(purchasePrice)}`,
      `Down Payment: ${money(c.downPaymentAmt)} (${Number(c.effectiveDownPaymentPct).toFixed(1)}%)`,
      `Loan Amount: ${money(c.loanAmount)}`,
      `Loan Type: ${loanLabel}`,
      `Interest Rate: ${c.finalRate.toFixed(3)}%`,
      ...(aprPct !== null ? [`Est. APR: ${aprPct.toFixed(3)}%`] : []),
      ...(c.dpaActive
        ? [`DPA: ${c.dpaPct}% (${money(c.dpaAmount)}) · ${c.dpaSecondType === "amortizing" ? `10-yr 2nd @ ${c.dpaSecondRate.toFixed(3)}% (${money(c.dpaSecondMonthly)}/mo)` : "silent 2nd (no payments)"}`]
        : []),
      `Monthly P&I: ${money(c.pi)}`,
      `Property Taxes: ${c.taxComplete ? `${money(inputs.annualTaxes)}/yr (${taxSource()})` : "Unavailable — enter the annual bill manually"}`,
      ...(quickTax.result && taxSource() !== "manual" ? [
        `Property Tax Evidence: ${quickTax.result.label}; ${quickTax.result.sourceName}; ${quickTax.result.sourceUrl ?? "source URL not supplied"}; tax year ${quickTax.result.taxYear ?? "unknown"}; rates year ${quickTax.result.ratesYear ?? "unknown"}; NAV ${quickTax.result.navPending ? "pending" : quickTax.result.nav ?? "unavailable"}; official verification ${quickTax.result.officialState}`,
      ] : []),
      `Total Monthly Housing: ${c.taxComplete ? money(c.totalHousing) : "Incomplete — property taxes unavailable"}`,
      `Est. Cash to Close: ${c.taxComplete ? money(c.cashToClose) : "Incomplete — property taxes unavailable"}`,
    ].join(" | ");
  }

  function openLeadDialog(action: "share" | "save") {
    setLeadDialogForScenario(false);
    setLeadDialogAction(action);
    setLeadScenarioDetails(buildScenarioDetails());
    setLeadDialogOpen(true);
  }

  function handleLeadSuccess() {
    if (leadDialogForScenario) {
      setLeadDialogForScenario(false);
      setShowAddressPrompt(true);
    } else if (leadDialogAction === "share") {
      const url = window.location.href;
      navigator.clipboard.writeText(url).catch(() => {});
      toast({ title: "Link copied!", description: "Share the URL with anyone to show this estimate." });
    } else {
      toast({ title: "Scenario saved!", description: "Your estimate scenario has been saved." });
    }
  }

  // Editable address
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [editAddressVal, setEditAddressVal] = useState(address);
  const {
    bindInputRef: addressInputRef,
    inputRef: addressInputElementRef,
  } = useGooglePlaces({
    enabled: isEditingAddress,
    onPlaceSelected: async place => {
      if (!await authorize("purchase", place.formatted_address)) return;
      setIsEditingAddress(false);
      setLocation(`/estimate?address=${encodeURIComponent(place.formatted_address)}`);
    },
  });

  useEffect(() => {
    if (!isEditingAddress) return;
    setEditAddressVal(address);
    const timer = setTimeout(() => addressInputElementRef.current?.select(), 30);
    return () => clearTimeout(timer);
  }, [address, addressInputElementRef, isEditingAddress]);

  const defaultPrice = 350000;

  // Live mortgage rates from mortgagenewsdaily.com
  const { data: liveRates } = useQuery<{ conventional: number; fha: number; va: number; usda?: number; source: string; lastUpdated: string | null }>({
    queryKey: ["/api/mortgage-rates"],
    staleTime: 60 * 60 * 1000,
  });

  // FEMA flood zone for the entered address
  const { data: floodData } = useQuery<{ zone: string; subtype: string; requiresFloodInsurance: boolean }>({
    queryKey: ["/api/flood-zone", address],
    queryFn: () => authedFetch(`/api/flood-zone?address=${encodeURIComponent(address)}`).then(r => { if (!r.ok) throw new Error("Flood zone not found"); return r.json(); }),
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
  });

  // Sync flood insurance with zone data whenever address changes
  const floodLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (floodData && floodLoadedRef.current !== address) {
      floodLoadedRef.current = address;
      if (suppressSeparateFloodInsurance(inputsRef.current.propertyType)) {
        setInputs((p) => enforceFloodInsurancePolicy(p));
      } else if (!floodData.requiresFloodInsurance) {
        setInputs((p) => ({ ...p, annualFloodIns: 0 }));
      } else {
        // Restore default flood insurance when switching to a high-risk zone
        setInputs((p) =>
          suppressSeparateFloodInsurance(p.propertyType)
            ? enforceFloodInsurancePolicy(p)
            : { ...p, annualFloodIns: p.annualFloodIns === 0 ? 2000 : p.annualFloodIns },
        );
      }
    }
  }, [floodData, address]);

  // Area Median Income for the entered address
  const { data: amiData } = useQuery<{ areaName: string; annualAMI: number; monthlyAMI: number; source: string }>({
    queryKey: ["/api/ami", address],
    queryFn: () => authedFetch(`/api/ami?address=${encodeURIComponent(address)}`).then(r => { if (!r.ok) throw new Error("AMI not found"); return r.json(); }),
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
  });

  // Set monthly income to AMI once loaded (only on first load) — but
  // NEVER overwrite a value the user has manually entered. The Source
  // check is the only guard that keeps a user's $8,000 alive across
  // refresh / login / address change / AMI recompute.
  const amiLoadedRef = useRef(false);
  useEffect(() => {
    if (amiData && !amiLoadedRef.current) {
      amiLoadedRef.current = true;
      setInputs((p) => {
        if (p.monthlyIncomeSource === "manual") {
          return p;
        }
        return {
          ...p,
          monthlyIncome: amiData.monthlyAMI,
          monthlyIncomeSource: "ami_default",
        };
      });
    }
  }, [amiData]);
  // Jumbo prices like Conventional for now, so live rates (which have
  // no jumbo key) get it mirrored explicitly — every `(rates as any)
  // [loanType]` lookup then resolves correctly for jumbo too.
  const rates = { ...(liveRates ?? FALLBACK_RATES), jumbo: (liveRates ?? FALLBACK_RATES).conventional };

  // Builds the starting Inputs for an address, restoring any tunable fields
  // the user previously saved on the dashboard so we don't overwrite their
  // saved estimate with default-derived numbers on revisit.
  //
  // Three cases:
  //   1. There's a saved scenario for THIS exact address → restore it
  //      (revisit / refresh / login). Existing behavior.
  //   2. No saved scenario for THIS address, but the user has OTHER
  //      saved Purchase scenarios → carry the borrower-level prefs from
  //      the most recently saved one so they don't have to re-pick loan
  //      type, down-payment style, deferred student loans, or discount
  //      points for the new property. Property-level fields stay at
  //      defaults and are filled in from Zillow + the questionnaire.
  //   3. No saved Purchase scenarios at all (or logged out) → clean
  //      defaults. The questionnaire (Pages 1-3) collects the rest.
  function inputsForAddress(addr: string): Inputs {
    const base = makeDefaultInputs(defaultPrice);
    if (typeof window === "undefined") return base;
    const hasSession = getSession() !== null;
    if (!hasSession || !addr) return base;
    const key = addr.trim().toLowerCase();
    const allSaved = getPurchaseScenarios();
    const saved = allSaved.find(s => s.address.trim().toLowerCase() === key);
    if (!saved) {
      // Case 2: borrower-level carry from the most recent OTHER scenario.
      const others = allSaved
        .filter(s => s.address.trim().toLowerCase() !== key)
        .slice()
        .sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
      const source = others[0];
      if (!source) {
        console.debug("[purchase-new-scenario] user has existing purchase scenarios", false);
        return base;
      }
      console.debug("[purchase-new-scenario] user has existing purchase scenarios", true);
      console.debug("[purchase-new-scenario] source scenario id", source.id);
      const validLoanTypesC2 = ["conventional", "jumbo", "fha", "va", "usda", "dscr", "bank_statement"] as const;
      const carriedLoanType = validLoanTypesC2.includes(source.loanType as any)
        ? (source.loanType as Inputs["loanType"])
        : base.loanType;
      const carriedDpMode: "percent" | "amount" =
        source.downPaymentMode === "amount" ? "amount" : "percent";
      const carriedDpPct = Math.min(
        source.downPaymentPct ?? base.downPaymentPct,
        MAX_DOWN_PAYMENT_PCT,
      );
      console.debug("[purchase-new-scenario] borrower fields copied", {
        loanType: carriedLoanType,
        downPaymentPct: carriedDpPct,
        downPaymentMode: carriedDpMode,
        hasDeferredStudentLoans: source.hasDeferredStudentLoans ?? false,
        deferredStudentLoanBalance: source.deferredStudentLoanBalance ?? 0,
        discountPointsPct: source.discountPointsPct ?? 0,
      });
      console.debug("[purchase-new-scenario] property fields reset");
      console.debug("[purchase-new-scenario] new address applied", addr);
      // Borrower/user-level Page 1 + Page 2 answers belong to the user,
      // not the property, so carry them into the new home search. Only a
      // MANUALLY entered income is carried forward — an AMI/default income
      // is county-specific, so a brand-new address should re-default it.
      const carriedIncome =
        source.monthlyIncomeSource === "manual" && typeof source.monthlyIncome === "number"
          ? { monthlyIncome: source.monthlyIncome, monthlyIncomeSource: "manual" as const }
          : {};
      console.debug("[purchase-profile-prefill] applied to new scenario", {
        occupancy: source.occupancyType,
        monthlyIncome:
          "monthlyIncome" in carriedIncome ? carriedIncome.monthlyIncome : "(re-defaulted)",
        monthlyDebts: source.monthlyDebts,
        creditScore: source.creditScore,
        reserves: source.reserves,
        isVeteran: source.isVeteran,
        hasMortgage: source.hasMortgage,
        hasRentalIncome: source.hasRentalIncome,
      });
      return {
        ...base,
        loanType: carriedLoanType,
        downPaymentPct: carriedDpPct,
        downPaymentMode: carriedDpMode,
        downPaymentAmount: Math.round(base.purchasePrice * (carriedDpPct / 100)),
        hasDeferredStudentLoans:
          typeof source.hasDeferredStudentLoans === "boolean"
            ? source.hasDeferredStudentLoans
            : base.hasDeferredStudentLoans,
        deferredStudentLoanBalance:
          typeof source.deferredStudentLoanBalance === "number"
            ? source.deferredStudentLoanBalance
            : base.deferredStudentLoanBalance,
        discountPointsPct: snapDiscountPoints(
          typeof source.discountPointsPct === "number"
            ? source.discountPointsPct
            : base.discountPointsPct,
        ),
        // ── Page 1 borrower-level carry-forward ──
        occupancy: source.occupancyType ?? base.occupancy,
        propertyUseSelected: ["primary","secondary","investment"].includes(source.occupancyType ?? ""),
        monthlyDebts:
          typeof source.monthlyDebts === "number" ? source.monthlyDebts : base.monthlyDebts,
        creditScore:
          typeof source.creditScore === "number" ? source.creditScore : base.creditScore,
        reserves: typeof source.reserves === "number" ? source.reserves : base.reserves,
        ...carriedIncome,
        // ── Page 2 borrower-level carry-forward ──
        isVeteran: typeof source.isVeteran === "boolean" ? source.isVeteran : base.isVeteran,
        vaDisability:
          typeof source.vaDisability === "boolean" ? source.vaDisability : base.vaDisability,
        vaDisabilityRating100:
          typeof source.vaDisabilityRating100 === "boolean"
            ? source.vaDisabilityRating100
            : base.vaDisabilityRating100,
        vaLoanUse: source.vaLoanUse ?? base.vaLoanUse,
        hasMortgage:
          typeof source.hasMortgage === "boolean" ? source.hasMortgage : base.hasMortgage,
        currentLoanFHA:
          typeof source.currentLoanFHA === "boolean"
            ? source.currentLoanFHA
            : base.currentLoanFHA,
        hasRentalIncome:
          typeof source.hasRentalIncome === "boolean"
            ? source.hasRentalIncome
            : base.hasRentalIncome,
        monthlyRentalIncome:
          typeof source.monthlyRentalIncome === "number"
            ? source.monthlyRentalIncome
            : base.monthlyRentalIncome,
        rentalType: source.rentalType ?? base.rentalType,
      };
    }
    const price = saved.price ?? base.purchasePrice;
    const validLoanTypes = ["conventional", "jumbo", "fha", "va", "usda", "dscr", "bank_statement"] as const;
    const loanType = validLoanTypes.includes(saved.loanType as any)
      ? (saved.loanType as Inputs["loanType"])
      : base.loanType;
    // Reconcile saved DP mode + pct + amount so Page 4 picks up
    // whatever the user last set on Page 3 (or in a previous Page 4
    // session). When the saved mode is "amount" and a $ value is
    // present, the pct is recomputed from amount/price so the two
    // stay coherent even if the price has since changed.
    const savedMode: "percent" | "amount" =
      saved.downPaymentMode === "amount" ? "amount" : "percent";
    // Clamp rehydrated values to the same [minDown..75%] window the
    // live editors enforce so saved scenarios from before the 75%
    // cap (or with stale price) can never re-introduce a >75% DP.
    const savedPct = Math.min(saved.downPaymentPct ?? base.downPaymentPct, MAX_DOWN_PAYMENT_PCT);
    let dpPct = savedPct;
    let dpAmt =
      saved.downPaymentAmount != null
        ? Math.round(saved.downPaymentAmount)
        : Math.round(price * (savedPct / 100));
    if (savedMode === "amount" && price > 0) {
      const maxAmt = Math.floor(price * (MAX_DOWN_PAYMENT_PCT / 100));
      const clampedAmt = Math.max(0, Math.min(dpAmt, maxAmt));
      dpAmt = clampedAmt;
      dpPct = Math.round((clampedAmt / price) * 10000) / 100;
    } else if (savedMode === "percent") {
      dpAmt = Math.round(price * (dpPct / 100));
    }
    const restoredPropertyType = saved.propertyType ?? base.propertyType;
    return enforceFloodInsurancePolicy({
      ...base,
      purchasePrice: price,
      purchasePriceSource:
        saved.priceSource === "manual"
          ? "user"
          : saved.priceSource === "zillow"
            ? "zillow_cache"
            : "default",
      downPaymentPct: dpPct,
      downPaymentMode: savedMode,
      downPaymentAmount: dpAmt,
      interestRate: saved.interestRate ?? base.interestRate,
      loanType,
      // Phase 2: restore the user's saved Occupancy / Property Use so
      // refresh/logout/login round-trips it and the Insurance default
      // rule (HO3 / HO6 / DP3) re-evaluates from the correct value.
      propertyUseSelected: ["primary","secondary","investment"].includes(saved.occupancyType ?? ""),
      occupancy:
        saved.occupancyType === "primary" ||
        saved.occupancyType === "secondary" ||
        saved.occupancyType === "investment"
          ? saved.occupancyType
          : base.occupancy,
      // Restore saved annual taxes / HO insurance when present, else
      // fall back to the price-derived defaults. The annualHOIns line-
      // 2186 default-sync effect respects userAnswerSources to avoid
      // clobbering a restored or simulator-set value (see guard below).
      annualTaxes:
        saved.userAnswerSources?.annual_taxes === "manual" &&
        typeof saved.annualTaxes === "number" && Number.isFinite(saved.annualTaxes) && saved.annualTaxes >= 0
          ? saved.annualTaxes
          : 0,
      annualHOIns:
        typeof saved.annualHOIns === "number" && Number.isFinite(saved.annualHOIns)
          ? saved.annualHOIns
          : calculateDefaultHomeownersInsurance(price).annualInsurance,
      // Restore saved Property Type + provenance so a "manual" pick
      // survives reload/login and Zillow refreshes can't overwrite it.
      propertyType: restoredPropertyType,
      propertyTypeSource:
        saved.propertyTypeSource === "manual" ||
        saved.propertyTypeSource === "zillow" ||
        saved.propertyTypeSource === "default"
          ? saved.propertyTypeSource
          : base.propertyTypeSource,
      // Deferred student loans: restore the Yes/No answer and the
      // entered balance so DTI math is consistent after refresh.
      hasDeferredStudentLoans:
        typeof saved.hasDeferredStudentLoans === "boolean"
          ? saved.hasDeferredStudentLoans
          : base.hasDeferredStudentLoans,
      deferredStudentLoanBalance:
        typeof saved.deferredStudentLoanBalance === "number"
          ? saved.deferredStudentLoanBalance
          : base.deferredStudentLoanBalance,
      // Discount Points buydown: restore the user's slider position
      // so the closing-cost / rate impact survives refresh/login.
      // We re-derive cost + rate reduction every render from this
      // single value, so the persisted derived fields (cost, rate
      // reduction, before/after) are intentionally not read back.
      discountPointsPct: snapDiscountPoints(
        typeof saved.discountPointsPct === "number"
          ? saved.discountPointsPct
          : base.discountPointsPct,
      ),
      // Borrower monthly income — restore the user's entered value and
      // its provenance so the AMI-prefill effect (which runs after this
      // initial render) will short-circuit on `manual` and won't
      // overwrite it on refresh / login / address change.
      monthlyIncome:
        typeof saved.monthlyIncome === "number" && Number.isFinite(saved.monthlyIncome)
          ? saved.monthlyIncome
          : base.monthlyIncome,
      monthlyIncomeSource:
        saved.monthlyIncomeSource === "manual" ||
        saved.monthlyIncomeSource === "ami_default" ||
        saved.monthlyIncomeSource === "default"
          ? saved.monthlyIncomeSource
          : base.monthlyIncomeSource,
      // ── 2026_05_28 comprehensive borrower-answer restore ──
      // Every user-edited field on Pages 1-4 reloads exactly as entered.
      // Numeric fields use type narrowing + Number.isFinite to ignore
      // legacy NaN/null. Yes/no fields preserve `null` (unanswered)
      // distinctly from `false` (answered no).
      monthlyDebts:
        typeof saved.monthlyDebts === "number" && Number.isFinite(saved.monthlyDebts)
          ? saved.monthlyDebts : base.monthlyDebts,
      creditScore:
        typeof saved.creditScore === "number" && Number.isFinite(saved.creditScore)
          ? saved.creditScore : base.creditScore,
      reserves:
        typeof saved.reserves === "number" && Number.isFinite(saved.reserves)
          ? saved.reserves : base.reserves,
      isVeteran:
        saved.isVeteran === true || saved.isVeteran === false || saved.isVeteran === null
          ? saved.isVeteran : base.isVeteran,
      vaDisability:
        saved.vaDisability === true || saved.vaDisability === false || saved.vaDisability === null
          ? saved.vaDisability : base.vaDisability,
      vaDisabilityRating100:
        saved.vaDisabilityRating100 === true || saved.vaDisabilityRating100 === false || saved.vaDisabilityRating100 === null
          ? saved.vaDisabilityRating100 : base.vaDisabilityRating100,
      vaLoanUse:
        saved.vaLoanUse === "first" || saved.vaLoanUse === "second" || saved.vaLoanUse === null
          ? saved.vaLoanUse : base.vaLoanUse,
      hasMortgage:
        saved.hasMortgage === true || saved.hasMortgage === false || saved.hasMortgage === null
          ? saved.hasMortgage : base.hasMortgage,
      currentLoanFHA:
        saved.currentLoanFHA === true || saved.currentLoanFHA === false || saved.currentLoanFHA === null
          ? saved.currentLoanFHA : base.currentLoanFHA,
      hasRentalIncome:
        saved.hasRentalIncome === true || saved.hasRentalIncome === false || saved.hasRentalIncome === null
          ? saved.hasRentalIncome : base.hasRentalIncome,
      monthlyRentalIncome:
        typeof saved.monthlyRentalIncome === "number" && Number.isFinite(saved.monthlyRentalIncome)
          ? saved.monthlyRentalIncome : base.monthlyRentalIncome,
      rentalType:
        saved.rentalType === "annual" || saved.rentalType === "short-term" || saved.rentalType === null
          ? saved.rentalType : base.rentalType,
      sellerConcessions:
        typeof saved.sellerConcessions === "number" && Number.isFinite(saved.sellerConcessions)
          ? saved.sellerConcessions : base.sellerConcessions,
      sellerConcessionsMode:
        saved.sellerConcessionsMode === "percent" || saved.sellerConcessionsMode === "amount"
          ? saved.sellerConcessionsMode : base.sellerConcessionsMode,
      annualFloodIns:
        effectiveAnnualFloodInsurance(
          restoredPropertyType,
          typeof saved.annualFloodIns === "number" && Number.isFinite(saved.annualFloodIns)
            ? saved.annualFloodIns
            : base.annualFloodIns,
        ),
      hoaMonthly:
        typeof saved.hoaMonthly === "number" && Number.isFinite(saved.hoaMonthly)
          ? saved.hoaMonthly : base.hoaMonthly,
      cddAnnual:
        typeof saved.cddAnnual === "number" && Number.isFinite(saved.cddAnnual)
          ? saved.cddAnnual : base.cddAnnual,
      impactWindows:
        typeof saved.impactWindows === "boolean" ? saved.impactWindows : base.impactWindows,
      roofAttachment:
        typeof saved.roofAttachment === "string" ? saved.roofAttachment : base.roofAttachment,
      swr: typeof saved.swr === "boolean" ? saved.swr : base.swr,
      userAnswerSources: (() => {
        // Start from the saved source map (or base), then auto-stamp
        // `annual_ho_ins` if the saved insurance value is present and
        // doesn't match the price-derived default. This protects legacy
        // rows (saved before the source map existed) and any future
        // writer that bypasses the source-stamping path: without this,
        // the line-2186 default-sync useEffect would clobber the
        // restored value on first render.
        const base0 = (saved.userAnswerSources && typeof saved.userAnswerSources === "object")
          ? { ...saved.userAnswerSources }
          : { ...(base.userAnswerSources ?? {}) };
        const savedHo = typeof saved.annualHOIns === "number" && Number.isFinite(saved.annualHOIns)
          ? saved.annualHOIns : null;
        if (savedHo != null && !base0.annual_ho_ins) {
          const yearBuilt = validInsuranceYearBuilt(base0.insurance_year_built);
          const defaultHo = Math.round(
            price * getBaselineHomeownersInsuranceRate({ yearBuilt }),
          );
          if (Math.abs(savedHo - defaultHo) > 1) {
            base0.annual_ho_ins = "manual";
          }
        }
        return Object.keys(base0).length > 0 ? base0 : undefined;
      })(),
      // FHA DPA answers round-trip through the persisted
      // `userAnswerSources` jsonb (no dedicated columns needed).
      ...(() => {
        const uas = (saved.userAnswerSources && typeof saved.userAnswerSources === "object")
          ? (saved.userAnswerSources as Record<string, string>)
          : {};
        return {
          dpaEnabled:
            uas.dpa_enabled === "yes" ? true :
            uas.dpa_enabled === "no" ? false :
            base.dpaEnabled ?? null,
          dpaPct:
            uas.dpa_pct === "3.5" ? (3.5 as const) :
            uas.dpa_pct === "5" ? (5 as const) :
            base.dpaPct ?? null,
          dpaSecondType:
            uas.dpa_second === "amortizing" || uas.dpa_second === "silent"
              ? uas.dpa_second
              : base.dpaSecondType ?? null,
        };
      })(),
    });
  }

  const [inputs, setInputs] = useAnonymousDraft<Inputs>("inputs", () => inputsForAddress(address));
  const confirmedInputs=useRef("");
  useEffect(()=>{
    const key=JSON.stringify([activeScenarioId,inputs.monthlyIncome,inputs.monthlyDebts,inputs.creditScore,inputs.downPaymentPct,inputs.purchasePrice]);
    if(confirmedInputs.current && confirmedInputs.current!==key && inputs.qualificationInputsConfirmed)
      setInputs(p=>({...p,qualificationInputsConfirmed:false}));
    confirmedInputs.current=key;
  },[activeScenarioId,inputs.monthlyIncome,inputs.monthlyDebts,inputs.creditScore,inputs.downPaymentPct,inputs.purchasePrice]);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  // Fast planning estimates and independent official verification share a
  // guarded tuple; neither may overwrite a manually entered bill.
  const activeTaxAddress = scenarios.find(s => s.id === activeScenarioId)?.address || address;
  // The navigation address is included too: URL edits can precede the
  // scenario-address sync effect by one render.
  const taxRequestKey = JSON.stringify([
    officialTaxRequestKey(activeScenarioId, activeTaxAddress, inputs.purchasePrice, inputs.occupancy === "primary"),
    address,
    inputs.propertyUseSelected === true,
    inputs.occupancy,
  ]);
  const quickTax = useQuickPropertyTax({
    scenarioId: activeScenarioId, address: activeTaxAddress,
    purchasePrice: inputs.purchasePrice, isPrimaryResidence: inputs.occupancy === "primary",
    propertyUseSelected: inputs.propertyUseSelected === true,
    requestScope: address,
  });
  const currentTaxRequest = {
    key: taxRequestKey, loading: quickTax.loading,
    breakdown: quickTax.result?.breakdown, reason: quickTax.reason,
    status: quickTax.result?.status, annualTax: quickTax.result?.annualTax,
  };

  // Address strings can differ between the URL param and the saved
  // scenario row (Google appends ", USA"); compare them loosely so the
  // HCPA override isn't dropped over a formatting difference.
  function sameHcpaAddr(a: string, b: string): boolean {
    const norm = (s: string) =>
      s.toLowerCase().replace(/,\s*usa\s*$/, "").trim();
    return norm(a) === norm(b);
  }

  // Persist the amount and its exact status/evidence together. Estimate statuses
  // remain estimates in saved JSON even after an official lookup fails.
  useEffect(() => {
    const result = quickTax.result;
    if (!result || !inputs.propertyUseSelected) return;
    setInputs(current => {
      if (current.userAnswerSources?.annual_taxes === "manual") return current;
      if (current.purchasePrice !== inputs.purchasePrice || current.occupancy !== inputs.occupancy) return current;
      const annual = result.annualTax ?? 0;
      const provenance = JSON.stringify(result);
      if (current.annualTaxes === annual && current.userAnswerSources?.property_tax_provenance === provenance) return current;
      return { ...current, annualTaxes: annual,
        userAnswerSources: { ...current.userAnswerSources, annual_taxes: result.status,
          property_tax_provenance: provenance, property_tax_request_key: quickTax.key } };
    });
  // eslint-disable-next-line
  }, [quickTax.result, quickTax.key, inputs.propertyUseSelected, inputs.purchasePrice, inputs.occupancy]);

  /** Numeric compatibility for existing calculation writers. Missing official
   * taxes use an internal sentinel; taxSource gates every dependent disclosure.
   * VA eligibility never substitutes a zero for an unavailable county bill.
   */
  function computePropertyTax(
    address: string,
    purchasePrice: number,
    occupancy: "primary" | "secondary" | "investment",
    _vaDisabilityRating100: boolean | null,
    current: Inputs = inputsRef.current,
  ): number {
    // Manual bills are never changed by price, address, or exemption toggles.
    if (current.userAnswerSources?.annual_taxes === "manual") return current.annualTaxes;
    // Use live HCPA figure only when it was resolved for these exact inputs
    if (
      quickTax.result?.annualTax != null &&
      sameHcpaAddr(activeTaxAddress, address) &&
      inputs.purchasePrice === purchasePrice &&
      inputs.occupancy === occupancy && current.propertyUseSelected
    ) {
      return quickTax.result.annualTax;
    }
    return 0; // Internal sentinel only; all disclosures and totals gate on taxSource.
  }

  function taxSource(value: Inputs = inputs) {
    if(!value.propertyUseSelected) return "unavailable";
    return resolvePurchasePropertyTaxSource(
      value.annualTaxes, value.userAnswerSources?.annual_taxes,
      taxRequestKey, currentTaxRequest,
    );
  }

  function renderPropertyTaxRow() {
    return <PropertyTaxRow
      result={quickTax.result} loading={quickTax.loading} reason={quickTax.reason}
      propertyUse={inputs.propertyUseSelected ? inputs.occupancy : undefined}
      annualTax={taxSource() === "unavailable" ? quickTax.result?.annualTax ?? null : inputs.annualTaxes}
      manual={inputs.userAnswerSources?.annual_taxes === "manual"}
      onRefresh={quickTax.refresh}
      warnings={inputs.vaDisabilityRating100 === true && (inputs.occupancy === "primary"
        ? <p className="text-[11px] text-emerald-700" data-testid="note-va-property-tax-exemption">A 100% VA disability rating may qualify for a homestead property-tax exemption. The county property appraiser must confirm eligibility; taxes are not automatically set to $0.</p>
        : <p className="text-[11px] text-amber-700" data-testid="note-va-exemption-non-primary">Full property-tax exemption only applies when this property is your primary residence. Currently set to {inputs.occupancy}; verify the official bill or enter it manually.</p>)}
      onManualChange={amount => setInputs(current => ({
        ...current, annualTaxes: amount ?? quickTax.result?.annualTax ?? 0,
        userAnswerSources: { ...current.userAnswerSources,
          annual_taxes: amount === null ? quickTax.result?.status ?? "unavailable" : "manual",
          property_tax_provenance: amount === null ? JSON.stringify(quickTax.result ?? null) : JSON.stringify({status:"manual",annualTax:amount}),
        },
      }))}
    />;
  }

  // ── Insurance panel state ───────────────────────────────────────────────────
  const insuranceSectionRef = useRef<HTMLDivElement>(null);

  const [insRegionKey, setInsRegionKey] = useState<InsRegionKey>(() => getInsRegionFromAddress(address));
  const [insRoofIdx, setInsRoofIdx] = useState(1);
  const [insWindIdx, setInsWindIdx] = useState(1);
  const [insHurrIdx, setInsHurrIdx] = useState(0);
  const [insConstIdx, setInsConstIdx] = useState(0);
  const [insYearIdx, setInsYearIdx] = useState(1);
  const [insClaimsIdx, setInsClaimsIdx] = useState(0);
  // The detailed questionnaire is intentionally controlled here. Its values
  // translate into this route's established premium engine below; QuoteRUSH
  // and purchase-scenario persistence remain owned by this page.
  const [insurancePolicyType, setInsurancePolicyType] = useState<InsurancePolicyType>(() =>
    getDefaultInsurancePolicyType({
      occupancyType: inputs.propertyUseSelected ? inputs.occupancy : undefined,
      propertyType: inputs.propertyType,
    }) ?? "HO3",
  );
  const insurancePolicyTouchedRef = useRef(false);
  const [insuranceNewPurchase, setInsuranceNewPurchase] = useState<boolean | null>(true);
  const [insurancePurchaseDate, setInsurancePurchaseDate] = useState("");
  const [insurancePurchasePrice, setInsurancePurchasePrice] = useState(0);
  const [insuranceResidenceUse, setInsuranceResidenceUse] = useState<ResidenceUse>("primary");
  const [insuranceRentalTerm, setInsuranceRentalTerm] = useState<RentalTerm>("");
  const [insuranceRoofYear, setInsuranceRoofYear] = useState(new Date().getFullYear() - 10);
  const [insuranceRoofShape, setInsuranceRoofShape] = useState(2);
  const [insuranceSWR, setInsuranceSWR] = useState(1);
  const [insuranceYearBuilt, setInsuranceYearBuilt] = useState(
    () => validInsuranceYearBuilt(inputs.userAnswerSources?.insurance_year_built) ?? 1995,
  );
  const [insuranceAopDeductible, setInsuranceAopDeductible] = useState(2500);
  const [insuranceRebuild, setInsuranceRebuild] = useState(() =>
    Math.min(1_500_000, Math.max(150_000, inputs.purchasePrice)),
  );
  const insuranceRebuildTouchedRef = useRef(false);

  // Tracks whether the user has actively engaged the insurance simulator.
  const userTouchedInsuranceSimRef = useRef(false);
  const markInsuranceSimTouched = () => { userTouchedInsuranceSimRef.current = true; };
  function resetInsuranceQuestionnaire(nextInputs: Inputs) {
    insurancePolicyTouchedRef.current = false;
    insuranceRebuildTouchedRef.current = false;
    userTouchedInsuranceSimRef.current = false;
    setInsurancePolicyType(
      getDefaultInsurancePolicyType({
        occupancyType: nextInputs.propertyUseSelected ? nextInputs.occupancy : undefined,
        propertyType: nextInputs.propertyType,
      }) ?? "HO3",
    );
    setInsuranceNewPurchase(true);
    setInsurancePurchaseDate("");
    setInsuranceResidenceUse(nextInputs.occupancy);
    setInsuranceRentalTerm("");
    setInsuranceRebuild(
      Math.min(1_500_000, Math.max(150_000, nextInputs.purchasePrice)),
    );
    setInsuranceRoofYear(new Date().getFullYear() - 10);
    setInsuranceRoofShape(2);
    setInsuranceSWR(1);
    const nextYearBuilt =
      validInsuranceYearBuilt(nextInputs.userAnswerSources?.insurance_year_built) ?? 1995;
    setInsuranceYearBuilt(nextYearBuilt);
    setInsuranceAopDeductible(2500);
    setInsRoofIdx(1);
    setInsWindIdx(1);
    setInsHurrIdx(0);
    setInsConstIdx(0);
    setInsYearIdx(legacyInsuranceYearIndex(nextYearBuilt));
    setInsClaimsIdx(0);
  }

  // Auto-detect region whenever address changes (does NOT count as
  // a user interaction — it's driven by the address field).
  useEffect(() => {
    if (address && address !== "Unknown Address") {
      setInsRegionKey(getInsRegionFromAddress(address));
    }
  }, [address]);
  useEffect(() => {
    if (!insuranceRebuildTouchedRef.current) {
      setInsuranceRebuild(
        Math.min(1_500_000, Math.max(150_000, inputs.purchasePrice)),
      );
    }
  }, [inputs.purchasePrice]);
  useEffect(() => {
    if (insurancePolicyTouchedRef.current) return;
    const nextPolicy = getDefaultInsurancePolicyType({
      occupancyType: inputs.propertyUseSelected ? inputs.occupancy : undefined,
      propertyType: inputs.propertyType,
    });
    if (nextPolicy) setInsurancePolicyType(nextPolicy);
    setInsuranceResidenceUse(inputs.occupancy);
  }, [inputs.occupancy, inputs.propertyType]);

  // Calculate the planning premium from home-age bands plus the additive
  // frame surcharge. Other simulator factors refine that baseline.
  const insPremiumCalc = useMemo(() => {
    const rebuild = insuranceRebuild;
    const rawAdj = INS_ROOF_ADJ[insRoofIdx] * INS_WIND_ADJ[insWindIdx] * INS_HURR_ADJ[insHurrIdx]
              * INS_CLAIM_ADJ[insClaimsIdx];
    const neutral =
      INS_ROOF_ADJ[1] * INS_WIND_ADJ[1] * INS_HURR_ADJ[0]
      * INS_CLAIM_ADJ[0];
    const adj = rawAdj / neutral;
    const baselineRate = getBaselineHomeownersInsuranceRate({
      yearBuilt: insuranceYearBuilt,
      isFrameConstruction: insConstIdx === 2,
    });
    const midRate  = baselineRate * adj;
    const lowRate  = midRate * 0.85;
    const highRate = midRate * 1.15;
    return {
      low:   Math.round(rebuild * lowRate),
      mid:   Math.round(rebuild * midRate),
      high:  Math.round(rebuild * highRate),
      monthly: Math.round(rebuild * midRate / 12),
      hurrDeductible: Math.round(rebuild * [0.02, 0.05, 0.10][insHurrIdx]),
      hurrPct: [2, 5, 10][insHurrIdx],
    };
  }, [insuranceRebuild, insuranceYearBuilt, insRoofIdx, insWindIdx, insHurrIdx, insConstIdx, insClaimsIdx]);

  // Wire insurance midpoint into annualHOIns after simulator engagement.
  useEffect(() => {
    if (!userTouchedInsuranceSimRef.current) return;
    // Stamp source=simulator so the price-sync default writer below
    // (and any future load) recognizes the midpoint as authoritative
    // and won't fall back to the 0.75%-of-price default.
    setInputs(prev => ({
      ...prev,
      annualHOIns: insPremiumCalc.mid,
      userAnswerSources: { ...(prev.userAnswerSources ?? {}), annual_ho_ins: "simulator" },
    }));
  }, [insPremiumCalc.mid]);

  // Keep the age/construction baseline in sync until the user touches the
  // simulator. Once they have, the simulator-midpoint wire-up owns it.
  // ALSO skip when userAnswerSources.annual_ho_ins is "manual" or
  // "simulator" — that flag is restored from the saved scenario and
  // is the only thing that prevents this effect from clobbering a
  // round-tripped insurance value on the very first render after
  // refresh / login.
  useEffect(() => {
    if (userTouchedInsuranceSimRef.current) return;
    setInputs(prev => {
      const src = prev.userAnswerSources?.annual_ho_ins;
      if (src === "manual" || src === "simulator") {
        // Treat a restored saved value as a touched simulator so the
        // midpoint wire-up takes over for subsequent edits without
        // a one-shot clobber on mount.
        if (!userTouchedInsuranceSimRef.current) userTouchedInsuranceSimRef.current = true;
        return prev;
      }
      const target = Math.round(
        prev.purchasePrice *
        getBaselineHomeownersInsuranceRate({
          yearBuilt: insuranceYearBuilt,
          isFrameConstruction: insConstIdx === 2,
        }),
      );
      if (prev.annualHOIns === target) return prev;
      return { ...prev, annualHOIns: target };
    });
  }, [inputs.purchasePrice, insuranceYearBuilt, insConstIdx]);

  // Purchase-price changes always preserve the selected down-payment
  // percentage. The dollar amount changes with the price even when the
  // control is currently displaying dollar mode.
  useEffect(() => {
    setInputs((p) => {
      if (p.purchasePrice <= 0) return p;
      const newAmt = Math.round(p.purchasePrice * (p.downPaymentPct / 100));
      if (newAmt === p.downPaymentAmount) return p;
      return { ...p, downPaymentAmount: newAmt };
    });
  }, [inputs.purchasePrice]);

  // Clamp seller concessions whenever loan type, occupancy, or down payment changes
  useEffect(() => {
    const maxC = getMaxSellerConcessions(inputs.loanType, inputs.occupancy, inputs.downPaymentPct, inputs.purchasePrice);
    const allowed = !(
      (inputs.loanType === "fha" || inputs.loanType === "usda" || inputs.loanType === "va") &&
      inputs.occupancy !== "primary"
    );
    if (!allowed) {
      setInputs((p) => ({ ...p, sellerConcessions: 0 }));
    } else if (inputs.sellerConcessions > maxC) {
      setInputs((p) => ({ ...p, sellerConcessions: Math.round(maxC) }));
    }
  }, [inputs.loanType, inputs.occupancy, inputs.downPaymentPct, inputs.purchasePrice]);

  // Sync interest rate to live rate (with credit + occupancy adjustments) when rates first load
  const ratesLoadedRef = useRef(false);
  useEffect(() => {
    if (liveRates && !ratesLoadedRef.current) {
      ratesLoadedRef.current = true;
      setInputs((p) => ({ ...p, interestRate: fullRate((rates as any)[p.loanType] ?? liveRates.fha, p.creditScore, p.occupancy, p.downPaymentPct, p.loanType, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (p.downPaymentPct ?? 0) / 100)) }));
    }
  }, [liveRates]);

  // Recompute the rate whenever the monthly income or the resolved
  // county AMI changes. These two values feed the Conventional AMI
  // discount but are NOT inputs to the existing setLoanType /
  // setOccupancy / setCreditScore / setDownPayment handlers, so
  // without this effect a user typing a new income on Page 3/4 (or
  // the async /api/ami response arriving) would leave the rate
  // stale. Guarded on loanType === "conventional" && primary so it's
  // a no-op for every other flow (FHA, VA, USDA, DSCR, Bank
  // Statement, Secondary, Investment) and can never double-apply.
  useEffect(() => {
    if (inputs.loanType !== "conventional" || inputs.occupancy !== "primary") return;
    setInputs((p) => {
      const baseRate = (rates as any)[p.loanType] ?? rates.conventional;
      const next = fullRate(baseRate, p.creditScore, p.occupancy, p.downPaymentPct, p.loanType, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (p.downPaymentPct ?? 0) / 100));
      return next === p.interestRate ? p : { ...p, interestRate: next };
    });
  }, [inputs.monthlyIncome, amiData?.annualAMI, inputs.loanType, inputs.occupancy]);

  // Recompute the rate whenever the property type changes so the
  // Conventional condo pricing add-on (+0.300%) is applied/removed
  // immediately when the user toggles between (e.g.) Single Family and
  // Condominium, or when a Zillow lookup fills in the property type.
  // `fullRate` recomputes from the live base rate every call, so this
  // can never double-apply. Non-condo / non-Conventional combos resolve
  // to the same rate and short-circuit via the identity check.
  useEffect(() => {
    setInputs((p) => {
      const baseRate = (rates as any)[p.loanType] ?? rates.conventional;
      const next = fullRate(baseRate, p.creditScore, p.occupancy, p.downPaymentPct, p.loanType, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (p.downPaymentPct ?? 0) / 100));
      return next === p.interestRate ? p : { ...p, interestRate: next };
    });
  }, [inputs.propertyType]);

  // Auto-recalculate property taxes whenever the address changes
  const taxAddressRef = useRef<string>("");
  useEffect(() => {
    if (address && address !== taxAddressRef.current) {
      taxAddressRef.current = address;
      setInputs((p) => ({
        ...p,
        annualTaxes: computePropertyTax(address, p.purchasePrice, p.occupancy, p.vaDisabilityRating100, p),
      }));
    }
  }, [address]);

  function getMinDown(lt: "conventional" | "jumbo" | "fha" | "va" | "usda" | "dscr" | "bank_statement", hasMortgage: boolean | null, occupancy?: "primary" | "secondary" | "investment"): number {
    if (occupancy === "investment") return 20;
    if (occupancy === "secondary") return 10;
    if (lt === "va" || lt === "usda") return 0;
    if (lt === "fha") return 3.5;
    return hasMortgage === true ? 5 : 3;
  }

  // ─── Purchase loan-type priority rule ───────────────────────────
  // On Page 3 (Purchase Details) the visible loan type must follow a
  // strict priority that beats whatever the user previously had
  // selected:
  //   1. Primary + Veteran          → VA   (overrides everything)
  //   2. Primary + FICO < 720       → FHA  (only when not veteran)
  //   3. Otherwise no recommendation (existing selection wins).
  // Non-primary (Secondary / Investment) is never auto-defaulted to
  // FHA or VA — those programs require Primary occupancy.
  // Returns null when no rule applies.
  function getPurchaseRecommendedLoanType(args: {
    occupancy: "primary" | "secondary" | "investment";
    creditScore: number;
    isVeteran: boolean | null;
  }): "fha" | "va" | null {
    if (args.occupancy !== "primary") return null;
    if (args.isVeteran === true) return "va";
    // Strict "not a veteran" per spec — `null` means unanswered and
    // is treated as unknown so we don't auto-pick FHA before the
    // veteran question is answered on Page 2.
    if (args.isVeteran === false && Number(args.creditScore) < 720) return "fha";
    return null;
  }

  function setLoanType(lt: "conventional" | "jumbo" | "fha" | "va" | "usda" | "dscr" | "bank_statement") {
    setInputs((p) => {
      const newMin = getMinDown(lt, p.hasMortgage, p.occupancy);
      const newDown = clampDownPaymentPct(p.downPaymentPct, newMin);
      const baseRate = (lt === "dscr" || lt === "bank_statement") ? rates.conventional : ((rates as any)[lt] ?? rates.conventional);
      return {
        ...p,
        loanType: lt,
        interestRate: fullRate(baseRate, p.creditScore, p.occupancy, newDown, lt, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (newDown ?? 0) / 100)),
        downPaymentPct: newDown,
      };
    });
  }

  function setOccupancy(occ: "primary" | "secondary" | "investment") {
    setInputs((p) => {
      p = {...p, propertyUseSelected:true};
      // Investment is limited to Conventional + DSCR (spec). Only
      // DSCR survives the occupancy switch as an "alt" — a previously
      // selected Bank Statement falls through and is replaced by
      // Conventional (or DSCR if sub-620), matching the new selector.
      const isAltInvestment = p.loanType === "dscr";
      console.debug("[loan-options] property use", occ);
      console.debug("[loan-options] selected loan type before", p.loanType);
      // Non-primary normally forces Conventional, but Conventional
      // requires 620+ FICO. For sub-620 investment, fall through to
      // DSCR (no FICO floor in the same way). For sub-620 secondary
      // there's no eligible program — keep Conventional so the
      // selector + warning communicates the ineligibility instead of
      // leaving `loanType` undefined.
      const belowConvMin = p.creditScore < CONVENTIONAL_MIN_FICO;
      const forcedLoan = occ === "primary" ? p.loanType
        : occ === "investment" && isAltInvestment ? p.loanType
        : occ === "investment" && belowConvMin ? "dscr"
        : "conventional";
      const newMin = getMinDown(forcedLoan, p.hasMortgage, occ);
      const newDown = clampDownPaymentPct(p.downPaymentPct, newMin);
      const baseRate = (forcedLoan === "dscr" || forcedLoan === "bank_statement") ? rates.conventional : ((rates as any)[forcedLoan] ?? rates.conventional);
      console.debug("[loan-options] allowed loan types", occ === "investment" ? ["conventional", "dscr"] : occ === "secondary" ? ["conventional"] : ["conventional", "fha", "va", "usda"]);
      console.debug("[loan-options] selected loan type after", forcedLoan);
      return {
        ...p,
        occupancy: occ,
        loanType: forcedLoan,
        interestRate: fullRate(baseRate, p.creditScore, occ, newDown, forcedLoan, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (newDown ?? 0) / 100)),
        downPaymentPct: newDown,
        rentalType: occ === "investment" ? p.rentalType : null,
        annualTaxes: computePropertyTax(address, p.purchasePrice, occ, p.vaDisabilityRating100, p),
      };
    });
  }

  function setCreditScore(score: number) {
    setInputs((p) => {
      p={...p,qualificationInputsConfirmed:false};
      const isAltLoan = p.loanType === "dscr" || p.loanType === "bank_statement";
      // Below Conventional's program floor (620), Conventional isn't a
      // valid option — auto-switch to FHA on primary residences so the
      // user lands on something pricable. On non-primary, leave whatever
      // alt-investment loan they have selected; pure Conventional on
      // non-primary with sub-620 credit is gated in the loan-type
      // selector with a warning instead of silently switching.
      const belowConvMin = score < CONVENTIONAL_MIN_FICO;
      const autoLoanType =
        isAltLoan ? p.loanType :
        // Sub-620 + primary → swap Conventional out for FHA so the
        // user lands on something pricable.
        belowConvMin && p.loanType === "conventional" && p.occupancy === "primary" ? "fha" :
        // Sub-620 + investment → swap Conventional out for DSCR
        // (alt-investment, no equivalent FICO floor).
        belowConvMin && p.loanType === "conventional" && p.occupancy === "investment" ? "dscr" :
        // Sub-620 + secondary → keep Conventional. There's no eligible
        // alternative; the selector renders Conventional disabled with
        // an explicit ineligibility warning so the state stays consistent.
        p.occupancy !== "primary" ? "conventional" :
        score < 720 && p.loanType === "conventional" ? "fha" :
        score >= 720 && p.loanType === "fha" ? "conventional" :
        p.loanType;
      const baseRate = isAltLoan ? rates.conventional : ((rates as any)[autoLoanType] ?? rates.conventional);
      return {
        ...p,
        creditScore: score,
        loanType: autoLoanType,
        interestRate: fullRate(baseRate, score, p.occupancy, p.downPaymentPct, autoLoanType, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (p.downPaymentPct ?? 0) / 100)),
      };
    });
  }

  // Normalize saved/stale loan-type + occupancy combos that the
  // current selectors no longer expose. Investment is now limited to
  // Conventional + DSCR (spec), so a saved Investment + Bank
  // Statement scenario would render an empty Select trigger. Snap it
  // to DSCR (the closest alt-investment program) so Page 3 / Page 4
  // stay in sync and the rate/closing-cost math re-derives cleanly.
  useEffect(() => {
    if (
      inputs.occupancy === "investment" &&
      inputs.loanType !== "conventional" &&
      inputs.loanType !== "dscr"
    ) {
      console.debug("[loan-options] normalizing stale investment loan type", inputs.loanType, "→ dscr");
      setLoanType("dscr");
    }
  }, [inputs.occupancy, inputs.loanType]);

  // Re-apply the Purchase loan-type priority rule whenever any input
  // it depends on changes, or whenever the user reaches Page 3. This
  // is what makes Primary + sub-720 land on FHA (and Primary + Veteran
  // land on VA) even when a saved scenario carried in a stale
  // Conventional selection. `inputs.loanType` is the same state Page 4
  // reads, so the two pages stay in sync automatically.
  useEffect(() => {
    const rec = getPurchaseRecommendedLoanType({
      occupancy: inputs.occupancy,
      creditScore: inputs.creditScore,
      isVeteran: inputs.isVeteran,
    });
    console.debug("[purchase-loan-default] credit score", inputs.creditScore);
    console.debug("[purchase-loan-default] occupancy/property use", inputs.occupancy);
    console.debug("[purchase-loan-default] veteran/VA eligible", inputs.isVeteran);
    console.debug("[purchase-loan-default] previous loan type", inputs.loanType);
    console.debug("[purchase-loan-default] recommended loan type", rec);
    if (!rec) {
      console.debug("[purchase-loan-default] final selected loan type", inputs.loanType, "(no rule applies)");
      return;
    }
    // FHA → snap to its standard 3.5%; VA → 0%.
    const targetDown = rec === "fha" ? 3.5 : 0;
    // Skip only when the loan type AND the down-payment already match
    // the recommendation. Without the DP check, FHA arriving via
    // setCreditScore's own auto-switch (which preserves the prior DP)
    // would leave a stale 5% / 20% in place, violating the spec's
    // "default DP to 3.5% when FHA wins" requirement.
    if (rec === inputs.loanType && inputs.downPaymentPct === targetDown) {
      console.debug("[purchase-loan-default] final selected loan type", inputs.loanType, "(already matches)");
      return;
    }
    setInputs((p) => {
      const newMin = getMinDown(rec, p.hasMortgage, p.occupancy);
      const newDown = Math.max(targetDown, newMin);
      const baseRate = (rates as any)[rec] ?? rates.conventional;
      console.debug("[purchase-loan-default] final selected loan type", rec);
      console.debug("[purchase-loan-default] updated fields", {
        loanType: rec,
        downPaymentPct: newDown,
        downPaymentAmount: Math.round(p.purchasePrice * (newDown / 100)),
      });
      console.debug("[purchase-loan-default] Page 3 visible loan type", rec);
      console.debug("[purchase-loan-default] Page 4 visible loan type", rec);
      return {
        ...p,
        loanType: rec,
        downPaymentPct: newDown,
        downPaymentAmount: Math.round(p.purchasePrice * (newDown / 100)),
        downPaymentMode: "percent",
        interestRate: fullRate(baseRate, p.creditScore, p.occupancy, newDown, rec, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (newDown ?? 0) / 100)),
      };
    });
    // NOTE: No FHA-DPA / `uses_dpa` / `dpa_type` fields exist in the
    // current Inputs / purchase_scenarios schema, so the spec's
    // "clear DPA state when VA wins" / "keep DPA available on FHA"
    // requirements are no-ops here — there is nothing to clear or
    // expose. If a DPA toggle is added later, reset it to false
    // alongside the `loanType: rec` write above.
    // NOTE: `step` is intentionally NOT a dependency. The rule must
    // fire on input/scenario changes so it can correct a stale
    // Conventional carried in from a saved scenario, but it must NOT
    // fire on mere step navigation — otherwise a user who manually
    // overrides loan type on Page 4 would see the rule clobber their
    // choice the moment they navigate back to Page 3.
  }, [inputs.occupancy, inputs.creditScore, inputs.isVeteran, activeScenarioId]);

  function setDownPayment(pct: number) {
    setInputs((p) => {
      p={...p,qualificationInputsConfirmed:false};
      const minDown = getMinDown(p.loanType, p.hasMortgage, p.occupancy);
      const newDown = Math.min(Math.max(pct, minDown), MAX_DOWN_PAYMENT_PCT);
      // Re-derive the $ amount so the Dollar-Amount input/display
      // stays in sync when the user edits the percent slider.
      const newAmt = Math.round(p.purchasePrice * (newDown / 100));
      return {
        ...p,
        downPaymentPct: newDown,
        downPaymentMode: "percent",
        downPaymentAmount: newAmt,
        interestRate: fullRate((rates as any)[p.loanType] ?? rates.conventional, p.creditScore, p.occupancy, newDown, p.loanType, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (newDown ?? 0) / 100)),
      };
    });
  }

  /** Dollar-Amount mode setter. Stores the user-typed dollar amount
   *  as canonical and derives pct from the current purchase price.
   *  Honors the same per-loan-type minimum DP enforced by
   *  `setDownPayment` (clamps amount up to `minPct * price` when the
   *  typed value would otherwise drop below program minimums). */
  function setDownPaymentDollars(amount: number) {
    setInputs((p) => {
      const maxAmt = Math.floor(p.purchasePrice * (MAX_DOWN_PAYMENT_PCT / 100));
      const safeAmt = Math.max(0, Math.min(amount, maxAmt));
      const minPct = getMinDown(p.loanType, p.hasMortgage, p.occupancy);
      const minAmt = Math.round(p.purchasePrice * (minPct / 100));
      const finalAmt = Math.max(safeAmt, minAmt);
      const finalPct =
        p.purchasePrice > 0
          ? Math.round((finalAmt / p.purchasePrice) * 10000) / 100
          : minPct;
      return {
        ...p,
        downPaymentAmount: finalAmt,
        downPaymentPct: finalPct,
        downPaymentMode: "amount",
        interestRate: fullRate((rates as any)[p.loanType] ?? rates.conventional, p.creditScore, p.occupancy, finalPct, p.loanType, p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (finalPct ?? 0) / 100)),
      };
    });
  }

  /** Toggle the DP control between Percentage and Dollar Amount.
   *  Switching never changes the numeric down-payment — it just
   *  flips which field the UI lets you edit. */
  function setDownPaymentMode(mode: "percent" | "amount") {
    setInputs((p) => {
      const amt =
        p.downPaymentAmount != null
          ? p.downPaymentAmount
          : Math.round(p.purchasePrice * (p.downPaymentPct / 100));
      return { ...p, downPaymentMode: mode, downPaymentAmount: amt };
    });
  }

  function handlePurchasePriceChange(value: number) {
    setInputs((p) => {
      const previousPrice = p.purchasePrice;
      const annualHOIns =
        previousPrice > 0 && p.annualHOIns > 0
          ? Math.round(p.annualHOIns * (value / previousPrice))
          : calculateDefaultHomeownersInsurance(value).annualInsurance;
      return {
        ...p,
        purchasePrice: value,
        purchasePriceSource: "user",
        downPaymentAmount: Math.round(value * (p.downPaymentPct / 100)),
        annualTaxes: computePropertyTax(
          address,
          value,
          p.occupancy,
          p.vaDisabilityRating100,
          p,
        ),
        annualHOIns,
      };
    });
  }

  function set<K extends keyof Inputs>(key: K, value: Inputs[K]) {
    setInputs((p) => ({ ...p, [key]: value }));
  }

  /** Reusable Seller Concessions control. Rendered on Page 3 (Loan
   *  Details) and Page 4 (See My Estimate → Real Estate card). Both
   *  surfaces edit the same canonical `inputs.sellerConcessions`
   *  dollar field, so they stay synced automatically and the value
   *  auto-saves with the rest of the inputs. Caps come from
   *  `getMaxSellerConcessions` and are enforced on every write. */
  function renderSellerConcessions(compact = false) {
    const maxConcessions = getMaxSellerConcessions(inputs.loanType, inputs.occupancy, inputs.downPaymentPct, inputs.purchasePrice);
    const price = inputs.purchasePrice;
    const pct = price > 0 ? (inputs.sellerConcessions / price) * 100 : 0;
    const maxPct = price > 0 ? (maxConcessions / price) * 100 : 0;
    const isLoanAllowed = !(
      (inputs.loanType === "fha" || inputs.loanType === "usda" || inputs.loanType === "va") &&
      inputs.occupancy !== "primary"
    );
    const mode = inputs.sellerConcessionsMode ?? "percent";
    const setMode = (m: "percent" | "amount") => set("sellerConcessionsMode", m);
    const setFromPct = (newPct: number) => {
      const dollars = price > 0 ? Math.round((price * newPct) / 100) : 0;
      set("sellerConcessions", Math.min(Math.max(0, dollars), Math.round(maxConcessions)));
    };
    const setFromAmount = (newAmt: number) => {
      set("sellerConcessions", Math.min(Math.max(0, newAmt), Math.round(maxConcessions)));
    };
    const atCap = isLoanAllowed && maxConcessions > 0 && inputs.sellerConcessions >= Math.round(maxConcessions);
    if (compact) {
      return (
        <div>
          <div className="flex items-center justify-between gap-3 px-2 py-2">
            <span className="text-xs text-muted-foreground">Seller Concessions</span>
            <div className="flex items-center gap-2">
              <div className="inline-flex shrink-0 overflow-hidden rounded border border-border text-[10px] leading-none">
                <button
                  type="button"
                  onClick={() => setMode("percent")}
                  disabled={!isLoanAllowed}
                  className={`px-2 py-1 transition-colors ${
                    mode === "percent"
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "bg-background text-muted-foreground hover:text-foreground"
                  } ${!isLoanAllowed ? "opacity-50 cursor-not-allowed" : ""}`}
                  aria-pressed={mode === "percent"}
                >
                  %
                </button>
                <button
                  type="button"
                  onClick={() => setMode("amount")}
                  disabled={!isLoanAllowed}
                  className={`px-2 py-1 border-l border-border transition-colors ${
                    mode === "amount"
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "bg-background text-muted-foreground hover:text-foreground"
                  } ${!isLoanAllowed ? "opacity-50 cursor-not-allowed" : ""}`}
                  aria-pressed={mode === "amount"}
                >
                  $
                </button>
              </div>
              {mode === "percent" ? (
                <SliderInput
                  label=""
                  value={Number(pct.toFixed(2))}
                  onChange={setFromPct}
                  min={0}
                  max={Math.max(0, Number(maxPct.toFixed(2)))}
                  step={0.25}
                  suffix="%"
                  decimals={2}
                  disabled={!isLoanAllowed || price <= 0}
                  compact
                />
              ) : (
                <SliderInput
                  label=""
                  value={inputs.sellerConcessions}
                  onChange={setFromAmount}
                  min={0}
                  max={Math.round(maxConcessions)}
                  step={500}
                  prefix="$"
                  disabled={!isLoanAllowed}
                  compact
                />
              )}
            </div>
          </div>
          <p className={`px-2 text-right text-[10px] ${isLoanAllowed ? "text-muted-foreground" : "text-red-600"}`}>
            {isLoanAllowed
              ? `Maximum ${maxPct.toFixed(2)}% (${fmt(maxConcessions)}) for this loan; reduces estimated cash to close.`
              : `Seller concessions are not allowed for this ${inputs.occupancy} ${inputs.loanType.toUpperCase()} loan.`}
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between flex-wrap gap-1">
          <span className="text-xs text-muted-foreground">Seller Concessions (% of Purchase Price)</span>
          <div className="flex items-center gap-1.5">
            <div className="inline-flex rounded border border-border overflow-hidden text-[10px] leading-none">
              <button
                type="button"
                onClick={() => setMode("percent")}
                disabled={!isLoanAllowed}
                className={`px-2 py-1 transition-colors ${
                  mode === "percent"
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "bg-background text-muted-foreground hover:text-foreground"
                } ${!isLoanAllowed ? "opacity-50 cursor-not-allowed" : ""}`}
                aria-pressed={mode === "percent"}
              >
                %
              </button>
              <button
                type="button"
                onClick={() => setMode("amount")}
                disabled={!isLoanAllowed}
                className={`px-2 py-1 border-l border-border transition-colors ${
                  mode === "amount"
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "bg-background text-muted-foreground hover:text-foreground"
                } ${!isLoanAllowed ? "opacity-50 cursor-not-allowed" : ""}`}
                aria-pressed={mode === "amount"}
              >
                $
              </button>
            </div>
            {isLoanAllowed ? (
              <span className="text-[10px] bg-muted rounded px-1.5 py-0.5 text-muted-foreground">
                Max {maxPct.toFixed(2)}% · {fmt(maxConcessions)}
              </span>
            ) : (
              <span className="text-[10px] bg-red-50 text-red-600 rounded px-1.5 py-0.5">
                Not allowed on {inputs.occupancy} with {inputs.loanType.toUpperCase()}
              </span>
            )}
          </div>
        </div>
        {mode === "percent" ? (
          <SliderInput
            label=""
            value={Number(pct.toFixed(2))}
            onChange={setFromPct}
            min={0}
            max={Math.max(0, Number(maxPct.toFixed(2)))}
            step={0.25}
            suffix="%"
            decimals={2}
            disabled={!isLoanAllowed || price <= 0}
          />
        ) : (
          <SliderInput
            label=""
            value={inputs.sellerConcessions}
            onChange={setFromAmount}
            min={0}
            max={Math.round(maxConcessions)}
            step={500}
            prefix="$"
            disabled={!isLoanAllowed}
          />
        )}
        {inputs.sellerConcessions > 0 && price > 0 && (
          <p className="text-[10px] text-green-700 text-right">
            {pct.toFixed(2)}% · {fmt(inputs.sellerConcessions)} · reduces cash to close
          </p>
        )}
        {atCap && (
          <p className="text-[10px] text-amber-600 text-right">Maximum allowed for this loan type.</p>
        )}
        {price <= 0 && (
          <p className="text-[10px] text-muted-foreground text-right">
            Enter a purchase price to see the linked {mode === "percent" ? "dollar" : "percent"} value.
          </p>
        )}
      </div>
    );
  }

  /** Reusable Down Payment control. Rendered inside the Real Estate
   *  card on Page 4 (See My Estimate) so the user can flip between
   *  Percentage / Dollar Amount and slide live. Edits the same
   *  canonical `inputs.downPaymentPct` + `downPaymentMode` +
   *  `downPaymentAmount` fields used by the rest of the app, which
   *  is also what Page 3 (Loan Details / Purchase Details edit
   *  overlay) writes to — so the two surfaces stay synced via the
   *  shared scenario state without any duplicate state here. Matches
   *  the style of `renderSellerConcessions()` a few lines below it. */
  function renderDownPayment() {
    const price = inputs.purchasePrice;
    if (dpaSelectionComplete) {
      const dpaAmount = Math.round(price * 0.035);
      return (
        <div className="flex items-center justify-between gap-3 px-2 py-2" data-testid="dpa-down-payment-covered-re">
          <span className="text-xs text-muted-foreground">
            Down Payment ({fmt(dpaAmount)} · 3.50%)
          </span>
          <span className="text-xs font-semibold text-foreground">
            Fully covered by DPA
          </span>
        </div>
      );
    }
    const minDown = getMinDown(inputs.loanType, inputs.hasMortgage, inputs.occupancy);
    const mode: "percent" | "amount" = inputs.downPaymentMode ?? "percent";
    const dpAmt =
      inputs.downPaymentAmount ??
      Math.round(price * (inputs.downPaymentPct / 100));
    const minAmt = price > 0 ? Math.round(price * (minDown / 100)) : 0;
    const maxAmt = Math.max(minAmt, Math.floor(price * (MAX_DOWN_PAYMENT_PCT / 100)));
    return (
      <div className="flex items-center justify-between gap-3 px-2 py-2">
        <span className="text-xs text-muted-foreground">
          Down Payment ({fmt(dpAmt)} · {Number(inputs.downPaymentPct).toFixed(2)}%)
        </span>
        <div className="flex items-center gap-2">
          <div className="inline-flex shrink-0 overflow-hidden rounded border border-border text-[10px] leading-none">
            <button
              type="button"
              data-testid="dp-mode-percent-re"
              onClick={() => setDownPaymentMode("percent")}
              className={`px-2 py-1 transition-colors ${
                mode === "percent"
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "bg-background text-muted-foreground hover:text-foreground"
              }`}
              aria-pressed={mode === "percent"}
            >%</button>
            <button
              type="button"
              data-testid="dp-mode-amount-re"
              onClick={() => setDownPaymentMode("amount")}
              className={`px-2 py-1 border-l border-border transition-colors ${
                mode === "amount"
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "bg-background text-muted-foreground hover:text-foreground"
              }`}
              aria-pressed={mode === "amount"}
            >$</button>
          </div>
          {mode === "percent" ? (
            <SliderInput
              label=""
              value={Number(Number(inputs.downPaymentPct).toFixed(2))}
              onChange={(v) => setDownPayment(v)}
              min={minDown}
              max={MAX_DOWN_PAYMENT_PCT}
              step={0.25}
              suffix="%"
              decimals={2}
              disabled={price <= 0}
              compact
            />
          ) : (
            <SliderInput
              label=""
              value={dpAmt}
              onChange={(v) => setDownPaymentDollars(v)}
              min={minAmt}
              max={maxAmt}
              step={500}
              prefix="$"
              disabled={price <= 0}
              compact
            />
          )}
        </div>
      </div>
    );
  }

  /** Write FHA DPA answers. Mirrors every answer into
   *  `userAnswerSources` (dpa_enabled / dpa_pct / dpa_second) so the
   *  choices persist through the existing jsonb round-trip without a
   *  schema migration. When the program is fully selected, the down
   *  payment is snapped to the FHA minimum 3.5% (the DPA covers it). */
  function setDpa(patch: Partial<Pick<Inputs, "dpaEnabled" | "dpaPct" | "dpaSecondType">>) {
    setInputs((p) => {
      const next: Inputs = { ...p, ...patch };
      if (patch.dpaEnabled === false) {
        next.dpaPct = null;
        next.dpaSecondType = null;
      }
      const uas: Record<string, string> = { ...(p.userAnswerSources ?? {}) };
      if (next.dpaEnabled === true) uas.dpa_enabled = "yes";
      else if (next.dpaEnabled === false) uas.dpa_enabled = "no";
      else delete uas.dpa_enabled;
      if (next.dpaPct === 3.5) uas.dpa_pct = "3.5";
      else if (next.dpaPct === 5) uas.dpa_pct = "5";
      else delete uas.dpa_pct;
      if (next.dpaSecondType === "amortizing" || next.dpaSecondType === "silent") uas.dpa_second = next.dpaSecondType;
      else delete uas.dpa_second;
      next.userAnswerSources = uas;
      if (next.loanType === "fha" && next.dpaEnabled === true && next.dpaPct != null && next.dpaSecondType != null) {
        next.downPaymentPct = 3.5;
        next.downPaymentMode = "percent";
        next.downPaymentAmount = Math.round(next.purchasePrice * 0.035);
      }
      return next;
    });
  }

  /** True when the FHA DPA program is fully selected and should
   *  drive the calc (loan must currently be FHA). */
  const dpaSelectionComplete =
    inputs.loanType === "fha" &&
    inputs.dpaEnabled === true &&
    (inputs.dpaPct === 3.5 || inputs.dpaPct === 5) &&
    (inputs.dpaSecondType === "amortizing" || inputs.dpaSecondType === "silent");


  // ─── Calculations ──────────────────────────────────────────────────────────

  const calcBasis = useMemo(() => {
    const taxComplete = taxSource() !== "unavailable";
    const taxVerified = taxSource() === "official" || taxSource() === "manual";
    const { purchasePrice, downPaymentPct, loanType, creditScore, interestRate,
      annualTaxes, hoaMonthly, cddAnnual, annualHOIns, annualFloodIns,
      monthlyDebts, monthlyIncome, monthlyRentalIncome, reserves, impactWindows, roofAttachment, swr,
      vaDisability, vaLoanUse, hasDeferredStudentLoans, deferredStudentLoanBalance } = inputs;

    // Deferred-student-loan DTI add-on. Computed every time loanType
    // or balance changes so flipping conventional <-> FHA/VA/USDA
    // automatically retunes the assumed payment (1% vs 0.5%). When
    // the user has answered "No" we contribute $0 regardless of any
    // stale balance — the form preserves the balance value but the
    // calc treats it as if cleared.
    const deferredStudentLoanFactorVal = deferredStudentLoanFactor(loanType);
    const deferredStudentLoanMonthly =
      hasDeferredStudentLoans === true && (deferredStudentLoanBalance ?? 0) > 0
        ? Math.round((deferredStudentLoanBalance ?? 0) * deferredStudentLoanFactorVal)
        : 0;
    // `monthlyDebts` from Page 1 stays the user's source of truth and
    // is never mutated. We layer the deferred-SL payment on top only
    // for DTI math so changing loan type recomputes DTI instantly.
    const effectiveMonthlyDebts = monthlyDebts + deferredStudentLoanMonthly;

    // ─── FHA Down Payment Assistance (DPA) ─────────────────────────────────
    // Only applies when the loan is FHA and every DPA question is
    // answered. All effects are derived here (never written back into
    // `inputs`) so flipping loan types can never double-count.
    const dpaActive =
      loanType === "fha" &&
      inputs.dpaEnabled === true &&
      (inputs.dpaPct === 3.5 || inputs.dpaPct === 5) &&
      (inputs.dpaSecondType === "amortizing" || inputs.dpaSecondType === "silent");
    const dpaPct = dpaActive ? (inputs.dpaPct as 3.5 | 5) : 0;
    const dpaSecondType = dpaActive ? (inputs.dpaSecondType as "amortizing" | "silent") : null;
    // Total assistance funds = 3.5% or 5% of purchase price. This is
    // also the principal of the 2nd lien.
    const dpaAmount = dpaActive ? Math.round(purchasePrice * (dpaPct / 100)) : 0;
    // Rate adjustment applied ON TOP of the priced FHA rate
    // (i.e. "the rate without these options"):
    //   3.5% + amortizing → +1.00%   3.5% + silent → +1.75%
    //   5%   + amortizing → +1.25%   5%   + silent → +1.75% + 2 pts cash
    const dpaRateBump = !dpaActive ? 0
      : dpaPct === 3.5
        ? (dpaSecondType === "amortizing" ? 1.0 : 1.75)
        : (dpaSecondType === "amortizing" ? 1.25 : 1.75);
    const dpaExtraPointsPct = dpaActive && dpaPct === 5 && dpaSecondType === "silent" ? 2 : 0;

    // With DPA active the down payment is always the FHA minimum
    // 3.5% — fully funded by the assistance.
    const effectiveDownPaymentPct = dpaActive ? 3.5 : downPaymentPct;
    const downPaymentAmt = purchasePrice * (effectiveDownPaymentPct / 100);
    const baseLoanAmount = purchasePrice - downPaymentAmt;
    const fhaUFMIP = loanType === "fha" ? Math.round(baseLoanAmount * 0.0175 * 100) / 100 : 0;
    const vaFundingFeeAmt = loanType === "va" ? calcVAFundingFeeAmt(baseLoanAmount, vaDisability, vaLoanUse) : 0;
    const loanAmount = baseLoanAmount + fhaUFMIP + vaFundingFeeAmt;
    const ltv = baseLoanAmount / purchasePrice;

    // ─── Discount Points buydown ────────────────────────────────────────────
    // The priced rate from `fullRate(...)` already lives in
    // `inputs.interestRate` and is treated as the BASE rate here
    // (it has all existing pricing adjustments — credit/LTV/
    // occupancy/AMI/loan-type LLPAs/Conventional -0.100% nudge —
    // baked in). The discount-point buydown is applied AFTER, on
    // top of that base, and is never written back into `inputs`
    // so flipping loan type / loan amount / down payment can
    // never double-count it. Cost is computed off the BASE loan
    // amount (excluding financed FHA UFMIP / VA funding fee).
    const discountPointsPctRaw = inputs.discountPointsPct ?? 0;
    const discountPointsPctSnapped = snapDiscountPoints(discountPointsPctRaw);
    const discountPointsRateReduction = getDiscountPointsRateReduction(
      discountPointsPctSnapped,
      loanType,
    );
    const rateBeforeDiscountPoints = interestRate;
    // Round the final rate to 3 decimals as the spec requires.
    // Floor at 0 so an extreme buydown can never produce a
    // negative rate.
    const rateAfterDiscountPoints =
      Math.max(0, Math.round((rateBeforeDiscountPoints - discountPointsRateReduction) * 1000) / 1000);
    const discountPointsCost = calculateDiscountPointsCost(
      baseLoanAmount,
      discountPointsPctSnapped,
    );
    // Final first-mortgage rate = bought-down rate + DPA rate
    // adjustment (0 when no DPA). Used for P&I so monthly payment /
    // DTI / qualification all reflect both.
    const finalRate = Math.round((rateAfterDiscountPoints + dpaRateBump) * 1000) / 1000;
    const rate = finalRate / 100;

    const pi = calcPI(loanAmount, rate);

    // DPA 2nd lien: amortizing = repaid over 10 years at the final
    // first-mortgage rate + 2%. Silent = no monthly payment (must
    // keep the home 10 years; full amount due on refinance).
    const dpaSecondRate = dpaActive && dpaSecondType === "amortizing"
      ? Math.round((finalRate + 2) * 1000) / 1000
      : 0;
    const dpaSecondMonthly = dpaActive && dpaSecondType === "amortizing"
      ? calcPI(dpaAmount, dpaSecondRate / 100, 120)
      : 0;
    const monthlyTax = taxComplete ? annualTaxes / 12 : 0;
    const monthlyHOIns = annualHOIns / 12;
    // Synchronous policy guard: calculations never trust a possibly stale raw
    // scenario value (for example, during hydration or a late Zillow result).
    const effectiveAnnualFloodIns = effectiveAnnualFloodInsurance(
      inputs.propertyType,
      annualFloodIns,
    );
    const monthlyFlood = effectiveAnnualFloodIns / 12;
    const monthlyCDD = cddAnnual / 12;

    const pmi = (loanType === "conventional" || loanType === "jumbo") ? calcConventionalPMI(baseLoanAmount, purchasePrice, creditScore) : 0;
    const mip = loanType === "fha" ? calcFHAMIP(loanAmount) : 0;
    const mortgageInsurance = pmi + mip;

    const totalHousing = pi + monthlyTax + monthlyHOIns + monthlyFlood + hoaMonthly + monthlyCDD + mortgageInsurance + dpaSecondMonthly;
    // Base closing costs ≈ 3% of purchase price. DSCR adds a 1.00%
    // origination charge on top per spec; the add-on is derived here
    // and never written back into `inputs`, so switching loan types
    // (DSCR → Conventional → DSCR) can never double-count it.
    const baseClosingCosts = Math.round(purchasePrice * 0.03);
    const dscrOriginationPercent = loanType === "dscr" ? 1.0 : 0;
    const dscrOriginationAmount = loanType === "dscr" ? Math.round(purchasePrice * 0.01) : 0;
    // Discount-point cost is added to closing costs (and therefore
    // cash-to-close). It's strictly additive to the DSCR
    // origination charge — the two are separate line items per
    // spec — and is derived from `inputs.discountPointsPct` only,
    // so re-renders / loan-type flips never double-count.
    // 5% DPA + silent 2nd: the first-mortgage lender charges 2 program
    // points (2% of the base loan amount) in cash to close. This does
    // NOT buy the rate down, but is a first-lien prepaid finance charge
    // included once in that loan's APR under 12 CFR 1026.4(a), (b)(3).
    const dpaExtraPointsCost = dpaExtraPointsPct > 0
      ? Math.round(baseLoanAmount * (dpaExtraPointsPct / 100))
      : 0;
    const closingCosts = baseClosingCosts + dscrOriginationAmount + discountPointsCost + dpaExtraPointsCost;
    if (loanType === "dscr") {
      console.debug("[dscr-costs] base closing costs", baseClosingCosts);
      console.debug("[dscr-costs] origination add-on", dscrOriginationAmount);
      console.debug("[dscr-costs] total closing costs", closingCosts);
    }
    const sellerConcessions = inputs.sellerConcessions ?? 0;
    // Cap the seller-concession credit applied to cash-to-close at
    // eligible closing costs — concessions can't reduce down payment
    // or go below $0 cash-to-close. The user's selected concession
    // amount is preserved in `inputs.sellerConcessions` for display.
    const sellerConcessionsApplied = Math.min(sellerConcessions, closingCosts);
    // DPA credits: the assistance always covers the full 3.5% down
    // payment; the 5% program additionally credits 1.5% of the
    // purchase price toward closing costs. Floored at $0 so credits
    // can never produce negative cash to close.
    const dpaDownPaymentCredit = dpaActive ? downPaymentAmt : 0;
    const dpaClosingCostCredit = dpaActive && dpaPct === 5 ? Math.round(purchasePrice * 0.015) : 0;
    const cashToClose = Math.round(
      Math.max(0, downPaymentAmt - dpaDownPaymentCredit) +
      Math.max(0, closingCosts - sellerConcessionsApplied - dpaClosingCostCredit)
    );

    // Rental income: lenders allow 75% of gross rental income to count toward qualifying income
    const rentalIncomeQualifying = Math.round((monthlyRentalIncome ?? 0) * 0.75);
    const qualifyingIncome = monthlyIncome + rentalIncomeQualifying;

    const housingDTI = qualifyingIncome > 0 ? totalHousing / qualifyingIncome : 0;
    const dti = qualifyingIncome > 0 ? (totalHousing + effectiveMonthlyDebts) / qualifyingIncome : 0;
    const { housingMax: maxHousingDti, totalMax: maxTotalDti } = getDTILimits(loanType);
    const { housingGreen, totalGreen } = getQualThresholds(loanType);
    const maxDti = maxTotalDti; // keep for backward compat in recs
    const requiredIncome = maxTotalDti === Infinity ? 0 : Math.round((totalHousing + effectiveMonthlyDebts) / maxTotalDti);
    const requiredReserves = Math.round(totalHousing * 2);
    const availableReserves = Math.max(0, reserves - cashToClose);
    // "Likely Qualifies" requires BOTH housing DTI and total DTI strictly
    // below the per-loan-type green thresholds; anything else "Needs Review".
    const housingDTIPass = housingGreen === Infinity || housingDTI < housingGreen;
    const totalDTIPass = totalGreen === Infinity || dti < totalGreen;
    const dtiLikelyQualifies = taxVerified && housingDTIPass && totalDTIPass;
    // Per spec, the qualification status is driven purely by the DTI
    // thresholds. Reserves are surfaced as an advisory row below, not a
    // gate on the "Likely Qualifies" / "Needs Review" badge.
    const qualifies = inputs.qualificationInputsConfirmed===true && dtiLikelyQualifies;

    const estimatedHOIns = calcInsuranceEstimate(purchasePrice, impactWindows, roofAttachment, swr);

    const loanComparison = (["conventional", "fha", "va"] as const).map((lt) => {
      const ltRate = rates[lt] / 100;
      const ltDown = lt === "va" ? 0 : lt === "fha" ? 3.5 : downPaymentPct;
      const ltBaseLoan = purchasePrice * (1 - ltDown / 100);
      const ltUFMIP = lt === "fha" ? Math.round(ltBaseLoan * 0.0175 * 100) / 100 : 0;
      const ltVAFee = lt === "va" ? calcVAFundingFeeAmt(ltBaseLoan, vaDisability, vaLoanUse) : 0;
      const ltLoan = ltBaseLoan + ltUFMIP + ltVAFee;
      const ltPI = calcPI(ltLoan, ltRate);
      const ltPMI = lt === "conventional" ? calcConventionalPMI(ltBaseLoan, purchasePrice, creditScore) : 0;
      const ltMIP = lt === "fha" ? calcFHAMIP(ltLoan) : 0;
      const ltMI = ltPMI + ltMIP;
      const ltTotal = ltPI + monthlyTax + monthlyHOIns + monthlyFlood + hoaMonthly + monthlyCDD + ltMI;
      return { lt, rate: ltRate * 100, downPct: ltDown, pi: ltPI, mi: ltMI, total: ltTotal };
    });

    const recs: string[] = [];
    if (qualifyingIncome < requiredIncome) {
      recs.push(`Increase income to at least ${fmt(requiredIncome)}/mo, or reduce monthly debts.`);
      if (purchasePrice > 300000) recs.push("Consider a lower purchase price.");
      if (downPaymentPct < 20) recs.push("A larger down payment reduces your monthly payment.");
      if (loanType === "conventional" && creditScore < 680) recs.push("Improving your credit score may unlock better rates.");
      if (loanType !== "fha") recs.push("FHA loans allow a lower qualifying income threshold.");
      if (loanType !== "va") recs.push("If eligible, a VA loan requires $0 down and has no PMI.");
    }
    if (reserves < cashToClose) {
      recs.push(`You need at least ${fmt(cashToClose)} in cash to close. Consider down payment assistance programs.`);
    }

    return {
      loanAmount, baseLoanAmount, fhaUFMIP, vaFundingFeeAmt, downPaymentAmt, pi, monthlyTax, monthlyHOIns, monthlyFlood,
      monthlyCDD, mortgageInsurance, pmi, mip, totalHousing,
      closingCosts, baseClosingCosts, dscrOriginationAmount, dscrOriginationPercent,
      // Discount Points buydown surface — read by the Real Estate
      // card (cost / rate-reduction / final-rate display) and by
      // the auto-save effect for persistence. Snapped/rounded
      // values so what's saved is exactly what the UI shows.
      discountPointsPct: discountPointsPctSnapped,
      discountPointsCost,
      discountPointsRateReduction,
      rateBeforeDiscountPoints,
      rateAfterDiscountPoints,
      // FHA DPA surface — drives the Page 3 controls, Page 4 rows,
      // PDF, and share text. `finalRate` is the rate actually used
      // for P&I (buydown + DPA bump applied).
      finalRate,
      dpaActive, dpaPct, dpaSecondType, dpaAmount, dpaRateBump,
      dpaSecondRate, dpaSecondMonthly,
      dpaDownPaymentCredit, dpaClosingCostCredit, dpaExtraPointsCost,
      effectiveDownPaymentPct,
      cashToClose, housingDTI, dti, maxHousingDti, maxTotalDti, maxDti, requiredIncome, requiredReserves, availableReserves,
      housingGreen, totalGreen, dtiLikelyQualifies,
      qualifies, taxComplete, taxVerified, estimatedHOIns, loanComparison, recs, ltv,
      rentalIncomeQualifying, qualifyingIncome,
      // Deferred-student-loan DTI add-on (derived). `baseMonthlyDebts`
      // is what the user typed on Page 1 and is the only persisted
      // figure; `totalMonthlyDebts` is what DTI uses + what the UI
      // surfaces on Page 1 / Page 4 so the user sees the full picture
      // without us ever overwriting their typed value.
      deferredStudentLoanMonthly,
      deferredStudentLoanFactor: deferredStudentLoanFactorVal,
      baseMonthlyDebts: monthlyDebts,
      totalMonthlyDebts: effectiveMonthlyDebts,
    };
  }, [inputs, taxRequestKey, quickTax.result]);

  // ── Initial Fees Worksheet + APR ─────────────────────────────────
  // Built from the same upstream loan/payment outputs the payment card
  // uses. Its itemized totals then become the final source of truth for
  // closing costs and cash to close everywhere downstream.
  // the popup worksheet and the APR disclosure can never drift from
  // the numbers on screen. APR = note rate + prepaid finance charges
  // (origination/points, including first-lien DPA program points,
  // underwriting, processing-type fees, prepaid interest) + the
  // monthly MI stream, solved on the actual payment.
  const [feeWorksheetEscrowsEnabled, setFeeWorksheetEscrowsEnabled] = useState(true);
  const feeWorksheet = useMemo(() => {
    if (!calcBasis.taxComplete || inputs.purchasePrice <= 0 || calcBasis.loanAmount <= 0 || calcBasis.pi <= 0) return null;
    return buildFeeWorksheet({
      purchasePrice: inputs.purchasePrice,
      baseLoanAmount: calcBasis.baseLoanAmount,
      loanAmount: calcBasis.loanAmount,
      ratePct: calcBasis.finalRate,
      loanType: inputs.loanType,
      monthlyPI: calcBasis.pi,
      monthlyTax: calcBasis.monthlyTax,
      monthlyHOIns: calcBasis.monthlyHOIns,
      monthlyFlood: calcBasis.monthlyFlood,
      monthlyMI: calcBasis.mortgageInsurance,
      hoaMonthly: inputs.hoaMonthly,
      monthlyCDD: calcBasis.monthlyCDD,
      downPaymentAmt: calcBasis.downPaymentAmt,
      discountPointsCost: calcBasis.discountPointsCost,
      discountPointsPct: calcBasis.discountPointsPct,
      dscrOriginationAmount: calcBasis.dscrOriginationAmount,
      dpaExtraPointsCost: calcBasis.dpaExtraPointsCost,
      dpaSecondMonthly: calcBasis.dpaSecondMonthly,
      // Uncapped — the worksheet caps against its own itemized
      // eligible costs so A−B stays internally consistent.
      sellerCredits: inputs.sellerConcessions ?? 0,
      dpaDownPaymentCredit: calcBasis.dpaDownPaymentCredit,
      dpaClosingCostCredit: calcBasis.dpaClosingCostCredit,
      requiresElevationCertificate:
        inputs.propertyType === "Single Family Residence" &&
        floodData?.requiresFloodInsurance === true,
      escrowsEnabled: feeWorksheetEscrowsEnabled,
    });
  }, [inputs, calcBasis, floodData?.requiresFloodInsurance, feeWorksheetEscrowsEnabled]);

  const calc = useMemo(() => {
    if (!feeWorksheet) return calcBasis;

    const cashToClose =
      Math.round(feeWorksheet.fundsToClose.estimatedCash * 100) / 100;
    const availableReserves = Math.max(0, inputs.reserves - cashToClose);
    const recs = calcBasis.recs.filter(
      (rec) => !rec.includes("in cash to close"),
    );
    if (inputs.reserves < cashToClose) {
      recs.push(
        `You need at least ${fmt(cashToClose)} in cash to close. Consider down payment assistance programs.`,
      );
    }

    return {
      ...calcBasis,
      closingCosts: feeWorksheet.totalClosingCosts,
      cashToClose,
      availableReserves,
      recs,
    };
  }, [calcBasis, feeWorksheet, inputs.reserves]);
  const calcRef = useRef(calc);
  calcRef.current = calc;
  const qualificationLoanLabel =
    inputs.loanType === "conventional" ? "Conventional"
    : inputs.loanType === "jumbo" ? "Jumbo"
    : inputs.loanType === "fha" ? "FHA"
    : inputs.loanType === "va" ? "VA"
    : inputs.loanType === "usda" ? "USDA"
    : inputs.loanType === "dscr" ? "DSCR"
    : "Bank Statement";
  const housingRatioWithinMax =
    calc.taxComplete && (calc.maxHousingDti === Infinity || calc.housingDTI <= calc.maxHousingDti);
  const totalRatioWithinMax =
    calc.taxComplete && (calc.maxTotalDti === Infinity || calc.dti <= calc.maxTotalDti);
  const withinLoanRatioLimits = housingRatioWithinMax && totalRatioWithinMax;
  const aprPct = feeWorksheet?.aprPct ?? null;
  const feeWorksheetMeta = useMemo<InitialFeesWorksheetPdfMeta | null>(() => {
    if (!feeWorksheet) return null;
    return {
      address: address && address !== "Unknown Address" ? address : undefined,
      purchasePrice: inputs.purchasePrice,
      loanAmount: calc.loanAmount,
      loanTypeLabel:
        inputs.loanType === "conventional" ? "Conventional"
        : inputs.loanType === "jumbo" ? "Jumbo"
        : inputs.loanType === "fha" ? "FHA"
        : inputs.loanType === "va" ? "VA"
        : inputs.loanType === "usda" ? "USDA"
        : inputs.loanType === "dscr" ? "DSCR"
        : inputs.loanType.toUpperCase(),
      ratePct: calc.finalRate,
      aprPct: feeWorksheet.aprPct,
      occupancyLabel:
        inputs.occupancy === "primary" ? "Primary Residence"
        : inputs.occupancy === "secondary" ? "Second Home"
        : inputs.occupancy === "investment" ? "Investment"
        : undefined,
    };
  }, [address, calc.finalRate, calc.loanAmount, feeWorksheet, inputs.loanType, inputs.occupancy, inputs.purchasePrice]);
  const currentPurchaseScenarioSnapshot = useMemo(() => ({
    address,
    price: inputs.purchasePrice,
    priceSource:
      inputs.purchasePriceSource === "user"
        ? "manual" as const
        : inputs.purchasePriceSource?.startsWith("zillow")
          ? "zillow" as const
          : "default" as const,
    monthlyPayment: calc.taxComplete ? Math.round(calc.totalHousing) : undefined,
    cashToClose: calc.taxComplete ? Math.round(calc.cashToClose * 100) / 100 : undefined,
    dti: calc.taxComplete ? calc.dti : undefined,
    qualifies: calc.taxVerified ? calc.qualifies : undefined,
    downPaymentPct: inputs.downPaymentPct,
    downPaymentMode: inputs.downPaymentMode ?? "percent",
    downPaymentAmount:
      inputs.downPaymentAmount ??
      Math.round(inputs.purchasePrice * (inputs.downPaymentPct / 100)),
    interestRate: inputs.interestRate,
    loanType: inputs.loanType,
    propertyType: inputs.propertyType,
    propertyTypeSource: inputs.propertyTypeSource,
    occupancyType: inputs.propertyUseSelected ? inputs.occupancy : undefined,
    monthlyIncome: inputs.monthlyIncome,
    monthlyIncomeSource: inputs.monthlyIncomeSource ?? "default",
    monthlyDebts: inputs.monthlyDebts,
    creditScore: inputs.creditScore,
    reserves: inputs.reserves,
    isVeteran: inputs.isVeteran,
    vaDisability: inputs.vaDisability,
    vaDisabilityRating100: inputs.vaDisabilityRating100,
    vaLoanUse: inputs.vaLoanUse,
    hasMortgage: inputs.hasMortgage,
    currentLoanFHA: inputs.currentLoanFHA,
    hasRentalIncome: inputs.hasRentalIncome,
    monthlyRentalIncome: inputs.monthlyRentalIncome,
    rentalType: inputs.rentalType,
    sellerConcessions: inputs.sellerConcessions,
    sellerConcessionsMode: inputs.sellerConcessionsMode ?? "percent",
    annualTaxes: calc.taxComplete ? inputs.annualTaxes : undefined,
    annualHOIns: inputs.annualHOIns,
    annualFloodIns: effectiveAnnualFloodInsurance(
      inputs.propertyType,
      inputs.annualFloodIns,
    ),
    hoaMonthly: inputs.hoaMonthly,
    cddAnnual: inputs.cddAnnual,
    impactWindows: inputs.impactWindows,
    roofAttachment: inputs.roofAttachment,
    swr: inputs.swr,
    userAnswerSources: {
      ...inputs.userAnswerSources, annual_taxes: taxSource(),
      property_tax_provenance: taxSource() === "manual" ? JSON.stringify({status:"manual",annualTax:inputs.annualTaxes})
        : JSON.stringify(quickTax.result ?? {status:"unavailable",annualTax:null}),
      property_tax_request_key: quickTax.key,
    },
    hasDeferredStudentLoans: inputs.hasDeferredStudentLoans ?? false,
    deferredStudentLoanBalance: inputs.deferredStudentLoanBalance ?? 0,
    discountPointsPct: calc.discountPointsPct,
    discountPointsCost: calc.discountPointsCost,
    discountPointsRateReduction: calc.discountPointsRateReduction,
    rateBeforeDiscountPoints: calc.rateBeforeDiscountPoints,
    rateAfterDiscountPoints: calc.rateAfterDiscountPoints,
  }), [address, calc, inputs, quickTax.result, quickTax.key]);
  useAnonymousAccountDraft("purchase", {
    ...currentPurchaseScenarioSnapshot, id: activeScenarioId, savedAt: new Date().toISOString(),
  });
  const [feeWorksheetOpen, setFeeWorksheetOpen] = useState(false);
  const [openingLiveQuote, setOpeningLiveQuote] = useState(false);
  useEffect(() => {
    if (!calc.taxVerified) setFeeWorksheetOpen(false);
  }, [calc.taxVerified]);

  function createIfwPdfFile(lenderInfo: PurchaseLenderInfo): File | null {
    if (!calcRef.current.taxVerified) return null;
    if (!feeWorksheet || !feeWorksheetMeta?.address) return null;
    const blob = createInitialFeesWorksheetPdfBlob({
      worksheet: feeWorksheet,
      meta: feeWorksheetMeta,
      lenderInfo,
    });
    return new File(
      [blob],
      buildInitialFeesWorksheetFileName(feeWorksheetMeta.address),
      { type: "application/pdf" },
    );
  }

  function saveCurrentIfwScenario(): void {
    if (!calcRef.current.taxVerified) throw new Error("Verify official property taxes or enter the annual bill before saving this worksheet.");
    if (!getSession()) throw new Error("Please sign in before saving this worksheet.");
    if (!address || address === "Unknown Address") throw new Error("Add a property address before saving this worksheet.");
    const existing = getPurchaseScenarios();
    const key = address.trim().toLowerCase();
    const index = existing.findIndex((scenario) => scenario.address.trim().toLowerCase() === key);
    const now = new Date().toISOString();
    if (index >= 0) {
      const updated = [...existing];
      updated[index] = {
        ...updated[index],
        ...currentPurchaseScenarioSnapshot,
        savedAt: updated[index].savedAt || now,
      };
      savePurchaseScenarios(updated);
    } else {
      savePurchaseScenarios([
        ...existing,
        {
          id: activeScenarioIdRef.current || `sc_${Date.now()}`,
          savedAt: now,
          ...currentPurchaseScenarioSnapshot,
        },
      ]);
    }
    trackEvent("scenario_saved", { type: "purchase", source: "ifw" });
  }

  function notifyIfwActivity(action: "save" | "download" | "share"): void {
    if (!calcRef.current.taxComplete) return;
    if (!feeWorksheet || !feeWorksheetMeta?.address) return;
    void authedFetch("/api/ifw/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        action,
        address: feeWorksheetMeta.address,
        summary: {
          price: feeWorksheetMeta.purchasePrice,
          downPayment: calc.downPaymentAmt,
          loanAmount: feeWorksheetMeta.loanAmount,
          monthlyPayment: feeWorksheet.totalMonthly,
          cashToClose: feeWorksheet.fundsToClose.estimatedCash,
          notes: `${feeWorksheetMeta.loanTypeLabel} at ${feeWorksheetMeta.ratePct.toFixed(3)}% (APR ${feeWorksheetMeta.aprPct.toFixed(3)}%)`,
        },
      }),
    }).then((response) => {
      if (!response.ok) console.warn("[ifw-activity] notification failed:", response.status);
    }).catch((error) => {
      console.warn("[ifw-activity] notification failed:", error);
    });
  }

  const handleGetLiveInsuranceQuote = async () => {
    if (!getSession() && !await requireAccount()) return;
    if (openingLiveQuote) return;
    setOpeningLiveQuote(true);
    try {
      const response = await authedFetch("/api/insurance/live-quote-click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
        keepalive: true,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || (!result.delivered && !result.deduped)) {
        throw new Error(
          response.status === 401
            ? "Please sign in again before requesting a live quote."
            : result.error || "The insurance team alert could not be confirmed.",
        );
      }
      setLocation(`/insurance?address=${encodeURIComponent(address)}`);
    } catch (error) {
      console.warn("[insurance-live-quote] FUB click alert failed:", error);
      toast({
        variant: "destructive",
        title: "Live quote request not sent",
        description:
          error instanceof Error
            ? error.message
            : "Please try again so we can alert the insurance team.",
      });
    } finally {
      setOpeningLiveQuote(false);
    }
  };

  // ── Loan-limit enforcement (2026 limits) ─────────────────────────
  // Watches the BASE loan amount (before financed UFMIP / funding fee,
  // which is how the programs measure limits) and auto-flips:
  //   FHA over the FHA floor        → Conventional (popup)
  //   Conventional over conforming  → Jumbo        (popup)
  //   Jumbo back under conforming   → Conventional (silent)
  // The popup explains why the loan type changed. `setLoanType` re-
  // prices the rate through `fullRate`, so the switch is fully wired
  // into every downstream calc. A ref guards against the effect
  // re-firing for the state it just wrote.
  const [loanLimitNotice, setLoanLimitNotice] = useState<{
    fromLabel: string;
    toLabel: string;
    limit: number;
    limitLabel: string;
    /** false when we could NOT auto-switch (e.g. sub-620 FICO can't
     *  hold Conventional/Jumbo) — the popup copy adapts. */
    switched: boolean;
  } | null>(null);
  useEffect(() => {
    const result = checkLoanLimit(inputs.loanType, calc.baseLoanAmount);
    if (result.exceeded) {
      const labels: Record<string, string> = { fha: "FHA", conventional: "Conventional", jumbo: "Jumbo" };
      // If the target ALSO exceeds its own limit (FHA → Conventional
      // when the loan is already above conforming), jump straight to
      // the final eligible program.
      const finalTo =
        result.to === "conventional" && calc.baseLoanAmount > CONFORMING_LOAN_LIMIT_2026
          ? "jumbo"
          : result.to;
      // Conventional and Jumbo both require 620+ FICO. If the borrower
      // is below that, there is no eligible program at this loan
      // amount — warn without switching (the selectors already gate
      // Conventional/Jumbo, so force-switching would strand the UI on
      // a product the user can't even select).
      const eligibleToSwitch = inputs.creditScore >= CONVENTIONAL_MIN_FICO;
      setLoanLimitNotice({
        fromLabel: labels[result.from] ?? result.from,
        toLabel: labels[finalTo] ?? finalTo,
        limit: result.limit,
        limitLabel: result.limitLabel,
        switched: eligibleToSwitch,
      });
      if (eligibleToSwitch) setLoanType(finalTo);
    } else if (canDowngradeFromJumbo(inputs.loanType, calc.baseLoanAmount)) {
      // Loan shrank back under the conforming limit — return to
      // Conventional silently and drop any now-stale limit popup.
      setLoanLimitNotice(null);
      setLoanType("conventional");
    }
  }, [inputs.loanType, calc.baseLoanAmount, inputs.creditScore]);

  // Auto-save / update this estimate on the user's dashboard when they're logged in.
  // Debounced so rapid input changes don't thrash storage. Status is written
  // to the SPECIFIC scenario id (snapshotted at effect start), so even if the
  // user switches tabs mid-debounce the "Saving…"/"Saved" indicator stays
  // pinned to the right scenario.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!address || address === "Unknown Address") return;
    const targetScenarioId = activeScenarioIdRef.current;
    // Mark this scenario as pending-save so the user sees "Saving…"
    // immediately on edit, not only when the debounce fires.
    setScenarios(prev => prev.map(s =>
      s.id === targetScenarioId ? { ...s, saveStatus: "saving" } : s
    ));
    let timerFired = false;
    const handle = setTimeout(async () => {
      timerFired = true;
      let didWrite = false;
      try {
        const existing = getPurchaseScenarios();
        const key = address.trim().toLowerCase();
        const idx = existing.findIndex(s => s.address.trim().toLowerCase() === key);
        const next = currentPurchaseScenarioSnapshot;
        if (idx >= 0) {
          // Only write if something actually changed (avoid noisy storage writes)
          const cur = existing[idx];
          const same = cur.price === next.price
            && cur.monthlyPayment === next.monthlyPayment
            && cur.cashToClose === next.cashToClose
            && cur.dti === next.dti
            && cur.qualifies === next.qualifies
            && cur.downPaymentPct === next.downPaymentPct
            && (cur.downPaymentMode ?? "percent") === next.downPaymentMode
            && cur.downPaymentAmount === next.downPaymentAmount
            && cur.interestRate === next.interestRate
            && cur.loanType === next.loanType
            && (cur.propertyType ?? undefined) === next.propertyType
            && (cur.propertyTypeSource ?? undefined) === next.propertyTypeSource
            && (cur.occupancyType ?? undefined) === next.occupancyType
            && (cur.monthlyIncome ?? undefined) === next.monthlyIncome
            && (cur.monthlyIncomeSource ?? "default") === next.monthlyIncomeSource
            && (cur.hasDeferredStudentLoans ?? false) === next.hasDeferredStudentLoans
            && (cur.deferredStudentLoanBalance ?? 0) === next.deferredStudentLoanBalance
            && (cur.discountPointsPct ?? 0) === next.discountPointsPct
            && (cur.discountPointsCost ?? 0) === next.discountPointsCost
            && (cur.discountPointsRateReduction ?? 0) === next.discountPointsRateReduction
            && (cur.rateBeforeDiscountPoints ?? null) === next.rateBeforeDiscountPoints
            && (cur.rateAfterDiscountPoints ?? null) === next.rateAfterDiscountPoints
            // ── 2026_05_28 comprehensive borrower-answer same-check ──
            && (cur.monthlyDebts ?? undefined) === next.monthlyDebts
            && (cur.creditScore ?? undefined) === next.creditScore
            && (cur.reserves ?? undefined) === next.reserves
            && (cur.isVeteran ?? undefined) === next.isVeteran
            && (cur.vaDisability ?? undefined) === next.vaDisability
            && (cur.vaDisabilityRating100 ?? undefined) === next.vaDisabilityRating100
            && (cur.vaLoanUse ?? undefined) === next.vaLoanUse
            && (cur.hasMortgage ?? undefined) === next.hasMortgage
            && (cur.currentLoanFHA ?? undefined) === next.currentLoanFHA
            && (cur.hasRentalIncome ?? undefined) === next.hasRentalIncome
            && (cur.monthlyRentalIncome ?? undefined) === next.monthlyRentalIncome
            && (cur.rentalType ?? undefined) === next.rentalType
            && (cur.sellerConcessions ?? undefined) === next.sellerConcessions
            && (cur.sellerConcessionsMode ?? "percent") === next.sellerConcessionsMode
            && (cur.annualTaxes ?? undefined) === next.annualTaxes
            && (cur.annualHOIns ?? undefined) === next.annualHOIns
            && (cur.annualFloodIns ?? undefined) === next.annualFloodIns
            && (cur.hoaMonthly ?? undefined) === next.hoaMonthly
            && (cur.cddAnnual ?? undefined) === next.cddAnnual
            && (cur.impactWindows ?? undefined) === next.impactWindows
            && (cur.roofAttachment ?? undefined) === next.roofAttachment
            && (cur.swr ?? undefined) === next.swr
            && JSON.stringify(cur.userAnswerSources ?? null) === JSON.stringify(next.userAnswerSources ?? null)
            && cur.address === address;
          if (!same) {
            const updated = [...existing];
            updated[idx] = { ...cur, ...next };
            console.debug("[purchase-scenario-save] scenario id", cur.id);
            console.debug("[purchase-scenario-save] write ok (existing)");
            await confirmAnonymousAccountDraftSaved("purchase", () => savePurchaseScenarios(updated));
            didWrite = true;
          }
        } else {
          const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          console.debug("[purchase-scenario-save] scenario id", newId);
          console.debug("[purchase-scenario-save] write ok (new)");
          await confirmAnonymousAccountDraftSaved("purchase", () => savePurchaseScenarios([
            ...existing,
            {
              id: newId,
              savedAt: new Date().toISOString(),
              ...next,
            },
          ]));
          didWrite = true;
        }
        // On no-op (nothing changed) we still flip the status back to
        // "saved" so a stale "Saving…" never sticks.
        setScenarios(prev => prev.map(s =>
          s.id === targetScenarioId ? { ...s, saveStatus: "saved" } : s
        ));
        // Auto-clear "saved" back to "idle" after a moment so the
        // indicator doesn't permanently camp on the screen.
        const clearHandle = setTimeout(() => {
          setScenarios(prev => prev.map(s =>
            s.id === targetScenarioId && s.saveStatus === "saved"
              ? { ...s, saveStatus: "idle" }
              : s
          ));
        }, 1800);
        // Best-effort cleanup; if the effect re-runs before the timeout
        // fires, the cleanup below clears the outer timer but this inner
        // one is short-lived enough to be harmless.
        void clearHandle;
        void didWrite;
      } catch (err) {
        console.warn("Auto-save to dashboard failed:", err);
        setScenarios(prev => prev.map(s =>
          s.id === targetScenarioId ? { ...s, saveStatus: "error" } : s
        ));
      }
    }, 800);
    // If the effect re-runs (more edits) or unmounts before the 800ms
    // timer fires, the pending write is canceled. Revert the "saving"
    // marker on that scenario back to "idle" so the indicator never
    // sticks (e.g. user switches tabs mid-debounce). Only clear if the
    // status is still "saving"; if a later cycle already finalized it
    // to "saved"/"error", leave that alone.
    return () => {
      clearTimeout(handle);
      if (!timerFired) {
        setScenarios(prev => prev.map(s =>
          s.id === targetScenarioId && s.saveStatus === "saving"
            ? { ...s, saveStatus: "idle" }
            : s
        ));
      }
    };
  }, [
    // Depend on the WHOLE inputs object so EVERY user-editable field on
    // Pages 1-4 triggers the debounced autosave — not just price / down
    // payment / rate / loan type. Previously borrower-level Page 1 fields
    // (credit score, reserves, occupancy), most Page 2 qualification
    // answers, and Page 3 fields (property type, taxes/insurance/HOA when
    // they didn't move a watched calc output) never re-ran this effect, so
    // their edits silently failed to persist. The "same" check above still
    // prevents redundant writes when nothing actually changed.
    isAuthenticated, address, inputs,
    // Re-run once when a logged-in buyer reaches Page 4 so a completed
    // purchase-with-loan estimate is persisted even if the final navigation
    // did not itself change an input.
    step === 4,
    calc.totalHousing, calc.cashToClose, calc.dti, calc.qualifies,
    currentPurchaseScenarioSnapshot,
  ]);

  function fmt(n: number): string {
    return "$" + Math.round(n).toLocaleString();
  }
  function fmtCents(n: number): string {
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  function fmtPct(n: number): string {
    return (n * 100).toFixed(1) + "%";
  }

  function Row({ label, value, sub, status, link, onClick, testId }: { label: ReactNode; value: string; sub?: string; status?: "green" | "yellow" | "red"; link?: { url: string; label: string }; onClick?: () => void; testId?: string }) {
    const bg = status === "green" ? "bg-green-50" : status === "yellow" ? "bg-yellow-50" : status === "red" ? "bg-red-50" : "";
    const labelColor = status === "green" ? "text-green-800" : status === "yellow" ? "text-yellow-800" : status === "red" ? "text-red-800" : "text-muted-foreground";
    const valueColor = status === "green" ? "text-green-700 font-bold" : status === "yellow" ? "text-yellow-700 font-bold" : status === "red" ? "text-red-700 font-bold" : "font-semibold";
    const subColor = status === "green" ? "text-green-600" : status === "yellow" ? "text-yellow-600" : status === "red" ? "text-red-600" : "text-muted-foreground";
    return (
      <div
        className={`flex justify-between items-center py-2 px-2 rounded-md transition-colors ${bg} ${onClick ? "cursor-pointer hover:bg-primary/5 group" : ""}`}
        onClick={onClick}
        data-testid={testId}
      >
        <span className={`min-w-0 text-sm ${labelColor} flex flex-wrap items-center gap-x-1.5 gap-y-0`}>
          {label}
          {onClick && <ChevronDown className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />}
          {link && (
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-primary/70 hover:text-primary underline underline-offset-2 font-normal leading-none whitespace-nowrap"
            >
              Look up →
            </a>
          )}
        </span>
        <span className={`shrink-0 text-sm text-right ${valueColor}`} data-testid={testId ? `${testId}-value` : undefined}>
          {value}
          {sub && <span className={`block text-xs font-normal ${subColor}`}>{sub}</span>}
        </span>
      </div>
    );
  }

  function SummaryRow({ label, value, onEdit, sub, testId }: { label: ReactNode; value: string; onEdit: () => void; sub?: string; testId?: string }) {
    return (
      <div className="py-1.5 border-b border-border/30 last:border-0" data-testid={testId}>
        <div className="flex justify-between items-center gap-2">
          <span className="min-w-0 text-xs text-muted-foreground">{label}</span>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="shrink-0 text-xs font-medium text-right" data-testid={testId ? `${testId}-value` : undefined}>{value}</span>
            <button onClick={onEdit} className="text-primary/50 hover:text-primary transition-colors shrink-0" title="Edit">
              <Pencil className="h-2.5 w-2.5" />
            </button>
          </div>
        </div>
        {sub && (
          <p className="text-[10px] text-muted-foreground italic mt-0.5 leading-tight">{sub}</p>
        )}
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Helmet>
        <title>Estimate — {address}</title>
      </Helmet>

      <div className="min-h-screen bg-gray-50">
        {/* Top bar */}
        <div className="bg-white border-b shadow-sm sticky top-[73px] z-40">
          {/* Scenario tabs */}
          <div className="container mx-auto px-4 pt-2 flex items-center gap-1 overflow-x-auto scrollbar-none">
            {scenarios.map((sc) => (
              <div
                key={sc.id}
                onClick={() => switchScenario(sc.id)}
                draggable
                onDragStart={(e) => {
                  setDraggingScenarioId(sc.id);
                  e.dataTransfer.effectAllowed = "move";
                  // Required for Firefox to actually fire drag events.
                  try { e.dataTransfer.setData("text/plain", sc.id); } catch {}
                }}
                onDragOver={(e) => {
                  if (draggingScenarioId && draggingScenarioId !== sc.id) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const fromId = draggingScenarioId || e.dataTransfer.getData("text/plain");
                  if (fromId) moveScenario(fromId, sc.id);
                  setDraggingScenarioId(null);
                }}
                onDragEnd={() => setDraggingScenarioId(null)}
                title="Drag to reorder"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-md text-xs font-medium cursor-pointer whitespace-nowrap border border-b-0 transition-colors ${
                  sc.id === activeScenarioId
                    ? "bg-white border-border text-foreground shadow-sm -mb-px relative z-10"
                    : "bg-gray-100 border-transparent text-muted-foreground hover:bg-gray-200"
                } ${draggingScenarioId === sc.id ? "opacity-50" : ""}`}
              >
                <MapPin className="h-3 w-3 shrink-0" />
                <span>{shortLabel(sc.address)}</span>
                {sc.zillowStatus === "loading" && (
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-primary/70 animate-pulse"
                    title="Pulling Zillow data…"
                    aria-label="Pulling Zillow data"
                  />
                )}
                {(sc.zillowStatus === "applied" ||
                  sc.zillowStatus === "loaded_from_zillow") && (
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-emerald-500"
                    title="Property data updated from Zillow"
                    aria-label="Property data updated from Zillow"
                  />
                )}
                {sc.zillowStatus === "loaded_from_cache" && (
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-emerald-400"
                    title="Property data loaded from saved records"
                    aria-label="Property data loaded from saved records"
                  />
                )}
                {(sc.zillowStatus === "unavailable" || sc.zillowStatus === "error") && (
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-amber-400"
                    title="Property data unavailable"
                    aria-label="Property data unavailable"
                  />
                )}
                {scenarios.length > 1 && (
                  <button
                    onClick={(e) => removeScenario(sc.id, e)}
                    className="ml-0.5 rounded-full hover:bg-black/10 p-0.5 transition-colors"
                    aria-label="Remove scenario"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
            ))}
            {scenarios.length < 5 && (
              <button
                onClick={requestAddScenario}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-t-md text-xs text-muted-foreground hover:text-primary hover:bg-gray-100 border border-transparent border-b-0 transition-colors"
                title="Compare a new property"
              >
                <Plus className="h-3.5 w-3.5" /> Add Property
              </button>
            )}
          </div>
          <div className="container mx-auto px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  // Logged-in users who arrived from the dashboard go
                  // back to the dashboard overview. Everyone else (the
                  // logged-out flow that came through the address →
                  // service picker) goes back to the six-option picker
                  // with their address preserved — never to the bare
                  // home page, which would force re-typing the address.
                  if (fromDashboard) {
                    setLocation("/dashboard");
                  } else {
                    setLocation(
                      address
                        ? `/select-service?address=${encodeURIComponent(address)}`
                        : "/select-service",
                    );
                  }
                }}
                className="text-muted-foreground hover:text-primary transition-colors"
                title={fromDashboard ? "Back to Dashboard" : "Back to Services"}
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Property Estimate</p>
                {isEditingAddress ? (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
                    <input
                      ref={addressInputRef}
                      type="text"
                      value={editAddressVal}
                      onChange={(e) => setEditAddressVal(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter") {
                          const val = editAddressVal.trim();
                          if (val && await authorize("purchase", val)) setLocation(`/estimate?address=${encodeURIComponent(val)}`);
                          setIsEditingAddress(false);
                        } else if (e.key === "Escape") {
                          setIsEditingAddress(false);
                        }
                      }}
                      onBlur={(e) => {
                        // Delay to allow autocomplete click to fire first
                        setTimeout(() => setIsEditingAddress(false), 200);
                      }}
                      className="text-sm font-semibold bg-transparent border-b border-primary outline-none w-72 max-w-full leading-tight pb-0.5"
                      autoComplete="off"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setIsEditingAddress(true)}
                    className="group flex items-center gap-1.5 mt-0.5 hover:text-primary transition-colors text-left"
                  >
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
                    <span className="font-semibold text-sm leading-tight">{address}</span>
                    <Pencil className="h-3 w-3 text-muted-foreground/50 group-hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* "Pull from Zillow" and "Save to Dashboard" have been
                  retired from the normal UI: Zillow now auto-runs after a
                  valid address selection (see triggerZillowLookup), and
                  dashboard saving is automatic for logged-in users via the
                  debounced auto-save effect above. The escape hatches stay
                  available under ?debug=1 for QA. */}
              {debugMode && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setShowZillowLookup(true)}
                  data-testid="estimate-open-zillow-lookup"
                  title="Debug: manually open Zillow lookup dialog"
                >
                  <Home className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Pull from Zillow (debug)</span>
                </Button>
              )}
              {debugMode && (() => {
                const sessionUser = getSession();
                if (!sessionUser) return null;
                return (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    title="Debug: manually save current scenario"
                    onClick={() => {
                      if (!calcRef.current.taxComplete) {
                        toast({ title: "Complete property taxes first", description: "Enter the annual bill before saving this estimate.", variant: "destructive" });
                        return;
                      }
                      const existing = getPurchaseScenarios();
                      const alreadySaved = existing.some(
                        s => s.address.trim().toLowerCase() === address.trim().toLowerCase()
                      );
                      if (alreadySaved) {
                        toast({ title: "Already in your dashboard", description: address });
                      } else {
                        savePurchaseScenarios([
                          ...existing,
                          {
                            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                            address,
                            savedAt: new Date().toISOString(),
                            price: inputs.purchasePrice,
                            monthlyPayment: Math.round(calc.totalHousing),
                          },
                        ]);
                        toast({ title: "Saved to dashboard", description: address });
                      }
                    }}
                  >
                    <LayoutDashboard className="h-4 w-4" /> Save to Dashboard (debug)
                  </Button>
                );
              })()}
              {/* Share + Save Scenario — replaces the previous pair
                  that opened ShareDialog + LeadCaptureDialog so the
                  Purchase-with-Loan detail view uses the same
                  AuthDialog-gated component as the other four flows.
                  Draft state (inputs, scenarios, Zillow cache)
                  survives the dialog because it renders inside this
                  component tree. */}
              <ScenarioActions
                scenarioType="purchase"
                onDownloadPdf={generateEstimatePDF}
                onSave={async () => {
                  if (!calcRef.current.taxComplete) throw new Error("Enter the annual bill before saving this financial estimate.");
                  if (!getSession()) throw new Error("Please sign in before saving.");
                  const existing = getPurchaseScenarios();
                  const key = address.trim().toLowerCase();
                  const match = existing.find(scenario => scenario.address.trim().toLowerCase() === key);
                  const snapshot = {
                    ...currentPurchaseScenarioSnapshot,
                    id: match?.id || activeScenarioIdRef.current,
                    savedAt: match?.savedAt || new Date().toISOString(),
                  };
                  await confirmAnonymousAccountDraftSaved("purchase", () => savePurchaseScenarios(match
                    ? existing.map(scenario => scenario.id === match.id ? { ...scenario, ...snapshot } : scenario)
                    : [...existing, snapshot]));
                }}
              />
            </div>
          </div>
        </div>

        <div className="container mx-auto px-4 py-6">

          {/* Step progress bar */}
          <div className="max-w-2xl mx-auto mb-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-foreground">
                {step === 1 ? "Borrower Profile" : step === 2 ? "Additional Info" : step === 3 ? "Purchase Details" : "Your Estimate"}
              </p>
              <p className="text-xs text-muted-foreground font-medium">Page {step} of 4</p>
            </div>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4].map((s) => (
                <div key={s} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${s <= step ? "bg-primary" : "bg-border"}`} />
              ))}
            </div>
          </div>

          <div className="max-w-2xl mx-auto space-y-4">

            {/* Per-scenario property-data status banner. Shows loading,
                cache-hit, fresh-zillow, or error feedback for the active
                tab only. Tied to the active scenario's id — switching tabs
                shows the status of the new tab, never the old one. */}
            {(() => {
              const sc = scenarios.find(s => s.id === activeScenarioId);
              const status = sc?.zillowStatus;
              if (!status || status === "applied") return null;
              const cfg =
                status === "loading"
                  ? { msg: "Loading property data from Zillow…", cls: "bg-blue-50 border-blue-200 text-blue-800", pulse: true }
                : status === "loaded_from_cache"
                  ? { msg: "Property data loaded from saved records.", cls: "bg-emerald-50 border-emerald-200 text-emerald-800", pulse: false }
                : status === "loaded_from_zillow"
                  ? { msg: "Property data updated from Zillow.", cls: "bg-emerald-50 border-emerald-200 text-emerald-800", pulse: false }
                : status === "error" || status === "unavailable"
                  ? { msg: "Property data unavailable — using default estimates.", cls: "bg-amber-50 border-amber-200 text-amber-800", pulse: false }
                : null;
              if (!cfg) return null;
              return (
                <div
                  className={`flex items-center gap-2 text-xs px-3 py-2 rounded-md border ${cfg.cls}`}
                  data-testid="banner-property-data-status"
                  role="status"
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${cfg.pulse ? "bg-current animate-pulse" : "bg-current"}`}
                    aria-hidden="true"
                  />
                  <span>{cfg.msg}</span>
                  {cfg.pulse && (
                    <span className="ml-auto text-[10px] opacity-70">
                      Purchase price is being derived from property data.
                    </span>
                  )}
                </div>
              );
            })()}

            {/* Per-scenario dashboard auto-save indicator. Only renders for
                logged-in users, and only when there's a transient status
                to show on the ACTIVE tab. Driven by `saveStatus` on the
                Scenario object, which the auto-save effect writes per id —
                so a save in progress on tab 2 never shows "Saving…" on
                tab 1. Logged-out users see no indicator (their work stays
                local; the "Save Scenario" button still routes them to
                account creation). */}
            {isAuthenticated && (() => {
              const sc = scenarios.find(s => s.id === activeScenarioId);
              const ss = sc?.saveStatus;
              if (!ss || ss === "idle") return null;
              const cfg =
                ss === "saving"
                  ? { msg: "Saving to your dashboard…", cls: "text-muted-foreground", dot: "bg-blue-400 animate-pulse" }
                : ss === "saved"
                  ? { msg: "Saved to your dashboard", cls: "text-emerald-700", dot: "bg-emerald-500" }
                : { msg: "Unable to save — will retry on next change", cls: "text-amber-700", dot: "bg-amber-500" };
              return (
                <div
                  className={`flex items-center gap-1.5 text-[11px] ${cfg.cls} -mt-2`}
                  data-testid="indicator-dashboard-save-status"
                  role="status"
                  aria-live="polite"
                >
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${cfg.dot}`} aria-hidden="true" />
                  <span>{cfg.msg}</span>
                </div>
              );
            })()}

            {/* ── STEP 1: Borrower Profile ───
                Rendered either as a normal questionnaire step (step === 1)
                or, when the user clicks the pencil on the summary, inside
                a Dialog overlay (editingPage === 1) without leaving the
                Property Estimate. The Card body is identical in both
                modes; only the wrapper differs. */}
            {(step === 1 || editingPage === 1) && (
              <StepEditWrapper
                editing={editingPage === 1}
                title="Edit Borrower Profile"
                onClose={() => setEditingPage(null)}
              >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <UserCheck className="h-4 w-4 text-primary" />
                    Borrower Profile
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  {/* Occupancy Type */}
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">Property Use (required)</p>
                    <div className="flex gap-2">
                      {(["primary", "secondary", "investment"] as const).map((occ) => (
                        <button
                          key={occ}
                          onClick={() => setOccupancy(occ)}
                          className={`flex-1 py-1.5 rounded-md text-xs font-semibold border capitalize transition-colors ${
                            inputs.propertyUseSelected && inputs.occupancy === occ
                              ? "bg-primary text-white border-primary"
                              : "border-border text-muted-foreground hover:border-primary"
                          }`}
                        >
                          {occ}
                        </button>
                      ))}
                    </div>
                    {!inputs.propertyUseSelected && <p className="text-xs mt-2 text-muted-foreground">Select Property Use to calculate property tax.</p>}
                    {inputs.propertyUseSelected && inputs.occupancy !== "primary" && (
                      <p className="text-[11px] mt-1.5 text-amber-600 font-medium">
                        {inputs.occupancy === "secondary"
                          ? "Secondary home requires minimum 10% down"
                          : "Investment property requires minimum 20% down"}
                      </p>
                    )}

                    {inputs.occupancy === "investment" && (
                      <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg animate-in fade-in slide-in-from-top-2 duration-200">
                        <p className="text-xs font-semibold text-blue-800 mb-2">How do you plan to rent this property?</p>
                        <div className="flex gap-2">
                          {([
                            { value: "annual", label: "Annual Lease", sub: "12-month tenant" },
                            { value: "short-term", label: "Short-Term Rental", sub: "Airbnb / VRBO" },
                          ] as const).map(({ value, label, sub }) => (
                            <button
                              key={value}
                              onClick={() => set("rentalType", value)}
                              className={`flex-1 py-2 px-2 rounded-md text-left border transition-colors ${
                                inputs.rentalType === value
                                  ? "bg-blue-600 text-white border-blue-600"
                                  : "bg-white border-blue-200 text-blue-900 hover:border-blue-400"
                              }`}
                            >
                              <p className="text-xs font-semibold leading-tight">{label}</p>
                              <p className={`text-[10px] leading-tight mt-0.5 ${inputs.rentalType === value ? "text-blue-100" : "text-muted-foreground"}`}>{sub}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1">
                    <SliderInput
                      label="Monthly Gross Income (exclude rental income)"
                      value={inputs.monthlyIncome}
                      onChange={(v) => {
                        // Stamp source=manual the moment the user touches
                        // the slider so the AMI-prefill effect (and any
                        // future address-change recompute) treats this as
                        // the borrower's source of truth and never
                        // overwrites it with a county-AMI default.
                        setInputs(p => ({
                          ...p,
                          monthlyIncome: v,
                          monthlyIncomeSource: "manual",
                          qualificationInputsConfirmed:false,
                        }));
                      }}
                      min={1000} max={50000} step={100}
                      prefix="$"
                    />
                    {amiData && (
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        <span className="text-green-600 font-medium">Auto-set from Area Median Income</span>
                        {" · "}{amiData.areaName.split(",").slice(0, 2).join(",")}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <SliderInput
                      label="Monthly Debts (mortgage, auto, cards, etc.)"
                      value={inputs.monthlyDebts}
                      onChange={(v) => set("monthlyDebts", v)}
                      min={0} max={10000} step={50}
                      prefix="$"
                    />
                    {/* When the borrower has reported deferred student
                        loans on Page 2, the lender-assumed monthly
                        payment is layered on top of the typed amount
                        and the *total* is what DTI uses. We show both
                        lines so the user understands their typed value
                        is preserved while DTI reflects the full debt
                        picture. The slider above remains the user's
                        editable base — only the helper text + total
                        below change as Page 2 / loan type changes. */}
                    {calc.deferredStudentLoanMonthly > 0 && (
                      <div className="text-[11px] leading-tight space-y-0.5 pt-0.5">
                        <div className="flex justify-between text-muted-foreground">
                          <span>Deferred student loan estimate</span>
                          <span>+{fmt(calc.deferredStudentLoanMonthly)}/mo</span>
                        </div>
                        <div className="flex justify-between font-semibold border-t border-border/40 pt-0.5 text-foreground">
                          <span>Total monthly debts (used for DTI)</span>
                          <span data-testid="text-total-monthly-debts">{fmt(calc.totalMonthlyDebts)}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground italic pt-0.5">
                          Includes {fmt(calc.deferredStudentLoanMonthly)}/mo estimated deferred student loan payment.
                        </p>
                      </div>
                    )}
                  </div>
                  {/* Reserves field with inline
                      asset eligibility guide */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        Available Reserves / Savings
                      </span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            aria-label="What counts as reserves"
                            className="text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
                          >
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-72 p-4 text-xs"
                          side="top"
                          align="start"
                        >
                          <p className="font-semibold text-foreground mb-2">
                            What to include
                          </p>
                          <ul className="space-y-1 text-muted-foreground mb-3">
                            <li className="flex items-start gap-1.5">
                              <span className="text-green-600 mt-0.5">✓</span>
                              Checking &amp; savings accounts
                            </li>
                            <li className="flex items-start gap-1.5">
                              <span className="text-green-600 mt-0.5">✓</span>
                              Investment / brokerage accounts
                            </li>
                            <li className="flex items-start gap-1.5">
                              <span className="text-green-600 mt-0.5">✓</span>
                              60% of 401(k) or IRA balance
                            </li>
                            <li className="flex items-start gap-1.5">
                              <span className="text-green-600 mt-0.5">✓</span>
                              Gift funds from a family member (with gift letter)
                            </li>
                          </ul>
                          <p className="font-semibold text-foreground mb-2">
                            Do not include
                          </p>
                          <ul className="space-y-1 text-muted-foreground">
                            <li className="flex items-start gap-1.5">
                              <span className="text-red-500 mt-0.5">✗</span>
                              Cash not in a bank account
                            </li>
                            <li className="flex items-start gap-1.5">
                              <span className="text-red-500 mt-0.5">✗</span>
                              Life insurance policy cash value
                            </li>
                          </ul>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <SliderInput
                      label=""
                      value={inputs.reserves}
                      onChange={(v) => set("reserves", v)}
                      min={0} max={500000} step={1000}
                      prefix="$"
                    />
                  </div>
                  <SliderInput
                    label="Credit Score"
                    value={inputs.creditScore}
                    onChange={setCreditScore}
                    min={580} max={850} step={10}
                  />

                </CardContent>
              </Card>
              </StepEditWrapper>
            )}

            {step === 1 && (
              <div className="flex justify-end pt-2">
                <Button disabled={!inputs.propertyUseSelected} onClick={() => { setStep(2); scrollToTop(); }} className="gap-2">
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            {/* ── STEP 2: Additional Info ─── */}
            {(step === 2 || editingPage === 2) && (
              <StepEditWrapper
                editing={editingPage === 2}
                title="Edit Additional Info"
                onClose={() => setEditingPage(null)}
              >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-primary" />
                    Additional Info
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  {/* Current mortgage questions */}
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">Do you currently have a mortgage?</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setInputs((p) => {
                            const newMin = getMinDown(p.loanType, true, p.occupancy);
                            return { ...p, hasMortgage: true, downPaymentPct: clampDownPaymentPct(p.downPaymentPct, newMin) };
                          })}
                          className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.hasMortgage === true ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setInputs((p) => ({ ...p, hasMortgage: false, currentLoanFHA: null }))}
                          className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.hasMortgage === false ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                        >
                          No
                        </button>
                      </div>
                    </div>

                    {inputs.hasMortgage === true && (
                      <div className="space-y-3">
                        <div>
                          <p className="text-xs text-muted-foreground mb-2">Is your current loan FHA?</p>
                          <div className="flex gap-2">
                            <button
                              onClick={() => set("currentLoanFHA", true)}
                              className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.currentLoanFHA === true ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                            >
                              Yes
                            </button>
                            <button
                              onClick={() => set("currentLoanFHA", false)}
                              className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.currentLoanFHA === false ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                            >
                              No
                            </button>
                          </div>

                          {inputs.currentLoanFHA === true && (
                            <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                              <p className="text-xs font-semibold text-amber-800 mb-1.5">FHA allows only one loan at a time.</p>
                              <p className="text-xs text-amber-700 mb-1.5">A second FHA loan is only permitted if you qualify for one of these exceptions:</p>
                              <ul className="text-xs text-amber-700 space-y-1 list-none">
                                <li className="flex items-start gap-1.5"><span className="mt-0.5 shrink-0">1.</span> Growing family size</li>
                                <li className="flex items-start gap-1.5"><span className="mt-0.5 shrink-0">2.</span> Co-signer / co-borrower situation</li>
                                <li className="flex items-start gap-1.5"><span className="mt-0.5 shrink-0">3.</span> Divorcing from co-borrower</li>
                                <li className="flex items-start gap-1.5"><span className="mt-0.5 shrink-0">4.</span> Relocating more than 100 miles from current home</li>
                              </ul>
                              <a
                                href="https://answers.hud.gov/FHA/s/article/Can-a-person-have-more-than-one-FHA-loan"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[10px] text-primary underline underline-offset-2 mt-2 inline-block"
                              >
                                HUD.gov — FHA multiple loan policy
                              </a>
                            </div>
                          )}
                        </div>

                        {/* Rental income question */}
                        <div className="space-y-3">
                          <div>
                            <p className="text-xs text-muted-foreground mb-2">Do you receive any rental income to help pay for these mortgages?</p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => set("hasRentalIncome", true)}
                                className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.hasRentalIncome === true ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setInputs((p) => ({ ...p, hasRentalIncome: false, monthlyRentalIncome: 0 }))}
                                className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.hasRentalIncome === false ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                              >
                                No
                              </button>
                            </div>
                          </div>
                          {inputs.hasRentalIncome === true && (
                            <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                              <SliderInput
                                label="Monthly Rental Income (gross)"
                                value={inputs.monthlyRentalIncome}
                                onChange={(v) => set("monthlyRentalIncome", v)}
                                min={0} max={20000} step={100}
                                prefix="$"
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">
                                75% ({fmt(calc.rentalIncomeQualifying)}/mo) counts toward qualifying income
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {inputs.occupancy === "primary" && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">Are you a Veteran?</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setInputs((p) => ({
                            ...p,
                            isVeteran: true,
                            loanType: "va",
                            downPaymentPct: 0,
                            vaDisability: null,
                            vaDisabilityRating100: null,
                            vaLoanUse: null,
                            interestRate: fullRate(rates.va, p.creditScore, p.occupancy, 0, "va", undefined, undefined, undefined, p.purchasePrice * 1),
                            // Clear any prior exemption since the rating-100 answer is being reset
                            annualTaxes: computePropertyTax(address, p.purchasePrice, p.occupancy, null, p),
                          }))}
                          className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.isVeteran === true ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setInputs((p) => ({
                            ...p,
                            isVeteran: false,
                            loanType: "conventional",
                            vaDisability: null,
                            vaDisabilityRating100: null,
                            vaLoanUse: null,
                            interestRate: fullRate(rates.conventional, p.creditScore, p.occupancy, p.downPaymentPct, "conventional", p.monthlyIncome, amiData?.annualAMI, p.propertyType, p.purchasePrice * (1 - (p.downPaymentPct ?? 0) / 100)),
                            annualTaxes: computePropertyTax(address, p.purchasePrice, p.occupancy, null, p),
                          }))}
                          className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.isVeteran === false ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                        >
                          No
                        </button>
                      </div>

                      {inputs.isVeteran === true && (
                        <div className="mt-3 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                          <div>
                            <p className="text-xs text-muted-foreground mb-2">Do you receive VA disability?</p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => setInputs((p) => ({
                                  ...p,
                                  vaDisability: true,
                                  vaLoanUse: null,
                                  // vaDisabilityRating100 stays untouched if already answered;
                                  // otherwise the follow-up question will render below.
                                }))}
                                className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.vaDisability === true ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setInputs((p) => ({
                                  ...p,
                                  vaDisability: false,
                                  vaLoanUse: null,
                                  // User no longer receives VA disability → reset the
                                  // rating-100 answer and drop any homestead exemption.
                                  vaDisabilityRating100: null,
                                  annualTaxes: computePropertyTax(address, p.purchasePrice, p.occupancy, null, p),
                                }))}
                                className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.vaDisability === false ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                              >
                                No
                              </button>
                            </div>
                            {inputs.vaDisability === true && (
                              <p className="text-[11px] text-green-700 mt-1.5 font-medium">No funding fee — loan amount equals the base loan only.</p>
                            )}
                          </div>

                          {/* Follow-up: rating 100%? Only when they've said
                              they receive VA disability. Strictly Yes/No —
                              no "Not sure" option, per product spec, so the
                              homestead-exemption estimate is only applied
                              when the user has explicitly confirmed both
                              100% rating AND primary residence. */}
                          {inputs.vaDisability === true && (
                            <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                              <p className="text-xs text-muted-foreground mb-2">Is your VA disability rating 100%?</p>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => setInputs((p) => ({
                                    ...p,
                                    vaDisabilityRating100: true,
                                    // Apply (or clear) exemption based on current occupancy.
                                    annualTaxes: computePropertyTax(address, p.purchasePrice, p.occupancy, true, p),
                                  }))}
                                  className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.vaDisabilityRating100 === true ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                                  data-testid="btn-va-rating-100-yes"
                                >
                                  Yes
                                </button>
                                <button
                                  onClick={() => setInputs((p) => ({
                                    ...p,
                                    vaDisabilityRating100: false,
                                    // Drop any exemption — normal estimate applies.
                                    annualTaxes: computePropertyTax(address, p.purchasePrice, p.occupancy, false, p),
                                  }))}
                                  className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.vaDisabilityRating100 === false ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                                  data-testid="btn-va-rating-100-no"
                                >
                                  No
                                </button>
                              </div>
                              {inputs.vaDisabilityRating100 === false && (
                                <p className="text-[11px] text-muted-foreground mt-1.5">
                                  VA disability may qualify for an exemption. Confirm eligibility with the county property appraiser; the amount still requires official data or a manual bill.
                                </p>
                              )}
                            </div>
                          )}

                          {inputs.vaDisability === false && (
                            <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                              <p className="text-xs text-muted-foreground mb-2">Is this your first or second time using a VA loan?</p>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => setInputs((p) => ({ ...p, vaLoanUse: "first" }))}
                                  className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.vaLoanUse === "first" ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                                >
                                  First use (2.15%)
                                </button>
                                <button
                                  onClick={() => setInputs((p) => ({ ...p, vaLoanUse: "second" }))}
                                  className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.vaLoanUse === "second" ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                                >
                                  Second use (3.30%)
                                </button>
                              </div>
                              <p className="text-[11px] text-muted-foreground mt-1.5">Funding fee is financed into the loan amount.</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Deferred student loans — DTI add-on. Even when a
                      borrower's student loans are in deferment, lenders
                      assume a monthly payment for DTI purposes. The
                      assumed percentage of the deferred balance varies
                      by loan program (see `deferredStudentLoanFactor`).
                      Saved per-scenario so the answer + balance persist
                      across refresh / logout / login, and the calc
                      automatically retunes when the user changes loan
                      type on Page 3. */}
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">
                        Do you have any deferred student loans right now?
                      </p>
                      <div className="flex gap-2">
                        <button
                          data-testid="btn-deferred-sl-yes"
                          onClick={() =>
                            setInputs((p) => ({ ...p, hasDeferredStudentLoans: true }))
                          }
                          className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.hasDeferredStudentLoans === true ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                        >
                          Yes
                        </button>
                        <button
                          data-testid="btn-deferred-sl-no"
                          onClick={() =>
                            // "No" clears the balance to $0 so DTI ignores
                            // any previously-entered amount.
                            setInputs((p) => ({
                              ...p,
                              hasDeferredStudentLoans: false,
                              deferredStudentLoanBalance: 0,
                            }))
                          }
                          className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.hasDeferredStudentLoans === false ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                        >
                          No
                        </button>
                      </div>
                    </div>

                    {inputs.hasDeferredStudentLoans === true && (
                      <div className="animate-in fade-in slide-in-from-top-2 duration-200 space-y-1.5">
                        <SliderInput
                          label="What is the total balance of your deferred student loans?"
                          value={inputs.deferredStudentLoanBalance ?? 0}
                          onChange={(v) => set("deferredStudentLoanBalance", v)}
                          min={0}
                          max={300000}
                          step={1000}
                          prefix="$"
                        />
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Conventional assumes 1% of the total deferred student loan balance as a monthly DTI payment.
                          FHA, VA, and USDA assume 0.5% of the total deferred student loan balance.
                        </p>
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Only enter the deferred balance here if the payment is not already included in your monthly debts.
                        </p>
                        {(inputs.deferredStudentLoanBalance ?? 0) > 0 && (
                          <p className="text-[11px] text-emerald-700 font-medium">
                            +{fmt(Math.round((inputs.deferredStudentLoanBalance ?? 0) * deferredStudentLoanFactor(inputs.loanType)))}/mo added to DTI ({inputs.loanType === "conventional" || inputs.loanType === "jumbo" || inputs.loanType === "bank_statement" ? "1.0%" : inputs.loanType === "dscr" ? "0%" : "0.5%"} of balance for {inputs.loanType.toUpperCase()})
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
              </StepEditWrapper>
            )}

            {step === 2 && (
              <div className="flex justify-between pt-2">
                <Button variant="outline" onClick={() => setStep(1)} className="gap-2">
                  <ChevronLeft className="h-4 w-4" /> Back
                </Button>
                <Button onClick={() => { setStep(3); scrollToTop(); }} className="gap-2">
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            {/* ── STEP 3: Purchase Details ─── */}
            {(step === 3 || editingPage === 3) && (
              <StepEditWrapper
                editing={editingPage === 3}
                title="Edit Purchase Details"
                onClose={() => setEditingPage(null)}
              >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-primary" />
                    Purchase Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <SliderInput
                    label="Purchase Price"
                    value={inputs.purchasePrice}
                    onChange={handlePurchasePriceChange}
                    min={50000} max={3000000} step={5000}
                    prefix="$"
                  />
                  {/* Source label — tells the user where the purchase price
                      came from so the default $350k isn't mistaken for a
                      derived value while Zillow/cache is still loading. */}
                  {(() => {
                    const activeScenarioStatus =
                      scenarios.find(s => s.id === activeScenarioId)?.zillowStatus;
                    const loading = activeScenarioStatus === "loading";
                    const src = inputs.purchasePriceSource ?? "default";
                    const label =
                      loading && src === "default"
                        ? "Temporary estimate — waiting for property data…"
                      : src === "user" ? "Source: You entered this value"
                      : src === "zillow_sold" ? "Source: Zillow sold price"
                      : src === "zillow_listing" ? "Source: Zillow listing price"
                      : src === "zillow_zestimate" ? "Source: Zillow Zestimate"
                      : src === "zillow_cache" ? "Source: Saved property data"
                      : "Source: Temporary estimate";
                    const tone =
                      loading && src === "default" ? "text-amber-600"
                      : src === "default" || activeScenarioStatus === "error" ? "text-muted-foreground"
                      : "text-emerald-700";
                    return (
                      <p
                        className={`text-[11px] -mt-3 ${tone}`}
                        data-testid="text-purchase-price-source"
                      >
                        {label}
                      </p>
                    );
                  })()}

                  {/* Property Type — sits directly under Purchase Price
                      per spec. Defaults to "Single Family Residence";
                      auto-seeded from Zillow scraper unless the user has
                      manually overridden it. Provenance is persisted to
                      `purchase_scenarios.property_type_source` so a later
                      Zillow refresh never clobbers a manual pick. */}
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">Property Type</Label>
                    <Select
                      value={inputs.propertyType ?? "Single Family Residence"}
                      onValueChange={(v) =>
                        setInputs((p) => ({
                          ...p,
                          propertyType: v,
                          propertyTypeSource: "manual",
                          annualFloodIns: suppressSeparateFloodInsurance(v)
                            ? 0
                            : floodData?.requiresFloodInsurance === true && p.annualFloodIns === 0
                              ? 2000
                              : p.annualFloodIns,
                        }))
                      }
                    >
                      <SelectTrigger data-testid="select-property-type"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PROPERTY_TYPE_OPTIONS.map((opt) => (
                          <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                        ))}
                        {/* Surface any saved value that's not in the
                            canonical list (older row / alt Zillow label)
                            so the user's stored pick never silently
                            disappears. */}
                        {inputs.propertyType &&
                          !PROPERTY_TYPE_OPTIONS.includes(inputs.propertyType as any) && (
                            <SelectItem value={inputs.propertyType}>{inputs.propertyType}</SelectItem>
                          )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">Loan Type</Label>
                    <Select
                      value={inputs.loanType}
                      onValueChange={(v) => setLoanType(v as any)}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {/* Conventional requires a 620+ FICO. We keep
                            the row visible but disable it below 620 so
                            the Select always has the currently-selected
                            value (avoids an empty trigger on sub-620
                            secondary, which has no other option). */}
                        <SelectItem value="conventional" disabled={inputs.creditScore < CONVENTIONAL_MIN_FICO}>
                          Conventional{inputs.creditScore < CONVENTIONAL_MIN_FICO ? " (requires 620+ FICO)" : ""}
                        </SelectItem>
                        {/* Jumbo — for loans above the conforming limit.
                            Same FICO gating + pricing as Conventional. */}
                        <SelectItem value="jumbo" disabled={inputs.creditScore < CONVENTIONAL_MIN_FICO}>
                          Jumbo{inputs.creditScore < CONVENTIONAL_MIN_FICO ? " (requires 620+ FICO)" : ""}
                        </SelectItem>
                        {inputs.occupancy === "primary" && <SelectItem value="fha">FHA</SelectItem>}
                        {inputs.occupancy === "primary" && <SelectItem value="va">VA</SelectItem>}
                        {inputs.occupancy === "primary" && <SelectItem value="usda">USDA</SelectItem>}
                        {inputs.occupancy === "investment" && <SelectItem value="dscr">DSCR</SelectItem>}
                      </SelectContent>
                    </Select>
                    {inputs.occupancy === "investment" && (
                      <p className="text-[11px] mt-1.5 leading-tight text-muted-foreground" data-testid="text-investment-loan-note">
                        Investment properties are limited to Conventional or DSCR in this estimate.
                      </p>
                    )}
                    {inputs.creditScore < CONVENTIONAL_MIN_FICO && inputs.occupancy !== "primary" && (
                      <p className="text-[11px] mt-1.5 leading-tight text-red-600 font-medium">
                        Conventional is not available below a 620 credit score. {inputs.occupancy === "investment" ? "Consider DSCR, which doesn't have the same FICO floor." : "Improve credit to 620+ to qualify for a secondary-home loan."}
                      </p>
                    )}
                    {inputs.creditScore < CONVENTIONAL_MIN_FICO && inputs.occupancy === "primary" && (
                      <p className="text-[11px] mt-1.5 leading-tight text-amber-600 font-medium">
                        Conventional hidden — minimum 620 FICO required.
                      </p>
                    )}
                    {inputs.occupancy === "secondary" ? (
                      <p className="text-[11px] mt-1.5 leading-tight text-muted-foreground">
                        <span className="text-amber-600 font-medium">Only Conventional available for secondary properties</span>
                      </p>
                    ) : inputs.occupancy === "investment" ? null : (
                      <ul className="mt-1.5 space-y-0.5 text-[11px] leading-tight text-muted-foreground">
                        <li>Conventional — best if credit score &gt; 720</li>
                        <li>FHA — best if credit score &lt; 720</li>
                        <li>VA — only if you are a Veteran</li>
                        <li>
                          <a
                            href="https://eligibility.sc.egov.usda.gov/eligibility/welcomeAction.do?pageAction=sfp"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-foreground"
                          >USDA</a> — only if the home qualifies with USDA
                        </li>
                      </ul>
                    )}
                  </div>

                  {/* FHA Down Payment Assistance (DPA) — only offered on
                      FHA loans. Answers are persisted via
                      userAnswerSources and applied in the calc memo. */}
                  {inputs.loanType === "fha" && (
                    <div className="space-y-3 rounded-md border border-border p-3" data-testid="dpa-section">
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1.5 block">Would you like Down Payment Assistance (DPA)?</Label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            data-testid="dpa-yes"
                            onClick={() => setDpa({ dpaEnabled: true })}
                            className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.dpaEnabled === true ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                          >Yes</button>
                          <button
                            type="button"
                            data-testid="dpa-no"
                            onClick={() => setDpa({ dpaEnabled: false })}
                            className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${inputs.dpaEnabled === false ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                          >No</button>
                        </div>
                      </div>
                      {inputs.dpaEnabled === true && (
                        <div>
                          <Label className="text-xs text-muted-foreground mb-1.5 block">How much assistance?</Label>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              data-testid="dpa-pct-35"
                              onClick={() => setDpa({ dpaPct: 3.5 })}
                              className={`flex-1 py-1.5 px-2 rounded-md border text-left transition-colors ${inputs.dpaPct === 3.5 ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                            >
                              <span className="block text-xs font-semibold">3.5%</span>
                              <span className="block text-[10px] text-muted-foreground leading-tight">Covers your full down payment</span>
                            </button>
                            <button
                              type="button"
                              data-testid="dpa-pct-5"
                              onClick={() => setDpa({ dpaPct: 5 })}
                              className={`flex-1 py-1.5 px-2 rounded-md border text-left transition-colors ${inputs.dpaPct === 5 ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                            >
                              <span className="block text-xs font-semibold">5%</span>
                              <span className="block text-[10px] text-muted-foreground leading-tight">Down payment + 1.5% toward closing costs</span>
                            </button>
                          </div>
                        </div>
                      )}
                      {inputs.dpaEnabled === true && inputs.dpaPct != null && (
                        <div>
                          <Label className="text-xs text-muted-foreground mb-1.5 block">How is the assistance repaid?</Label>
                          <div className="space-y-1.5">
                            <button
                              type="button"
                              data-testid="dpa-second-amortizing"
                              onClick={() => setDpa({ dpaSecondType: "amortizing" })}
                              className={`w-full py-1.5 px-2 rounded-md border text-left transition-colors ${inputs.dpaSecondType === "amortizing" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                            >
                              <span className="block text-xs font-semibold">Fully Amortizing 2nd Mortgage</span>
                              <span className="block text-[10px] text-muted-foreground leading-tight">Repay the {inputs.dpaPct}% over 10 years at the FHA rate + 2%</span>
                            </button>
                            <button
                              type="button"
                              data-testid="dpa-second-silent"
                              onClick={() => setDpa({ dpaSecondType: "silent" })}
                              className={`w-full py-1.5 px-2 rounded-md border text-left transition-colors ${inputs.dpaSecondType === "silent" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                            >
                              <span className="block text-xs font-semibold">Fully Silent 2nd Mortgage</span>
                              <span className="block text-[10px] text-muted-foreground leading-tight">No payments — but you must keep the home 10 years. If you refinance, the full amount is owed back.</span>
                            </button>
                          </div>
                        </div>
                      )}
                      {calc.dpaActive && (
                        <div className="rounded-md bg-muted/50 p-2 space-y-0.5" data-testid="dpa-summary">
                          <p className="text-[11px] leading-tight">
                            <span className="font-semibold">DPA applied:</span> {fmt(calc.dpaAmount)} assistance · rate adjusted +{calc.dpaRateBump.toFixed(2)}% → <span className="font-semibold">{calc.finalRate.toFixed(3)}%</span>
                          </p>
                          {calc.dpaSecondType === "amortizing" && (
                            <p className="text-[11px] leading-tight text-muted-foreground">
                              Adds a 2nd mortgage payment of <span className="font-semibold text-foreground">{fmt(calc.dpaSecondMonthly)}/mo</span> ({fmt(calc.dpaAmount)} @ {calc.dpaSecondRate.toFixed(3)}% over 10 yrs)
                            </p>
                          )}
                          {calc.dpaSecondType === "silent" && (
                            <p className="text-[11px] leading-tight text-muted-foreground">
                              No 2nd mortgage payment. You must keep the home 10 years — refinancing means the full {fmt(calc.dpaAmount)} is owed back.
                            </p>
                          )}
                          {calc.dpaExtraPointsCost > 0 && (
                            <p className="text-[11px] leading-tight text-amber-700 font-medium">
                              Adds 2 discount points ({fmt(calc.dpaExtraPointsCost)}) to your cash to close.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(() => {
                    if (dpaSelectionComplete) {
                      return (
                        <div className="space-y-1" data-testid="dpa-down-payment-covered">
                          <span className="text-xs text-muted-foreground">
                            Down Payment
                            <span className="ml-1.5 text-foreground/80 font-medium">
                              3.50% / ${Math.round(inputs.purchasePrice * 0.035).toLocaleString()}
                            </span>
                          </span>
                          <p className="text-[11px] text-emerald-700 font-medium leading-tight">
                            Fully covered by your Down Payment Assistance program.
                          </p>
                        </div>
                      );
                    }
                    const minDown = getMinDown(inputs.loanType, inputs.hasMortgage, inputs.occupancy);
                    const mode: "percent" | "amount" = inputs.downPaymentMode ?? "percent";
                    const dpAmt =
                      inputs.downPaymentAmount ??
                      Math.round(inputs.purchasePrice * (inputs.downPaymentPct / 100));
                    const minAmt = Math.round(inputs.purchasePrice * (minDown / 100));
                    const loanAmt = Math.max(0, inputs.purchasePrice - dpAmt);
                    const snapPoints = [
                      { pct: 0,   label: "0%",   sub: "VA / USDA" },
                      { pct: 3,   label: "3%",   sub: "Conv (no mtg)" },
                      { pct: 3.5, label: "3.5%", sub: "FHA" },
                      { pct: 5,   label: "5%",   sub: "Conv (w/ mtg)" },
                      { pct: 10,  label: "10%",  sub: "Secondary" },
                      { pct: 20,  label: "20%",  sub: "Investment" },
                    ];
                    return (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">
                            Down Payment
                            <span className="ml-1.5 text-foreground/80 font-medium">
                              {Number(inputs.downPaymentPct).toFixed(2)}% / ${dpAmt.toLocaleString()}
                            </span>
                          </span>
                          <div className="inline-flex rounded-md border border-border overflow-hidden text-[11px]">
                            <button
                              type="button"
                              data-testid="dp-mode-percent"
                              onClick={() => setDownPaymentMode("percent")}
                              className={`px-2 py-0.5 transition-colors ${
                                mode === "percent"
                                  ? "bg-primary text-primary-foreground font-semibold"
                                  : "bg-background text-muted-foreground hover:text-foreground"
                              }`}
                            >Percentage</button>
                            <button
                              type="button"
                              data-testid="dp-mode-amount"
                              onClick={() => setDownPaymentMode("amount")}
                              className={`px-2 py-0.5 transition-colors border-l border-border ${
                                mode === "amount"
                                  ? "bg-primary text-primary-foreground font-semibold"
                                  : "bg-background text-muted-foreground hover:text-foreground"
                              }`}
                            >Dollar Amount</button>
                          </div>
                        </div>
                        {mode === "percent" ? (
                          <SliderInput
                            label=""
                            value={inputs.downPaymentPct}
                            onChange={(v) => setDownPayment(v)}
                            min={minDown} max={MAX_DOWN_PAYMENT_PCT} step={0.5}
                            suffix="%" decimals={1}
                          />
                        ) : (
                          <SliderInput
                            label=""
                            value={dpAmt}
                            onChange={(v) => setDownPaymentDollars(v)}
                            min={minAmt}
                            max={Math.max(minAmt, Math.floor(inputs.purchasePrice * (MAX_DOWN_PAYMENT_PCT / 100)))}
                            step={500}
                            prefix="$"
                          />
                        )}
                        <div className="flex gap-1 flex-wrap pt-0.5">
                          {snapPoints.map(({ pct, label, sub }) => {
                            const isMin = pct === minDown;
                            const isCurrent = inputs.downPaymentPct === pct;
                            const isDisabled = pct < minDown;
                            return (
                              <button
                                key={pct}
                                disabled={isDisabled}
                                onClick={() => setDownPayment(pct)}
                                className={`flex flex-col items-center px-2 py-1 rounded border text-[10px] leading-tight transition-colors ${
                                  isDisabled
                                    ? "border-border/30 text-muted-foreground/30 cursor-not-allowed"
                                    : isMin
                                    ? "border-primary bg-primary/5 text-primary font-semibold"
                                    : isCurrent
                                    ? "border-primary/60 text-primary"
                                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                                }`}
                              >
                                <span className="font-semibold">{label}</span>
                                <span className="text-[9px] opacity-70">{sub}</span>
                              </button>
                            );
                          })}
                        </div>
                        <div className="text-[11px] text-muted-foreground leading-tight pt-0.5">
                          Loan Amount: <span className="text-foreground font-semibold">${loanAmt.toLocaleString()}</span>
                          <span className="ml-1 opacity-70">(calculated: purchase price − down payment)</span>
                        </div>
                      </div>
                    );
                  })()}

                  {renderSellerConcessions()}

                  <div data-testid="purchase-property-tax-input">{renderPropertyTaxRow()}</div>

                  <div className="space-y-1" data-testid="editable-rate-disclosure">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">
                        Interest Rate{" "}
                        {aprPct !== null && <em>{formatAprParenthetical(aprPct)}</em>}
                      </span>
                      {liveRates && (
                        <span className="text-[10px] font-semibold bg-green-100 text-green-700 rounded px-1 py-0.5 leading-none">LIVE</span>
                      )}
                      {liveRates && (
                        <a
                          href="https://www.mortgagenewsdaily.com/mortgage-rates"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-primary/60 hover:text-primary underline underline-offset-2 leading-none"
                        >
                          mortgagenewsdaily.com
                        </a>
                      )}
                    </div>
                    <SliderInput
                      label=""
                      value={inputs.interestRate}
                      onChange={(v) => set("interestRate", v)}
                      min={3} max={12} step={0.005}
                      suffix="%"
                      decimals={3}
                    />
                    {calc.dpaActive && (
                      <p className="text-[11px] text-amber-700 font-medium pt-1" data-testid="note-dpa-rate-bump">
                        DPA rate adjustment: +{calc.dpaRateBump.toFixed(2)}% → final rate {calc.finalRate.toFixed(3)}%
                      </p>
                    )}
                    {/* AMI-based Conventional rate discount note.
                        Only rendered for Primary + Conventional;
                        helper short-circuits to discountPercent=0
                        for every other flow so this block is a
                        no-op there. The exact same helper feeds
                        `fullRate`, so the badge and the displayed
                        rate can never disagree. */}
                    {inputs.loanType === "conventional" && inputs.occupancy === "primary" && (() => {
                      const ami = getConventionalAmiRateDiscount({
                        monthlyIncome: inputs.monthlyIncome,
                        annualAMI: amiData?.annualAMI,
                        loanType: inputs.loanType,
                        occupancy: inputs.occupancy,
                      });
                      if (ami.eligible) {
                        return (
                          <p
                            className="text-[11px] text-emerald-700 font-medium pt-1"
                            data-testid="note-ami-discount-applied"
                          >
                            AMI Conventional Rate Discount: −{ami.discountPercent.toFixed(3)}%
                            <span className="text-muted-foreground font-normal ml-1">
                              ({ami.reason.toLowerCase()})
                            </span>
                          </p>
                        );
                      }
                      if (!amiData?.annualAMI && address && address !== "Unknown Address") {
                        return (
                          <p
                            className="text-[11px] text-muted-foreground pt-1"
                            data-testid="note-ami-discount-unavailable"
                          >
                            AMI discount unavailable because county AMI could not be determined.
                          </p>
                        );
                      }
                      return null;
                    })()}
                    {inputs.occupancy !== "primary" && (() => {
                      const baseConv = (rates as any).conventional ?? FALLBACK_RATES.conventional;
                      const baseWithCredit = adjustedRate(baseConv, inputs.creditScore);
                      const occAdj = occupancyRateAdj(inputs.occupancy, inputs.downPaymentPct);
                      return (
                        <div className="text-[11px] leading-tight space-y-0.5 pt-0.5">
                          <div className="flex justify-between text-muted-foreground">
                            <span>Par rate (Conventional)</span>
                            <span>{baseConv.toFixed(3)}%</span>
                          </div>
                          {creditAdjustment(inputs.creditScore) !== 0 && (
                            <div className="flex justify-between text-muted-foreground">
                              <span>Credit score adj.</span>
                              <span>{creditAdjustment(inputs.creditScore) >= 0 ? "+" : ""}{creditAdjustment(inputs.creditScore).toFixed(3)}%</span>
                            </div>
                          )}
                          <div className="flex justify-between text-amber-600 font-medium">
                            <span>{inputs.occupancy.charAt(0).toUpperCase() + inputs.occupancy.slice(1)} property adj. ({Number(inputs.downPaymentPct).toFixed(1)}% down)</span>
                            <span>+{occAdj.toFixed(2)}%</span>
                          </div>
                          <div className="flex justify-between font-semibold border-t border-border/40 pt-0.5 text-foreground">
                            <span>Calculated rate</span>
                            <span>{(baseWithCredit + occAdj).toFixed(3)}%</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                </CardContent>
              </Card>
              </StepEditWrapper>
            )}

            {step === 3 && (
              <div className="flex flex-wrap justify-between gap-3 pt-2">
                <label className="w-full text-xs flex gap-2"><input type="checkbox" checked={inputs.qualificationInputsConfirmed===true} onChange={e=>setInputs(p=>({...p,qualificationInputsConfirmed:e.target.checked}))}/>I confirm the income, debts, credit score and down payment shown are my current inputs, not unreviewed defaults.</label>
                <Button variant="outline" onClick={() => setStep(2)} className="gap-2">
                  <ChevronLeft className="h-4 w-4" /> Back
                </Button>
                <Button disabled={!inputs.propertyUseSelected} onClick={() => { setStep(4); scrollToTop(); }} className="gap-2">
                  See My Estimate <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            {/* ── STEP 4: Estimate ─── */}
            {step === 4 && (
              <div className="space-y-4">
                <p className="text-xs">Based on debt-to-income only. Not a prequalification or approval. Confirm your income, debts, credit score and down payment before relying on the qualification indicator.</p>
                <MortgageCompliance/>

                {/* Property photo carousel — at the very top of the
                    detail/numbers page per spec. Photos come from the
                    active scenario (loaded from Supabase / property
                    cache, or freshly scraped via triggerZillowLookup).
                    Loading state is gated to the Zillow lookup status
                    so we never show "No photos" while a lookup is in
                    flight. Display is restricted to the Purchase flow
                    only — Refinance and Insurance never render this. */}
                {(() => {
                  const sc = scenarios.find(s => s.id === activeScenarioId);
                  const status: "idle" | "loading" | "loaded" | "error" =
                    sc?.zillowStatus === "loading" ? "loading"
                    : sc?.zillowStatus === "error" || sc?.zillowStatus === "unavailable" ? "error"
                    : sc?.zillowStatus ? "loaded" : "idle";
                  return (
                    <PhotoCarousel
                      photos={sc?.propertyPhotos ?? []}
                      primary={sc?.primaryPhotoUrl}
                      status={status}
                    />
                  );
                })()}

                {/* Collapsed answers accordion */}
                <div className="border border-border rounded-xl overflow-hidden bg-white shadow-sm">
                  <button
                    onClick={() => setAnswersOpen((o) => !o)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/60 transition-colors text-left"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <ClipboardList className="h-4 w-4 text-primary" />
                      Review Your Answers (Pages 1–3)
                    </span>
                    {answersOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </button>
                  {answersOpen && (() => {
                    // All rows read from `inputs` / `calc` / `address`
                    // — the same source of truth every estimate
                    // calculation uses — so the summary can never drift
                    // out of sync. Each pencil opens the matching page
                    // via `setEditingPage(N)` (inline edit dialog,
                    // never a jump back to step 1), and edits flow
                    // straight back into `inputs` so the See My
                    // Estimate numbers and this summary both update
                    // immediately on close.
                    const occupancyLabel =
                      inputs.occupancy === "primary" ? "Primary Residence"
                      : inputs.occupancy === "secondary" ? "Secondary Home"
                      : "Investment Property";
                    const loanTypeLabel: Record<typeof inputs.loanType, string> = {
                      conventional: "Conventional",
                      jumbo: "Jumbo",
                      fha: "FHA",
                      va: "VA",
                      usda: "USDA",
                      dscr: "DSCR",
                      bank_statement: "Bank Statement",
                    };
                    const dpMode = inputs.downPaymentMode ?? "percent";
                    const dpAmt =
                      inputs.downPaymentAmount ??
                      Math.round(inputs.purchasePrice * (inputs.downPaymentPct / 100));
                    const scMode = inputs.sellerConcessionsMode ?? "percent";
                    const scPct = inputs.purchasePrice > 0
                      ? (inputs.sellerConcessions / inputs.purchasePrice) * 100
                      : 0;
                    const yesNo = (v: boolean | null | undefined): string =>
                      v === true ? "Yes" : v === false ? "No" : "—";
                    return (
                      <div className="border-t border-border px-4 py-4 grid grid-cols-1 sm:grid-cols-2 gap-6">
                        <div className="space-y-6">
                          {/* ── Page 1 — Borrower Details ── */}
                          <div>
                          <p className="text-[10px] font-bold text-primary uppercase tracking-widest mb-2">Page 1 — Borrower</p>
                          <SummaryRow label="Property Use" value={occupancyLabel} onEdit={() => setEditingPage(1)} />
                          <SummaryRow label="Monthly Income" value={fmt(inputs.monthlyIncome)} onEdit={() => setEditingPage(1)} />
                          <SummaryRow label="Base Monthly Debts" value={fmt(inputs.monthlyDebts)} onEdit={() => setEditingPage(1)} />
                          {calc.deferredStudentLoanMonthly > 0 && (
                            <SummaryRow
                              label="Deferred Student Loan Adj."
                              value={`+${fmt(calc.deferredStudentLoanMonthly)}/mo`}
                              onEdit={() => setEditingPage(2)}
                              sub={`Assumes ${(calc.deferredStudentLoanFactor * 100).toFixed(1)}% of ${fmt(inputs.deferredStudentLoanBalance ?? 0)} balance (${loanTypeLabel[inputs.loanType]})`}
                            />
                          )}
                          <SummaryRow
                            label="Total Monthly Debts (DTI)"
                            value={fmt(calc.totalMonthlyDebts)}
                            onEdit={() => setEditingPage(1)}
                          />
                          <SummaryRow label="Credit Score" value={String(inputs.creditScore)} onEdit={() => setEditingPage(1)} />
                          <SummaryRow label="Available Reserves" value={fmt(inputs.reserves)} onEdit={() => setEditingPage(1)} />
                          </div>

                          {/* ── Page 2 — Additional Questions ── */}
                          <div>
                          <p className="text-[10px] font-bold text-primary uppercase tracking-widest mb-2">Page 2 — Additional</p>
                          <SummaryRow label="Has Current Mortgage?" value={yesNo(inputs.hasMortgage)} onEdit={() => setEditingPage(2)} />
                          {inputs.hasMortgage === true && (
                            <SummaryRow label="Current Loan FHA?" value={yesNo(inputs.currentLoanFHA)} onEdit={() => setEditingPage(2)} />
                          )}
                          {inputs.hasMortgage === true && (
                            <SummaryRow label="Rental Income?" value={yesNo(inputs.hasRentalIncome)} onEdit={() => setEditingPage(2)} />
                          )}
                          {inputs.hasRentalIncome === true && (
                            <SummaryRow label="Monthly Rental Income" value={`${fmt(inputs.monthlyRentalIncome)}/mo`} onEdit={() => setEditingPage(2)} />
                          )}
                          {inputs.occupancy === "primary" && (
                            <SummaryRow label="Veteran / VA Eligible?" value={yesNo(inputs.isVeteran)} onEdit={() => setEditingPage(2)} />
                          )}
                          {inputs.isVeteran === true && (
                            <SummaryRow label="Receives VA Disability?" value={yesNo(inputs.vaDisability)} onEdit={() => setEditingPage(2)} />
                          )}
                          {inputs.isVeteran === true && inputs.vaDisability === true && (
                            <SummaryRow label="VA Disability Rating 100%?" value={yesNo(inputs.vaDisabilityRating100)} onEdit={() => setEditingPage(2)} />
                          )}
                          {inputs.isVeteran === true && inputs.vaDisability === false && (
                            <SummaryRow label="VA Loan Use" value={inputs.vaLoanUse === "first" ? "First (2.15%)" : inputs.vaLoanUse === "second" ? "Second (3.30%)" : "—"} onEdit={() => setEditingPage(2)} />
                          )}
                          <SummaryRow label="Deferred Student Loans?" value={yesNo(inputs.hasDeferredStudentLoans)} onEdit={() => setEditingPage(2)} />
                          {inputs.hasDeferredStudentLoans === true && (
                            <SummaryRow
                              label="Deferred SL Balance"
                              value={fmt(inputs.deferredStudentLoanBalance ?? 0)}
                              onEdit={() => setEditingPage(2)}
                              sub={
                                calc.deferredStudentLoanMonthly > 0
                                  ? `Adds ${fmt(calc.deferredStudentLoanMonthly)}/mo to DTI`
                                  : undefined
                              }
                            />
                          )}
                          </div>
                        </div>

                        {/* ── Page 3 — Purchase Details ── */}
                        <div>
                          <p className="text-[10px] font-bold text-primary uppercase tracking-widest mb-2">Page 3 — Purchase</p>
                          <SummaryRow
                            label="Address"
                            value={address && address !== "Unknown Address" ? address : "—"}
                             onEdit={() => setEditingPage(3)}
                          />
                          <SummaryRow label="Purchase Price" value={fmt(inputs.purchasePrice)} onEdit={() => setEditingPage(3)} />
                          <SummaryRow label="Property Type" value={inputs.propertyType ?? "Single Family Residence"} onEdit={() => setEditingPage(3)} />
                          <SummaryRow label="Loan Type" value={loanTypeLabel[inputs.loanType]} onEdit={() => setEditingPage(3)} />
                          {inputs.loanType === "fha" && (
                            <SummaryRow
                              label="Down Payment Assistance"
                              value={
                                calc.dpaActive
                                  ? `${calc.dpaPct}% (${fmt(calc.dpaAmount)}) · ${calc.dpaSecondType === "amortizing" ? "10-yr amortizing 2nd" : "silent 2nd"}`
                                  : inputs.dpaEnabled === false
                                  ? "No"
                                  : "—"
                              }
                              onEdit={() => setEditingPage(3)}
                            />
                          )}
                          <SummaryRow
                            label={dpMode === "amount" ? "Down Payment ($)" : "Down Payment (%)"}
                            value={
                              dpMode === "amount"
                                ? `${fmt(dpAmt)} (${Number(inputs.downPaymentPct).toFixed(2)}%)`
                                : `${Number(inputs.downPaymentPct).toFixed(2)}% (${fmt(dpAmt)})`
                            }
                            onEdit={() => setEditingPage(3)}
                          />
                          <SummaryRow label="Loan Amount" value={fmt(calc.loanAmount)} onEdit={() => setEditingPage(3)} sub="Calculated" />
                          <SummaryRow
                            label={scMode === "amount" ? "Seller Concessions ($ of Purchase Price)" : "Seller Concessions (% of Purchase Price)"}
                            value={
                              inputs.sellerConcessions > 0
                                ? (scMode === "amount"
                                    ? `${fmt(inputs.sellerConcessions)} (${scPct.toFixed(2)}%)`
                                    : `${scPct.toFixed(2)}% (${fmt(inputs.sellerConcessions)})`)
                                : "None"
                            }
                            onEdit={() => setEditingPage(3)}
                          />
                          <SummaryRow label="Estimated Closing Costs" value={calc.taxComplete ? fmt(calc.closingCosts) : "Incomplete — enter taxes"} onEdit={() => setEditingPage(3)} />
                          <SummaryRow label="Annual Property Taxes" value={calc.taxComplete ? `${fmt(inputs.annualTaxes)}/yr (${taxSource()})` : "Unavailable — enter manually"} onEdit={() => setEditingPage(3)} />
                          <SummaryRow label="Homeowners Insurance" value={`${fmt(inputs.annualHOIns)}/yr`} onEdit={() => setEditingPage(3)} />
                          {calc.monthlyFlood > 0 && (
                            <SummaryRow label="Flood Insurance" value={`${fmt(calc.monthlyFlood * 12)}/yr`} onEdit={() => setEditingPage(3)} />
                          )}
                          {suppressSeparateFloodInsurance(inputs.propertyType) && (
                            <p className="mb-1 text-[11px] leading-relaxed text-muted-foreground" data-testid="note-flood-insurance-property-type">
                              {inputs.propertyType === "Land"
                                ? "No separate building flood premium is included for land. Confirm any required coverage with your lender and insurance professional."
                                : FLOOD_HOA_ASSUMPTION_NOTE}
                            </p>
                          )}
                          <SummaryRow label="HOA / Condo Fees" value={inputs.hoaMonthly > 0 ? `${fmt(inputs.hoaMonthly)}/mo` : "None"} onEdit={() => setEditingPage(3)} />
                          {inputs.cddAnnual > 0 && (
                            <SummaryRow label="CDD" value={`${fmt(inputs.cddAnnual)}/yr`} onEdit={() => setEditingPage(3)} />
                          )}
                          <SummaryRow
                            label={
                              <>
                                Interest Rate{" "}
                                {aprPct !== null && <em>{formatAprParenthetical(aprPct)}</em>}
                              </>
                            }
                            value={`${calc.finalRate.toFixed(3)}%`}
                            sub={calc.dpaActive ? `Includes +${calc.dpaRateBump.toFixed(2)}% DPA adjustment` : undefined}
                            onEdit={() => setEditingPage(3)}
                             testId="purchase-summary-rate-disclosure"
                          />
                          <SummaryRow label="Loan Term" value="30 yr fixed" onEdit={() => setEditingPage(3)} />
                        </div>
                      </div>
                    );
                  })()}
                </div>

              {/* Summary Banner */}
              <div className="overflow-hidden rounded-xl border-2 border-primary/20">
                {/* Qualification header bar */}
                <div className={`w-full py-2 px-4 text-center text-sm font-semibold tracking-wide ${!calc.taxComplete ? "bg-muted text-muted-foreground" : calc.qualifies ? "bg-green-600 text-white" : "bg-red-600 text-white"}`}>
                  {calc.qualifies
                    ? "Likely Qualifies"
                    : calc.taxComplete ? !calc.taxVerified ? "Planning estimate — property taxes not yet verified" : inputs.qualificationInputsConfirmed ? "Needs Review — DTI exceeds guidelines" : "Confirm your inputs — qualification not assessed" : "Incomplete — enter annual property taxes"}
                </div>
                <p className="px-5 text-xs">Based on debt-to-income only. Not a prequalification or approval.</p>
                {/* Metrics row */}
                <div className="bg-primary/5 px-5 py-4">
                  <div className="grid grid-cols-1 min-[400px]:grid-cols-2 sm:grid-cols-3 gap-4 [&>div]:min-w-0 [&_p]:break-words">
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">New Monthly Mortgage Payment</p>
                      <p className="text-2xl font-bold text-primary">{calc.taxComplete ? fmt(calc.totalHousing) : "Incomplete"}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Assumed Debts</p>
                      <p className="text-2xl font-bold text-primary">{fmt(calc.totalMonthlyDebts)}</p>
                      {calc.deferredStudentLoanMonthly > 0 && (
                        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                          Includes {fmt(calc.deferredStudentLoanMonthly)}/mo deferred student loan
                        </p>
                      )}
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Monthly Income Needed</p>
                      <p className="text-2xl font-bold text-primary">{calc.taxComplete ? fmt(calc.requiredIncome) : "Unavailable"}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Housing DTI</p>
                      <p className={`text-2xl font-bold ${!calc.taxComplete ? "text-muted-foreground" : calc.housingGreen !== Infinity && calc.housingDTI >= calc.housingGreen ? "text-red-600" : "text-green-600"}`}>
                        {calc.taxComplete ? fmtPct(calc.housingDTI) : "Unavailable"}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Total DTI</p>
                      <p className={`text-2xl font-bold ${!calc.taxComplete ? "text-muted-foreground" : calc.totalGreen !== Infinity && calc.dti >= calc.totalGreen ? "text-red-600" : "text-green-600"}`}>
                        {calc.taxComplete ? fmtPct(calc.dti) : "Unavailable"}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Cash to Close</p>
                      <p className="text-2xl font-bold text-primary">{calc.taxComplete ? fmt(calc.cashToClose) : "Incomplete"}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Schedule-showing CTA — only when the buyer Likely Qualifies
                  (same condition as the green status banner above). Sits
                  between the qualification banner and the Mortgage card. */}
              {calc.qualifies && (
                <ScheduleShowingButton
                  service="purchase_with_loan"
                  address={address}
                  qualificationStatus="likely_qualifies"
                  estimatedPrice={inputs.purchasePrice}
                  className="text-center"
                />
              )}

              {/* Combined purchase and mortgage summary */}
              <Card>
                <CardHeader className="pb-2">
                  {/* Title + loan-type selector. Mirrors the Page 3
                      Loan Type Select (around line 3055) — same
                      `inputs.loanType` source of truth, same
                      `setLoanType` setter, same eligibility gating —
                      so switching here re-runs every downstream calc
                      (rate / P&I / MIP / VA funding fee / cash-to-
                      close / DTI / qualification) and stays in sync
                      with Page 3. On mobile the controls stack
                      vertically. */}
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2 text-primary">
                      <Building2 className="h-4 w-4" />
                      Purchase &amp; Mortgage Summary
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground whitespace-nowrap">Loan Type</Label>
                      <Select
                        value={inputs.loanType}
                        onValueChange={(v) => setLoanType(v as any)}
                      >
                        <SelectTrigger className="h-8 w-[160px] text-xs" data-testid="select-page4-loan-type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {/* Conventional needs 620+ FICO. Keep the row
                              visible (so the trigger never goes empty)
                              but disable it sub-620. */}
                          <SelectItem
                            value="conventional"
                            disabled={inputs.creditScore < CONVENTIONAL_MIN_FICO}
                          >
                            Conventional{inputs.creditScore < CONVENTIONAL_MIN_FICO ? " (620+ FICO)" : ""}
                          </SelectItem>
                          {/* Jumbo — above-conforming loans; prices like
                              Conventional, same FICO gate. */}
                          <SelectItem
                            value="jumbo"
                            disabled={inputs.creditScore < CONVENTIONAL_MIN_FICO}
                          >
                            Jumbo{inputs.creditScore < CONVENTIONAL_MIN_FICO ? " (620+ FICO)" : ""}
                          </SelectItem>
                          {/* FHA: primary only. */}
                          {inputs.occupancy === "primary" && (
                            <SelectItem value="fha">FHA</SelectItem>
                          )}
                          {/* VA: primary + veteran only. Kept visible
                              when already selected (even if veteran
                              flag flips) so the trigger never blanks. */}
                          {inputs.occupancy === "primary" && (inputs.isVeteran === true || inputs.loanType === "va") && (
                            <SelectItem value="va">VA</SelectItem>
                          )}
                          {/* USDA: primary only. Page 3 exposes it
                              too; keep parity so a USDA selection
                              made on Page 3 stays selectable here. */}
                          {inputs.occupancy === "primary" && (
                            <SelectItem value="usda">USDA</SelectItem>
                          )}
                          {/* DSCR / Bank Statement: investment only. */}
                          {inputs.occupancy === "investment" && (
                            <SelectItem value="dscr">DSCR</SelectItem>
                          )}
                          {/* Bank Statement was previously offered for
                              investment but the spec restricts
                              investment to Conventional + DSCR only.
                              If a saved scenario still carries
                              `bank_statement` on investment, the
                              normalization effect below snaps it to
                              DSCR so the trigger never goes blank. */}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Building2 className="h-4 w-4 text-primary" />
                      Purchase &amp; Loan
                    </h3>
                  <div className="flex items-center justify-between gap-3 px-2 py-2">
                    <span className="text-xs text-muted-foreground">Purchase Price</span>
                    <SliderInput
                      label=""
                      value={inputs.purchasePrice}
                      onChange={handlePurchasePriceChange}
                      min={50000}
                      max={3000000}
                      step={5000}
                      prefix="$"
                      compact
                    />
                  </div>
                  <Separator />
                  {renderDownPayment()}
                  <Separator />
                  <Row label="Loan Amount" value={fmt(calc.loanAmount)} />
                  <Separator />
                  <Row label="Principal & Interest" value={fmt(calc.pi)} />
                  {/* Interest Rate disclosure under P&I. Single source
                      of truth: the rate already used by `calc.pi`.
                      - No discount points → show the priced base rate
                        from Page 3 (`inputs.interestRate`).
                      - Discount points > 0 → show the bought-down
                        rate that actually drove `calc.pi`, plus
                        base + buydown reduction as supporting lines
                        per spec. All values are derived inside the
                        `calc` memo from `inputs.interestRate` +
                        `inputs.discountPointsPct`, so loan-type /
                        credit / down-payment / AMI / occupancy /
                        discount-point changes update this row
                        instantly — no stale state. */}
                  <Row
                    label={
                      <>
                        Interest Rate{" "}
                        {aprPct !== null && <em>{formatAprParenthetical(aprPct)}</em>}
                      </>
                    }
                    value={`${calc.finalRate.toFixed(3)}%`}
                     testId="payment-card-rate-disclosure"
                    sub={
                      [
                        calc.discountPointsPct > 0
                          ? `Includes ${calc.discountPointsPct.toFixed(1)} discount point buydown`
                          : null,
                        calc.dpaActive
                          ? `Includes +${calc.dpaRateBump.toFixed(2)}% DPA adjustment`
                          : null,
                      ].filter(Boolean).join(" · ") || undefined
                    }
                  />
                  <div className="py-2">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between flex-wrap gap-1">
                        <span className="text-xs text-muted-foreground">Discount Points (% of Loan Amount)</span>
                        <Select
                          value={String(calc.discountPointsPct)}
                          onValueChange={(v) => {
                            const next = snapDiscountPoints(parseFloat(v));
                            setInputs((p) => ({ ...p, discountPointsPct: next }));
                          }}
                        >
                          <SelectTrigger
                            className="h-7 w-[110px] text-xs"
                            data-testid="select-discount-points"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DISCOUNT_POINTS_STEPS.map((step) => (
                              <SelectItem key={step} value={String(step)}>
                                {step.toFixed(1)}%
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {calc.discountPointsPct > 0 && (
                        <p className="text-[10px] text-right text-muted-foreground">
                          {calc.discountPointsPct.toFixed(1)}% of loan ·{" "}
                          <span className="font-medium text-foreground">{fmt(calc.discountPointsCost)}</span>
                        </p>
                      )}
                    </div>
                  </div>
                  {/* Per spec the explicit "Base Rate Before Points"
                      and "Discount Point Buydown" rows are hidden
                      from the user-facing UI. The buydown
                      calculation still runs in `calc` and drives
                      both `calc.pi` and the Interest Rate row
                      above. */}
                  {renderPropertyTaxRow()}
                  <Row
                    label="Homeowners Insurance"
                    value={`${fmt(calc.monthlyHOIns)}/mo`}
                    sub={`${fmt(inputs.annualHOIns)}/yr`}
                    onClick={() => insuranceSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  />
                  {!suppressSeparateFloodInsurance(inputs.propertyType) && (
                    <Row label="Flood Insurance" value={`${fmt(calc.monthlyFlood)}/mo`} />
                  )}
                  {suppressSeparateFloodInsurance(inputs.propertyType) && (
                    <p className="text-[11px] leading-relaxed text-muted-foreground -mt-1 mb-1 px-1" data-testid="note-flood-insurance-assumption">
                      {inputs.propertyType === "Land"
                        ? "No separate building flood premium is included for land. Confirm any required coverage with your lender and insurance professional."
                        : FLOOD_HOA_ASSUMPTION_NOTE}
                    </p>
                  )}
                  {inputs.hoaMonthly > 0 && <Row label="HOA" value={fmt(inputs.hoaMonthly)} />}
                  {inputs.cddAnnual > 0 && <Row label="CDD" value={`${fmt(calc.monthlyCDD)}/mo`} />}
                  {calc.mortgageInsurance > 0 && (
                    <Row
                      label={inputs.loanType === "fha" ? "FHA MIP" : "PMI"}
                      value={fmt(calc.mortgageInsurance)}
                    />
                  )}
                  <Separator />
                  <Row
                    label="Estimated Closing Costs (Itemized IFW)"
                    value={calc.taxComplete ? fmt(calc.closingCosts) : "Incomplete — enter taxes"}
                    sub={
                      inputs.loanType === "dscr"
                        ? `Includes DSCR Origination Charge 1.00% (${fmt(calc.dscrOriginationAmount)})`
                        : calc.dpaExtraPointsCost > 0
                        ? `Includes 2 program points (${fmt(calc.dpaExtraPointsCost)}) — DPA 5% silent 2nd; included in first-mortgage APR`
                        : undefined
                    }
                  />
                  <div className="py-2">
                    {renderSellerConcessions(true)}
                  </div>
                  {calc.dpaActive && (
                    <>
                      <Row
                        label="DPA Covers Down Payment"
                        value={`− ${fmt(calc.dpaDownPaymentCredit)}`}
                        sub={`${calc.dpaPct}% assistance program`}
                      />
                      {calc.dpaClosingCostCredit > 0 && (
                        <Row
                          label="DPA Closing-Cost Credit (1.5%)"
                          value={`− ${fmt(calc.dpaClosingCostCredit)}`}
                        />
                      )}
                    </>
                  )}
                  {calc.dpaActive && calc.dpaSecondType === "amortizing" && (
                    <Row
                      label="DPA 2nd Mortgage"
                      value={fmt(calc.dpaSecondMonthly)}
                      sub={`${fmt(calc.dpaAmount)} @ ${calc.dpaSecondRate.toFixed(3)}% / 10 yr`}
                    />
                  )}
                  {calc.dpaActive && calc.dpaSecondType === "silent" && (
                    <p className="text-[11px] text-muted-foreground px-1 py-1" data-testid="note-dpa-silent-second">
                      Silent 2nd of {fmt(calc.dpaAmount)}: no monthly payment and no program-points charge allocated to this lien. The 2 program points are included once in the first-mortgage APR. You must keep the home 10 years — if you refinance, the full amount is owed back.
                    </p>
                  )}
                  <Separator />
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm font-semibold">Total Monthly Payment</span>
                    <span className="text-base font-bold text-primary">{calc.taxComplete ? fmtCents(calc.totalHousing) : "Incomplete"}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm font-semibold">Estimated Cash to Close</span>
                    <span className="text-base font-bold text-primary">{calc.taxComplete ? fmtCents(calc.cashToClose) : "Incomplete"}</span>
                  </div>
                  {feeWorksheet && (
                    <>
                      <Separator />
                      <div className="flex justify-end px-2 py-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5 px-3 text-xs font-medium"
                          onClick={() => setFeeWorksheetOpen(true)}
                          disabled={!calc.taxVerified}
                          title={!calc.taxVerified ? "Verify county taxes or enter your annual bill before creating a worksheet." : undefined}
                          data-testid="button-fee-worksheet"
                        >
                          <FileDown className="h-3.5 w-3.5" />
                          Initial Fees Worksheet
                        </Button>
                      </div>
                    </>
                  )}
                  </div>
                </CardContent>
              </Card>

              {/* Qualification Section */}
              <Card className={`border-2 ${!calc.taxComplete ? "border-border" : withinLoanRatioLimits ? "border-green-200" : "border-red-200"}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <UserCheck className="h-4 w-4 text-primary" />
                    Can I Afford This Home?
                    {!calc.taxComplete ? (
                      <Badge className="ml-auto border border-border bg-muted text-muted-foreground">Incomplete</Badge>
                    ) : withinLoanRatioLimits ? (
                      <Badge className="ml-auto bg-green-100 text-green-700 border border-green-300">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Within Loan Limits
                      </Badge>
                    ) : (
                      <Badge className="ml-auto bg-red-100 text-red-700 border border-red-300">
                        <XCircle className="h-3 w-3 mr-1" /> Above Loan Limits
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    These two ratios show how the new home payment and your other debts compare with the income entered.
                  </p>

                  {!calc.taxComplete ? (
                    <div className="rounded-xl border border-border bg-muted/20 p-4 text-muted-foreground">
                      <p className="text-sm font-semibold">Qualification incomplete</p>
                      <p className="mt-1 text-xs leading-relaxed">Annual property taxes are unavailable. Enter the annual bill to calculate the payment, DTI, required income, reserves, and qualification status.</p>
                      <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => setEditingPage(3)}>Enter annual property taxes</Button>
                    </div>
                  ) : (<>
                  <div className={`rounded-xl border p-4 ${housingRatioWithinMax ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className={`text-sm font-semibold ${housingRatioWithinMax ? "text-green-900" : "text-red-900"}`}>
                          Housing-to-Income (HTI)
                        </p>
                        <p className={`mt-0.5 text-xs ${housingRatioWithinMax ? "text-green-700" : "text-red-700"}`}>
                          New home payment ÷ monthly income
                        </p>
                      </div>
                      <p className={`text-2xl font-bold ${housingRatioWithinMax ? "text-green-800" : "text-red-800"}`}>
                        {fmtPct(calc.housingDTI)}
                      </p>
                    </div>
                    <p className={`mt-3 text-xs font-medium ${housingRatioWithinMax ? "text-green-800" : "text-red-800"}`}>
                      {fmt(calc.totalHousing)} ÷ {fmt(calc.qualifyingIncome)} = {fmtPct(calc.housingDTI)}
                    </p>
                    <p className={`mt-1 text-xs leading-relaxed ${housingRatioWithinMax ? "text-green-700" : "text-red-700"}`}>
                      {calc.maxHousingDti === Infinity
                        ? `${qualificationLoanLabel} does not use a fixed HTI maximum in this estimate.`
                        : housingRatioWithinMax
                          ? `${qualificationLoanLabel} maximum: ${fmtPct(calc.maxHousingDti)}. You are ${fmtPct(calc.maxHousingDti - calc.housingDTI)} below the maximum.`
                          : `${qualificationLoanLabel} maximum: ${fmtPct(calc.maxHousingDti)}. You are ${fmtPct(calc.housingDTI - calc.maxHousingDti)} above the maximum.`}
                    </p>
                  </div>

                  <div className={`rounded-xl border p-4 ${totalRatioWithinMax ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className={`text-sm font-semibold ${totalRatioWithinMax ? "text-green-900" : "text-red-900"}`}>
                          Debt-to-Income (DTI)
                        </p>
                        <p className={`mt-0.5 text-xs ${totalRatioWithinMax ? "text-green-700" : "text-red-700"}`}>
                          Home payment + other debts ÷ monthly income
                        </p>
                      </div>
                      <p className={`text-2xl font-bold ${totalRatioWithinMax ? "text-green-800" : "text-red-800"}`}>
                        {fmtPct(calc.dti)}
                      </p>
                    </div>
                    <p className={`mt-3 text-xs font-medium ${totalRatioWithinMax ? "text-green-800" : "text-red-800"}`}>
                      ({fmt(calc.totalHousing)} + {fmt(calc.totalMonthlyDebts)}) ÷ {fmt(calc.qualifyingIncome)} = {fmtPct(calc.dti)}
                    </p>
                    <p className={`mt-1 text-xs leading-relaxed ${totalRatioWithinMax ? "text-green-700" : "text-red-700"}`}>
                      {calc.maxTotalDti === Infinity
                        ? `${qualificationLoanLabel} does not use a fixed DTI maximum in this estimate.`
                        : totalRatioWithinMax
                          ? `${qualificationLoanLabel} maximum: ${fmtPct(calc.maxTotalDti)}. You are ${fmtPct(calc.maxTotalDti - calc.dti)} below the maximum.`
                          : `${qualificationLoanLabel} maximum: ${fmtPct(calc.maxTotalDti)}. You are ${fmtPct(calc.dti - calc.maxTotalDti)} above the maximum.`}
                    </p>
                  </div>

                  {!withinLoanRatioLimits && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <p className="text-sm font-semibold text-amber-900">What may help</p>
                      <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-amber-800">
                        <li>• Consider a lower-priced home or reduce monthly debts.</li>
                        <li>• A larger down payment may lower the monthly payment.</li>
                        <li>• A loan advisor can check programs that may fit your situation better.</li>
                      </ul>
                    </div>
                  )}

                  <div className="rounded-xl border bg-muted/20 p-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Savings check
                    </p>
                    <Row label="Cash needed upfront" value={fmt(calc.cashToClose)} />
                    <Row
                      label="Savings left after closing"
                      value={fmt(calc.availableReserves)}
                      sub={
                        calc.availableReserves < calc.requiredReserves
                          ? `A lender may want about ${fmt(calc.requiredReserves)} left in savings.`
                          : "This meets the estimated savings cushion."
                      }
                      status={
                        calc.availableReserves >= calc.requiredReserves
                          ? "green"
                          : "red"
                      }
                    />
                  </div>

                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    This is an estimate, not a loan approval. A lender will review your full application, credit, income, and debts.
                  </p>
                  </>)}
                </CardContent>
              </Card>

              {/* ── Full Insurance Panel ── */}
              <div
                ref={insuranceSectionRef}
                className="grid scroll-mt-6 grid-cols-1 items-start gap-6"
              >
                <Card className="border-2 border-primary/20 shadow-md">
                  <CardHeader className="pb-3 bg-primary/5 rounded-t-lg">
                    <CardTitle className="text-base flex items-center gap-2 text-primary">
                      <Shield className="h-4 w-4" />
                      Homeowners Insurance Estimate
                      <Badge className="ml-auto bg-primary/10 text-primary border-primary/30 font-mono text-sm">
                        {fmt(insPremiumCalc.mid)}/yr midpoint
                      </Badge>
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      Midpoint premium feeds into your monthly payment above. Adjust factors below to refine the estimate.
                    </p>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <InsuranceEstimateForm
                      policyType={insurancePolicyType}
                      onPolicyTypeChange={(value) => {
                        insurancePolicyTouchedRef.current = true;
                        setInsurancePolicyType(value);
                      }}
                      policyTypeNote="QuoteRUSH policy defaults are applied automatically when this selection changes."
                      newPurchase={insuranceNewPurchase}
                      onNewPurchaseChange={(value) => { setInsuranceNewPurchase(value); setInsurancePurchaseDate(""); }}
                      purchaseDate={insurancePurchaseDate}
                      onPurchaseDateChange={setInsurancePurchaseDate}
                      purchasePrice={insurancePurchasePrice}
                      onPurchasePriceChange={setInsurancePurchasePrice}
                      residenceUse={insuranceResidenceUse}
                      onResidenceUseChange={(value) => { setInsuranceResidenceUse(value); if (value !== "investment") setInsuranceRentalTerm(""); }}
                      rentalTerm={insuranceRentalTerm}
                      onRentalTermChange={setInsuranceRentalTerm}
                      rebuild={insuranceRebuild}
                      onRebuildChange={(value) => {
                        markInsuranceSimTouched();
                        insuranceRebuildTouchedRef.current = true;
                        setInsuranceRebuild(value);
                      }}
                      roofYear={insuranceRoofYear}
                      onRoofYearChange={(value) => { markInsuranceSimTouched(); setInsuranceRoofYear(value); const age = new Date().getFullYear() - value; setInsRoofIdx(age < 5 ? 0 : age <= 14 ? 1 : age <= 20 ? 2 : 3); }}
                      openingProtection={insWindIdx === 2 ? 1 : 0}
                      onOpeningProtectionChange={(value) => { markInsuranceSimTouched(); setInsWindIdx(value === 1 ? 2 : 0); }}
                      roofShape={insuranceRoofShape}
                      onRoofShapeChange={(value) => { markInsuranceSimTouched(); setInsuranceRoofShape(value); setInsWindIdx(value === 0 && insuranceSWR === 2 ? 2 : 1); }}
                      swr={insuranceSWR}
                      onSwrChange={(value) => { markInsuranceSimTouched(); setInsuranceSWR(value); setInsWindIdx(insuranceRoofShape === 0 && value === 2 ? 2 : 1); }}
                      hurricaneDeductible={insHurrIdx}
                      onHurricaneDeductibleChange={(value) => { markInsuranceSimTouched(); setInsHurrIdx(value); }}
                      construction={insConstIdx}
                      onConstructionChange={(value) => { markInsuranceSimTouched(); setInsConstIdx(value); }}
                      yearBuilt={insuranceYearBuilt}
                      onYearBuiltChange={(value) => {
                        markInsuranceSimTouched();
                        setInsuranceYearBuilt(value);
                        setInsYearIdx(legacyInsuranceYearIndex(value));
                        setInputs(prev => ({
                          ...prev,
                          userAnswerSources: {
                            ...(prev.userAnswerSources ?? {}),
                            insurance_year_built: String(value),
                            insurance_year_built_source: "manual",
                          },
                        }));
                      }}
                      aopDeductible={insuranceAopDeductible}
                      onAopDeductibleChange={setInsuranceAopDeductible}
                      floodZone={floodData?.zone}
                      floodZoneSource={floodData?.zone ? "FEMA" : undefined}
                      annualPremium={insPremiumCalc.mid}
                    />
                  </CardContent>
                </Card>
                <Card className="border shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Shield className="h-4 w-4 text-primary" />
                      Live Carrier Quotes
                    </CardTitle>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Compare this planning estimate with real-time rates from Florida-appointed carriers.
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="rounded-xl border border-primary/15 bg-primary/5 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Current planning estimate
                      </p>
                      <p className="mt-2 font-mono text-3xl font-bold text-primary">
                        {fmt(insPremiumCalc.mid)}
                        <span className="ml-1 text-sm font-medium text-muted-foreground">/yr</span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {fmt(insPremiumCalc.monthly)}/month midpoint before a carrier reviews the property.
                      </p>
                    </div>

                    <div className="space-y-2 text-xs text-muted-foreground">
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
                        <span>Uses this property address and your saved insurance details.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
                        <span>Returns live carrier pricing when available.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
                        <span>Lets the insurance team review coverage and available discounts.</span>
                      </div>
                    </div>

                    <Button
                      type="button"
                      className="w-full"
                      onClick={handleGetLiveInsuranceQuote}
                      disabled={
                        openingLiveQuote ||
                        !address ||
                        address === "Unknown Address"
                      }
                      data-testid="button-get-live-insurance-quote"
                    >
                      {openingLiveQuote ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Opening Live Quotes…
                        </>
                      ) : (
                        authUser ? "Get a Live Quote" : "Sign In to Get Live Quotes"
                      )}
                    </Button>
                    <p className="text-center text-[10px] leading-relaxed text-muted-foreground">
                      A licensed team member will be alerted to call you within 60 seconds.
                    </p>
                  </CardContent>
                </Card>
              </div>

              <p className="text-xs text-muted-foreground text-center px-4 pb-4">
                All estimates are for informational purposes only and are not a commitment to lend. Actual rates, payments, and qualification requirements may vary. Contact a licensed mortgage professional for a full analysis.
              </p>
            </div>
            )}
          </div>
        </div>
      </div>

      {/* Share dialog */}
      {/* Loan-limit popup — shown when the loan amount crossed a 2026
          program limit and the loan type was auto-switched. */}
      <Dialog open={loanLimitNotice !== null} onOpenChange={(v) => { if (!v) setLoanLimitNotice(null); }}>
        <DialogContent className="max-w-md" data-testid="dialog-loan-limit">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-primary">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Above the {loanLimitNotice?.fromLabel} Loan Limit
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 pt-1 text-sm text-muted-foreground">
                <p>
                  Your loan amount is above the {loanLimitNotice?.limitLabel} of{" "}
                  <span className="font-semibold text-foreground">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(loanLimitNotice?.limit ?? 0)}
                  </span>
                  , so a {loanLimitNotice?.fromLabel} loan isn't available at this amount.
                </p>
                {loanLimitNotice?.switched ? (
                  <p>
                    We've automatically switched your estimate to a{" "}
                    <span className="font-semibold text-foreground">{loanLimitNotice?.toLabel}</span> loan
                    and re-priced your rate and payment. You can lower the purchase price or increase
                    your down payment to bring the loan back under the limit.
                  </p>
                ) : (
                  <p>
                    A <span className="font-semibold text-foreground">{loanLimitNotice?.toLabel}</span> loan
                    would normally apply here, but it requires a 620+ credit score. Lower the purchase
                    price or increase your down payment to bring the loan back under the limit.
                  </p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <Button onClick={() => setLoanLimitNotice(null)} data-testid="button-loan-limit-ok">
            Got It
          </Button>
        </DialogContent>
      </Dialog>

      {/* Initial Fees Worksheet popup — opened from the Mortgage card. */}
      <FeeWorksheetDialog
        open={feeWorksheetOpen}
        onOpenChange={setFeeWorksheetOpen}
        worksheet={feeWorksheet}
        lenderInfo={purchaseLenderInfo}
        escrowsEnabled={feeWorksheetEscrowsEnabled}
        onEscrowsEnabledChange={setFeeWorksheetEscrowsEnabled}
        escrowsRequired={inputs.loanType === "fha"}
        meta={feeWorksheetMeta}
        onSave={saveCurrentIfwScenario}
        createPdfFile={createIfwPdfFile}
        onActivity={notifyIfwActivity}
      />

      <LeadCaptureDialog
        open={leadDialogOpen}
        onOpenChange={(open) => { setLeadDialogOpen(open); if (!open) setLeadDialogForScenario(false); }}
        action={leadDialogForScenario ? "new-scenario" : leadDialogAction}
        address={address}
        scenarioDetails={leadScenarioDetails}
        onSuccess={handleLeadSuccess}
      />

      {/* New scenario address prompt */}
      <PropertyLookupDialog
        open={showZillowLookup}
        onOpenChange={setShowZillowLookup}
        initialAddressOrUrl={address && address !== "Unknown Address" ? address : ""}
        applyLabel="Use these values"
        onApply={handleZillowApply}
      />

      <Dialog open={showAddressPrompt} onOpenChange={setShowAddressPrompt}>
        <DialogContent
          className="sm:max-w-sm"
          aria-describedby="add-property-desc"
        >
          <DialogHeader>
            <DialogTitle>Add New Property</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <p id="add-property-desc" className="text-sm text-muted-foreground">
              Start typing an address and pick a suggestion — your new property tab is added automatically.
            </p>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                ref={newScenarioInputRef}
                type="text"
                value={newScenarioAddress}
                onChange={(e) => setNewScenarioAddress(e.target.value)}
                placeholder="123 Main St, City, State…"
                autoComplete="off"
                autoFocus
                className="w-full pl-9 pr-3 py-2 text-sm border rounded-md outline-none focus:ring-2 ring-primary/30 focus:border-primary"
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
