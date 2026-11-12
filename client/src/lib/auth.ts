import { supabase, supabaseReady } from "./supabase";
import type { OfficialTaxBreakdown } from "@shared/official-tax";
import { currentBillEvidenceToRow, currentBillFetchedAt, savedCurrentBillBreakdown } from "./property-tax-refi";
import { authedFetch } from "./authed-fetch";
import {
  ensureInsuranceForAddresses,
  type BulkAddress,
} from "./insurance-from-property";
import { normalizePropertyKey } from "./property-key";
import { trackEvent } from "./posthog";
import {
  effectiveAnnualFloodInsurance,
  sanitizeSavedPurchaseFloodSnapshot,
  suppressSeparateFloodInsurance,
} from "../../../shared/flood-insurance-policy";
import {
  syncPropertyValueAcrossTabs,
  isPropertyValueSyncInFlight,
  type PropertyValueSourceTab,
} from "./property-value-sync";

/** Stamp source = "manual" on rows whose value field changed between
 *  two save calls — but only when the change did NOT come from the
 *  cross-tab sync helper. Returns a new array (does not mutate `next`).
 *  Used by savePurchaseScenarios / saveTrackedLoans / saveInsuranceScenarios
 *  so that pure-UI edits stamp provenance without each page needing to
 *  thread the source down through its edit handlers.
 *
 *  Skips stamping when sync is in flight — the sync helper sets its
 *  own provenance ("property_value_sync" / "default_0_75_percent"). */
export function _stampManualOnValueDiff<T extends { id: string }>(
  prev: T[],
  next: T[],
  getValue: (row: T) => number | undefined,
  applyManual: (row: T) => T,
): T[] {
  if (isPropertyValueSyncInFlight()) return next;
  return next.map(row => {
    const old = prev.find(p => p.id === row.id);
    if (!old) return row; // brand-new row — let the create path set source
    const v = getValue(row);
    if (!Number.isFinite(v as number) || (v as number) <= 0) return row;
    if (getValue(old) === v) return row;
    return applyManual(row);
  });
}

/** Diff-watcher for the cross-tab property-value sync (Phase 1). Detects
 *  when an existing row's value field changed between two save calls
 *  and fires `syncPropertyValueAcrossTabs`. Skipped when:
 *   - no authenticated user (anon drafts must not write to other users)
 *   - a sync is already in flight (loop guard — the helper calls back
 *     into our save funcs as it writes to the other tables)
 *   - the row didn't exist in `prev` (it's a brand-new add, not an edit
 *     — `autoCreateInsuranceFromAddresses` handles the create case) */
function _diffAndSyncPropertyValue<T extends { id: string }>(
  prev: T[],
  next: T[],
  sourceTab: PropertyValueSourceTab,
  getValue: (row: T) => number | undefined,
  getAddress: (row: T) => string | undefined,
  getKey?: (row: T) => string | undefined,
): void {
  if (isPropertyValueSyncInFlight()) return;
  const userId = _session?.id;
  if (!userId) return;
  for (const row of next) {
    const oldRow = prev.find(p => p.id === row.id);
    if (!oldRow) continue; // brand-new — handled by auto-create paths
    const newVal = getValue(row);
    const oldVal = getValue(oldRow);
    if (!Number.isFinite(newVal as number) || (newVal as number) <= 0) continue;
    if (oldVal === newVal) continue;
    const key = getKey?.(row) || normalizePropertyKey(getAddress(row)).key;
    if (!key) continue;
    syncPropertyValueAcrossTabs({
      userId,
      normalizedPropertyKey: key,
      sourceTab,
      newValue: newVal as number,
    });
  }
}

// PostHog: scenario_saved (purchase) — fire once per scenario id per
// session. Without this dedupe, the debounced autosave would fire the
// analytics event on every keystroke-batched persist.
const _phPurchaseSavedFired = new Set<string>();

const NOT_CONFIGURED = {
  ok: false as const,
  error: "Sign-in is temporarily unavailable. Please try again in a moment.",
};

// ── Agents (matches FUB_AGENT_IDS on the server) ───────────────────
export const AGENTS = [
  { id: "christian", name: "Christian Tateo", initials: "CT" },
  { id: "omar",      name: "Omar Andujar",    initials: "OA" },
  { id: "kyle",      name: "Kyle Schweinitz", initials: "KS" },
  { id: "alex",      name: "Sandor “Alex” Szabo", initials: "AS" },
  { id: "team",      name: "Team",            initials: "TM", isTeam: true },
] as const;

export type AgentId = typeof AGENTS[number]["id"];

export interface InvitedUser {
  name: string;
  email: string;
  invitedAt: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
  /** Presence flag only. The DOB value remains in the protected profile and
   *  is read server-side when a live quote is explicitly requested. */
  hasDateOfBirth?: boolean;
  agent?: string;
  invitedUser?: InvitedUser;
  createdAt: string;
  /** Borrower-level DTI figures (monthly, dollars) — persisted on the
   *  profile so the refi DTI check prefills across sessions. */
  monthlyIncome?: number;
  monthlyDebts?: number;
}

export interface PurchaseScenario {
  id: string;
  address: string;
  savedAt: string;
  price?: number;
  monthlyPayment?: number;
  downPayment?: number;
  interestRate?: number;
  cashToClose?: number;
  dti?: number;
  qualifies?: boolean;
  downPaymentPct?: number;
  loanType?: string;
  /** UI mode for the down-payment control. Persisted so the user's
   *  choice (Percentage vs. Dollar Amount) survives reload/login
   *  and stays in sync between Purchase Page 3 (`/mortgage`) and
   *  Page 4 (`/estimate`). Defaults to "percent" when missing. */
  downPaymentMode?: "percent" | "amount";
  /** Canonical down-payment dollar amount. Always equals
   *  `price * downPaymentPct / 100` for "percent" mode; in
   *  "amount" mode this is the source of truth and pct is derived. */
  downPaymentAmount?: number;
  /** First photo URL (denormalized for fast list cards). Set when
   *  Zillow/Apify returns at least one photo or restored from the
   *  shared property_cache; used by `/estimate` to render the hero
   *  image immediately on revisit. */
  primaryPhotoUrl?: string;
  /** Full photo list (deduped URLs). Persisted to the
   *  `purchase_scenarios.property_photos` jsonb column so the
   *  Purchase detail page can show a carousel without re-scraping. */
  propertyPhotos?: string[];
  /** User-facing property type (e.g. "Single Family Residence",
   *  "Townhouse", "Condominium"). Defaults to "Single Family Residence"
   *  when neither the user nor Zillow has supplied one. */
  propertyType?: string;
  /** Where `propertyType` came from. "manual" means the user picked it
   *  on Page 3 and Zillow refreshes must not overwrite it. */
  propertyTypeSource?: "manual" | "zillow" | "default";
  /** Page-2 Additional Info: does the borrower have deferred student
   *  loans? When true, `deferredStudentLoanBalance` is used to compute
   *  an assumed monthly DTI payment via a loan-type-specific factor
   *  (1.0% conventional, 0.5% FHA/VA/USDA). Saved here so the answer
   *  persists across refresh / logout / login. */
  hasDeferredStudentLoans?: boolean;
  /** Total deferred student loan balance in dollars. Only meaningful
   *  when `hasDeferredStudentLoans === true`. */
  deferredStudentLoanBalance?: number;
  /** Page 4 Discount Points buydown (Real Estate card). Percent of
   *  the base loan amount the buyer is paying up-front to reduce
   *  the interest rate. Valid values: 0 / 0.5 / 1 / 1.5 / 2 / 2.5 /
   *  3. Default 0 (no buydown). The runtime recomputes cost + rate
   *  reduction from this single field every render — the persisted
   *  derived fields below are written for dashboard / read-only
   *  consumers, never read back to drive calculations (so flipping
   *  loan type or loan amount can never double-count). */
  discountPointsPct?: number;
  /** Dollar cost of the selected discount points = base loan amount
   *  × discountPointsPct / 100. Persisted for read-only display. */
  discountPointsCost?: number;
  /** Rate reduction (percentage points) applied for the selected
   *  buydown, looked up from the loan-type buydown table. */
  discountPointsRateReduction?: number;
  /** Interest rate before the discount-point buydown is applied
   *  (i.e. the priced rate from `fullRate(...)`). Stored separately
   *  from `interestRate` so consumers can show "Base / Buydown /
   *  Final" without recomputing. */
  rateBeforeDiscountPoints?: number;
  /** Final interest rate after the discount-point buydown,
   *  rounded to 3 decimals. */
  rateAfterDiscountPoints?: number;
  /** Provenance for `price`. "manual" means the user typed/changed it
   *  in the Purchase-with-Loan flow and Phase 1 cross-tab value sync
   *  must not overwrite it. Stored on `purchase_scenarios.price_source`.
   *  Stamped by the diff-watcher in `savePurchaseScenarios` when a save
   *  is not coming from sync. */
  priceSource?: "manual" | "zillow" | "default";
  /** Occupancy / property-use for the purchase. Used by the Phase 2
   *  insurance policy-type rule to default Investment → DP3 and
   *  Primary/Secondary → HO3 (HO6 overrides via propertyType). Stored
   *  on `purchase_scenarios.occupancy_type`. */
  occupancyType?: "primary" | "secondary" | "investment";
  /** Borrower's gross monthly income. Persisted to
   *  `purchase_scenarios.monthly_income`. Manual user entry must survive
   *  refresh / login / address changes — the AMI-prefill effect checks
   *  `monthlyIncomeSource` and skips when it's "manual". */
  monthlyIncome?: number;
  /** Provenance for `monthlyIncome`.
   *  "manual" — the user typed/changed it in the borrower-details panel;
   *    the AMI lookup must not overwrite it.
   *  "ami_default" — seeded from the area-median-income API on first load
   *    of a brand-new scenario.
   *  "default" — the in-memory factory default ($8,000) was never touched.
   *  Stored on `purchase_scenarios.monthly_income_source`. */
  monthlyIncomeSource?: "manual" | "ami_default" | "default";
  // ── Comprehensive borrower-answer persistence (2026_05_28 migration) ──
  // Every user-edited field on Pages 1-4 round-trips here so the value
  // reloads exactly as entered after refresh / login / address change.
  // All fields are optional; rowToPurchase / purchaseToRow treat
  // undefined as "no recorded answer" and the caller falls back to its
  // in-memory default.
  monthlyDebts?: number;
  creditScore?: number;
  reserves?: number;
  isVeteran?: boolean | null;
  vaDisability?: boolean | null;
  vaDisabilityRating100?: boolean | null;
  vaLoanUse?: "first" | "second" | null;
  hasMortgage?: boolean | null;
  currentLoanFHA?: boolean | null;
  hasRentalIncome?: boolean | null;
  monthlyRentalIncome?: number;
  rentalType?: "annual" | "short-term" | null;
  sellerConcessions?: number;
  sellerConcessionsMode?: "percent" | "amount";
  annualTaxes?: number;
  annualHOIns?: number;
  annualFloodIns?: number;
  hoaMonthly?: number;
  cddAnnual?: number;
  impactWindows?: boolean;
  roofAttachment?: string;
  swr?: boolean;
  /** Generic per-field provenance map. Only fields that have other
   *  in-app writers need an entry; everything else is implicitly
   *  "manual" once persisted. The line 2186 annualHOIns default sync
   *  in estimate.tsx checks `userAnswerSources?.annual_ho_ins` to
   *  decide whether to overwrite a user/loaded value with the
   *  0.75%-of-price default. */
  userAnswerSources?: Record<string, string>;
}

/** Provenance for `InsuranceScenario.annualPremium`.
 *  "manual" / "quote" — locked, cross-tab sync must not overwrite.
 *  "default_0_75_percent" — auto-derived from property value × 0.75%;
 *    safe to recompute when a synced value arrives.
 *  "property_value_sync" — stamped by sync helper when it writes. */
export type InsurancePremiumSource =
  | "manual" | "quote" | "default_0_75_percent" | "property_value_sync";

/** Provenance for `InsuranceScenario.coverageA` (Rebuild / Replacement
 *  Cost). "manual" — locked. "property_value_sync" — synced from another
 *  tab. "default" — initial seed from defaultRebuildFor(). */
export type InsuranceCoverageASource =
  | "manual" | "property_value_sync" | "default";

/** Provenance for snapshot/dropdown fields that previously had no
 *  source tracking. "manual" — user edited the field in the Insurance
 *  detail view; protected from defaults / Purchase / Cash / Refi /
 *  property-value sync. "default" — never user-touched. Persisted on
 *  the matching *_source column added in the 2026 insurance migration.
 *  Sync helpers (insurance-from-property.ts, property-value-sync.ts)
 *  must skip any field whose source === "manual". */
export type InsuranceFieldSource = "default" | "manual";

export interface InsuranceScenario {
  id: string;
  address: string;
  savedAt: string;
  annualPremium?: number;
  /** Provenance for `annualPremium`. See InsurancePremiumSource. When
   *  null/undefined (legacy rows), the sync helper falls back to the
   *  0.75%-of-candidate-value heuristic. */
  premiumSource?: InsurancePremiumSource;
  /** Rebuild / Replacement Cost (Coverage A). Phase 1 cross-tab sync
   *  propagates this from Purchase/Cash/Refi/Seller value edits unless
   *  `coverageASource === "manual"`. */
  coverageA?: number;
  /** Provenance for `coverageA`. See InsuranceCoverageASource. */
  coverageASource?: InsuranceCoverageASource;
  coverageType?: string;
  /** Auto-defaulted from occupancy + property type via
   *  `getDefaultInsurancePolicyType()`. Stored on
   *  `insurance_scenarios.policy_type`. */
  policyType?: "HO3" | "HO6" | "DP3";
  /** Provenance for `policyType`. "manual" means the user explicitly
   *  picked it and the default-rule must not overwrite it on later
   *  property-type / occupancy changes. Persisted on
   *  `insurance_scenarios.policy_type_source`. */
  policyTypeSource?: "default_rule" | "manual";
  /** Occupancy snapshot carried over from the source flow (purchase /
   *  cash buy / refinance) so the policy-type rule can re-evaluate when
   *  property type changes later. Not persisted as its own column —
   *  derived from the linked source scenario at correlation time. */
  occupancyType?: CashBuyOccupancyType;
  /** Physical property type ("Single Family Residence", "Condo",
   *  "Townhouse", ...) snapshot from the source flow. Same lifecycle
   *  as `occupancyType` above. */
  propertyType?: string;
  /** Normalized property key derived from address via the shared
   *  `normalizePropertyKey` helper. Mirrors the DB column added by the
   *  insurance migration and powers the (user_id, normalized_property_key)
   *  unique index that prevents duplicate Insurance rows for the same
   *  property. Backfilled at row→frontend mapping time so legacy rows
   *  participate in dedup the first time they're re-saved. */
  normalizedPropertyKey?: string;
  /** Provenance for `occupancyType` snapshot. "manual" means the user
   *  changed occupancy from inside the Insurance detail view and the
   *  Purchase/Cash/Refi sync must not overwrite it. */
  occupancyTypeSource?: InsuranceFieldSource;
  /** Provenance for `propertyType` snapshot. Same semantics as
   *  `occupancyTypeSource` — used by `ensureInsuranceForAddress` to
   *  skip the snapshot refresh when the user has overridden it. */
  propertyTypeSource?: InsuranceFieldSource;
  /** Provenance for the optional `carrier` field. Future-proofed —
   *  no UI today, but the column exists and is round-tripped. */
  carrierSource?: InsuranceFieldSource;
  /** Provenance for the AOP / hurricane / flood deductible
   *  selections. Future-proofed — round-tripped through the mappers
   *  so a later UI surface can stamp `"manual"` to lock the value. */
  aopDeductibleSource?: InsuranceFieldSource;
  hurricaneDeductibleSource?: InsuranceFieldSource;
  floodDeductibleSource?: InsuranceFieldSource;
  /** Provenance for the discounts / mitigation selections (the factor
   *  dropdowns in the Insurance detail view — roof age, wind
   *  mitigation, hurricane deductible %, construction, year built,
   *  claims history). When the user changes any of those, autosave
   *  stamps this `"manual"` and the corresponding factor values are
   *  persisted inside `userAnswerSources`. */
  discountsSource?: InsuranceFieldSource;
  /** Provenance for `quoteDetails` (carrier quote assumptions, if
   *  uploaded). Future-proofed. */
  quoteDetailsSource?: InsuranceFieldSource;
  /** Open-ended provenance + scratch map for fields without their own
   *  column. Used by the Insurance autosave to persist the six factor
   *  dropdown values (factor_roofIdx, factor_windIdx, factor_hurrIdx,
   *  factor_constIdx, factor_yearIdx, factor_claimsIdx). Values are
   *  numbers or strings — JSON-encoded into the
   *  `insurance_scenarios.user_answer_sources` jsonb column. */
  userAnswerSources?: Record<string, any>;
}

export type SellerScenarioStatus =
  | "draft"
  | "reviewing"
  | "ready_to_list"
  | "listed"
  | "sold";

/** Provenance for refinance-derived seller fields. "manual" means the
 *  user edited the value in the Sell-Your-Home detail view and must
 *  never be overwritten by a subsequent refinance upload. NULL/undefined
 *  is treated as "auto / overridable" by the seller-from-refinance helper.
 *  See supabase/migrations/2026_05_24_seller_scenario_sources.sql. */
export type SellerEstimatedSalePriceSource = "refinance" | "zillow" | "manual" | "property_value_sync";
// "refinance_statement" — legacy tag written by the Refinance→Seller
//   sync (treated the same as "refinance" for display/locking).
// "refinance"           — pulled live from a matching Refinance loan.
// "statement"           — extracted from a statement uploaded on the
//   Sell-Your-Home page; locked like "manual".
// "amortized_estimate"  — estimated from last sale price/date.
export type SellerMortgagePayoffSource =
  | "refinance_statement" | "refinance" | "manual" | "statement" | "amortized_estimate";
export type SellerRealtorCommissionSource = "default_5_percent" | "manual";
// Provenance for the three free-text user inputs that previously had
// no source tracking. "default" — never user-touched (0 / unset).
// "manual" — user has typed/dragged a value. Used by the seller
// autosave to keep manual entries from being wiped by future
// refinance / Zillow / property-cache merges. Persisted on the
// matching *_source column on seller_scenarios.
export type SellerBuyerConcessionsSource = "default" | "manual";
export type SellerRepairBudgetSource = "default" | "manual";
export type SellerOtherSellingCostsSource = "default" | "manual";
export type SellerClosingCostsSource =
  | "default_percent"     // current default (1.85% of sale price)
  | "percent_manual"      // user moved the percent slider
  | "manual"              // legacy: user typed a dollar amount pre-migration
  | "default_1_percent";  // legacy: pre-1.85% default (still treated as overridable)
// Estimated capital-gains tax fields (see lib/seller-taxes.ts).
export type SellerFilingStatus = "single" | "married";
// Where the prior purchase price (cost basis) came from. "manual" must never
// be overwritten by a later Zillow / property-cache resolve.
export type SellerPriorPurchasePriceSource =
  | "zillow" | "property_cache" | "manual" | "unknown";

export interface SellerScenario {
  id: string;
  address: string;
  normalizedPropertyKey?: string;
  savedAt: string;
  updatedAt: string;
  estimatedSalePrice?: number;
  mortgagePayoff?: number;
  sellerClosingCosts?: number;
  /** Seller closing costs stored as a percent of sale price (e.g. 1.85 = 1.85%).
   *  The dollar amount in `sellerClosingCosts` is always derived from
   *  `estimatedSalePrice * sellerClosingCostsPercent / 100`. */
  sellerClosingCostsPercent?: number;
  /** Realtor commission stored as a percent (e.g. 6 = 6%). */
  realtorCommissionPct?: number;
  buyerConcessions?: number;
  repairBudget?: number;
  otherSellingCosts?: number;
  /** Latest computed net proceeds snapshot. UI always recomputes from inputs. */
  netProceeds?: number;
  status: SellerScenarioStatus;
  primaryPhotoUrl?: string;
  propertyPhotos?: string[];
  // Provenance for refinance-derived fields. See the type aliases above.
  estimatedSalePriceSource?: SellerEstimatedSalePriceSource;
  mortgagePayoffSource?: SellerMortgagePayoffSource;
  /** Snapshot of the amortization inputs/outputs when mortgagePayoff was
   *  estimated (source === "amortized_estimate"). Persisted to
   *  seller_scenarios.mortgage_payoff_estimate_inputs (jsonb). */
  mortgagePayoffEstimateInputs?: Record<string, unknown>;
  /** Lightweight metadata from an uploaded mortgage statement (lender,
   *  extracted balance, file name, uploaded date). Persisted to
   *  seller_scenarios.mortgage_statement_metadata (jsonb). */
  mortgageStatementMetadata?: Record<string, unknown>;
  realtorCommissionSource?: SellerRealtorCommissionSource;
  sellerClosingCostsSource?: SellerClosingCostsSource;
  /** Provenance for the three free-text seller inputs. See type aliases above. */
  buyerConcessionsSource?: SellerBuyerConcessionsSource;
  repairBudgetSource?: SellerRepairBudgetSource;
  otherSellingCostsSource?: SellerOtherSellingCostsSource;
  /** Open-ended provenance map (mirrors cash-buy's user_answer_sources).
   *  Keys are camelCase field names; values are arbitrary string tags.
   *  Persisted on seller_scenarios.user_answer_sources (jsonb). */
  userAnswerSources?: Record<string, string>;

  // ── Estimated capital-gains tax inputs (see lib/seller-taxes.ts) ──
  /** Was this a primary residence 2 of the last 5 years? null = unanswered. */
  primaryResidence2of5?: boolean | null;
  /** Filing status for the §121 exclusion. null = unanswered. */
  filingStatus?: SellerFilingStatus | null;
  /** Non-primary sellers: run numbers assuming a qualifying 1031 exchange. */
  assume1031Exchange?: boolean;
  /** Dollars of capital improvements added to cost basis. */
  capitalImprovements?: number;
  /** Prior purchase price (cost basis) — from Zillow/cache or manual entry. */
  priorPurchasePrice?: number | null;
  /** Where priorPurchasePrice came from. "manual" is never overwritten by Zillow. */
  priorPurchasePriceSource?: SellerPriorPurchasePriceSource;
  /** Latest computed estimated taxes due snapshot. UI always recomputes. */
  estimatedTaxesDue?: number;
}

export type CashBuyOccupancyType = "primary" | "secondary" | "investment";
export type SellerConcessionsMode = "percent" | "amount";
export type CashBuyPurchasePriceSource =
  | "default" | "user"
  | "zillow_cache" | "zillow_listing" | "zillow_sold" | "zillow_zestimate";
export type CashBuyClosingCostsSource = "default_percent" | "manual";
export type CashBuyHoaSource = "zillow" | "manual" | "unknown";
/** Manual-lock provenance for fields whose values have other in-app
 *  writers (defaults / Zillow / property cache / cross-tab sync). Once
 *  stamped `"manual"`, those other writers must skip the field. */
export type CashBuyManualSource = "manual" | "default" | "zillow";
export type CashBuyZillowStatus =
  | "loading" | "loaded_from_cache" | "loaded_from_zillow" | "error";

/** Persisted insurance-simulator factors. Mirrors the field shape used by
 *  `PropertyInsuranceSimulator`. Stored as jsonb so the simulator can add
 *  knobs without further migrations. */
export interface CashBuyInsuranceFactors {
  regionKey: string;
  roofIdx: number;
  windIdx: number;
  hurrIdx: number;
  constIdx: number;
  yearIdx: number;
  /** Exact Zillow/user year when available; older rows use yearIdx. */
  yearBuilt?: number;
  claimsIdx: number;
}

export interface CashBuyScenario {
  id: string;
  address: string;
  normalizedPropertyKey?: string;
  savedAt: string;
  updatedAt: string;
  purchasePrice?: number;
  /** Provenance of `purchasePrice` — used to gate Zillow overwrites. */
  purchasePriceSource?: CashBuyPurchasePriceSource;
  occupancyType?: CashBuyOccupancyType;
  /** Physical property type ("Single Family Residence", "Condo",
   *  "Townhouse", ...) used by the Phase 2 insurance policy-type rule
   *  to override Condo/Townhouse → HO6. Stored on
   *  `cash_buy_scenarios.property_type`. */
  propertyType?: string;
  /** Manual-lock for `propertyType` — blocks the Zillow seed effect. */
  propertyTypeSource?: CashBuyManualSource;
  /** Manual-lock for `occupancyType` — recorded but currently no other
   *  writer; persisted so future defaults can respect it. */
  occupancyTypeSource?: CashBuyManualSource;
  propertyTaxes?: number;        // annual
  /** Manual-lock for `propertyTaxes` — blocks the price/occupancy-driven
   *  `computeAnnualTaxes` recompute in `setPurchasePrice`/`setOccupancy`. */
  propertyTaxesSource?: CashBuyManualSource;
  homeownersInsurance?: number;  // annual (synced from simulator midpoint)
  /** Manual-lock for `homeownersInsurance` — blocks both the 0.75%-of-price
   *  default and the insurance-simulator overwrite. */
  homeownersInsuranceSource?: CashBuyManualSource;
  /** Annual flood insurance estimate. System-estimated from the FEMA
   *  flood-zone lookup (same source + default as Purchase with Loan):
   *  $2,000/yr when the property is in a required-insurance flood zone,
   *  $0 otherwise. Stored on `cash_buy_scenarios.annual_flood_ins`. */
  annualFloodIns?: number;
  hoaMonthly?: number;           // monthly HOA / condo fees
  /** Source of the HOA value. `"manual"` blocks Zillow overwrites. */
  hoaSource?: CashBuyHoaSource;
  closingCosts?: number;         // buyer-side closing costs (title, recording, doc stamps, inspection, etc.)
  /** Default % applied when `closingCostsSource === "default_percent"`. */
  closingCostsPercent?: number;
  /** Tracks whether the user has manually overridden closing costs. */
  closingCostsSource?: CashBuyClosingCostsSource;
  sellerConcessionsMode?: SellerConcessionsMode;
  sellerConcessionsPercent?: number; // 0–9
  sellerConcessionsAmount?: number;  // absolute $
  /** Manual-lock for seller-concessions fields. */
  sellerConcessionsSource?: CashBuyManualSource;
  /** Latest computed cash-to-close snapshot. UI always recomputes from inputs. */
  cashToClose?: number;
  primaryPhotoUrl?: string;
  propertyPhotos?: string[];
  /** Last-known Zillow lookup status — surfaced as a small badge.
   *  Held in-memory only (no `zillow_status` column in cash_buy_scenarios). */
  zillowStatus?: CashBuyZillowStatus;
  /** Insurance simulator state (in-memory only — not in the canonical
   *  table). Lost on refresh; sim re-derives defaults from the address. */
  insuranceFactors?: CashBuyInsuranceFactors;
  insurancePremiumAnnual?: number;
  /** Persisted lifecycle marker (e.g. "active", "archived"). Defaults to
   *  "active" on first write. */
  status?: string;
  /** Pointer back to the property_cache row that seeded this scenario,
   *  if available. Persisted but not currently consumed by the UI. */
  zillowCacheKey?: string;
  propertyCacheId?: string;
  /** Generic per-field manual-lock map. Mirrors `purchase_scenarios.user_answer_sources`.
   *  Used alongside the typed *_source columns above so future writers can
   *  record provenance without a schema change. */
  userAnswerSources?: Record<string, "manual" | "default" | "zillow" | "simulator">;
}

export type TrackedLoanPropertyType = "primary" | "secondary" | "investment";

export interface TrackedLoan {
  id: string;
  propertyAddress: string;
  lender: string;
  loanBalance: number;
  currentRate: number;
  currentPI: number;
  monthlyPayment: number;
  /** Current existing-servicer escrow balance extracted from a mortgage
   *  statement. Stored on tracked_loans.current_escrow_balance. */
  currentEscrowBalance?: number;
  estimatedHomeValue: number;
  estimatedRemainingYears: number;
  propertyType: TrackedLoanPropertyType;
  /** Phase 2: dedicated occupancy field (Primary / Secondary /
   *  Investment). The legacy `propertyType` field above historically
   *  holds the same value — `occupancyType` is preferred when present
   *  and `propertyType` is treated as a fallback for old rows.
   *  Stored on `tracked_loans.occupancy_type`. */
  occupancyType?: "primary" | "secondary" | "investment";
  /** Phase 2: physical structure type ("Single Family Residence",
   *  "Condo", "Townhouse", ...) — separate from the historical
   *  `propertyType` (which holds occupancy). Drives Condo/Townhouse →
   *  HO6 in the insurance policy-type rule. Stored on
   *  `tracked_loans.physical_property_type`. */
  physicalPropertyType?: string;
  /** Refinance loan program. Persisted on tracked_loans.loan_type.
   *  VA/FHA are only valid when propertyType === "primary"; the UI
   *  enforces this and auto-falls-back to "conventional" if the user
   *  switches occupancy. */
  loanType?: TrackedLoanType;
  /** VA disability funding-fee exemption. Stored on tracked_loans.va_disability. */
  vaDisability?: boolean;
  addedAt: string;
  balanceAsOf?: string;
  /** Servicer loan/account number extracted from the uploaded mortgage
   *  statement. Stored as text to preserve leading zeros and dashes.
   *  Optional — older saved loans may not have one. */
  loanNumber?: string;
  /** FICO score used by the shared mortgage pricing engine. Stored on
   *  the tracked_loans row so refresh/logout/login preserve it. */
  creditScore?: number;
  /** Provenance for `estimatedHomeValue`. "manual" — user-edited, locked
   *  against Phase 1 cross-tab value sync. "synced" — written by the
   *  sync helper. "statement" / "zillow" — reserved for upload / lookup
   *  flows. Stored on `tracked_loans.estimated_home_value_source`. */
  estimatedHomeValueSource?: "manual" | "statement" | "zillow" | "synced";
  /** Refinance UI: which goal tab the user last had open. Persisted so
   *  reload/login restores their chosen scenario. Stored on
   *  `tracked_loans.refi_goal`. */
  refiGoal?: "rate_term" | "cash_out" | "home_equity";
  /** Refinance UI: "finance closing costs into the new loan" toggle.
   *  Defaults to true. Stored on `tracked_loans.finance_fees`. */
  financeFees?: boolean;
  /** Refinance UI: "include escrow reserve" toggle. Defaults to false.
   *  Stored on `tracked_loans.include_escrows`. */
  includeEscrows?: boolean;
  /** Refinance Cash-Out tab: the user-chosen new loan amount on the
   *  slider (cash-out is derived from this minus the balance). Stored on
   *  `tracked_loans.cash_out_new_loan_amount`. */
  cashOutNewLoanAmount?: number;
  /** Refinance Home-Equity tab: chosen 2nd-lien product. Stored on
   *  `tracked_loans.home_equity_product`. */
  homeEquityProduct?: "heloc" | "he_loan";
  /** Refinance Home-Equity tab: the user-chosen borrow amount on the
   *  slider. Stored on `tracked_loans.home_equity_borrow_amount`. */
  homeEquityBorrowAmount?: number;
  /** How this loan was entered. Older rows have none and read as
   *  "statement". Stored on `tracked_loans.entry_method`. */
  entryMethod?: "statement" | "closing_disclosure" | "manual" | "free_and_clear";
  /** Origination details (Closing Disclosure + manual flows). */
  purchaseDate?: string;            // ISO date, tracked_loans.purchase_date
  firstPaymentDate?: string;        // first scheduled due date, tracked_loans.first_payment_date
  originalPurchasePrice?: number;   // tracked_loans.original_purchase_price
  originalLoanAmount?: number;      // tracked_loans.original_loan_amount
  originalRate?: number;            // note rate %, tracked_loans.original_rate
  originalTermMonths?: number;      // tracked_loans.original_term_months
  /** Amortization verification (manual flow): what the schedule says
   *  today's balance should be, and whether the user confirmed. */
  amortizedBalanceCheck?: number;   // tracked_loans.amortized_balance_check
  balanceConfirmed?: boolean;       // tracked_loans.balance_confirmed
  /** Property owned outright — models a 1st-lien cash-out refinance.
   *  Stored on `tracked_loans.free_and_clear`. */
  freeAndClear?: boolean;
  /** Current annual property-tax bill for the existing owner (NOT a purchase
   *  estimate). Looked up from the tax-collector or entered manually.
   *  Stored on `tracked_loans.annual_property_tax`. */
  annualPropertyTax?: number;
  /** Where annualPropertyTax came from. "manual" is never overwritten by
   *  a background lookup. Stored on `tracked_loans.annual_property_tax_source`. */
  annualPropertyTaxSource?: "manual" | "tax-collector-bill-scrape" | "manatee-arcgis";
  /** Tax year the bill was issued. Stored on
   *  `tracked_loans.annual_property_tax_year`. */
  annualPropertyTaxYear?: number;
  /** ISO timestamp of last successful lookup. Stored on
   *  `tracked_loans.annual_property_tax_queried_at`. */
  annualPropertyTaxQueriedAt?: string;
  annualPropertyTaxBreakdown?: OfficialTaxBreakdown | null;
}

export type TrackedLoanType = "va" | "fha" | "conventional" | "dscr" | "bank_statement";

// ── In-memory caches (kept in sync with Supabase) ──────────────────
let _session: AuthUser | null = null;
// True until the first hydrateFromSupabase() finishes (or immediately if
// Supabase isn't configured). Consumers use this to distinguish "still
// loading the session" from "definitely signed out".
let _authHydrated = false;
let _purchaseScenarios: PurchaseScenario[] = [];
let _insuranceScenarios: InsuranceScenario[] = [];
let _sellerScenarios: SellerScenario[] = [];
let _cashBuyScenarios: CashBuyScenario[] = [];
let _trackedLoans: TrackedLoan[] = [];
const _listeners = new Set<() => void>();

// Persistence-error listeners — UI subscribes to surface a visible toast
// instead of silently logging to the console. Payload includes the table
// name (so consumers can scope which tab to warn about) and the raw
// Supabase error message.
export type PersistenceError = { table: string; message: string };
const _errorListeners = new Set<(e: PersistenceError) => void>();

function notify() { _listeners.forEach(fn => { try { fn(); } catch {} }); }
function notifyError(e: PersistenceError) {
  _errorListeners.forEach(fn => { try { fn(e); } catch {} });
}

export function subscribeAuthChange(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function subscribePersistenceError(
  fn: (e: PersistenceError) => void,
): () => void {
  _errorListeners.add(fn);
  return () => { _errorListeners.delete(fn); };
}

export function getSession(): AuthUser | null { return _session; }
export function isAuthHydrated(): boolean { return _authHydrated; }

function rowToProfile(row: any): AuthUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? undefined,
    agent: row.agent ?? undefined,
    invitedUser: row.invited_user ?? undefined,
    createdAt: row.created_at,
    monthlyIncome:
      typeof row.monthly_income === "number" || typeof row.monthly_income === "string"
        ? Number(row.monthly_income) || undefined
        : undefined,
    monthlyDebts:
      row.monthly_debts != null && Number.isFinite(Number(row.monthly_debts))
        ? Number(row.monthly_debts)
        : undefined,
  };
}

function rowToPurchase(row: any): PurchaseScenario {
  const floodSnapshot = sanitizeSavedPurchaseFloodSnapshot(
    row.property_type,
    numOrUndef(row.annual_flood_ins),
    numOrUndef(row.monthly_payment),
  );
  return {
    id: row.id,
    address: row.address,
    savedAt: row.saved_at,
    price: row.price ?? undefined,
    monthlyPayment: floodSnapshot.monthlyPayment ?? undefined,
    downPayment: row.down_payment ?? undefined,
    interestRate: row.interest_rate ?? undefined,
    cashToClose: row.cash_to_close ?? undefined,
    dti: row.dti ?? undefined,
    qualifies: row.qualifies ?? undefined,
    downPaymentPct: row.down_payment_pct ?? undefined,
    loanType: row.loan_type ?? undefined,
    downPaymentMode:
      row.down_payment_mode === "amount" || row.down_payment_mode === "percent"
        ? row.down_payment_mode
        : undefined,
    downPaymentAmount:
      row.down_payment_amount != null && Number.isFinite(Number(row.down_payment_amount))
        ? Number(row.down_payment_amount)
        : undefined,
    primaryPhotoUrl: row.primary_photo_url ?? undefined,
    propertyPhotos: Array.isArray(row.property_photos)
      ? row.property_photos.filter((p: any) => typeof p === "string")
      : undefined,
    propertyType: row.property_type ?? undefined,
    occupancyType: ((): "primary" | "secondary" | "investment" | undefined => {
      const v = row.occupancy_type;
      return v === "primary" || v === "secondary" || v === "investment" ? v : undefined;
    })(),
    propertyTypeSource:
      row.property_type_source === "manual" ||
      row.property_type_source === "zillow" ||
      row.property_type_source === "default"
        ? row.property_type_source
        : undefined,
    hasDeferredStudentLoans:
      typeof row.has_deferred_student_loans === "boolean"
        ? row.has_deferred_student_loans
        : undefined,
    deferredStudentLoanBalance:
      row.deferred_student_loan_balance != null &&
      Number.isFinite(Number(row.deferred_student_loan_balance))
        ? Number(row.deferred_student_loan_balance)
        : undefined,
    discountPointsPct:
      row.discount_points_percent != null &&
      Number.isFinite(Number(row.discount_points_percent))
        ? Number(row.discount_points_percent)
        : undefined,
    discountPointsCost:
      row.discount_points_cost != null &&
      Number.isFinite(Number(row.discount_points_cost))
        ? Number(row.discount_points_cost)
        : undefined,
    discountPointsRateReduction:
      row.discount_points_rate_reduction != null &&
      Number.isFinite(Number(row.discount_points_rate_reduction))
        ? Number(row.discount_points_rate_reduction)
        : undefined,
    rateBeforeDiscountPoints:
      row.rate_before_discount_points != null &&
      Number.isFinite(Number(row.rate_before_discount_points))
        ? Number(row.rate_before_discount_points)
        : undefined,
    rateAfterDiscountPoints:
      row.rate_after_discount_points != null &&
      Number.isFinite(Number(row.rate_after_discount_points))
        ? Number(row.rate_after_discount_points)
        : undefined,
    priceSource:
      row.price_source === "manual" ||
      row.price_source === "zillow" ||
      row.price_source === "default"
        ? row.price_source
        : undefined,
    monthlyIncome:
      row.monthly_income != null && Number.isFinite(Number(row.monthly_income))
        ? Number(row.monthly_income)
        : undefined,
    monthlyIncomeSource:
      row.monthly_income_source === "manual" ||
      row.monthly_income_source === "ami_default" ||
      row.monthly_income_source === "default"
        ? row.monthly_income_source
        : undefined,
    // ── 2026_05_28 comprehensive borrower-answer round-trip ──
    monthlyDebts: numOrUndef(row.monthly_debts),
    creditScore: numOrUndef(row.credit_score),
    reserves: numOrUndef(row.reserves),
    isVeteran: boolOrUndef(row.is_veteran),
    vaDisability: boolOrUndef(row.va_disability),
    vaDisabilityRating100: boolOrUndef(row.va_disability_rating_100),
    vaLoanUse:
      row.va_loan_use === "first" || row.va_loan_use === "second"
        ? row.va_loan_use
        : undefined,
    hasMortgage: boolOrUndef(row.has_mortgage),
    currentLoanFHA: boolOrUndef(row.current_loan_fha),
    hasRentalIncome: boolOrUndef(row.has_rental_income),
    monthlyRentalIncome: numOrUndef(row.monthly_rental_income),
    rentalType:
      row.rental_type === "annual" || row.rental_type === "short-term"
        ? row.rental_type
        : undefined,
    sellerConcessions: numOrUndef(row.seller_concessions),
    sellerConcessionsMode:
      row.seller_concessions_mode === "percent" ||
      row.seller_concessions_mode === "amount"
        ? row.seller_concessions_mode
        : undefined,
    annualTaxes: numOrUndef(row.annual_taxes),
    annualHOIns: numOrUndef(row.annual_ho_ins),
    annualFloodIns: floodSnapshot.annualFloodIns ?? undefined,
    hoaMonthly: numOrUndef(row.hoa_monthly),
    cddAnnual: numOrUndef(row.cdd_annual),
    impactWindows:
      typeof row.impact_windows === "boolean" ? row.impact_windows : undefined,
    roofAttachment:
      typeof row.roof_attachment === "string" ? row.roof_attachment : undefined,
    swr: typeof row.swr === "boolean" ? row.swr : undefined,
    userAnswerSources:
      row.user_answer_sources && typeof row.user_answer_sources === "object"
        ? (row.user_answer_sources as Record<string, string>)
        : undefined,
  };
}

// Helpers for the round-trip above. `numOrUndef` accepts Supabase's
// `numeric → string` coercion (e.g. "780") as well as numbers, and
// rejects NaN. `boolOrUndef` accepts only real booleans so legacy
// "null" rows stay nullable in the UI.
function numOrUndef(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function boolOrUndef(v: unknown): boolean | null | undefined {
  if (v === true || v === false) return v;
  if (v === null) return null;
  return undefined;
}
function purchaseToRow(s: PurchaseScenario, userId: string) {
  // Mirror cash_buy_scenarios shape: keep writing legacy `address` /
  // `saved_at` (still NOT NULL on existing schemas) AND populate the
  // newer canonical columns `full_address`, `normalized_property_key`,
  // `updated_at` that the operator added to `purchase_scenarios`. The
  // server-side `created_at` / `status` columns have defaults
  // (`now()` / `'draft'`) so we don't have to send them — the DB fills
  // them in on insert.
  const normKey = normalizePropertyKey(s.address).key || null;
  const floodSnapshot = sanitizeSavedPurchaseFloodSnapshot(
    s.propertyType,
    s.annualFloodIns,
    s.monthlyPayment,
  );
  return {
    id: s.id,
    user_id: userId,
    address: s.address,
    saved_at: s.savedAt,
    full_address: s.address,
    normalized_property_key: normKey,
    updated_at: new Date().toISOString(),
    price: s.price ?? null,
    monthly_payment: floodSnapshot.monthlyPayment ?? null,
    down_payment: s.downPayment ?? null,
    interest_rate: s.interestRate ?? null,
    cash_to_close: s.cashToClose ?? null,
    dti: s.dti ?? null,
    qualifies: s.qualifies ?? null,
    down_payment_pct: s.downPaymentPct ?? null,
    loan_type: s.loanType ?? null,
    down_payment_mode: s.downPaymentMode ?? null,
    down_payment_amount: s.downPaymentAmount ?? null,
    // Data safety: never overwrite a previously-saved good photo array
    // with an empty array — leave the column untouched when we have
    // nothing fresh to write. The merge happens on the read side; on
    // write we only send a value when we actually have one.
    ...(s.primaryPhotoUrl ? { primary_photo_url: s.primaryPhotoUrl } : {}),
    ...(s.propertyPhotos && s.propertyPhotos.length > 0
      ? { property_photos: s.propertyPhotos }
      : {}),
    ...(s.propertyType ? { property_type: s.propertyType } : {}),
    ...(s.propertyTypeSource ? { property_type_source: s.propertyTypeSource } : {}),
    ...(s.occupancyType ? { occupancy_type: s.occupancyType } : {}),
    // Borrower monthly income — gated on a real number so we never
    // clobber a saved value with `undefined` from older Inputs shapes.
    ...(typeof s.monthlyIncome === "number" && Number.isFinite(s.monthlyIncome)
      ? { monthly_income: s.monthlyIncome }
      : {}),
    ...(s.monthlyIncomeSource ? { monthly_income_source: s.monthlyIncomeSource } : {}),
    // ── 2026_05_28 comprehensive borrower-answer write ──
    // Each entry is a conditional spread so older Inputs shapes (where
    // a field is still `undefined`) never clobber a column that's
    // already been populated by a later save. `null` is meaningful for
    // the yes/no Page-2 fields (user hasn't answered yet) and IS
    // persisted distinctly from `undefined` (no recorded answer at all).
    ...(typeof s.monthlyDebts === "number" && Number.isFinite(s.monthlyDebts)
      ? { monthly_debts: s.monthlyDebts } : {}),
    ...(typeof s.creditScore === "number" && Number.isFinite(s.creditScore)
      ? { credit_score: s.creditScore } : {}),
    ...(typeof s.reserves === "number" && Number.isFinite(s.reserves)
      ? { reserves: s.reserves } : {}),
    ...(s.isVeteran !== undefined ? { is_veteran: s.isVeteran } : {}),
    ...(s.vaDisability !== undefined ? { va_disability: s.vaDisability } : {}),
    ...(s.vaDisabilityRating100 !== undefined
      ? { va_disability_rating_100: s.vaDisabilityRating100 } : {}),
    ...(s.vaLoanUse !== undefined ? { va_loan_use: s.vaLoanUse } : {}),
    ...(s.hasMortgage !== undefined ? { has_mortgage: s.hasMortgage } : {}),
    ...(s.currentLoanFHA !== undefined ? { current_loan_fha: s.currentLoanFHA } : {}),
    ...(s.hasRentalIncome !== undefined ? { has_rental_income: s.hasRentalIncome } : {}),
    ...(typeof s.monthlyRentalIncome === "number" && Number.isFinite(s.monthlyRentalIncome)
      ? { monthly_rental_income: s.monthlyRentalIncome } : {}),
    ...(s.rentalType !== undefined ? { rental_type: s.rentalType } : {}),
    ...(typeof s.sellerConcessions === "number" && Number.isFinite(s.sellerConcessions)
      ? { seller_concessions: s.sellerConcessions } : {}),
    ...(s.sellerConcessionsMode ? { seller_concessions_mode: s.sellerConcessionsMode } : {}),
    ...(typeof s.annualTaxes === "number" && Number.isFinite(s.annualTaxes)
      ? { annual_taxes: s.annualTaxes } : {}),
    ...(typeof s.annualHOIns === "number" && Number.isFinite(s.annualHOIns)
      ? { annual_ho_ins: s.annualHOIns } : {}),
    ...(typeof floodSnapshot.annualFloodIns === "number" &&
      Number.isFinite(floodSnapshot.annualFloodIns)
      || suppressSeparateFloodInsurance(s.propertyType)
      ? { annual_flood_ins: effectiveAnnualFloodInsurance(
          s.propertyType,
          floodSnapshot.annualFloodIns,
        ) }
      : {}),
    ...(typeof s.hoaMonthly === "number" && Number.isFinite(s.hoaMonthly)
      ? { hoa_monthly: s.hoaMonthly } : {}),
    ...(typeof s.cddAnnual === "number" && Number.isFinite(s.cddAnnual)
      ? { cdd_annual: s.cddAnnual } : {}),
    ...(typeof s.impactWindows === "boolean" ? { impact_windows: s.impactWindows } : {}),
    ...(typeof s.roofAttachment === "string" ? { roof_attachment: s.roofAttachment } : {}),
    ...(typeof s.swr === "boolean" ? { swr: s.swr } : {}),
    ...(s.userAnswerSources && Object.keys(s.userAnswerSources).length > 0
      ? { user_answer_sources: s.userAnswerSources } : {}),
    ...(typeof s.hasDeferredStudentLoans === "boolean"
      ? { has_deferred_student_loans: s.hasDeferredStudentLoans }
      : {}),
    ...(typeof s.deferredStudentLoanBalance === "number"
      ? { deferred_student_loan_balance: s.deferredStudentLoanBalance }
      : {}),
    // Discount Points buydown (Page 4 → Real Estate card). Always
    // written when set so the read side restores the user's slider
    // position. The rate-reduction / cost / before-after fields are
    // derived snapshots — they're persisted for dashboard display
    // only and never read back to drive the runtime calc.
    ...(typeof s.discountPointsPct === "number"
      ? { discount_points_percent: s.discountPointsPct }
      : {}),
    ...(typeof s.discountPointsCost === "number"
      ? { discount_points_cost: s.discountPointsCost }
      : {}),
    ...(typeof s.discountPointsRateReduction === "number"
      ? { discount_points_rate_reduction: s.discountPointsRateReduction }
      : {}),
    ...(typeof s.rateBeforeDiscountPoints === "number"
      ? { rate_before_discount_points: s.rateBeforeDiscountPoints }
      : {}),
    ...(s.priceSource ? { price_source: s.priceSource } : {}),
    ...(typeof s.rateAfterDiscountPoints === "number"
      ? { rate_after_discount_points: s.rateAfterDiscountPoints }
      : {}),
  };
}
function rowToInsurance(row: any): InsuranceScenario {
  const pt = row.policy_type;
  const policyType: InsuranceScenario["policyType"] =
    pt === "HO3" || pt === "HO6" || pt === "DP3" ? pt : undefined;
  const pts = row.policy_type_source;
  const policyTypeSource: InsuranceScenario["policyTypeSource"] =
    pts === "manual" || pts === "default_rule" ? pts : undefined;
  const ps = row.premium_source;
  const premiumSource: InsurancePremiumSource | undefined =
    ps === "manual" || ps === "quote" ||
    ps === "default_0_75_percent" || ps === "property_value_sync"
      ? ps : undefined;
  const cas = row.coverage_a_source;
  const coverageASource: InsuranceCoverageASource | undefined =
    cas === "manual" || cas === "property_value_sync" || cas === "default"
      ? cas : undefined;
  const asFieldSource = (v: any): InsuranceFieldSource | undefined =>
    v === "manual" || v === "default" ? v : undefined;
  // Backfill normalized_property_key from address for legacy rows
  // that pre-date the migration. The first re-save will write it
  // back through `insuranceToRow` so subsequent loads short-circuit
  // here and dedup picks it up.
  const storedKey = (row.normalized_property_key ?? "").toString().trim() || null;
  const derivedKey = storedKey ?? (normalizePropertyKey(row.address).key || null);
  if (!storedKey && derivedKey) {
    console.debug("[insurance-key] backfilled normalized property key", {
      id: row.id, address: row.address, key: derivedKey,
    });
  }
  return {
    id: row.id,
    address: row.address,
    savedAt: row.saved_at,
    annualPremium: row.annual_premium ?? undefined,
    premiumSource,
    coverageA: row.coverage_a != null && Number.isFinite(Number(row.coverage_a))
      ? Number(row.coverage_a) : undefined,
    coverageASource,
    coverageType: row.coverage_type ?? undefined,
    policyType,
    policyTypeSource,
    ...(derivedKey ? { normalizedPropertyKey: derivedKey } : {}),
    occupancyTypeSource:        asFieldSource(row.occupancy_type_source),
    propertyTypeSource:         asFieldSource(row.property_type_source),
    carrierSource:              asFieldSource(row.carrier_source),
    aopDeductibleSource:        asFieldSource(row.aop_deductible_source),
    hurricaneDeductibleSource:  asFieldSource(row.hurricane_deductible_source),
    floodDeductibleSource:      asFieldSource(row.flood_deductible_source),
    discountsSource:            asFieldSource(row.discounts_source),
    quoteDetailsSource:         asFieldSource(row.quote_details_source),
    userAnswerSources:
      row.user_answer_sources && typeof row.user_answer_sources === "object"
        ? (row.user_answer_sources as Record<string, any>)
        : undefined,
  };
}
function insuranceToRow(s: InsuranceScenario, userId: string) {
  // Always derive (and persist) the normalized key from the current
  // address — guarantees backfill for legacy rows on the very next
  // write and keeps the (user_id, normalized_property_key) unique
  // index participating for new rows.
  const normKey =
    (s.normalizedPropertyKey && s.normalizedPropertyKey.trim()) ||
    normalizePropertyKey(s.address).key ||
    null;
  return {
    id: s.id,
    user_id: userId,
    address: s.address,
    saved_at: s.savedAt,
    annual_premium: s.annualPremium ?? null,
    coverage_type: s.coverageType ?? null,
    normalized_property_key: normKey,
    // The `policy_type` + `policy_type_source` columns were added by the
    // user before this change went in (see spec). Omitted nulls preserve
    // any value already on the row.
    ...(s.policyType ? { policy_type: s.policyType } : { policy_type: null }),
    ...(s.policyTypeSource
      ? { policy_type_source: s.policyTypeSource }
      : { policy_type_source: null }),
    // 2026_05_26 migration — premium_source, coverage_a, coverage_a_source.
    // Older Supabase instances strip these via persistInsuranceScenarios'
    // optional-column retry loop if they're missing.
    ...(s.premiumSource ? { premium_source: s.premiumSource } : { premium_source: null }),
    ...(typeof s.coverageA === "number" ? { coverage_a: s.coverageA } : {}),
    ...(s.coverageASource ? { coverage_a_source: s.coverageASource } : { coverage_a_source: null }),
    // Eight new source columns from the most recent insurance
    // migration. Written as null when the user hasn't stamped them so
    // refinance/cash/purchase sync can still update those fields.
    occupancy_type_source:       s.occupancyTypeSource ?? null,
    property_type_source:        s.propertyTypeSource ?? null,
    carrier_source:              s.carrierSource ?? null,
    aop_deductible_source:       s.aopDeductibleSource ?? null,
    hurricane_deductible_source: s.hurricaneDeductibleSource ?? null,
    flood_deductible_source:     s.floodDeductibleSource ?? null,
    discounts_source:            s.discountsSource ?? null,
    quote_details_source:        s.quoteDetailsSource ?? null,
    user_answer_sources:         s.userAnswerSources ?? null,
  };
}
function rowToSeller(row: any): SellerScenario {
  const photos = Array.isArray(row.property_photos)
    ? row.property_photos.filter((p: any) => typeof p === "string")
    : undefined;
  const status: SellerScenarioStatus =
    row.status === "reviewing" || row.status === "ready_to_list" ||
    row.status === "listed" || row.status === "sold"
      ? row.status
      : "draft";
  return {
    id: row.id,
    // Schema column is `full_address`; fall back to legacy `address` so any
    // pre-rename rows still hydrate cleanly.
    address: row.full_address ?? row.address,
    normalizedPropertyKey: row.normalized_property_key ?? undefined,
    savedAt: row.created_at ?? row.saved_at,
    updatedAt: row.updated_at ?? row.created_at ?? row.saved_at,
    estimatedSalePrice: row.estimated_sale_price != null ? Number(row.estimated_sale_price) : undefined,
    mortgagePayoff: row.mortgage_payoff != null ? Number(row.mortgage_payoff) : undefined,
    sellerClosingCosts: row.seller_closing_costs != null ? Number(row.seller_closing_costs) : undefined,
    sellerClosingCostsPercent: row.seller_closing_costs_percent != null ? Number(row.seller_closing_costs_percent) : undefined,
    // Schema column is `realtor_commission` (percentage). Fall back to the
    // pre-rename `realtor_commission_pct` column if a stale row is loaded.
    realtorCommissionPct:
      row.realtor_commission != null ? Number(row.realtor_commission) :
      row.realtor_commission_pct != null ? Number(row.realtor_commission_pct) :
      undefined,
    buyerConcessions: row.buyer_concessions != null ? Number(row.buyer_concessions) : undefined,
    repairBudget: row.repair_budget != null ? Number(row.repair_budget) : undefined,
    otherSellingCosts: row.other_selling_costs != null ? Number(row.other_selling_costs) : undefined,
    netProceeds: row.net_proceeds != null ? Number(row.net_proceeds) : undefined,
    status,
    primaryPhotoUrl: row.primary_photo_url ?? undefined,
    propertyPhotos: photos,
    // Provenance — null/undefined means "auto / overridable" (legacy
    // rows pre-date the 2026_05_24 migration that added these columns).
    estimatedSalePriceSource: (row.estimated_sale_price_source ?? undefined) as SellerEstimatedSalePriceSource | undefined,
    mortgagePayoffSource:     (row.mortgage_payoff_source      ?? undefined) as SellerMortgagePayoffSource | undefined,
    mortgagePayoffEstimateInputs:
      row.mortgage_payoff_estimate_inputs && typeof row.mortgage_payoff_estimate_inputs === "object"
        ? row.mortgage_payoff_estimate_inputs as Record<string, unknown>
        : undefined,
    mortgageStatementMetadata:
      row.mortgage_statement_metadata && typeof row.mortgage_statement_metadata === "object"
        ? row.mortgage_statement_metadata as Record<string, unknown>
        : undefined,
    realtorCommissionSource:  (row.realtor_commission_source   ?? undefined) as SellerRealtorCommissionSource | undefined,
    sellerClosingCostsSource: (row.seller_closing_costs_source ?? undefined) as SellerClosingCostsSource | undefined,
    buyerConcessionsSource:   (row.buyer_concessions_source    ?? undefined) as SellerBuyerConcessionsSource | undefined,
    repairBudgetSource:       (row.repair_budget_source        ?? undefined) as SellerRepairBudgetSource | undefined,
    otherSellingCostsSource:  (row.other_selling_costs_source  ?? undefined) as SellerOtherSellingCostsSource | undefined,
    userAnswerSources:
      row.user_answer_sources && typeof row.user_answer_sources === "object"
        ? row.user_answer_sources as Record<string, string>
        : undefined,
    // ── Estimated capital-gains tax fields ──
    primaryResidence2of5:
      typeof row.primary_residence_2_of_5 === "boolean" ? row.primary_residence_2_of_5 : null,
    filingStatus:
      row.filing_status === "single" || row.filing_status === "married"
        ? row.filing_status as SellerFilingStatus : null,
    assume1031Exchange: row.assume_1031_exchange === true,
    capitalImprovements: row.capital_improvements != null ? Number(row.capital_improvements) : 0,
    priorPurchasePrice: row.prior_purchase_price != null ? Number(row.prior_purchase_price) : null,
    priorPurchasePriceSource:
      (row.prior_purchase_price_source ?? undefined) as SellerPriorPurchasePriceSource | undefined,
    estimatedTaxesDue: row.estimated_taxes_due != null ? Number(row.estimated_taxes_due) : undefined,
  };
}
function sellerToRow(s: SellerScenario, userId: string) {
  return {
    id: s.id,
    user_id: userId,
    full_address: s.address,
    normalized_property_key: s.normalizedPropertyKey ?? null,
    created_at: s.savedAt,
    updated_at: s.updatedAt,
    estimated_sale_price: s.estimatedSalePrice ?? null,
    mortgage_payoff: s.mortgagePayoff ?? null,
    seller_closing_costs: s.sellerClosingCosts ?? null,
    seller_closing_costs_percent: s.sellerClosingCostsPercent ?? null,
    realtor_commission: s.realtorCommissionPct ?? null,
    buyer_concessions: s.buyerConcessions ?? null,
    repair_budget: s.repairBudget ?? null,
    other_selling_costs: s.otherSellingCosts ?? null,
    net_proceeds: s.netProceeds ?? null,
    status: s.status ?? "draft",
    primary_photo_url: s.primaryPhotoUrl ?? null,
    property_photos: s.propertyPhotos ?? null,
    estimated_sale_price_source: s.estimatedSalePriceSource ?? null,
    mortgage_payoff_source:      s.mortgagePayoffSource ?? null,
    mortgage_payoff_estimate_inputs: s.mortgagePayoffEstimateInputs ?? null,
    mortgage_statement_metadata:     s.mortgageStatementMetadata ?? null,
    realtor_commission_source:   s.realtorCommissionSource ?? null,
    seller_closing_costs_source: s.sellerClosingCostsSource ?? null,
    buyer_concessions_source:    s.buyerConcessionsSource ?? null,
    repair_budget_source:        s.repairBudgetSource ?? null,
    other_selling_costs_source:  s.otherSellingCostsSource ?? null,
    user_answer_sources:         s.userAnswerSources ?? null,
    // ── Estimated capital-gains tax fields ──
    primary_residence_2_of_5:    s.primaryResidence2of5 ?? null,
    filing_status:               s.filingStatus ?? null,
    assume_1031_exchange:        s.assume1031Exchange ?? false,
    capital_improvements:        s.capitalImprovements ?? 0,
    prior_purchase_price:        s.priorPurchasePrice ?? null,
    prior_purchase_price_source: s.priorPurchasePriceSource ?? null,
    estimated_taxes_due:         s.estimatedTaxesDue ?? null,
  };
}
// Maps a Supabase `cash_buy_scenarios` row to the in-memory shape used
// by the UI. Column names follow the canonical schema (buyer_closing_costs,
// hoa_amount + hoa_frequency, status, zillow_cache_key, property_cache_id).
function rowToCashBuy(row: any): CashBuyScenario {
  const photos = Array.isArray(row.property_photos)
    ? row.property_photos.filter((p: any) => typeof p === "string")
    : undefined;
  const occ = row.occupancy_type;
  const occupancyType: CashBuyOccupancyType | undefined =
    occ === "primary" || occ === "secondary" || occ === "investment" ? occ : undefined;
  const mode = row.seller_concessions_mode;
  const sellerConcessionsMode: SellerConcessionsMode | undefined =
    mode === "percent" || mode === "amount" ? mode : undefined;
  const ccs = row.closing_costs_source;
  const closingCostsSource: CashBuyClosingCostsSource | undefined =
    ccs === "default_percent" || ccs === "manual" ? ccs : undefined;
  const hs = row.hoa_source;
  const hoaSource: CashBuyHoaSource | undefined =
    hs === "zillow" || hs === "manual" || hs === "unknown" ? hs : undefined;

  const toManualSource = (v: any): CashBuyManualSource | undefined =>
    v === "manual" || v === "default" || v === "zillow" ? v : undefined;
  const pps = row.purchase_price_source;
  const purchasePriceSource: CashBuyPurchasePriceSource | undefined =
    pps === "default" || pps === "user" || pps === "zillow_cache" ||
    pps === "zillow_listing" || pps === "zillow_sold" || pps === "zillow_zestimate"
      ? pps : undefined;
  const insuranceFactors: CashBuyInsuranceFactors | undefined =
    row.insurance_factors && typeof row.insurance_factors === "object" &&
    typeof row.insurance_factors.regionKey === "string"
      ? row.insurance_factors as CashBuyInsuranceFactors
      : undefined;
  const userAnswerSources =
    row.user_answer_sources && typeof row.user_answer_sources === "object"
      ? row.user_answer_sources as Record<string, "manual" | "default" | "zillow" | "simulator">
      : undefined;

  // HOA is stored as (amount, frequency). Normalize to a monthly number
  // for the UI — divide by 12 when the row recorded an annual figure.
  let hoaMonthly: number | undefined;
  if (row.hoa_amount != null) {
    const raw = Number(row.hoa_amount);
    hoaMonthly = row.hoa_frequency === "annual" ? Math.round(raw / 12) : raw;
  }

  return {
    id: row.id,
    address: row.full_address,
    normalizedPropertyKey: row.normalized_property_key ?? undefined,
    savedAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    purchasePrice: row.purchase_price != null ? Number(row.purchase_price) : undefined,
    purchasePriceSource,
    occupancyType,
    occupancyTypeSource: toManualSource(row.occupancy_type_source),
    propertyType: typeof row.property_type === "string" && row.property_type.trim()
      ? row.property_type : undefined,
    propertyTypeSource: toManualSource(row.property_type_source),
    propertyTaxes: row.property_taxes != null ? Number(row.property_taxes) : undefined,
    propertyTaxesSource: toManualSource(row.property_taxes_source),
    homeownersInsurance: row.homeowners_insurance != null ? Number(row.homeowners_insurance) : undefined,
    homeownersInsuranceSource: toManualSource(row.homeowners_insurance_source),
    annualFloodIns: suppressSeparateFloodInsurance(row.property_type)
      ? 0
      : row.annual_flood_ins != null ? Number(row.annual_flood_ins) : undefined,
    hoaMonthly,
    hoaSource,
    closingCosts: row.buyer_closing_costs != null ? Number(row.buyer_closing_costs) : undefined,
    closingCostsPercent: row.closing_costs_percent != null ? Number(row.closing_costs_percent) : undefined,
    closingCostsSource,
    sellerConcessionsMode,
    sellerConcessionsPercent: row.seller_concessions_percent != null ? Number(row.seller_concessions_percent) : undefined,
    sellerConcessionsAmount: row.seller_concessions_amount != null ? Number(row.seller_concessions_amount) : undefined,
    sellerConcessionsSource: toManualSource(row.seller_concessions_source),
    cashToClose: row.cash_to_close != null ? Number(row.cash_to_close) : undefined,
    insurancePremiumAnnual: row.insurance_premium_annual != null ? Number(row.insurance_premium_annual) : undefined,
    insuranceFactors,
    userAnswerSources,
    primaryPhotoUrl: row.primary_photo_url ?? undefined,
    propertyPhotos: photos,
    status: typeof row.status === "string" ? row.status : undefined,
    zillowCacheKey: row.zillow_cache_key ?? undefined,
    propertyCacheId: row.property_cache_id ?? undefined,
  };
}

function cashBuyToRow(s: CashBuyScenario, userId: string) {
  return {
    id: s.id,
    user_id: userId,
    full_address: s.address,
    normalized_property_key: s.normalizedPropertyKey ?? null,
    created_at: s.savedAt,
    updated_at: s.updatedAt,
    purchase_price: s.purchasePrice ?? null,
    purchase_price_source: s.purchasePriceSource ?? null,
    occupancy_type: s.occupancyType ?? null,
    occupancy_type_source: s.occupancyTypeSource ?? null,
    property_type: s.propertyType ?? null,
    property_type_source: s.propertyTypeSource ?? null,
    property_taxes: s.propertyTaxes ?? null,
    property_taxes_source: s.propertyTaxesSource ?? null,
    homeowners_insurance: s.homeownersInsurance ?? null,
    homeowners_insurance_source: s.homeownersInsuranceSource ?? null,
    annual_flood_ins: suppressSeparateFloodInsurance(s.propertyType)
      ? 0
      : s.annualFloodIns ?? null,
    insurance_premium_annual: s.insurancePremiumAnnual ?? null,
    insurance_factors: s.insuranceFactors ?? null,
    user_answer_sources: s.userAnswerSources ?? null,
    // Canonical column pair — we always persist the monthly value with
    // an explicit frequency tag so a future per-frequency reader can
    // round-trip without losing information.
    hoa_amount: s.hoaMonthly ?? null,
    hoa_frequency: s.hoaMonthly != null ? "monthly" : null,
    hoa_source: s.hoaSource ?? null,
    buyer_closing_costs: s.closingCosts ?? null,
    closing_costs_percent: s.closingCostsPercent ?? null,
    closing_costs_source: s.closingCostsSource ?? null,
    seller_concessions_mode: s.sellerConcessionsMode ?? null,
    seller_concessions_percent: s.sellerConcessionsPercent ?? null,
    seller_concessions_amount: s.sellerConcessionsAmount ?? null,
    seller_concessions_source: s.sellerConcessionsSource ?? null,
    cash_to_close: s.cashToClose ?? null,
    primary_photo_url: s.primaryPhotoUrl ?? null,
    property_photos: s.propertyPhotos ?? null,
    status: s.status ?? "active",
    zillow_cache_key: s.zillowCacheKey ?? null,
    property_cache_id: s.propertyCacheId ?? null,
  };
}
function rowToTrackedLoan(row: any): TrackedLoan {
  return {
    id: row.id,
    propertyAddress: row.property_address,
    lender: row.lender ?? "",
    loanBalance: Number(row.loan_balance),
    currentRate: Number(row.current_rate),
    currentPI: Number(row.current_pi),
    monthlyPayment: Number(row.monthly_payment),
    currentEscrowBalance: numOrUndef(row.current_escrow_balance),
    estimatedHomeValue: Number(row.estimated_home_value),
    estimatedRemainingYears: Number(row.estimated_remaining_years),
    propertyType: (row.property_type ?? "primary") as TrackedLoanPropertyType,
    occupancyType: ((): "primary" | "secondary" | "investment" | undefined => {
      const v = row.occupancy_type;
      return v === "primary" || v === "secondary" || v === "investment" ? v : undefined;
    })(),
    physicalPropertyType:
      typeof row.physical_property_type === "string" && row.physical_property_type.trim()
        ? row.physical_property_type : undefined,
    loanType: ((): TrackedLoanType | undefined => {
      const v = row.loan_type;
      return v === "va" || v === "fha" || v === "conventional" ||
             v === "dscr" || v === "bank_statement" ? v : undefined;
    })(),
    addedAt: row.added_at,
    balanceAsOf: row.balance_as_of ?? undefined,
    loanNumber: typeof row.loan_number === "string" && row.loan_number.trim()
      ? row.loan_number.trim() : undefined,
    creditScore: ((): number | undefined => {
      const v = row.credit_score;
      if (v === null || v === undefined) return undefined;
      const n = typeof v === "number" ? v : parseInt(String(v), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    estimatedHomeValueSource:
      row.estimated_home_value_source === "manual" ||
      row.estimated_home_value_source === "statement" ||
      row.estimated_home_value_source === "zillow" ||
      row.estimated_home_value_source === "synced"
        ? row.estimated_home_value_source
        : undefined,
    refiGoal:
      row.refi_goal === "rate_term" ||
      row.refi_goal === "cash_out" ||
      row.refi_goal === "home_equity"
        ? row.refi_goal
        : undefined,
    financeFees: typeof row.finance_fees === "boolean" ? row.finance_fees : undefined,
    includeEscrows: typeof row.include_escrows === "boolean" ? row.include_escrows : undefined,
    cashOutNewLoanAmount: ((): number | undefined => {
      const v = row.cash_out_new_loan_amount;
      if (v === null || v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    homeEquityProduct:
      row.home_equity_product === "heloc" || row.home_equity_product === "he_loan"
        ? row.home_equity_product
        : undefined,
    homeEquityBorrowAmount: ((): number | undefined => {
      const v = row.home_equity_borrow_amount;
      if (v === null || v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    })(),
    entryMethod:
      row.entry_method === "statement" ||
      row.entry_method === "closing_disclosure" ||
      row.entry_method === "manual" ||
      row.entry_method === "free_and_clear"
        ? row.entry_method
        : undefined,
    purchaseDate: typeof row.purchase_date === "string" && row.purchase_date
      ? row.purchase_date : undefined,
    firstPaymentDate: typeof row.first_payment_date === "string" && row.first_payment_date
      ? row.first_payment_date : undefined,
    originalPurchasePrice: numOrUndef(row.original_purchase_price),
    originalLoanAmount: numOrUndef(row.original_loan_amount),
    originalRate: numOrUndef(row.original_rate),
    originalTermMonths: ((): number | undefined => {
      const n = numOrUndef(row.original_term_months);
      return n !== undefined ? Math.round(n) : undefined;
    })(),
    amortizedBalanceCheck: numOrUndef(row.amortized_balance_check),
    balanceConfirmed: typeof row.balance_confirmed === "boolean" ? row.balance_confirmed : undefined,
    freeAndClear: typeof row.free_and_clear === "boolean" ? row.free_and_clear : undefined,
    annualPropertyTax: numOrUndef(row.annual_property_tax),
    annualPropertyTaxSource: ((): TrackedLoan["annualPropertyTaxSource"] => {
      const v = row.annual_property_tax_source;
      return v === "manual" || v === "tax-collector-bill-scrape" || v === "manatee-arcgis"
        ? v : undefined;
    })(),
    annualPropertyTaxYear: ((): number | undefined => {
      const n = numOrUndef(row.annual_property_tax_year);
      return n !== undefined ? Math.round(n) : undefined;
    })(),
    annualPropertyTaxBreakdown: savedCurrentBillBreakdown(
      row.annual_property_tax_breakdown, row.annual_property_tax_source, numOrUndef(row.annual_property_tax)),
    annualPropertyTaxQueriedAt: currentBillFetchedAt(savedCurrentBillBreakdown(
      row.annual_property_tax_breakdown, row.annual_property_tax_source, numOrUndef(row.annual_property_tax))),
    vaDisability: typeof row.va_disability === "boolean" ? row.va_disability : undefined,
  };
}
function trackedLoanToRow(l: TrackedLoan, userId: string) {
  const row = {
    id: l.id,
    user_id: userId,
    property_address: l.propertyAddress,
    lender: l.lender || null,
    loan_balance: l.loanBalance,
    current_rate: l.currentRate,
    current_pi: l.currentPI,
    monthly_payment: l.monthlyPayment,
    ...(typeof l.currentEscrowBalance === "number" && l.currentEscrowBalance >= 0
      ? { current_escrow_balance: l.currentEscrowBalance }
      : {}),
    estimated_home_value: l.estimatedHomeValue,
    estimated_remaining_years: l.estimatedRemainingYears,
    property_type: l.propertyType ?? "primary",
    ...(l.occupancyType ? { occupancy_type: l.occupancyType } : {}),
    ...(l.physicalPropertyType ? { physical_property_type: l.physicalPropertyType } : {}),
    loan_type: l.loanType ?? "conventional",
    ...(typeof l.vaDisability === "boolean" ? { va_disability: l.vaDisability } : {}),
    added_at: l.addedAt,
    balance_as_of: l.balanceAsOf ?? null,
    loan_number: l.loanNumber && l.loanNumber.trim() ? l.loanNumber.trim() : null,
    credit_score: typeof l.creditScore === "number" && l.creditScore > 0 ? l.creditScore : null,
    ...(l.estimatedHomeValueSource
      ? { estimated_home_value_source: l.estimatedHomeValueSource }
      : {}),
    ...(l.refiGoal ? { refi_goal: l.refiGoal } : {}),
    ...(typeof l.financeFees === "boolean" ? { finance_fees: l.financeFees } : {}),
    ...(typeof l.includeEscrows === "boolean" ? { include_escrows: l.includeEscrows } : {}),
    ...(typeof l.cashOutNewLoanAmount === "number" && l.cashOutNewLoanAmount > 0
      ? { cash_out_new_loan_amount: l.cashOutNewLoanAmount }
      : {}),
    ...(l.homeEquityProduct ? { home_equity_product: l.homeEquityProduct } : {}),
    ...(typeof l.homeEquityBorrowAmount === "number" && l.homeEquityBorrowAmount >= 0
      ? { home_equity_borrow_amount: l.homeEquityBorrowAmount }
      : {}),
    ...(l.entryMethod ? { entry_method: l.entryMethod } : {}),
    ...(l.purchaseDate ? { purchase_date: l.purchaseDate } : {}),
    ...(l.firstPaymentDate ? { first_payment_date: l.firstPaymentDate } : {}),
    ...(typeof l.originalPurchasePrice === "number" && l.originalPurchasePrice > 0
      ? { original_purchase_price: l.originalPurchasePrice } : {}),
    ...(typeof l.originalLoanAmount === "number" && l.originalLoanAmount > 0
      ? { original_loan_amount: l.originalLoanAmount } : {}),
    ...(typeof l.originalRate === "number" && l.originalRate > 0
      ? { original_rate: l.originalRate } : {}),
    ...(typeof l.originalTermMonths === "number" && l.originalTermMonths > 0
      ? { original_term_months: Math.round(l.originalTermMonths) } : {}),
    ...(typeof l.amortizedBalanceCheck === "number" && l.amortizedBalanceCheck > 0
      ? { amortized_balance_check: l.amortizedBalanceCheck } : {}),
    ...(typeof l.balanceConfirmed === "boolean" ? { balance_confirmed: l.balanceConfirmed } : {}),
    ...(typeof l.freeAndClear === "boolean" ? { free_and_clear: l.freeAndClear } : {}),
    ...(typeof l.annualPropertyTax === "number" && l.annualPropertyTax >= 0
      ? { annual_property_tax: l.annualPropertyTax } : {}),
    ...(l.annualPropertyTaxSource
      ? { annual_property_tax_source: l.annualPropertyTaxSource } : {}),
    ...currentBillEvidenceToRow(l),
    ...(l.annualPropertyTaxSource === "manual"
      ? {
          annual_property_tax_year: null,
          annual_property_tax_queried_at: null,
        }
      : {
          ...(typeof l.annualPropertyTaxYear === "number" && l.annualPropertyTaxYear > 0
            ? { annual_property_tax_year: Math.round(l.annualPropertyTaxYear) } : {}),
        }),
  };
  return row;
}

// ── Serialized write queues (one per table) ────────────────────────
// Prevents the race where two overlapping saves cause an older request
// to finish last and wipe newer rows via the delete-then-upsert pass.
const _writeChains: Record<string, Promise<void>> = {};
function enqueueWrite(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = _writeChains[key] ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _writeChains[key] = next;
  return next;
}

async function loadProfile(userId: string): Promise<AuthUser | null> {
  const baseColumns =
    "id,name,email,phone,agent,invited_user,created_at";
  let { data, error } = await supabase
    .from("profiles")
    .select(`${baseColumns},monthly_income,monthly_debts`)
    .eq("id", userId)
    .maybeSingle();
  if (error && /monthly_(income|debts)/i.test(error.message)) {
    ({ data, error } = await supabase
      .from("profiles")
      .select(baseColumns)
      .eq("id", userId)
      .maybeSingle());
  }
  if (error) { console.warn("[auth] loadProfile error:", error.message); return null; }
  return data ? rowToProfile(data) : null;
}

async function loadScenarios(userId: string) {
  const [pRes, iRes, sRes, cRes, lRes] = await Promise.all([
    supabase.from("purchase_scenarios").select("*").eq("user_id", userId).order("saved_at", { ascending: false }),
    supabase.from("insurance_scenarios").select("*").eq("user_id", userId).order("saved_at", { ascending: false }),
    supabase.from("seller_scenarios").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("cash_buy_scenarios").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("tracked_loans").select("*").eq("user_id", userId).order("added_at", { ascending: false }),
  ]);
  console.debug("[purchase-load] user id", userId);
  console.debug("[purchase-live-load] auth user id", userId);
  console.debug("[purchase-live-load] query table", "purchase_scenarios");
  if (pRes.error) {
    const errInfo = {
      message: pRes.error.message,
      details: (pRes.error as any).details,
      hint: (pRes.error as any).hint,
      code: (pRes.error as any).code,
    };
    console.error("[purchase-load] error", errInfo);
    console.error("[purchase-live-load] error", errInfo);
    notifyError({ table: "purchase_scenarios", message: pRes.error.message });
  }
  _purchaseScenarios = (pRes.data ?? []).map(rowToPurchase);
  // A "draft" here is any purchase scenario without a price set —
  // these are rows created immediately on address-add before the user
  // fills in Pages 1-4. The dashboard intentionally includes these so
  // the user sees the property they just added.
  const _draftCount = _purchaseScenarios.filter(p => p.price == null).length;
  console.debug("[purchase-load] rows loaded", {
    userId,
    count: _purchaseScenarios.length,
    draftCount: _draftCount,
    ids: _purchaseScenarios.map(p => p.id),
    addresses: _purchaseScenarios.map(p => p.address),
  });
  console.debug("[purchase-load] count", _purchaseScenarios.length);
  console.debug("[purchase-load] draft scenarios included", _draftCount);
  console.debug("[purchase-live-load] rows returned", _purchaseScenarios.length);
  console.debug("[purchase-live-load] row ids", _purchaseScenarios.map(p => p.id));
  console.debug("[purchase-live-load] row addresses", _purchaseScenarios.map(p => p.address));
  console.debug("[purchase-live-load] row statuses", (pRes.data ?? []).map((r: any) => r.status ?? null));
  console.debug("[purchase-live-load] filtered out rows, if any", []);
  _insuranceScenarios = (iRes.data ?? []).map(rowToInsurance);
  // Tolerate missing cash_buy_scenarios table on environments where the
  // latest schema.sql hasn't been re-run yet. Other tabs continue to work.
  if (cRes.error) {
    console.warn("[cash-buy-load] table missing or RLS blocked", {
      table: "cash_buy_scenarios", userId, error: cRes.error.message,
    });
    notifyError({ table: "cash_buy_scenarios", message: cRes.error.message });
    _cashBuyScenarios = [];
  } else {
    _cashBuyScenarios = (cRes.data ?? []).map(rowToCashBuy);
  }
  // Tolerate missing seller_scenarios table on environments where the latest
  // schema.sql has not yet been re-run. Other tabs continue to work.
  if (sRes.error) {
    console.error("[seller-load] FAILED — table missing or RLS blocked", {
      table: "seller_scenarios", userId, error: sRes.error,
    });
    notifyError({ table: "seller_scenarios", message: sRes.error.message });
    _sellerScenarios = [];
  } else {
    _sellerScenarios = (sRes.data ?? []).map(rowToSeller);
  }
  _trackedLoans      = (lRes.data ?? []).map(rowToTrackedLoan);
}

// One-time migration of pre-existing localStorage data into Supabase the
// first time a user signs in on this browser. Reads from both legacy keys
// that the codebase historically used, dedupes by id, then clears them.
const MIGRATED_FLAG = "tateo_localstorage_migrated_v1";
const LEGACY_LOAN_KEYS = ["refinance-tracked-loans", "tateo_tracked_loans"];

async function migrateLocalStorageOnce(userId: string) {
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return;
  } catch { return; }

  const collected: TrackedLoan[] = [];
  for (const key of LEGACY_LOAN_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<TrackedLoan>[];
      if (!Array.isArray(parsed)) continue;
      for (const l of parsed) {
        if (!l || !l.id || !l.propertyAddress) continue;
        collected.push({
          id: String(l.id),
          propertyAddress: l.propertyAddress,
          lender: l.lender || "",
          loanBalance: Number(l.loanBalance ?? 0),
          currentRate: Number(l.currentRate ?? 0),
          currentPI: Number(l.currentPI ?? 0),
          monthlyPayment: Number(l.monthlyPayment ?? 0),
          estimatedHomeValue: Number(l.estimatedHomeValue ?? 0),
          estimatedRemainingYears: Number(l.estimatedRemainingYears ?? 30),
          propertyType: (l.propertyType ?? "primary") as TrackedLoanPropertyType,
          addedAt: l.addedAt || new Date().toISOString(),
          balanceAsOf: l.balanceAsOf,
        });
      }
    } catch { /* ignore corrupt entries */ }
  }

  // Dedupe by id (later keys win — but they're effectively the same data).
  const byId = new Map<string, TrackedLoan>();
  for (const l of collected) byId.set(l.id, l);
  const all = Array.from(byId.values());

  if (all.length > 0) {
    const { error } = await supabase
      .from("tracked_loans")
      .upsert(all.map(l => trackedLoanToRow(l, userId)), { onConflict: "id" });
    if (error) {
      console.warn("[auth] tracked-loan migration failed:", error.message);
      return; // don't set the flag — let it retry next session
    }
  }

  try {
    for (const key of LEGACY_LOAN_KEYS) localStorage.removeItem(key);
    localStorage.setItem(MIGRATED_FLAG, "1");
  } catch {}
}

async function hydrateFromSupabase() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    _session = null;
    _purchaseScenarios = [];
    _insuranceScenarios = [];
    _sellerScenarios = [];
    _cashBuyScenarios = [];
    _trackedLoans = [];
    try { localStorage.removeItem("tateo_auth"); } catch {}
    _authHydrated = true;
    notify();
    return;
  }
  try { localStorage.setItem("tateo_auth", "1"); } catch {}

  // Build a safe fallback from the Supabase auth record so the UI can show
  // "signed in" even if the profiles table isn't reachable yet (e.g. schema
  // not yet applied, transient network error, or profile row missing).
  const meta = session.user.user_metadata || {};
  const fallback: AuthUser = {
    id: session.user.id,
    name: meta.name || session.user.email?.split("@")[0] || "User",
    email: session.user.email || "",
    phone: meta.phone ?? undefined,
    agent: meta.agent ?? undefined,
    createdAt: session.user.created_at ?? new Date().toISOString(),
  };

  let profile = await loadProfile(session.user.id);
  if (!profile) {
    // Try to create the row (first sign-in, or trigger not yet installed).
    const { error: upsertErr } = await supabase.from("profiles").upsert({
      id: session.user.id,
      name: fallback.name,
      email: fallback.email,
      phone: fallback.phone ?? null,
      agent: fallback.agent ?? null,
    });
    if (!upsertErr) profile = await loadProfile(session.user.id);
  }
  // Backfill missing fields from the Supabase auth metadata. A profile row that
  // was created before the phone was captured (or by an older trigger) can be
  // missing phone/name even though the auth record has them — without this,
  // the loaded profile would override the good fallback and lose the phone,
  // so showing-request notifications would show "Not provided".
  if (profile) {
    const needsPhone = !profile.phone && Boolean(fallback.phone);
    const needsName = !profile.name && Boolean(fallback.name);
    if (needsPhone || needsName) {
      profile = {
        ...profile,
        phone: profile.phone || fallback.phone,
        name: profile.name || fallback.name,
      };
      // Mirror it back to profiles so future loads + the FUB contact stay in sync.
      void supabase.from("profiles").update({
        ...(needsPhone ? { phone: fallback.phone } : {}),
        ...(needsName ? { name: fallback.name } : {}),
      }).eq("id", session.user.id);
    }
  }
  _session = profile ?? fallback;

  // Scenarios depend on their own tables; ignore errors so a missing schema
  // doesn't break the auth UI.
  try {
    await migrateLocalStorageOnce(session.user.id);
    await loadScenarios(session.user.id);
  } catch (e) {
    console.warn("[auth] loadScenarios skipped:", e);
  }
  _authHydrated = true;
  notify();
}

// React to Supabase auth lifecycle (sign-in, sign-out, token refresh).
if (supabaseReady) {
  supabase.auth.onAuthStateChange((_event, _session) => { void hydrateFromSupabase(); });
  // Initial hydration on app load.
  void hydrateFromSupabase();
} else {
  // No Supabase configured — there's nothing to wait for.
  _authHydrated = true;
}

// ── Auth actions ──────────────────────────────────────────────────
// Fire-and-forget notify to the server so Follow Up Boss is told about a
// real signup or sign-in action. Deliberately NOT called from
// hydrateFromSupabase / onAuthStateChange, so a session restore on page
// refresh never produces a duplicate sign-in notification. Never throws —
// a FUB hiccup must not block auth.
async function notifyAccountEvent(
  event: "account_created" | "account_signed_in",
): Promise<void> {
  try {
    // authedFetch attaches the Supabase access token so the server can
    // verify identity itself. The email/phone/name are derived from the
    // verified session server-side — never trusted from the body.
    await authedFetch("/api/leads/account-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    });
    console.log("[login] fub notification queued");
  } catch {
    /* non-blocking — ignore network/FUB failures */
  }
}

export function _validateBorrowerFinances(
  monthlyIncome: number,
  monthlyDebts: number,
): { valid: true } | { valid: false; error: string } {
  if (!Number.isFinite(monthlyIncome)) {
    return { valid: false, error: "Monthly income must be a valid number." };
  }
  if (monthlyIncome <= 0) {
    return { valid: false, error: "Monthly income must be greater than zero." };
  }
  if (!Number.isFinite(monthlyDebts)) {
    return { valid: false, error: "Monthly debts must be a valid number." };
  }
  if (monthlyDebts < 0) {
    return { valid: false, error: "Monthly debts cannot be negative." };
  }
  return { valid: true };
}

/**
 * Persist the borrower's DTI figures (gross monthly income + monthly
 * non-mortgage debts) on the user's profile so the refi DTI check
 * prefills across sessions. The in-memory session is changed only after
 * the database confirms that an existing profile row was updated.
 */
export async function saveBorrowerFinances(
  monthlyIncome: number,
  monthlyDebts: number,
): Promise<{ saved: boolean; error?: string }> {
  if (!supabaseReady) {
    return { saved: false, error: "Saving borrower finances is unavailable." };
  }
  if (!_session) {
    return { saved: false, error: "Sign in to save borrower finances." };
  }
  const validation = _validateBorrowerFinances(monthlyIncome, monthlyDebts);
  if (!validation.valid) return { saved: false, error: validation.error };

  const id = _session.id;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .update({ monthly_income: monthlyIncome, monthly_debts: monthlyDebts })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) {
      return { saved: false, error: error.message };
    }
    if (!data) {
      return { saved: false, error: "Borrower profile was not found." };
    }
    if (_session?.id === id) {
      _session = { ..._session, monthlyIncome, monthlyDebts };
      notify();
    }
    return { saved: true };
  } catch (e: unknown) {
    return {
      saved: false,
      error: e instanceof Error ? e.message : "Unable to save borrower finances.",
    };
  }
}

/**
 * Persist contact details (phone/name) to the signed-in user's profile.
 * Best-effort and never throws — used when a logged-in user supplies a missing
 * phone before a showing request. Updates the profiles row, mirrors the value
 * into the Supabase auth metadata, and updates the in-memory session so the
 * rest of the app (and the showing notification) sees it immediately.
 */
export async function updateProfileContact(
  opts: { phone?: string; name?: string; email?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseReady || !_session) return { ok: false, error: "Not signed in" };
  const id = _session.id;
  const phone = opts.phone?.trim();
  const name = opts.name?.trim();
  const email = opts.email?.trim().toLowerCase();
  // Email lives on profiles too, but only persist it when it differs from the
  // existing one (it's the login identity and is essentially always present).
  const emailChanged = Boolean(email) && email !== (_session.email || "").toLowerCase();
  const patch: Record<string, any> = {};
  if (phone) patch.phone = phone;
  if (name) patch.name = name;
  if (emailChanged) patch.email = email;
  if (Object.keys(patch).length === 0) return { ok: true };

  try {
    const { error } = await supabase.from("profiles").update(patch).eq("id", id);
    if (error) {
      console.warn("[profile-save] profile saved error", error.message);
      return { ok: false, error: error.message };
    }
    // Mirror name/phone into auth metadata so they survive a fresh session
    // restore too. (Email is managed by Supabase auth itself, so skip it here.)
    try {
      const meta: Record<string, any> = {};
      if (phone) meta.phone = phone;
      if (name) meta.name = name;
      if (Object.keys(meta).length > 0) await supabase.auth.updateUser({ data: meta });
    } catch { /* non-blocking */ }
    _session = {
      ..._session,
      ...(phone ? { phone } : {}),
      ...(name ? { name } : {}),
      ...(emailChanged ? { email: email! } : {}),
    };
    notify();
    return { ok: true };
  } catch (e: any) {
    console.warn("[profile-save] profile saved error", e?.message);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Parse and validate a date of birth without timezone conversion.
 * Accepted storage format is the HTML date-input/Postgres DATE format.
 */
export function normalizeDateOfBirth(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const candidateUtc = candidate.getTime();
  if (
    candidateUtc > todayUtc ||
    year < 1900
  ) {
    return null;
  }
  return value;
}

/** Save a missing DOB from the authenticated live-quote preflight. */
export async function saveDateOfBirth(
  rawDateOfBirth: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseReady || !_session) {
    return { ok: false, error: "Please sign in again before requesting quotes." };
  }
  const dateOfBirth = normalizeDateOfBirth(rawDateOfBirth);
  if (!dateOfBirth) {
    return { ok: false, error: "Please enter a valid date of birth." };
  }

  try {
    const response = await authedFetch("/api/profile/date-of-birth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dateOfBirth }),
    });
    if (!response.ok) {
      console.warn("[profile-save] date of birth was not persisted");
      return {
        ok: false,
        error: "We couldn't save your date of birth. Please try again.",
      };
    }

    _session = { ..._session, hasDateOfBirth: true };
    notify();
    return { ok: true };
  } catch (error: any) {
    console.warn("[profile-save] date of birth was not persisted");
    return {
      ok: false,
      error: "We couldn't save your date of birth. Please try again.",
    };
  }
}

/** Check DOB presence without ever returning the sensitive date to the UI. */
export async function hasSavedDateOfBirth(): Promise<boolean> {
  if (!supabaseReady || !_session) return false;
  try {
    const response = await authedFetch("/api/profile/status");
    if (!response.ok) return false;
    const data = await response.json();
    const hasDateOfBirth = data?.hasDateOfBirth === true;
    if (hasDateOfBirth && !_session.hasDateOfBirth) {
      _session = { ..._session, hasDateOfBirth: true };
      notify();
    }
    return hasDateOfBirth;
  } catch {
    return false;
  }
}

export async function register(
  name: string,
  email: string,
  password: string,
  opts?: { phone?: string; agent?: string; dateOfBirth?: string }
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseReady) return NOT_CONFIGURED;
  const cleanEmail = email.toLowerCase().trim();
  const cleanPhone = opts?.phone?.trim() || "";
  const dateOfBirth = normalizeDateOfBirth(opts?.dateOfBirth);
  if (!dateOfBirth) {
    return { ok: false, error: "Please enter a valid date of birth." };
  }
  const profileSetupNonce = crypto.randomUUID();
  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password,
    options: {
      data: {
        name: name.trim(),
        phone: cleanPhone || null,
        agent: opts?.agent?.trim() || null,
        // Non-sensitive, short-lived proof used by our server to finish the
        // protected profile even when email confirmation yields no session.
        profile_setup_nonce: profileSetupNonce,
      },
    },
  });
  if (error) { console.log("[auth-signup] error"); return { ok: false, error: error.message }; }
  console.log("[auth-signup] account created via Supabase Auth");
  if (!data.user?.id) {
    return { ok: false, error: "Your account could not be completed. Please try again." };
  }
  const profileResponse = await fetch("/api/profile/complete-registration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: data.user.id,
      profileSetupNonce,
      dateOfBirth,
    }),
  });
  if (!profileResponse.ok) {
    console.warn("[auth-signup] protected profile not saved");
    return {
      ok: false,
      error: "Your account was created, but your profile could not be saved. Please sign in and try again.",
    };
  }
  // Some Supabase projects require email confirmation — the server-side step
  // above still saved DOB before we ask the user to confirm and sign in.
  if (!data.session) {
    return { ok: false, error: "Check your email to confirm your account, then sign in." };
  }
  await hydrateFromSupabase();
  void notifyAccountEvent("account_created");
  return { ok: true };
}

export async function login(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseReady) return NOT_CONFIGURED;
  const cleanEmail = email.toLowerCase().trim();
  const { error } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });
  if (error) { console.log("[auth-login] error"); return { ok: false, error: error.message }; }
  console.log("[auth-login] signed in via Supabase Auth");
  await hydrateFromSupabase();
  void notifyAccountEvent("account_signed_in");
  console.log("[auth-login] fub sign-in notification sent");
  return { ok: true };
}

export async function logout(): Promise<void> {
  if (supabaseReady) await supabase.auth.signOut();
  _session = null;
  _purchaseScenarios = [];
  _insuranceScenarios = [];
  _sellerScenarios = [];
  _cashBuyScenarios = [];
  _trackedLoans = [];
  notify();
}

export async function updateProfile(
  _currentEmail: string,
  updates: { name?: string; email?: string; phone?: string; agent?: string }
): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const targetEmail = updates.email?.toLowerCase().trim();
  if (targetEmail && targetEmail !== user.email) {
    if (!targetEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return { ok: false, error: "Please enter a valid email address." };
    }
    const { error: emailErr } = await supabase.auth.updateUser({ email: targetEmail });
    if (emailErr) return { ok: false, error: emailErr.message };
  }

  let phone: string | null | undefined = undefined;
  if (updates.phone !== undefined) {
    const digits = updates.phone.replace(/\D/g, "");
    if (digits.length > 0 && digits.length < 10) {
      return { ok: false, error: "Please enter a valid 10-digit phone number." };
    }
    phone = digits || null;
  }

  const patch: Record<string, any> = {};
  if (updates.name !== undefined) patch.name = updates.name.trim();
  if (targetEmail) patch.email = targetEmail;
  if (phone !== undefined) patch.phone = phone;
  if (updates.agent !== undefined) patch.agent = updates.agent.trim() || null;

  if (Object.keys(patch).length > 0) {
    const { error: pErr } = await supabase.from("profiles").update(patch).eq("id", user.id);
    if (pErr) return { ok: false, error: pErr.message };
  }

  await hydrateFromSupabase();
  return { ok: true };
}

export async function updatePassword(
  _email: string,
  _currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  if (newPassword.length < 6) return { ok: false, error: "New password must be at least 6 characters." };
  // Supabase doesn't require the current password when an active session exists;
  // the session itself proves identity.
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Shared email format check. Passwords are NEVER stored in our tables —
// Supabase Auth hashes and manages them internally.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Forgot-password: ask Supabase Auth to email a reset link. Always
 *  resolves to a generic success so we never reveal whether an email is
 *  registered. The reset link returns the user to `/reset-password` on the
 *  same origin (works in dev and in production automatically). */
export async function requestPasswordReset(
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  const cleanEmail = email.toLowerCase().trim();
  if (!cleanEmail.match(EMAIL_RE)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (!supabaseReady) return NOT_CONFIGURED;
  // Prefer an explicit production site URL when configured (e.g.
  // https://havofl.com); fall back to the current origin so dev/preview
  // and any custom domain work without extra config.
  const siteUrl =
    (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)?.trim() ||
    window.location.origin;
  const redirectTo = `${siteUrl.replace(/\/$/, "")}/reset-password`;
  try {
    await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo });
  } catch {
    // Swallow — never reveal whether the address exists.
    console.log("[auth-forgot-password] error");
  }
  console.log("[auth-forgot-password] reset email requested (generic response shown)");
  console.log("[auth-schema] sql needed no");
  return { ok: true };
}

/** Reset-password page: set a new password using the recovery session that
 *  Supabase establishes from the email link (detectSessionInUrl handles the
 *  token exchange). Supabase Auth only — no raw password touches our DB. */
export async function completePasswordReset(
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseReady) return NOT_CONFIGURED;
  if (newPassword.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters." };
  }
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    console.log("[auth-reset-password] error");
    return { ok: false, error: error.message };
  }
  console.log("[auth-reset-password] password updated via Supabase Auth");
  return { ok: true };
}

export async function inviteUser(
  _email: string,
  inviteeName: string,
  inviteeEmail: string
): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!inviteeName.trim()) return { ok: false, error: "Please enter the invitee's full name." };
  const cleanEmail = inviteeEmail.toLowerCase().trim();
  if (!cleanEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    return { ok: false, error: "Please enter a valid email address for the invitee." };
  }
  if (cleanEmail === user.email) return { ok: false, error: "You can't invite yourself." };

  const invited_user = {
    name: inviteeName.trim(),
    email: cleanEmail,
    invitedAt: new Date().toISOString(),
  };
  const { error } = await supabase.from("profiles").update({ invited_user }).eq("id", user.id);
  if (error) return { ok: false, error: error.message };
  await hydrateFromSupabase();
  return { ok: true };
}

export async function removeInvitedUser(_email: string): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { error } = await supabase.from("profiles").update({ invited_user: null }).eq("id", user.id);
  if (error) return { ok: false, error: error.message };
  await hydrateFromSupabase();
  return { ok: true };
}

// ── Purchase scenarios ────────────────────────────────────────────
export function getPurchaseScenarios(): PurchaseScenario[] {
  return _purchaseScenarios;
}

export function savePurchaseScenarios(s: PurchaseScenario[]) {
  const prev = _purchaseScenarios;
  // Stamp priceSource = "manual" on user-driven price diffs (skipped when
  // a sync write is in flight — sync helper leaves priceSource untouched
  // because sync targets are overridable by definition).
  s = _stampManualOnValueDiff(prev, s,
    p => p.price,
    p => ({ ...p, priceSource: "manual" }));
  _purchaseScenarios = s;
  notify();
  void persistPurchaseScenarios(s);
  _diffAndSyncPropertyValue(prev, s, "purchase",
    p => p.price,
    p => p.address);
  autoCreateInsuranceFromAddresses(
    s.map(p => ({
      sourceType: "purchase" as const,
      sourceScenarioId: p.id,
      address: p.address,
      // Seed Insurance-tab annualPremium with 0.75% of purchase price
      // for newly-created rows (spec: insurance-default-075-percent).
      propertyValue: p.price ?? undefined,
      // Phase 2 follow-up: PurchaseScenario now has its own
      // `occupancyType` column (2026_05_27 migration). When set, we
      // use it directly so Investment purchases default to DP3 and
      // Secondary purchases stay on HO3. We fall back to "primary"
      // for legacy rows / new scenarios that haven't picked an
      // occupancy yet, matching the mortgage pricing engine default.
      // Manual overrides in the Insurance tab still win
      // (policyTypeSource = "manual").
      occupancyType: p.occupancyType ?? "primary",
      propertyType: p.propertyType,
    })),
  );
}

function persistPurchaseScenarios(s: PurchaseScenario[]) {
  // Bind the userId at enqueue time so a logout+login between enqueue and
  // execution can never cause us to write Account A's data into Account B's
  // rows. If the user has changed by the time the queue drains, drop it.
  const userId = _session?.id;
  console.debug("[purchase-save] user id", userId);
  console.debug("[purchase-save] scenario count", s.length);
  console.debug("[purchase-live-test] persist enqueued user id", userId);
  console.debug("[purchase-live-test] persist scenario count", s.length);
  if (!userId) {
    console.debug("[purchase-save] no session — skipping persist");
    console.debug("[purchase-live-test] upsert error", "no session at enqueue time");
    return Promise.resolve();
  }
  return enqueueWrite("purchase_scenarios", async () => {
    if (_session?.id !== userId) {
      console.debug("[purchase-save] user changed before drain — aborting");
      console.debug("[purchase-live-test] upsert error", "user changed before drain");
      return;
    }
    const keep = new Set(s.map(x => x.id));
    const { data: existing, error: selErr } = await supabase
      .from("purchase_scenarios")
      .select("id")
      .eq("user_id", userId);
    if (selErr) {
      console.error("[purchase-save] existing-id select error", selErr);
      notifyError({ table: "purchase_scenarios", message: selErr.message });
    }
    const toDelete = (existing ?? []).map(r => r.id).filter(id => !keep.has(id));
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from("purchase_scenarios")
        .delete()
        .in("id", toDelete)
        .eq("user_id", userId);
      if (delErr) {
        console.error("[purchase-save] delete-orphans error", delErr);
        notifyError({ table: "purchase_scenarios", message: delErr.message });
      }
    }
    if (s.length > 0) {
      // Strip-and-retry: protects against older Supabase instances that
      // haven't run the 2026_05_26 migration (price_source). Mirrors the
      // tracked_loans / seller_scenarios pattern.
      const PURCHASE_OPTIONAL_COLUMNS = [
        "price_source",
        "occupancy_type",
        "monthly_income",
        "monthly_income_source",
        // 2026_05_28 comprehensive borrower-answer persistence — every
        // column added by `2026_05_28_purchase_user_answers.sql` is
        // listed here so the strip-and-retry path keeps the app
        // working against Supabase instances that haven't applied the
        // migration yet.
        "monthly_debts",
        "credit_score",
        "reserves",
        "is_veteran",
        "va_disability",
        "va_disability_rating_100",
        "va_loan_use",
        "has_mortgage",
        "current_loan_fha",
        "has_rental_income",
        "monthly_rental_income",
        "rental_type",
        "seller_concessions",
        "seller_concessions_mode",
        "annual_taxes",
        "annual_ho_ins",
        "annual_flood_ins",
        "hoa_monthly",
        "cdd_annual",
        "impact_windows",
        "roof_attachment",
        "swr",
        "user_answer_sources",
      ] as const;
      const stripped = new Set<string>();
      const buildPayload = () => s.map(x => {
        const row: Record<string, any> = purchaseToRow(x, userId);
        Array.from(stripped).forEach(col => { delete row[col]; });
        return row;
      });
      let lastErr: string | null = null;
      let upData: any[] | null = null;
      let lastStatus: number | undefined;
      let lastStatusText: string | undefined;
      for (let attempt = 0; attempt <= PURCHASE_OPTIONAL_COLUMNS.length; attempt++) {
        const payload = buildPayload();
        if (attempt === 0) {
          payload.forEach((p) => {
            console.debug("[purchase-save] scenario id", p.id);
            console.debug("[purchase-save] full address", p.full_address ?? p.address);
            console.debug("[purchase-save] normalized key", p.normalized_property_key);
            console.debug("[purchase-live-test] normalized property key", p.normalized_property_key);
          });
          console.debug("[purchase-save] upsert payload", payload);
          console.debug("[purchase-live-test] upsert payload", payload);
        }
        const res = await supabase
          .from("purchase_scenarios")
          .upsert(payload, { onConflict: "id" })
          .select();
        lastStatus = res.status;
        lastStatusText = res.statusText;
        if (!res.error) { upData = res.data ?? []; lastErr = null; break; }
        const missing = extractMissingColumn(res.error.message);
        if (missing && (PURCHASE_OPTIONAL_COLUMNS as readonly string[]).includes(missing) && !stripped.has(missing)) {
          console.warn(`[purchase-save] retrying without missing column '${missing}'`);
          notifyError({
            table: "purchase_scenarios",
            message: `Your Supabase purchase_scenarios table is missing the '${missing}' column — re-apply supabase/schema.sql so this field can persist.`,
          });
          stripped.add(missing);
          continue;
        }
        lastErr = res.error.message;
        upData = null;
        const errInfo = {
          message: res.error.message,
          details: (res.error as any).details,
          hint: (res.error as any).hint,
          code: (res.error as any).code,
          status: res.status,
          statusText: res.statusText,
        };
        console.error("[purchase-save] upsert error", errInfo);
        console.error("[purchase-live-test] upsert error", errInfo);
        break;
      }
      const upErr = lastErr ? { message: lastErr } as any : null;
      const status = lastStatus;
      const statusText = lastStatusText;
      if (upErr) {
        notifyError({ table: "purchase_scenarios", message: upErr.message });
      } else {
        const okInfo = {
          status,
          rowCount: Array.isArray(upData) ? upData.length : 0,
          ids: Array.isArray(upData) ? upData.map((r: any) => r.id) : [],
        };
        console.debug("[purchase-save] upsert result", okInfo);
        console.debug("[purchase-live-test] upsert response", okInfo);
        console.debug("[purchase-save] upsert ok");
        // PostHog: scenario_saved (purchase). Fires once per scenario id
        // per session — the debounced autosave can persist the same row
        // dozens of times; we only want one analytics event per scenario.
        const newIds: string[] = Array.isArray(upData)
          ? upData.map((r: any) => r.id).filter((id: any): id is string => typeof id === "string")
          : [];
        for (const id of newIds) {
          if (_phPurchaseSavedFired.has(id)) continue;
          _phPurchaseSavedFired.add(id);
          trackEvent("scenario_saved", { type: "purchase" });
        }
      }
    } else {
      console.debug("[purchase-save] empty list — nothing to upsert");
      console.debug("[purchase-live-test] upsert response", "empty list — nothing to upsert");
    }
  });
}

// ── Insurance scenarios ───────────────────────────────────────────
export function getInsuranceScenarios(): InsuranceScenario[] {
  return _insuranceScenarios;
}

export function saveInsuranceScenarios(s: InsuranceScenario[]): Promise<void> {
  const prev = _insuranceScenarios;
  // Stamp coverageASource = "manual" on user-driven Coverage A diffs.
  // Premium is not stamped here because insurance.tsx has no direct
  // premium input — premium auto-derives from Coverage A, so a
  // Coverage-A edit must not lock the premium against future sync.
  // When the sync helper writes Coverage A, it stamps
  // coverageASource = "property_value_sync" itself, and this stamper
  // is skipped (isPropertyValueSyncInFlight() === true).
  s = _stampManualOnValueDiff(prev, s,
    i => i.coverageA,
    i => ({ ...i, coverageASource: "manual" }));
  _insuranceScenarios = s;
  notify();
  // Returns the persistence promise so callers (the new "Save
  // Scenario" button) can await a real Supabase write and only
  // show success after it finishes. Existing fire-and-forget
  // callers still work because the return value is ignorable.
  return persistInsuranceScenarios(s);
}

function persistInsuranceScenarios(s: InsuranceScenario[]) {
  const userId = _session?.id;
  if (!userId) return Promise.resolve();
  return enqueueWrite("insurance_scenarios", async () => {
    if (_session?.id !== userId) return;
    const keep = new Set(s.map(x => x.id));
    const { data: existing, error: selErr } = await supabase
      .from("insurance_scenarios")
      .select("id")
      .eq("user_id", userId);
    if (selErr) {
      notifyError({ table: "insurance_scenarios", message: selErr.message });
      throw new Error(selErr.message);
    }
    const toDelete = (existing ?? []).map(r => r.id).filter(id => !keep.has(id));
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from("insurance_scenarios").delete().in("id", toDelete).eq("user_id", userId);
      if (delErr) {
        notifyError({ table: "insurance_scenarios", message: delErr.message });
        throw new Error(delErr.message);
      }
    }
    if (s.length > 0) {
      // Strip-and-retry: protects against older Supabase instances that
      // haven't run the latest insurance migration (premium_source,
      // coverage_a, coverage_a_source, the eight *_source columns,
      // normalized_property_key, user_answer_sources). Each missing
      // column triggers one retry that drops the column from the
      // payload and continues — so a partial schema still saves the
      // fields it does have, with a one-time error toast naming the
      // missing column.
      const INSURANCE_OPTIONAL_COLUMNS = [
        "premium_source", "coverage_a", "coverage_a_source",
        "policy_type", "policy_type_source",
        "normalized_property_key", "user_answer_sources",
        "occupancy_type_source", "property_type_source",
        "carrier_source", "aop_deductible_source",
        "hurricane_deductible_source", "flood_deductible_source",
        "discounts_source", "quote_details_source",
      ] as const;
      const stripped = new Set<string>();
      const buildPayload = () => s.map(x => {
        const row: Record<string, any> = insuranceToRow(x, userId);
        Array.from(stripped).forEach(col => { delete row[col]; });
        return row;
      });
      // Prefer the (user_id, normalized_property_key) unique index when
      // available — it provides DB-level duplicate prevention and is
      // resilient to client-side id mismatches when the same property
      // is saved through two different flows. Fall back to PK (id)
      // when the unique index is missing or any row lacks a normalized
      // key (`onConflict` requires every row to have a value for the
      // conflict target).
      const allHaveKey = buildPayload().every(r => !!r.normalized_property_key);
      const conflictTargets = allHaveKey && !stripped.has("normalized_property_key")
        ? ["user_id,normalized_property_key", "id"]
        : ["id"];
      let conflictIdx = 0;
      let lastErr: string | null = null;
      for (let attempt = 0; attempt <= INSURANCE_OPTIONAL_COLUMNS.length + 1; attempt++) {
        const onConflict = conflictTargets[Math.min(conflictIdx, conflictTargets.length - 1)];
        console.debug("[insurance-user-save] upsert payload keys", {
          attempt, onConflict,
          rows: buildPayload().map(r => ({
            id: r.id, key: r.normalized_property_key,
            cols: Object.keys(r).length,
          })),
        });
        const { error: upErr } = await supabase
          .from("insurance_scenarios")
          .upsert(buildPayload(), { onConflict });
        if (!upErr) {
          console.debug("[insurance-user-save] upsert ok", { onConflict });
          lastErr = null;
          break;
        }
        const msg = upErr.message || "";
        // If the unique index doesn't exist yet, fall back to PK.
        if (onConflict !== "id" &&
            /no unique|exclusion constraint matching|42P10/i.test(msg)) {
          console.warn("[insurance-user-save] unique index missing — falling back to id");
          conflictIdx++;
          continue;
        }
        const missing = extractMissingColumn(msg);
        if (missing && (INSURANCE_OPTIONAL_COLUMNS as readonly string[]).includes(missing) && !stripped.has(missing)) {
          console.warn(`[insurance-save] retrying without missing column '${missing}'`);
          notifyError({
            table: "insurance_scenarios",
            message: `Your Supabase insurance_scenarios table is missing the '${missing}' column — re-apply supabase/schema.sql so this field can persist.`,
          });
          stripped.add(missing);
          // If we just stripped the normalized key, drop back to PK
          // conflict resolution on the next attempt.
          if (missing === "normalized_property_key") conflictIdx = conflictTargets.length - 1;
          continue;
        }
        console.debug("[insurance-user-save] upsert error", { onConflict, message: msg });
        lastErr = msg;
        break;
      }
      if (lastErr) {
        notifyError({ table: "insurance_scenarios", message: lastErr });
        throw new Error(lastErr);
      }
    }
  });
}

// ── Seller scenarios ──────────────────────────────────────────────
export function getSellerScenarios(): SellerScenario[] {
  return _sellerScenarios;
}

export function saveSellerScenarios(s: SellerScenario[]) {
  const prev = _sellerScenarios;
  _sellerScenarios = s;
  notify();
  void persistSellerScenarios(s);
  _diffAndSyncPropertyValue(prev, s, "seller",
    x => x.estimatedSalePrice,
    x => x.address,
    x => x.normalizedPropertyKey);
}

function persistSellerScenarios(s: SellerScenario[]) {
  const userId = _session?.id;
  if (!userId) {
    console.warn("[seller-save] skipped — no authenticated user", { count: s.length });
    return Promise.resolve();
  }
  return enqueueWrite("seller_scenarios", async () => {
    if (_session?.id !== userId) return;
    const keep = new Set(s.map(x => x.id));
    const { data: existing, error: selErr } = await supabase
      .from("seller_scenarios")
      .select("id")
      .eq("user_id", userId);
    if (selErr) {
      console.error("[seller-save] select-existing failed", {
        table: "seller_scenarios", userId, error: selErr,
      });
      notifyError({ table: "seller_scenarios", message: selErr.message });
      return;
    }
    const toDelete = (existing ?? []).map(r => r.id).filter(id => !keep.has(id));
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from("seller_scenarios").delete().in("id", toDelete).eq("user_id", userId);
      if (delErr) {
        console.error("[seller-save] delete failed", { ids: toDelete, error: delErr });
        notifyError({ table: "seller_scenarios", message: delErr.message });
      }
    }
    if (s.length > 0) {
      // Older Supabase schemas may be missing some of the source/percent
      // columns added in the 2026_05_24 migrations. Mirror the tracked_loans
      // strip-and-retry pattern so a stale schema warns the user instead of
      // dropping the whole save on the floor.
      const SELLER_OPTIONAL_COLUMNS = [
        "seller_closing_costs_percent",
        "estimated_sale_price_source",
        "mortgage_payoff_source",
        "mortgage_payoff_estimate_inputs",
        "mortgage_statement_metadata",
        "realtor_commission_source",
        "seller_closing_costs_source",
        // Estimated capital-gains tax columns (2026_06_15 migration).
        "primary_residence_2_of_5",
        "filing_status",
        "assume_1031_exchange",
        "capital_improvements",
        "prior_purchase_price",
        "prior_purchase_price_source",
        "estimated_taxes_due",
      ] as const;
      const stripped = new Set<string>();
      const buildPayload = () => s.map(x => {
        const row: Record<string, any> = sellerToRow(x, userId);
        for (const col of Array.from(stripped)) delete row[col];
        return row;
      });
      let lastErr: string | null = null;
      let upDataCount = 0;
      for (let attempt = 0; attempt <= SELLER_OPTIONAL_COLUMNS.length; attempt++) {
        const payload = buildPayload();
        const { error: upErr, data: upData } = await supabase
          .from("seller_scenarios")
          .upsert(payload, { onConflict: "id" })
          .select("id");
        if (!upErr) {
          upDataCount = upData?.length ?? 0;
          lastErr = null;
          break;
        }
        const missing = extractMissingColumn(upErr.message);
        if (missing && (SELLER_OPTIONAL_COLUMNS as readonly string[]).includes(missing) && !stripped.has(missing)) {
          console.warn(`[seller-save] retrying without missing column '${missing}'`);
          notifyError({
            table: "seller_scenarios",
            message: `Your Supabase seller_scenarios table is missing the '${missing}' column — re-apply supabase/schema.sql so this field can persist.`,
          });
          stripped.add(missing);
          continue;
        }
        lastErr = upErr.message;
        console.error("[seller-save] upsert failed", { error: upErr, payload });
        break;
      }
      if (lastErr) {
        notifyError({ table: "seller_scenarios", message: lastErr });
      } else {
      }
    }
  });
}

// ── Cash Buy scenarios ────────────────────────────────────────────
export function getCashBuyScenarios(): CashBuyScenario[] {
  return _cashBuyScenarios;
}

export function saveCashBuyScenarios(s: CashBuyScenario[]) {
  const prev = _cashBuyScenarios;
  _cashBuyScenarios = s;
  notify();
  void persistCashBuyScenarios(s);
  _diffAndSyncPropertyValue(prev, s, "cash_buy",
    x => x.purchasePrice,
    x => x.address,
    x => x.normalizedPropertyKey);
  autoCreateInsuranceFromAddresses(
    s.map(c => ({
      sourceType: "cash_buy" as const,
      sourceScenarioId: c.id,
      address: c.address,
      // Seed Insurance-tab annualPremium with 0.75% of purchase price
      // for newly-created rows (spec: insurance-default-075-percent).
      propertyValue: c.purchasePrice ?? undefined,
      occupancyType: c.occupancyType,
      // Phase 2 follow-up: cash_buy_scenarios.property_type column
      // added 2026_05_27. When the user (or Zillow) has supplied a
      // physical type, the rule can override Condo/Townhouse → HO6.
      propertyType: c.propertyType,
    })),
  );
}

function persistCashBuyScenarios(s: CashBuyScenario[]) {
  const userId = _session?.id;
  if (!userId) return Promise.resolve();
  return enqueueWrite("cash_buy_scenarios", async () => {
    if (_session?.id !== userId) return;
    const keep = new Set(s.map(x => x.id));
    const { data: existing, error: selErr } = await supabase
      .from("cash_buy_scenarios")
      .select("id")
      .eq("user_id", userId);
    if (selErr) {
      notifyError({ table: "cash_buy_scenarios", message: selErr.message });
      return;
    }
    const toDelete = (existing ?? []).map(r => r.id).filter(id => !keep.has(id));
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from("cash_buy_scenarios").delete().in("id", toDelete).eq("user_id", userId);
      if (delErr) notifyError({ table: "cash_buy_scenarios", message: delErr.message });
    }
    if (s.length > 0) {
      // Strip-and-retry: protects against older Supabase instances that
      // haven't run the 2026_05_27 / 2026_05_29 migrations. Mirrors the
      // purchase_scenarios pattern.
      const CASH_BUY_OPTIONAL_COLUMNS = [
        "property_type",
        "purchase_price_source",
        "occupancy_type_source",
        "property_type_source",
        "property_taxes_source",
        "homeowners_insurance_source",
        "annual_flood_ins",
        "seller_concessions_source",
        "insurance_premium_annual",
        "insurance_factors",
        "user_answer_sources",
      ] as const;
      const stripped = new Set<string>();
      const buildPayload = () => s.map(x => {
        const row: Record<string, any> = cashBuyToRow(x, userId);
        Array.from(stripped).forEach(col => { delete row[col]; });
        return row;
      });
      let lastErr: string | null = null;
      for (let attempt = 0; attempt <= CASH_BUY_OPTIONAL_COLUMNS.length; attempt++) {
        const payload = buildPayload();
        if (attempt === 0) {
          payload.forEach((p) => {
            console.debug("[cash-buy-user-save] scenario id", p.id);
            console.debug("[cash-buy-user-save] full address", p.full_address);
            console.debug("[cash-buy-user-save] upsert payload keys", Object.keys(p));
          });
        }
        const { error: upErr } = await supabase
          .from("cash_buy_scenarios")
          .upsert(payload, { onConflict: "id" });
        if (!upErr) { lastErr = null; console.debug("[cash-buy-user-save] upsert ok"); break; }
        const missing = extractMissingColumn(upErr.message);
        if (missing && (CASH_BUY_OPTIONAL_COLUMNS as readonly string[]).includes(missing) && !stripped.has(missing)) {
          console.warn(`[cash-buy-user-save] retrying without missing column '${missing}'`);
          const migrationFile = missing === "annual_flood_ins"
            ? "supabase/migrations/2026_06_17_cash_buy_flood_insurance.sql"
            : "supabase/migrations/2026_05_29_cash_buy_user_answers.sql";
          notifyError({
            table: "cash_buy_scenarios",
            message: `Your Supabase cash_buy_scenarios table is missing the '${missing}' column — apply ${migrationFile} so this field can persist.`,
          });
          stripped.add(missing);
          continue;
        }
        lastErr = upErr.message;
        break;
      }
      if (lastErr) {
        console.error("[cash-buy-user-save] upsert error", lastErr);
        notifyError({ table: "cash_buy_scenarios", message: lastErr });
      }
    }
  });
}

// ── Tracked refi loans ────────────────────────────────────────────
export function getTrackedLoans(): TrackedLoan[] {
  return _trackedLoans;
}

export function saveTrackedLoans(loans: TrackedLoan[]): Promise<void> {
  const prev = _trackedLoans;
  // Stamp estimatedHomeValueSource = "manual" on user-driven value diffs.
  loans = _stampManualOnValueDiff(prev, loans,
    l => l.estimatedHomeValue,
    l => ({ ...l, estimatedHomeValueSource: "manual" }));
  _trackedLoans = loans;
  notify();
  _diffAndSyncPropertyValue(prev, loans, "refinance",
    l => l.estimatedHomeValue,
    l => l.propertyAddress);
  autoCreateInsuranceFromAddresses(
    loans.map(l => ({
      sourceType: "refinance" as const,
      sourceScenarioId: l.id,
      address: l.propertyAddress,
      // Seed Insurance-tab annualPremium with 0.75% of estimated home
      // value for newly-created rows (spec: insurance-default-075-percent).
      propertyValue: l.estimatedHomeValue ?? undefined,
      // Phase 2 follow-up: prefer the new dedicated occupancy column
      // (2026_05_27 migration). Falls back to the legacy `propertyType`
      // field, which historically stored occupancy values
      // (primary/secondary/investment) — the name is historical, not
      // the physical type.
      occupancyType: l.occupancyType ?? l.propertyType,
      // Physical structure type (Single Family / Condo / Townhouse /
      // ...) from the dedicated column. Drives Condo/Townhouse → HO6.
      propertyType: l.physicalPropertyType,
    })),
  );
  // Returns the persistence promise — see saveInsuranceScenarios.
  return persistTrackedLoans(loans);
}

// ── Auto-create Insurance from Purchase / Cash-Buy / Refi addresses ──
//
// Ensures every property the user saves in one of the three source
// flows has a matching row in `insurance_scenarios` so the Insurance
// tab shows it automatically. Dedupe + manual-override protection
// live entirely inside `ensureInsuranceForAddresses` (matched by
// address + normalizePropertyKey, never overwrites existing rows).
//
// Gated on an authenticated user — anonymous draft entry should not
// leak into `insurance_scenarios`. The helper is fire-and-forget so
// the calling save path isn't blocked on the insurance write.
function autoCreateInsuranceFromAddresses(
  addresses: BulkAddress[],
): void {
  if (!_session?.id) {
    return;
  }
  if (addresses.length === 0) return;
  const { scenarios, changed } = ensureInsuranceForAddresses(
    addresses,
    _insuranceScenarios,
  );
  if (!changed) return;
  // Use the public saver so the in-memory cache, subscribers, and
  // Supabase write all stay consistent with the manual-add path.
  void saveInsuranceScenarios(scenarios).then(
    () => console.log("[insurance-auto-create] save ok", { count: scenarios.length }),
    (err: any) => {
      console.warn("[insurance-auto-create] save failed", { error: err?.message ?? String(err) });
      console.error("[policy-type-sync] save error", { message: err?.message ?? String(err) });
    },
  );
}

// Columns we know are "optional" on tracked_loans — some Supabase
// instances may not have run the latest migration yet. If PostgREST
// reports any of these as missing, we strip them from every row and
// retry the upsert once so the save still succeeds on older schemas.
const TRACKED_LOAN_OPTIONAL_COLUMNS = [
  "loan_number", "credit_score", "loan_type", "balance_as_of",
  "va_disability",
  "occupancy_type", "physical_property_type",
  "refi_goal", "finance_fees", "include_escrows",
  "cash_out_new_loan_amount", "home_equity_product", "home_equity_borrow_amount",
  "entry_method", "purchase_date", "original_purchase_price", "original_loan_amount",
  "first_payment_date",
  "original_rate", "original_term_months", "amortized_balance_check",
  "balance_confirmed", "free_and_clear",
  "annual_property_tax", "annual_property_tax_source",
  "annual_property_tax_year", "annual_property_tax_queried_at",
  "annual_property_tax_breakdown",
  "current_escrow_balance",
] as const;

export function extractMissingColumn(message: string): string | null {
  // PostgREST: "Could not find the 'foo' column of 'tracked_loans' in the schema cache"
  const m = message.match(/Could not find the '([^']+)' column/i);
  return m ? m[1] : null;
}

function persistTrackedLoans(loans: TrackedLoan[]) {
  const userId = _session?.id;
  if (!userId) return Promise.resolve();
  return enqueueWrite("tracked_loans", async () => {
    if (_session?.id !== userId) return;
    const keep = new Set(loans.map(l => l.id));
    const { data: existing, error: selErr } = await supabase
      .from("tracked_loans")
      .select("id")
      .eq("user_id", userId);
    if (selErr) {
      notifyError({ table: "tracked_loans", message: selErr.message });
      throw new Error(selErr.message); // awaited callers see the failure;
                                       // fire-and-forget callers wrap in .catch().
    }
    const toDelete = (existing ?? []).map(r => r.id).filter(id => !keep.has(id));
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from("tracked_loans").delete().in("id", toDelete).eq("user_id", userId);
      if (delErr) {
        notifyError({ table: "tracked_loans", message: delErr.message });
        throw new Error(delErr.message);
      }
    }
    if (loans.length > 0) {
      const stripped = new Set<string>();
      const buildRows = () => loans.map(l => {
        const row: Record<string, any> = trackedLoanToRow(l, userId);
        for (const col of Array.from(stripped)) delete row[col];
        return row;
      });
      // Try up to 1 + N attempts where N is the number of optional cols
      // — each retry strips one more missing column and retries.
      let lastErr: string | null = null;
      for (let attempt = 0; attempt <= TRACKED_LOAN_OPTIONAL_COLUMNS.length; attempt++) {
        const rows = buildRows();
        const { error: upErr } = await supabase
          .from("tracked_loans")
          .upsert(rows, { onConflict: "id" });
        if (!upErr) {
          lastErr = null;
          break;
        }
        const missing = extractMissingColumn(upErr.message);
        if (missing && (TRACKED_LOAN_OPTIONAL_COLUMNS as readonly string[]).includes(missing) && !stripped.has(missing)) {
          // Older schema — strip the missing optional column and retry.
          // We also notify so the UI can toast: a silent strip means the
          // user thinks their change saved when actually that field never
          // reached Supabase (e.g. `loan_type` → revert to default on read).
          console.warn(`[tracked_loans] retrying without missing column '${missing}'`);
          notifyError({
            table: "tracked_loans",
            message: `Your Supabase tracked_loans table is missing the '${missing}' column — re-apply supabase/schema.sql so this field can persist.`,
          });
          stripped.add(missing);
          continue;
        }
        lastErr = upErr.message;
        break;
      }
      if (lastErr) {
        notifyError({ table: "tracked_loans", message: lastErr });
        throw new Error(lastErr); // awaited callers (handlePropertyTypeSelect, Save button) catch this
      }
    }
  });
}
