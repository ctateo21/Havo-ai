import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { OfficialTaxBreakdown } from "@shared/official-tax";
import { CurrentBillDisclosure } from "./current-bill-disclosure";
import { parseOfficialTaxBreakdown } from "@/lib/official-property-tax";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  ChevronDown, ChevronUp, Trash2, MapPin, TrendingDown, TrendingUp,
  Minus, Clock, DollarSign, AlertCircle, Wallet, ArrowLeftRight,
  Banknote, Pencil, Check, X, Info, Landmark, Home, Building2, Sparkles,
  Loader2, Receipt, Search,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { calculateRefinance, calculateMonthlyPayment, formatCurrency } from "@/lib/refi-calculations";
import {
  buildCurrentTaxLookupPatch,
  buildManualPropertyTaxPatch,
  savedCurrentBillBreakdown,
} from "@/lib/property-tax-refi";
import { priceLoan } from "@/lib/mortgage-pricing";
import { PHYSICAL_PROPERTY_TYPE_OPTIONS } from "@/lib/property-type-options";
import { DtiCheck } from "@/components/refi/dti-check";
import { RefinanceFeeWorksheetDialog } from "@/components/refi/refinance-fee-worksheet-dialog";
import {
  buildRefinanceFeeWorksheet,
  calculateRefinanceVaFundingFee,
  VA_SUBSEQUENT_USE_FUNDING_FEE_RATE,
} from "@/lib/refinance-fee-worksheet";
import { resolveTrackedLoanBalance } from "@/lib/tracked-loan-balance";
import { isCdPurchasePriceLocked } from "@/lib/cd-property-value";

export interface MortgageAnalysis {
  loanBalance: number;
  interestRate: number;
  monthlyPayment: number;
  principalAndInterest: number;
  escrowAmount: number;
  currentEscrowBalance?: number | null;
  propertyAddress: string;
  lender: string;
  estimatedRemainingYears: number;
  estimatedHomeValue: number;
  /** Servicer loan/account number as printed on the statement, or null. */
  loanNumber?: string | null;
  confidence: "high" | "medium" | "low";
  recommendation: string;
  potentialSavings: number;
  rawExtractedData: Record<string, string | number>;
}

export type PropertyType = "primary" | "secondary" | "investment";

export type LoanType = "va" | "fha" | "conventional" | "dscr" | "bank_statement";

export interface TrackedLoan {
  id: string;
  propertyAddress: string;
  lender: string;
  loanBalance: number;
  currentRate: number;
  currentPI: number;
  monthlyPayment: number;
  /** Current balance in the existing servicer escrow account, when
   *  explicitly extracted from a mortgage statement. */
  currentEscrowBalance?: number;
  estimatedHomeValue: number;
  estimatedRemainingYears: number;
  addedAt: string;
  balanceAsOf?: string;
  propertyType: PropertyType;
  /** Phase 2: dedicated occupancy field, mirrored alongside the legacy
   *  `propertyType` field. Stored on `tracked_loans.occupancy_type` via
   *  the 2026_05_27 migration. */
  occupancyType?: PropertyType;
  /** Phase 2: physical structure type ("Single Family Residence",
   *  "Condo", "Townhouse", ...) — separate from occupancy. Stored on
   *  `tracked_loans.physical_property_type` via the 2026_05_27 migration. */
  physicalPropertyType?: string;
  loanType?: LoanType;
  /** VA funding-fee exemption: true = disability/$0 fee; false = 3.3%
   * subsequent-use fee. Undefined means the borrower has not answered yet. */
  vaDisability?: boolean;
  loanNumber?: string;
  /** FICO score used by the shared rate engine. Stored once per
   *  tracked loan; defaults to 740 when missing. The refinance page's
   *  top-level credit-score input writes this on every tracked loan. */
  creditScore?: number;
  /** Refinance UI inputs persisted to tracked_loans so the user's chosen
   *  scenario survives refresh/login. See the matching fields in
   *  lib/auth.ts's TrackedLoan for column mapping. */
  refiGoal?: "rate_term" | "cash_out" | "home_equity";
  financeFees?: boolean;
  includeEscrows?: boolean;
  cashOutNewLoanAmount?: number;
  homeEquityProduct?: HeProduct;
  homeEquityBorrowAmount?: number;
  /** How this loan was entered (statement upload is the legacy default). */
  entryMethod?: "statement" | "closing_disclosure" | "manual" | "free_and_clear";
  /** Origination details (Closing Disclosure / manual entry flows). */
  purchaseDate?: string;
  firstPaymentDate?: string;
  originalPurchasePrice?: number;
  originalLoanAmount?: number;
  originalRate?: number;
  originalTermMonths?: number;
  amortizedBalanceCheck?: number;
  balanceConfirmed?: boolean;
  /** Owned outright — only the 1st-lien cash-out analysis applies. */
  freeAndClear?: boolean;
  /** Current annual property-tax bill for the existing owner (NOT a purchase
   *  estimate). Looked up from the tax-collector or entered manually.
   *  Stored on tracked_loans.annual_property_tax. */
  annualPropertyTax?: number;
  /** Where annualPropertyTax came from. "manual" is never overwritten by
   *  a background lookup. Stored on tracked_loans.annual_property_tax_source. */
  annualPropertyTaxSource?: "manual" | "tax-collector-bill-scrape" | "manatee-arcgis";
  annualPropertyTaxSourceLabel?: string;
  annualPropertyTaxAdValorem?: number;
  annualPropertyTaxNonAdValorem?: number;
  annualPropertyTaxCounty?: string;
  /** Tax year the bill was issued. Stored on
   *  tracked_loans.annual_property_tax_year. */
  annualPropertyTaxYear?: number;
  /** ISO timestamp of last successful lookup. Stored on
   *  tracked_loans.annual_property_tax_queried_at. */
  annualPropertyTaxQueriedAt?: string;
  annualPropertyTaxBreakdown?: OfficialTaxBreakdown | null;
}

export interface LiveRate {
  name: string;
  rate: number;
  change: number;
  type: string;
  lastUpdated: string;
}

export const PROPERTY_TYPE_ADJUSTMENTS: Record<PropertyType, number> = { primary: 0.00, secondary: 0.25, investment: 0.75 };
const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = { primary: "Primary", secondary: "Secondary", investment: "Investment" };
// Color logic per product spec: Primary = blue, Secondary = yellow,
// Investment = green. Used for both the summary badge and the selected
// state of the property-type toggle buttons.
const PROPERTY_TYPE_COLORS: Record<PropertyType, string> = {
  primary:    "bg-blue-600 text-white border-blue-600",
  secondary:  "bg-amber-500 text-white border-amber-500",
  investment: "bg-green-600 text-white border-green-600",
};

// Loan-type options surfaced in the refinance detail. VA + FHA are
// restricted to primary residences (see VA_FHA_PRIMARY_ONLY below).
// DSCR + Bank Statement are selectable but no specialized pricing is
// connected yet — we show a small "Pricing not fully connected yet"
// note when one of those is selected.
const LOAN_TYPE_LABELS: Record<LoanType, string> = {
  va: "VA",
  fha: "FHA",
  conventional: "Conventional",
  dscr: "DSCR",
  bank_statement: "Bank Statement",
};
const LOAN_TYPE_OPTIONS: LoanType[] = ["va", "fha", "conventional", "dscr", "bank_statement"];
const VA_FHA_PRIMARY_ONLY: LoanType[] = ["va", "fha"];
const LOAN_TYPE_NOT_PRICED: LoanType[] = ["va", "fha", "dscr", "bank_statement"];
function isLoanTypeAllowed(lt: LoanType, pt: PropertyType): boolean {
  if (VA_FHA_PRIMARY_ONLY.includes(lt)) return pt === "primary";
  return true;
}

export const CLOSING_COST_PERCENT = 0.60;
export const CLOSING_COST_FIXED = 4065;
export const NEW_TERM_YEARS = 30;
export const HE_RATE_MARGIN = 2.0;
export const HE_MAX_CLTV: Record<PropertyType, number> = { primary: 0.90, secondary: 0.80, investment: 0.80 };
const HELOC_DRAW_YEARS = 10;
const HELOC_REPAY_YEARS = 20;
const HE_LOAN_TERM_YEARS = 15;
const CASH_OUT_MAX_LTV = 0.75;
export const ESCROW_RESERVE_MONTHS = 3;

type HeProduct = "heloc" | "he_loan";

export function getBestConventionalRate(rates: LiveRate[]): LiveRate | null {
  return rates.find(r => r.name === "30 Yr. Fixed") ?? rates.find(r => r.type === "Conventional") ?? rates[0] ?? null;
}

function getRateDelta(currentRate: number, newRate: number) {
  const delta = currentRate - newRate;
  if (delta >= 0.75) return { label: "Good time to refi", color: "text-green-600", bg: "bg-green-50 border-green-200" };
  if (delta >= 0.25) return { label: "Marginal savings", color: "text-amber-600", bg: "bg-amber-50 border-amber-200" };
  return { label: "Rates similar", color: "text-muted-foreground", bg: "bg-muted/40 border-border" };
}

export type BestOption = { type: "rate_term" | "second_lien" | "hold"; label: string; reason: string; badgeClass: string; cardBg: string; Icon: React.ElementType };

export function getBestOption(loan: TrackedLoan, adjustedTodayRate: number, propertyType: PropertyType): BestOption {
  const { loanBalance, estimatedHomeValue: homeValue, currentRate } = loan;
  const rateDelta = currentRate - adjustedTodayRate;
  const maxCltv = HE_MAX_CLTV[propertyType];
  const hasSecondLienEquity = homeValue > 0 && homeValue * maxCltv - loanBalance > 10_000;

  if (rateDelta <= 0) {
    if (hasSecondLienEquity) return { type: "second_lien", label: "2nd Lien Home Equity", reason: `Your ${currentRate.toFixed(3)}% rate is below today's market — protect it and tap equity via a 2nd lien instead`, badgeClass: "bg-yellow-100 text-yellow-800 border-yellow-300", cardBg: "bg-yellow-50 border-yellow-200", Icon: Landmark };
    return { type: "hold", label: "Hold — no action needed", reason: `Your ${currentRate.toFixed(3)}% rate is at or below today's market and equity is limited — wait for conditions to improve`, badgeClass: "bg-muted text-muted-foreground border", cardBg: "bg-muted/40 border-border", Icon: Home };
  }
  if (rateDelta >= 0.75) return { type: "rate_term", label: "Rate & Term Refinance", reason: `${rateDelta.toFixed(3)}% rate drop from ${currentRate.toFixed(3)}% → ${adjustedTodayRate.toFixed(3)}% — strongest savings opportunity right now`, badgeClass: "bg-blue-100 text-blue-800 border-blue-300", cardBg: "bg-blue-50 border-blue-200", Icon: ArrowLeftRight };
  if (hasSecondLienEquity) return { type: "second_lien", label: "2nd Lien Home Equity", reason: `Only a modest ${rateDelta.toFixed(3)}% rate gap — a 2nd lien lets you tap equity while keeping your current rate`, badgeClass: "bg-yellow-100 text-yellow-800 border-yellow-300", cardBg: "bg-yellow-50 border-yellow-200", Icon: Landmark };
  return { type: "rate_term", label: "Rate & Term Refinance", reason: `${rateDelta.toFixed(3)}% rate drop available — only viable option since equity is limited`, badgeClass: "bg-blue-100 text-blue-800 border-blue-300", cardBg: "bg-blue-50 border-blue-200", Icon: ArrowLeftRight };
}

function RateCompare({ current, today }: { current: number; today: number }) {
  const delta = current - today;
  return (
    <div className="flex items-center gap-2 text-sm flex-wrap">
      <span className="font-bold text-base">{current.toFixed(3)}%</span>
      <span className="text-muted-foreground">current</span>
      <span className="text-muted-foreground">→</span>
      <span className={`font-bold text-base ${delta > 0 ? "text-green-600" : "text-muted-foreground"}`}>{today.toFixed(3)}%</span>
      <span className="text-muted-foreground">today</span>
      {delta > 0 ? <span className="flex items-center gap-0.5 text-xs text-green-600 font-medium"><TrendingDown className="h-3 w-3" />{delta.toFixed(3)}% lower</span>
        : delta < 0 ? <span className="flex items-center gap-0.5 text-xs text-red-500 font-medium"><TrendingUp className="h-3 w-3" />{Math.abs(delta).toFixed(3)}% higher</span>
        : <span className="flex items-center gap-0.5 text-xs text-muted-foreground"><Minus className="h-3 w-3" />Same</span>}
    </div>
  );
}

function FeeToggles({ idPrefix, financeFees, setFinanceFees, includeEscrows, setIncludeEscrows, baseClosingCosts, monthlyEscrow }: {
  idPrefix: string;
  financeFees: boolean;
  setFinanceFees: (v: boolean) => void;
  includeEscrows: boolean;
  setIncludeEscrows: (v: boolean) => void;
  baseClosingCosts: number | null;
  monthlyEscrow: number;
}) {
  const safe = idPrefix.replace(/[^a-zA-Z0-9]/g, "");
  const escrowReserve = monthlyEscrow * ESCROW_RESERVE_MONTHS;
  return (
    <div className="rounded-md border bg-muted/20 p-3 flex flex-wrap items-center gap-x-6 gap-y-3" onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        <Switch id={`finance-fees-${safe}`} checked={financeFees} onCheckedChange={setFinanceFees} />
        <Label htmlFor={`finance-fees-${safe}`} className="text-sm cursor-pointer">
          Finance fees in new loan
          {baseClosingCosts !== null && (
            <span className="text-muted-foreground ml-1">({formatCurrency(baseClosingCosts)})</span>
          )}
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id={`include-escrows-${safe}`} checked={includeEscrows} onCheckedChange={setIncludeEscrows} disabled={monthlyEscrow <= 0} />
        <Label htmlFor={`include-escrows-${safe}`} className={`text-sm cursor-pointer ${monthlyEscrow <= 0 ? "opacity-50" : ""}`}>
          Include escrows ({ESCROW_RESERVE_MONTHS}-mo reserve
          {monthlyEscrow > 0 ? ` · ${formatCurrency(escrowReserve)}` : " · n/a"})
        </Label>
      </div>
    </div>
  );
}

/** Small per-loan credit score input; commits on blur / Enter. */
function PerLoanCreditScore({ loan, onUpdate }: { loan: TrackedLoan; onUpdate: (u: Partial<TrackedLoan>) => void }) {
  const [value, setValue] = useState<string>(loan.creditScore && loan.creditScore > 0 ? String(loan.creditScore) : "");
  // Keep in sync if the dashboard-wide input fans out a new score.
  useEffect(() => {
    setValue(loan.creditScore && loan.creditScore > 0 ? String(loan.creditScore) : "");
  }, [loan.creditScore]);
  function commit() {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return;
    const clamped = Math.min(850, Math.max(300, n));
    setValue(String(clamped));
    if (clamped !== loan.creditScore) onUpdate({ creditScore: clamped });
  }
  return (
    <div className="flex items-center gap-3 flex-wrap" data-testid={`per-loan-credit-score-${loan.id}`}>
      <span className="text-sm font-medium text-muted-foreground">Credit Score (this loan):</span>
      <Input
        type="number"
        inputMode="numeric"
        min={300}
        max={850}
        step={1}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-24 h-8"
        data-testid={`input-per-loan-credit-score-${loan.id}`}
        aria-label="Credit score used for this loan's rate estimates"
      />
    </div>
  );
}

function CashOutSection({ loan, newRate, displayRate, homeValue, onChangeHomeValue, financeFees, includeEscrows, monthlyEscrow, onPersistNewLoanAmount, showDtiCheck }: { loan: TrackedLoan; newRate: LiveRate; displayRate: number; homeValue: number; onChangeHomeValue: (v: number) => void; financeFees: boolean; includeEscrows: boolean; monthlyEscrow: number; onPersistNewLoanAmount: (v: number) => void; showDtiCheck?: boolean }) {
  const usesCdPurchasePrice = isCdPurchasePriceLocked(loan);
  const [editing, setEditing] = useState(false);
  const [worksheetOpen, setWorksheetOpen] = useState(false);
  const [editInput, setEditInput] = useState(String(Math.round(homeValue)));

  const escrowAmount = includeEscrows ? monthlyEscrow * ESCROW_RESERVE_MONTHS : 0;
  // Slider cap must keep the *funded* loan under 75% LTV, accounting for whatever fees are being financed.
  const ltvCap = homeValue * CASH_OUT_MAX_LTV;
  const vaFeeRate = loan.loanType === "va" && loan.vaDisability === false
    ? VA_SUBSEQUENT_USE_FUNDING_FEE_RATE
    : 0;
  const maxNewLoan = Math.floor(
    (ltvCap - (financeFees ? CLOSING_COST_FIXED + escrowAmount : 0))
      / (1 + vaFeeRate + (financeFees ? CLOSING_COST_PERCENT / 100 : 0)),
  );
  const currentLTV = homeValue > 0 ? loan.loanBalance / homeValue : 1;
  const isLTVTooHigh = currentLTV >= CASH_OUT_MAX_LTV;
  const [newLoanAmount, setNewLoanAmount] = useState(() =>
    typeof loan.cashOutNewLoanAmount === "number" && loan.cashOutNewLoanAmount > 0
      ? loan.cashOutNewLoanAmount
      : (isLTVTooHigh ? loan.loanBalance : maxNewLoan),
  );
  const clampedLoan = Math.min(Math.max(newLoanAmount, loan.loanBalance), Math.max(maxNewLoan, loan.loanBalance));
  const cashOut = Math.max(0, clampedLoan - loan.loanBalance);
  const closingCosts = (clampedLoan * CLOSING_COST_PERCENT) / 100 + CLOSING_COST_FIXED;
  const totalFees = closingCosts + escrowAmount;
  const vaFundingFee = calculateRefinanceVaFundingFee(
    clampedLoan,
    loan.loanType,
    loan.vaDisability,
  );
  const finalLoanWithCosts = clampedLoan + vaFundingFee + (financeFees ? totalFees : 0);
  const newMonthlyPI = calculateMonthlyPayment(finalLoanWithCosts, displayRate, NEW_TERM_YEARS);
  const newLTV = homeValue > 0 ? (finalLoanWithCosts / homeValue) * 100 : 0;
  const feeWorksheet = buildRefinanceFeeWorksheet({
    currentPayoff: loan.loanBalance,
    baseNewLoanAmount: clampedLoan,
    finalNewLoanAmount: finalLoanWithCosts,
    ratePct: displayRate,
    monthlyPI: newMonthlyPI,
    monthlyEscrow,
    escrowReserve: escrowAmount,
    financeFees,
    entryMethod: loan.entryMethod,
    currentEscrowBalance: loan.currentEscrowBalance,
    homeValue,
    annualPropertyTax: loan.annualPropertyTax,
    loanType: loan.loanType,
    vaDisability: loan.vaDisability,
    vaFundingFee,
    creditScore: loan.creditScore,
  });

  function commitEdit() {
    const parsed = parseFloat(editInput.replace(/[^0-9.]/g, ""));
    if (!isNaN(parsed) && parsed > 0) { onChangeHomeValue(parsed); }
    setEditing(false);
  }

  if (isLTVTooHigh) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold text-sm text-red-700">1st lien cash-out refinance is not possible due to LTV limits</p>
          <p className="text-sm text-red-600">Your current LTV is <strong>{(currentLTV * 100).toFixed(1)}%</strong>, which exceeds the 75% maximum.</p>
          <div className="flex items-start gap-1 mt-2 text-xs text-red-500">
            <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
            <span>
              Home value used: {formatCurrency(homeValue)} (
              {usesCdPurchasePrice ? "CD sale price — assumed appraised value" : "estimated value"}).{" "}
              <button className="underline" onClick={() => setEditing(true)}>Edit value</button>
            </span>
          </div>
          {editing && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-sm text-red-700">$</span>
              <input type="text" className="border rounded px-2 py-1 text-sm w-36 bg-background" value={editInput} onChange={e => setEditInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }} autoFocus />
              <Button size="sm" variant="ghost" onClick={commitEdit} className="h-7 px-2"><Check className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="h-7 px-2"><X className="h-3 w-3" /></Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 rounded-md border bg-muted/30 flex-wrap gap-2">
        <div className="space-y-0.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {usesCdPurchasePrice ? "Assumed Appraised Value" : "Est. Home Value"}
          </p>
          {editing ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">$</span>
              <input type="text" className="border rounded px-2 py-1 text-sm w-36 bg-background" value={editInput} onChange={e => setEditInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }} autoFocus />
              <Button size="sm" variant="ghost" onClick={commitEdit} className="h-7 px-2"><Check className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="h-7 px-2"><X className="h-3 w-3" /></Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg">{formatCurrency(homeValue)}</span>
              <button onClick={() => { setEditInput(String(Math.round(homeValue))); setEditing(true); }} className="text-muted-foreground hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
            </div>
          )}
          <p className="text-xs text-amber-600">
            {usesCdPurchasePrice
              ? "CD sale price — edit only if the appraised value differs"
              : "Estimated value — edit to use your actual value"}
          </p>
        </div>
        <div className="text-right space-y-0.5">
          <p className="text-xs text-muted-foreground">Current LTV</p>
          <p className="font-bold text-lg">{(currentLTV * 100).toFixed(1)}%</p>
          <p className="text-xs text-muted-foreground">75% max for cash-out</p>
        </div>
      </div>

      <div className="space-y-3 p-3 rounded-md border bg-background">
        <div className="flex items-baseline justify-between flex-wrap gap-1">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">New Loan Amount</p>
            <p className="font-bold text-2xl">{formatCurrency(finalLoanWithCosts)}</p>
          </div>
          <div className="text-right space-y-1">
            <div>
              <p className="text-xs text-muted-foreground">
                {feeWorksheet.estimatedCashToBorrower > 0 ? "Est. net cash to you" : "Est. cash due at closing"}
              </p>
              <p className={`font-bold text-xl ${feeWorksheet.estimatedCashToBorrower > 0 ? "text-green-600" : "text-amber-700"}`}>
                {formatCurrency(feeWorksheet.estimatedCashToBorrower > 0
                  ? feeWorksheet.estimatedCashToBorrower
                  : feeWorksheet.estimatedCashDueAtClosing)}
              </p>
              <p className="text-[10px] text-muted-foreground">{formatCurrency(cashOut)} gross before charges</p>
            </div>
            <div><p className="text-xs text-muted-foreground">Combined LTV</p><p className={`font-semibold text-sm ${newLTV > CASH_OUT_MAX_LTV * 100 ? "text-red-500" : ""}`}>{newLTV.toFixed(1)}%</p></div>
          </div>
        </div>
        <Slider min={loan.loanBalance} max={maxNewLoan} step={1000} value={[clampedLoan]} onValueChange={([val]) => setNewLoanAmount(val)} onValueCommit={([val]) => onPersistNewLoanAmount(val)} />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current Loan</p>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">Monthly P&I</span><span className="font-semibold">{formatCurrency(loan.currentPI)}</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">Loan Balance</span><span className="font-semibold">{formatCurrency(loan.loanBalance)}</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">LTV</span><span className="font-semibold">{(currentLTV * 100).toFixed(1)}%</span></div>
        </div>
        <div className="rounded-lg border bg-green-50 border-green-200 p-4 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">After Cash-Out</p>
            <Badge variant="outline" className="text-xs">{newRate.name} · {newRate.type}</Badge>
          </div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">New Rate</span><span className="font-bold text-lg">{displayRate.toFixed(3)}%</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">New Monthly P&I</span><span className="font-semibold">{formatCurrency(newMonthlyPI)}</span></div>
          {feeWorksheet.monthlyHousingExpense.mortgageInsurance !== null
            && feeWorksheet.monthlyHousingExpense.mortgageInsurance > 0 && (
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Est. Monthly PMI</span><span className="font-semibold text-amber-700">{formatCurrency(feeWorksheet.monthlyHousingExpense.mortgageInsurance)}</span></div>
          )}
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">Funded LTV</span><span className="font-semibold">{feeWorksheet.fundedLtvPct?.toFixed(2) ?? "—"}%</span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">New Loan Amount</span><span className="font-semibold">{formatCurrency(finalLoanWithCosts)} <span className="text-xs text-muted-foreground">{financeFees ? "(incl. fees)" : "(fees paid at close)"}</span></span></div>
          <div className="flex justify-between"><span className="text-sm text-muted-foreground">Est. Closing Costs</span><span className="font-semibold">{formatCurrency(closingCosts)}</span></div>
          {loan.loanType === "va" && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">VA Funding Fee</span>
              <span className="font-semibold">
                {loan.vaDisability === undefined ? "Answer required" : formatCurrency(vaFundingFee)}
              </span>
            </div>
          )}
          {includeEscrows && escrowAmount > 0 && (
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Escrow Reserve ({ESCROW_RESERVE_MONTHS} mo)</span><span className="font-semibold">{formatCurrency(escrowAmount)}</span></div>
          )}
        </div>
      </div>
      {loan.loanType === "conventional" && feeWorksheet.cashNeededFor80Ltv > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <strong>Funded LTV is {feeWorksheet.fundedLtvPct?.toFixed(2)}%.</strong>{" "}
          Estimated PMI is {formatCurrency(feeWorksheet.monthlyHousingExpense.mortgageInsurance ?? 0)}/month.
          Pay at least <strong>{formatCurrency(feeWorksheet.cashNeededFor80Ltv)}</strong> at closing toward costs,
          escrows, or principal to keep the funded loan at or below 80% LTV.
        </div>
      )}

      <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setWorksheetOpen(true)}>
        <Receipt className="mr-2 h-4 w-4" />
        View Initial Fees Worksheet
      </Button>
      <RefinanceFeeWorksheetDialog
        open={worksheetOpen}
        onOpenChange={setWorksheetOpen}
        worksheet={feeWorksheet}
        meta={{
          address: loan.propertyAddress,
          purpose: "Cash-Out Refinance",
          currentPayoff: loan.loanBalance,
          baseNewLoanAmount: clampedLoan,
          finalNewLoanAmount: finalLoanWithCosts,
          ratePct: displayRate,
          monthlyPI: newMonthlyPI,
          financeFees,
        }}
      />

      {showDtiCheck && (
        <DtiCheck
          housingPayment={
            feeWorksheet.monthlyHousingExpense.totalPiti
              ?? feeWorksheet.monthlyHousingExpense.knownPaymentSubtotal
          }
          paymentLabel={
            feeWorksheet.monthlyHousingExpense.totalPiti === null
              ? "known new housing payment before program charges"
              : "new mortgage PITI"
          }
        />
      )}
    </div>
  );
}

// ── Property-Tax lookup state (per-loan, keyed by loan.id) ───────────
type TaxLookupStatus = "idle" | "pending" | "ready" | "unavailable" | "error";
interface TaxLookupState {
  status: TaxLookupStatus;
  pendingMessage?: string;
  unavailableReason?: string;
  errorMessage?: string;
  breakdown?: OfficialTaxBreakdown;
}

const AUTO_TAX_REFRESH_MS = 180 * 24 * 60 * 60 * 1000;
const AUTO_TAX_PENDING_RETRIES = 3;
const taxLookupRequests = new Map<string, Promise<{ ok: boolean; data: any }>>();

function requestCurrentPropertyTaxBill(address: string) {
  const key = address.trim().toLowerCase();
  const existing = taxLookupRequests.get(key);
  if (existing) return existing;
  const request = fetch("/api/refinance/property-tax/current", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ address }),
  }).then(async res => ({
    ok: res.ok,
    data: await res.json(),
  })).finally(() => {
    if (taxLookupRequests.get(key) === request) taxLookupRequests.delete(key);
  });
  taxLookupRequests.set(key, request);
  return request;
}

function useAutomaticPropertyTaxLookup(
  loan: TrackedLoan,
  onUpdate: (u: Partial<TrackedLoan>) => void,
  sourceRef: MutableRefObject<TrackedLoan["annualPropertyTaxSource"]>,
  generationRef: MutableRefObject<number>,
) {
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const address = loan.propertyAddress?.trim();
    if (!address || address === "Unknown address") return;
    // A user's manual value is an explicit lock and is never overwritten.
    if (loan.annualPropertyTaxSource === "manual") return;

    const queriedAtMs = loan.annualPropertyTaxQueriedAt
      ? Date.parse(loan.annualPropertyTaxQueriedAt)
      : Number.NaN;
    const hasRecentAuthoritativeBill = typeof loan.annualPropertyTax === "number"
      && Number.isFinite(queriedAtMs)
      && Date.now() - queriedAtMs < AUTO_TAX_REFRESH_MS;
    if (hasRecentAuthoritativeBill) return;

    const generation = ++generationRef.current;

    async function lookup(attempt: number) {
      try {
        const { ok, data } = await requestCurrentPropertyTaxBill(address);
        if (generationRef.current !== generation || !ok) return;
        if (data.state === "ready") {
          const patch = buildCurrentTaxLookupPatch(data);
          if (patch && sourceRef.current !== "manual") onUpdate(patch);
          return;
        }
        if (data.state === "pending" && attempt < AUTO_TAX_PENDING_RETRIES) {
          retryTimerRef.current = setTimeout(
            () => void lookup(attempt + 1),
            4_000,
          );
        }
      } catch {
        // The visible section keeps manual entry and an explicit retry button
        // available when an automatic lookup cannot complete.
      }
    }

    void lookup(0);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
    // onUpdate is intentionally omitted because parent renders create a new
    // callback; lookup identity is the loan/address and persisted tax state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loan.id,
    loan.propertyAddress,
    loan.annualPropertyTax,
    loan.annualPropertyTaxSource,
    loan.annualPropertyTaxQueriedAt,
  ]);

  return {
    invalidate() {
      generationRef.current += 1;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    },
  };
}

/** Section shown on every LoanCard with the current owner's property-tax bill.
 *  Clearly labeled as the EXISTING OWNER's bill (not a purchase estimate).
 *  Supports lookup via POST /api/refinance/property-tax/current and manual entry. */
function PropertyTaxSection({
  loan,
  onUpdate,
  onManualTaxCommit,
  onCollectorLookupStart,
  lookupGenerationRef,
  currentAddressRef,
}: {
  loan: TrackedLoan;
  onUpdate: (u: Partial<TrackedLoan>) => void;
  onManualTaxCommit: () => void;
  onCollectorLookupStart: () => void;
  lookupGenerationRef: MutableRefObject<number>;
  currentAddressRef: MutableRefObject<string>;
}) {
  const [lookupState, setLookupState] = useState<TaxLookupState>({ status: "idle" });
  const [manualInput, setManualInput] = useState<string>("");
  const [showManual, setShowManual] = useState(false);

  // Pre-populate manual input when the loan already has a manual value.
  useEffect(() => {
    if (loan.annualPropertyTax !== undefined && loan.annualPropertyTaxSource === "manual") {
      setManualInput(String(loan.annualPropertyTax));
    }
  }, [loan.id, loan.annualPropertyTax, loan.annualPropertyTaxSource]);

  async function handleLookup() {
    if (!loan.propertyAddress || loan.propertyAddress === "Unknown address") return;
    const requestedAddress = loan.propertyAddress.trim();
    onCollectorLookupStart();
    const requestGeneration = lookupGenerationRef.current;
    setLookupState({ status: "pending", pendingMessage: "Contacting tax collector…" });
    try {
      const { ok, data } = await requestCurrentPropertyTaxBill(requestedAddress);
      if (
        lookupGenerationRef.current !== requestGeneration
        || currentAddressRef.current.trim() !== requestedAddress
      ) return;
      if (!ok) {
        setLookupState({ status: "error", errorMessage: data?.error || "Unexpected error from tax lookup." });
        return;
      }
      if (data.state === "ready") {
        const patch = buildCurrentTaxLookupPatch(data);
        if (!patch) {
          setLookupState({ status: "error", errorMessage: "Tax lookup returned an invalid amount." });
          return;
        }
        onUpdate(patch);
        setLookupState({ status: "ready" });
      } else if (data.state === "pending") {
        setLookupState({
          status: "pending",
          pendingMessage: data.county
            ? `Looking up ${data.county} county tax records — this may take a moment. Try again shortly.`
            : "Tax lookup is in progress. Try again in a few seconds.",
        });
      } else if (data.state === "unavailable") {
        setLookupState({
          status: "unavailable",
          breakdown: parseOfficialTaxBreakdown(data.breakdown),
          unavailableReason:
            data.operationalError ||
            data.reason ||
            "Automatic lookup is not available for this address.",
        });
        setShowManual(true);
      } else {
        setLookupState({ status: "error", errorMessage: "Unexpected response from tax lookup." });
      }
    } catch (e: any) {
      setLookupState({ status: "error", errorMessage: e?.message || "Network error — check your connection and try again." });
    }
  }

  function commitManual() {
    const n = parseFloat(manualInput.replace(/[^0-9.]/g, ""));
    const patch = buildManualPropertyTaxPatch(n);
    if (!patch) return;
    onManualTaxCommit();
    onUpdate(patch);
    setShowManual(false);
    setLookupState({ status: "idle" });
  }

  const hasTax = typeof loan.annualPropertyTax === "number";
  const monthly = hasTax ? loan.annualPropertyTax! / 12 : null;
  const sourceLabel: Record<NonNullable<TrackedLoan["annualPropertyTaxSource"]>, string> = {
    "manual": "Entered manually",
    "tax-collector-bill-scrape": "Tax collector",
    "manatee-arcgis": "Manatee Property Appraiser",
  };

  return (
    <div
      className="rounded-md border bg-muted/20 p-3 space-y-2"
      data-testid={`property-tax-section-${loan.id}`}
      role="region"
      aria-label="Current owner's annual property-tax bill"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <Receipt className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">Current Owner's Annual Property Tax</span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Lookup button — always available unless a lookup is in flight */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={handleLookup}
            disabled={
              lookupState.status === "pending" ||
              !loan.propertyAddress ||
              loan.propertyAddress === "Unknown address"
            }
            data-testid={`btn-property-tax-lookup-${loan.id}`}
            aria-label="Look up current property tax bill from the tax collector"
          >
            {lookupState.status === "pending"
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Search className="h-3 w-3" />}
            Look up current bill
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => setShowManual(v => !v)}
            data-testid={`btn-property-tax-manual-${loan.id}`}
            aria-label="Enter property tax bill manually"
          >
            <Pencil className="h-3 w-3" />
            {showManual ? "Cancel" : hasTax && loan.annualPropertyTaxSource === "manual" ? "Edit" : "Enter manually"}
          </Button>
        </div>
      </div>

      {/* Display: current bill details */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Annual bill</p>
          <p className="font-semibold" data-testid={`property-tax-annual-${loan.id}`}>
            {hasTax ? formatCurrency(loan.annualPropertyTax!) : <span className="text-muted-foreground italic">Not provided</span>}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Monthly equivalent</p>
          <p className="font-semibold" data-testid={`property-tax-monthly-${loan.id}`}>
            {monthly !== null ? formatCurrency(monthly) : <span className="text-muted-foreground italic">—</span>}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Source / Year</p>
          <p className="text-xs" data-testid={`property-tax-source-${loan.id}`}>
            {hasTax ? (
              <>
                {loan.annualPropertyTaxSource === "manual" ? "Entered manually" : loan.annualPropertyTaxSourceLabel
                  ? loan.annualPropertyTaxSourceLabel
                  : `${loan.annualPropertyTaxSource ? sourceLabel[loan.annualPropertyTaxSource] : "Unknown"}${loan.annualPropertyTaxYear ? ` · ${loan.annualPropertyTaxYear}` : ""}`}
              </>
            ) : (
              <span className="text-muted-foreground italic">—</span>
            )}
          </p>
        </div>
      </div>

      {loan.annualPropertyTaxSource !== "manual" && typeof loan.annualPropertyTaxAdValorem === "number" &&
        typeof loan.annualPropertyTaxNonAdValorem === "number" && (
        <p className="text-xs text-muted-foreground" data-testid={`property-tax-breakdown-${loan.id}`}>
          Ad valorem {formatCurrency(loan.annualPropertyTaxAdValorem)}
          {" + non-ad valorem / CDD "}
          {formatCurrency(loan.annualPropertyTaxNonAdValorem)}
          {loan.annualPropertyTaxCounty ? ` · ${loan.annualPropertyTaxCounty} Tax Collector` : ""}
        </p>
      )}

      {hasTax && <CurrentBillDisclosure
        manual={loan.annualPropertyTaxSource === "manual"}
        breakdown={savedCurrentBillBreakdown(loan.annualPropertyTaxBreakdown, loan.annualPropertyTaxSource, loan.annualPropertyTax)}
      />}
      {lookupState.status === "unavailable" && lookupState.breakdown && (
        <CurrentBillDisclosure breakdown={lookupState.breakdown} partial />
      )}

      {/* Clarifying note — always visible */}
      <p className="text-xs text-muted-foreground flex items-start gap-1">
        <Info className="h-3 w-3 shrink-0 mt-0.5" />
        This is the <strong>current owner's actual total tax bill</strong>, not a purchase estimate. Its monthly equivalent is included in the proposed refinance housing payment.
      </p>

      {/* Pending feedback */}
      {lookupState.status === "pending" && lookupState.pendingMessage && (
        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 mt-0.5" />
          <span>{lookupState.pendingMessage}</span>
        </div>
      )}

      {/* Unavailable feedback */}
      {lookupState.status === "unavailable" && lookupState.unavailableReason && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            Automatic lookup not available: {lookupState.unavailableReason} Please enter your annual bill manually.
          </span>
        </div>
      )}

      {/* Error feedback */}
      {lookupState.status === "error" && lookupState.errorMessage && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{lookupState.errorMessage}</span>
        </div>
      )}

      {/* Manual entry form */}
      {showManual && (
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <Label htmlFor={`manual-tax-${loan.id}`} className="text-xs whitespace-nowrap">Annual bill ($)</Label>
          <Input
            id={`manual-tax-${loan.id}`}
            data-testid={`input-property-tax-manual-${loan.id}`}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="e.g. 4800"
            value={manualInput}
            onChange={e => setManualInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commitManual(); if (e.key === "Escape") setShowManual(false); }}
            className="w-32 h-7 text-sm"
            aria-label="Annual property tax bill in dollars"
          />
          <Button
            size="sm"
            className="h-7 px-2 gap-1 text-xs"
            onClick={commitManual}
            data-testid={`btn-property-tax-save-manual-${loan.id}`}
          >
            <Check className="h-3 w-3" />Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => setShowManual(false)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

function LoanCard({ loan, liveRates, onRemove, onUpdate, allowPerLoanCreditScore, showDtiCheck }: { loan: TrackedLoan; liveRates: LiveRate[]; onRemove: () => void; onUpdate: (u: Partial<TrackedLoan>) => void; allowPerLoanCreditScore?: boolean; showDtiCheck?: boolean }) {
  const taxSourceRef = useRef(loan.annualPropertyTaxSource);
  const taxAddressRef = useRef(loan.propertyAddress);
  const taxLookupGenerationRef = useRef(0);
  taxSourceRef.current = loan.annualPropertyTaxSource;
  taxAddressRef.current = loan.propertyAddress;
  const automaticTaxLookup = useAutomaticPropertyTaxLookup(
    loan,
    onUpdate,
    taxSourceRef,
    taxLookupGenerationRef,
  );
  const [expanded, setExpanded] = useState(false);
  // Free & clear properties have no lien — the only analysis that
  // applies is a 1st-lien cash-out, so that's the only tab we render.
  const isFreeClear = !!loan.freeAndClear;
  const [activeTab, setActiveTab] = useState<"rate_term" | "cash_out" | "home_equity">(
    isFreeClear ? "cash_out" : (loan.refiGoal ?? "rate_term"),
  );
  const [homeValue, setHomeValue] = useState(loan.estimatedHomeValue);
  // Persist user-edited estimated home value back to the TrackedLoan
  // (and downstream: tracked_loans table + matching seller scenario).
  // Previously the pencil edit only updated local state, which is why
  // the user could see "$386K" in the UI while seller_scenarios still
  // held the older Zillow value.
  useEffect(() => {
    if (homeValue !== loan.estimatedHomeValue && homeValue > 0) {
      onUpdate({ estimatedHomeValue: homeValue });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeValue]);
  const [propertyType, setPropertyType] = useState<PropertyType>(loan.propertyType);
  const [loanType, setLoanType] = useState<LoanType>(loan.loanType ?? "conventional");
  const monthlyEscrow = Math.max(0, loan.monthlyPayment - loan.currentPI);
  const hasExistingEscrow = monthlyEscrow > 0;
  // ── Hydration sync ─────────────────────────────────────────────
  // On a hard refresh of /refinance, the parent (Refinance) initially
  // renders with `getTrackedLoans()` returning [] (auth/cache hasn't
  // hydrated yet). When hydration completes, the parent re-renders
  // with the persisted rows — under the same loan id, so this card
  // doesn't remount and `useState` initializers DO NOT re-run.
  // Without this sync, local `loanType`/`propertyType` stays
  // "conventional"/initial, then the next user edit (or any other
  // re-render that bubbles through onUpdate) would write the stale
  // local value back to tracked_loans, clobbering the persisted one.
  // The deps key on the prop value, so syncing to the same value is a
  // no-op — we only setState when the prop genuinely differs.
  useEffect(() => {
    const incoming = loan.loanType ?? "conventional";
    if (incoming !== loanType) {
      setLoanType(incoming);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.loanType]);
  useEffect(() => {
    if (loan.propertyType !== propertyType) setPropertyType(loan.propertyType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.propertyType]);
  const [financeFees, setFinanceFees] = useState(loan.financeFees ?? true);
  const [includeEscrows, setIncludeEscrows] = useState(
    loan.includeEscrows ?? hasExistingEscrow,
  );
  const [rateTermWorksheetOpen, setRateTermWorksheetOpen] = useState(false);
  // Hydration sync (same rationale as loanType/propertyType above): the
  // card doesn't remount when persisted rows arrive after async hydration,
  // so mirror the persisted refi inputs into local state when the prop
  // genuinely differs. Keyed on the prop so syncing the same value is a
  // no-op and never clobbers a fresh user edit.
  useEffect(() => {
    const incoming = isFreeClear ? "cash_out" : (loan.refiGoal ?? "rate_term");
    if (incoming !== activeTab) setActiveTab(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.refiGoal, isFreeClear]);
  useEffect(() => {
    const incoming = loan.financeFees ?? true;
    if (incoming !== financeFees) setFinanceFees(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.financeFees]);
  useEffect(() => {
    const incoming = loan.includeEscrows ?? hasExistingEscrow;
    if (incoming !== includeEscrows) setIncludeEscrows(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.includeEscrows, hasExistingEscrow]);
  // Persist first-use defaults so they survive refresh/logout/login. Existing
  // true or false values are explicit user choices and are never overwritten.
  useEffect(() => {
    const defaults: Partial<TrackedLoan> = {};
    if (loan.financeFees === undefined) defaults.financeFees = true;
    if (loan.includeEscrows === undefined) {
      defaults.includeEscrows = hasExistingEscrow;
    }
    if (Object.keys(defaults).length > 0) onUpdate(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.id, loan.financeFees, loan.includeEscrows, hasExistingEscrow]);
  function handleTabChange(tab: "rate_term" | "cash_out" | "home_equity") {
    setActiveTab(tab);
    onUpdate({ refiGoal: tab });
  }
  function handleFinanceFeesChange(v: boolean) {
    setFinanceFees(v);
    onUpdate({ financeFees: v });
  }
  function handleIncludeEscrowsChange(v: boolean) {
    setIncludeEscrows(v);
    onUpdate({ includeEscrows: v });
  }

  // When the user switches property use away from primary, VA / FHA are
  // no longer allowed — fall back to conventional and toast the rule.
  // The persisted update flows through onUpdate so refresh/logout/login
  // round-trips the corrected loan type.
  function handlePropertyTypeChange(pt: PropertyType) {
    setPropertyType(pt);
    // Phase 2: mirror occupancy into the dedicated column alongside the
    // legacy `propertyType` field so the Insurance auto-default rule
    // can read a clean occupancy value (DP3 for Investment, etc.).
    const updates: Partial<TrackedLoan> = { propertyType: pt, occupancyType: pt };
    if (pt !== "primary" && VA_FHA_PRIMARY_ONLY.includes(loanType)) {
      setLoanType("conventional");
      updates.loanType = "conventional";
    }
    onUpdate(updates);
  }

  // Phase 2: Physical Property Type — separate from occupancy. Drives
  // Condo/Townhouse → HO6 in the Insurance auto-default rule. Stored
  // on tracked_loans.physical_property_type via the 2026_05_27
  // migration. Defaults to "Single Family Residence" for new/legacy
  // rows; survives refresh/login because we hydrate from the loan prop.
  const [physicalPropertyType, setPhysicalPropertyTypeLocal] = useState<string>(
    loan.physicalPropertyType ?? "Single Family Residence",
  );
  useEffect(() => {
    const incoming = loan.physicalPropertyType ?? "Single Family Residence";
    if (incoming !== physicalPropertyType) setPhysicalPropertyTypeLocal(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.physicalPropertyType]);
  function handlePhysicalPropertyTypeChange(v: string) {
    setPhysicalPropertyTypeLocal(v);
    onUpdate({ physicalPropertyType: v });
  }
  function handleLoanTypeChange(lt: LoanType) {
    if (!isLoanTypeAllowed(lt, propertyType)) return;
    setLoanType(lt);
    onUpdate({ loanType: lt });
  }
  function handleVaDisabilityChange(value: boolean) {
    onUpdate({ vaDisability: value });
  }

  // Pricing now goes through the shared engine in lib/mortgage-pricing.ts
  // so Purchase and Refinance use the same tier formula. Credit score,
  // loan type, and occupancy are the live inputs; property value /
  // balance / LTV / term are passed downstream into calculateRefinance
  // unchanged.
  const pricing = priceLoan({
    loanType,
    creditScore: loan.creditScore,
    propertyType,
    liveRates,
    // Spec: pass the new refinance loan amount. `clampedLoan` lives in
    // CashOutSection's scope, so use the persisted cash-out amount when
    // on the cash-out tab; otherwise mirror CashOutSection's default
    // slider position (max LTV loan). This matters for free & clear
    // rows whose balance is 0 — pricing from 0 would skip the small-
    // loan adjustment and misprice the quote.
    loanAmount: ((): number => {
      if (activeTab !== "cash_out") return loan.loanBalance;
      if (typeof loan.cashOutNewLoanAmount === "number" && loan.cashOutNewLoanAmount > 0) {
        return loan.cashOutNewLoanAmount;
      }
      // Default slider position in CashOutSection (see maxNewLoan there).
      const escrow = includeEscrows
        ? Math.max(0, loan.monthlyPayment - loan.currentPI) * ESCROW_RESERVE_MONTHS
        : 0;
      const ltvCap = homeValue * CASH_OUT_MAX_LTV;
      const maxNewLoan = financeFees
        ? Math.floor((ltvCap - CLOSING_COST_FIXED - escrow) / (1 + CLOSING_COST_PERCENT / 100))
        : Math.floor(ltvCap);
      const ltvTooHigh = homeValue > 0 ? loan.loanBalance / homeValue >= CASH_OUT_MAX_LTV : true;
      return ltvTooHigh ? loan.loanBalance : Math.max(maxNewLoan, loan.loanBalance);
    })(),
  });
  const adjustedRate = pricing.rate;
  const rateAdj = pricing.occupancyAdj;
  const heRate = adjustedRate + HE_RATE_MARGIN;
  // Cash-out tab still wants a LiveRate-shaped object for its display
  // (it shows the source row from the live feed). Fall back to a
  // synthesized row built from the shared engine output so the section
  // renders even when the feed has nothing matching.
  const bestRate: LiveRate = getBestConventionalRate(liveRates) ?? {
    name: "Estimated",
    rate: adjustedRate,
    change: 0,
    type: "Conventional",
    lastUpdated: new Date().toISOString(),
  };

  const {
    currentBalance,
    elapsedPayments: liveMonths,
  } = resolveTrackedLoanBalance(loan);

  const escrowAmount = includeEscrows ? monthlyEscrow * ESCROW_RESERVE_MONTHS : 0;

  const delta = getRateDelta(loan.currentRate, adjustedRate);
  const bestOption = getBestOption({ ...loan, loanBalance: currentBalance, estimatedHomeValue: homeValue }, adjustedRate, propertyType);

  const rateTerm = calculateRefinance({
    appraisedValue: homeValue,
    loanBalance: currentBalance,
    currentInterestRate: loan.currentRate,
    newInterestRate: adjustedRate,
    currentTermRemainingYears: Math.max(1, Math.round(loan.estimatedRemainingYears)),
    newLoanTermYears: NEW_TERM_YEARS,
    closingCostsPercent: CLOSING_COST_PERCENT,
    closingCostsFixed: CLOSING_COST_FIXED,
    includeClosingCostsInLoan: financeFees,
    refinanceType: "rate_and_term",
  });
  const rateTermBaseClosingCosts = (currentBalance * CLOSING_COST_PERCENT) / 100 + CLOSING_COST_FIXED;
  const rateTermVaFundingFee = calculateRefinanceVaFundingFee(
    currentBalance,
    loanType,
    loan.vaDisability,
  );
  // Re-derive numbers when escrow is rolled in (calculateRefinance doesn't know about escrows)
  const rateTermNewLoanAmount = currentBalance
    + rateTermVaFundingFee
    + (financeFees ? rateTermBaseClosingCosts + escrowAmount : 0);
  const rateTermNewMonthlyPI = calculateMonthlyPayment(rateTermNewLoanAmount, adjustedRate, NEW_TERM_YEARS);
  const rateTermMonthlySavings = rateTerm.monthlyPaymentCurrent - rateTermNewMonthlyPI;
  const rateTermTotalFees = rateTermBaseClosingCosts + escrowAmount + rateTermVaFundingFee;
  const rateTermBreakEven = rateTermMonthlySavings > 0 ? Math.ceil(rateTermTotalFees / rateTermMonthlySavings) : 0;
  // Lifetime net: calculateRefinance already accounts for the financeFees toggle on closing costs.
  // Escrow reserve is an additional out-of-pocket (or financed-principal) cost not modeled there, so subtract it.
  const rateTermLifetimeNet = rateTerm.totalSavings - escrowAmount - rateTermVaFundingFee;
  const rateTermFeeWorksheet = buildRefinanceFeeWorksheet({
    currentPayoff: currentBalance,
    baseNewLoanAmount: currentBalance,
    finalNewLoanAmount: rateTermNewLoanAmount,
    ratePct: adjustedRate,
    monthlyPI: rateTermNewMonthlyPI,
    monthlyEscrow,
    escrowReserve: escrowAmount,
    financeFees,
    entryMethod: loan.entryMethod,
    currentEscrowBalance: loan.currentEscrowBalance,
    homeValue,
    annualPropertyTax: loan.annualPropertyTax,
    loanType,
    vaDisability: loan.vaDisability,
    vaFundingFee: rateTermVaFundingFee,
    creditScore: loan.creditScore,
  });
  const vaAnswerRequired = loanType === "va" && loan.vaDisability === undefined;

  return (
    <Card className="overflow-hidden">
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-base truncate flex items-center gap-1.5"><MapPin className="h-4 w-4 text-primary shrink-0" />{loan.propertyAddress}</p>
              <Badge variant="outline" className={`text-xs shrink-0 ${PROPERTY_TYPE_COLORS[propertyType]}`}>{PROPERTY_TYPE_LABELS[propertyType]}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{isFreeClear ? "Owned free & clear" : loan.lender} · Added {new Date(loan.addedAt).toLocaleDateString()}</p>
            {!isFreeClear && (
              <p className="text-xs text-muted-foreground" data-testid="text-loan-number">
                Loan Number: <span className="font-mono">{loan.loanNumber?.trim() || "—"}</span>
              </p>
            )}
            {!isFreeClear && <RateCompare current={loan.currentRate} today={adjustedRate} />}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {isFreeClear
              ? <div className="px-3 py-1.5 rounded-md border text-xs font-semibold bg-green-50 border-green-200 text-green-700">Free &amp; Clear</div>
              : <div className={`px-3 py-1.5 rounded-md border text-xs font-semibold ${delta.bg} ${delta.color}`}>{delta.label}</div>}
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-red-600" onClick={e => { e.stopPropagation(); onRemove(); }}>
              <Trash2 className="h-4 w-4" />
            </Button>
            {expanded ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
          </div>
        </div>

        {vaAnswerRequired ? (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900">
            VA disability answer required before calculating the proposed funded loan, P&amp;I, cash-out, or savings.
          </div>
        ) : isFreeClear ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t">
            <div><p className="text-xs text-muted-foreground">Home Value</p><p className="font-bold">{formatCurrency(homeValue)}</p></div>
            <div><p className="text-xs text-muted-foreground">Liens</p><p className="font-bold">None</p></div>
            <div><p className="text-xs text-muted-foreground">Max Cash-Out ({Math.round(CASH_OUT_MAX_LTV * 100)}% LTV)</p><p className="font-bold text-green-600">{formatCurrency(Math.max(0, homeValue * CASH_OUT_MAX_LTV))}</p></div>
            <div><p className="text-xs text-muted-foreground">Today's Rate (est.)</p><p className="font-bold">{adjustedRate.toFixed(3)}%</p></div>
          </div>
        ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t">
          <div><p className="text-xs text-muted-foreground">Balance</p><p className="font-bold">{formatCurrency(currentBalance)}</p>{liveMonths > 0 && <p className="text-xs text-muted-foreground">amortized {liveMonths}mo</p>}</div>
          <div><p className="text-xs text-muted-foreground">Current P&I</p><p className="font-bold">{formatCurrency(loan.currentPI)}/mo</p></div>
          <div><p className="text-xs text-muted-foreground">New P&I (est.)</p><p className={`font-bold ${rateTermMonthlySavings > 0 ? "text-green-600" : "text-muted-foreground"}`}>{formatCurrency(rateTermNewMonthlyPI)}/mo</p></div>
          <div><p className="text-xs text-muted-foreground">Monthly Savings</p><p className={`font-bold ${rateTermMonthlySavings > 0 ? "text-green-600" : "text-red-500"}`}>{rateTermMonthlySavings > 0 ? "+" : ""}{formatCurrency(rateTermMonthlySavings)}</p></div>
        </div>
        )}
      </div>

      {expanded && (
        <div className="border-t p-4 space-y-4">
          {/* Property type selector */}
          <div className="flex items-center gap-3 flex-wrap" data-testid="selector-property-type">
            <span className="text-sm font-medium text-muted-foreground">Property Use:</span>
            {(["primary", "secondary", "investment"] as PropertyType[]).map(pt => (
              <button
                key={pt}
                onClick={() => handlePropertyTypeChange(pt)}
                data-testid={`btn-property-type-${pt}`}
                className={`px-3 py-1 rounded-md text-xs font-semibold border transition-colors ${propertyType === pt ? PROPERTY_TYPE_COLORS[pt] : "border-border text-muted-foreground hover:border-primary"}`}
              >
                {PROPERTY_TYPE_LABELS[pt]}
              </button>
            ))}
            {rateAdj > 0 && <span className="text-xs text-amber-600">+{rateAdj.toFixed(3)}% LLPA for {PROPERTY_TYPE_LABELS[propertyType].toLowerCase()}</span>}
          </div>

          {/* Per-loan credit score override — internal (@tateoco.com)
              users track completed loans for different borrowers, so
              each scenario needs its own score. Regular users keep the
              single dashboard-wide score input. */}
          {allowPerLoanCreditScore && (
            <PerLoanCreditScore loan={loan} onUpdate={onUpdate} />
          )}

          {/* Phase 2: Physical Property Type — separate from Property Use
              (occupancy) above. Drives Condo / Townhouse → HO6 in the
              Insurance auto-default rule. */}
          <div className="flex items-center gap-3 flex-wrap" data-testid="selector-physical-property-type">
            <span className="text-sm font-medium text-muted-foreground">Property Type:</span>
            <Select value={physicalPropertyType} onValueChange={handlePhysicalPropertyTypeChange}>
              <SelectTrigger className="h-8 text-xs w-[200px]" data-testid="select-refi-physical-property-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PHYSICAL_PROPERTY_TYPE_OPTIONS.map(opt => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
                {physicalPropertyType &&
                  !PHYSICAL_PROPERTY_TYPE_OPTIONS.includes(physicalPropertyType as any) && (
                    <SelectItem value={physicalPropertyType}>{physicalPropertyType}</SelectItem>
                  )}
              </SelectContent>
            </Select>
          </div>

          {/* Loan type selector — VA/FHA disabled when not primary */}
          <div className="space-y-1" data-testid="selector-loan-type">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium text-muted-foreground">Loan Type:</span>
              {LOAN_TYPE_OPTIONS.map(lt => {
                const allowed = isLoanTypeAllowed(lt, propertyType);
                const selected = loanType === lt;
                return (
                  <button
                    key={lt}
                    type="button"
                    disabled={!allowed}
                    onClick={() => handleLoanTypeChange(lt)}
                    data-testid={`btn-loan-type-${lt}`}
                    title={!allowed ? "VA and FHA require primary residence occupancy." : undefined}
                    className={`px-3 py-1 rounded-md text-xs font-semibold border transition-colors ${
                      selected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:border-primary"
                    } ${!allowed ? "opacity-40 cursor-not-allowed hover:border-border" : ""}`}
                  >
                    {LOAN_TYPE_LABELS[lt]}
                  </button>
                );
              })}
            </div>
            {propertyType !== "primary" && (
              <p className="text-xs text-muted-foreground">
                VA and FHA are only available for primary residences.
              </p>
            )}
            {loanType === "va" && (
              <div className="mt-2 rounded-md border border-blue-200 bg-blue-50 p-3">
                <p className="text-sm font-medium text-blue-950">Do you have a VA disability?</p>
                <p className="mb-2 text-xs text-blue-800">
                  Yes makes the VA funding fee $0. No applies the 3.30% subsequent-use funding fee.
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={loan.vaDisability === true ? "default" : "outline"}
                    onClick={() => handleVaDisabilityChange(true)}
                    data-testid={`btn-va-disability-yes-${loan.id}`}
                  >
                    Yes — exempt
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={loan.vaDisability === false ? "default" : "outline"}
                    onClick={() => handleVaDisabilityChange(false)}
                    data-testid={`btn-va-disability-no-${loan.id}`}
                  >
                    No — 3.30%
                  </Button>
                </div>
                {loan.vaDisability === undefined && (
                  <p className="mt-2 text-xs font-medium text-amber-700">
                    Select Yes or No to complete the VA loan calculation.
                  </p>
                )}
              </div>
            )}
            {LOAN_TYPE_NOT_PRICED.includes(loanType) && !pricing.pricingConnected && (
              <p className="text-xs text-amber-600">
                {LOAN_TYPE_LABELS[loanType]} pricing not fully connected yet — calculations use a conventional-based estimate.
              </p>
            )}
            {/* Loan-type-specific cost notes (display only — calculations
                still use the shared rate engine). */}
            {loanType === "conventional" && homeValue > 0 && (currentBalance / homeValue) > 0.80 && (
              <p className="text-xs text-muted-foreground">
                PMI applies until LTV reaches 80%.
              </p>
            )}
            {loanType === "fha" && (
              <p className="text-xs text-muted-foreground">
                FHA MIP applies (upfront 1.75% + annual ~0.55%).
              </p>
            )}
            {loanType === "va" && (
              <p className="text-xs text-muted-foreground">
                VA funding fee applies (~2.15% first use, 3.3% subsequent).
              </p>
            )}
          </div>

          {/* Current owner's property tax bill — shown for all tracked loans.
              Clearly separate from purchase estimates and escrow math. */}
          <PropertyTaxSection
            loan={loan}
            onUpdate={onUpdate}
            onManualTaxCommit={() => {
              automaticTaxLookup.invalidate();
              taxSourceRef.current = "manual";
            }}
            onCollectorLookupStart={automaticTaxLookup.invalidate}
            lookupGenerationRef={taxLookupGenerationRef}
            currentAddressRef={taxAddressRef}
          />

          {/* Best option banner */}
          {isFreeClear ? (
            <div className="rounded-lg border p-4 bg-green-50 border-green-200">
              <div className="flex items-start gap-3">
                <Banknote className="h-5 w-5 mt-0.5 shrink-0" />
                <div>
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <p className="font-semibold text-sm">Recommended:</p>
                    <Badge variant="outline" className="text-xs bg-green-100 text-green-800 border-green-300">1st-Lien Cash-Out Refinance</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">You own this property outright — a cash-out refinance puts a new 1st lien on it and turns equity into cash.</p>
                </div>
              </div>
            </div>
          ) : (
          <div className={`rounded-lg border p-4 ${bestOption.cardBg}`}>
            <div className="flex items-start gap-3">
              <bestOption.Icon className="h-5 w-5 mt-0.5 shrink-0" />
              <div>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <p className="font-semibold text-sm">Recommended:</p>
                  <Badge variant="outline" className={`text-xs ${bestOption.badgeClass}`}>{bestOption.label}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{bestOption.reason}</p>
              </div>
            </div>
          </div>
          )}

          {/* Tab buttons — free & clear has no lien, so only Cash-Out applies */}
          {!isFreeClear && (
          <div className="flex rounded-md border overflow-hidden text-sm font-medium">
            {([["rate_term", "Rate & Term", ArrowLeftRight], ["cash_out", "Cash-Out Refi", Banknote], ["home_equity", "2nd Lien / Home Equity", Wallet]] as const).map(([tab, label, Icon]) => (
              <button key={tab} onClick={() => handleTabChange(tab as any)} className={`flex-1 py-2 px-3 flex items-center justify-center gap-1.5 transition-colors text-xs ${activeTab === tab ? "bg-primary text-white" : "bg-background text-muted-foreground hover:bg-muted"}`}>
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>
          )}
          {vaAnswerRequired && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Select Yes or No for VA disability above to calculate the funding fee and refinance proposal.
            </div>
          )}

          {/* Rate & Term */}
          {!isFreeClear && !vaAnswerRequired && activeTab === "rate_term" && (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current Loan</p>
                  <div className="flex justify-between"><span className="text-sm text-muted-foreground">Rate</span><span className="font-bold text-lg">{loan.currentRate.toFixed(3)}%</span></div>
                  <div className="flex justify-between"><span className="text-sm text-muted-foreground">Monthly P&I</span><span className="font-semibold">{formatCurrency(loan.currentPI)}</span></div>
                  <div className="flex justify-between"><span className="text-sm text-muted-foreground">Balance</span><span className="font-semibold">{formatCurrency(currentBalance)}</span></div>
                </div>
                <div className="rounded-lg border bg-green-50 border-green-200 p-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">After Refinance ({NEW_TERM_YEARS} yr)</p>
                  <div className="flex justify-between"><span className="text-sm text-muted-foreground">Rate</span><span className="font-bold text-lg text-green-700">{adjustedRate.toFixed(3)}%</span></div>
                  <div className="flex justify-between"><span className="text-sm text-muted-foreground">New Monthly P&I</span><span className="font-semibold">{formatCurrency(rateTermNewMonthlyPI)}</span></div>
                  {rateTermFeeWorksheet.monthlyHousingExpense.mortgageInsurance !== null
                    && rateTermFeeWorksheet.monthlyHousingExpense.mortgageInsurance > 0 && (
                    <div className="flex justify-between"><span className="text-sm text-muted-foreground">Est. Monthly PMI</span><span className="font-semibold text-amber-700">{formatCurrency(rateTermFeeWorksheet.monthlyHousingExpense.mortgageInsurance)}</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-sm text-muted-foreground">Funded LTV</span><span className="font-semibold">{rateTermFeeWorksheet.fundedLtvPct?.toFixed(2) ?? "—"}%</span></div>
                  <div className="flex justify-between"><span className="text-sm text-muted-foreground">New Loan Amount</span><span className="font-semibold">{formatCurrency(rateTermNewLoanAmount)}</span></div>
                  {loanType === "va" && (
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">VA Funding Fee</span>
                      <span className="font-semibold">
                        {loan.vaDisability === undefined ? "Answer required" : formatCurrency(rateTermVaFundingFee)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <FeeToggles
                idPrefix={`rt-${loan.id}`}
                financeFees={financeFees}
                setFinanceFees={handleFinanceFeesChange}
                includeEscrows={includeEscrows}
                setIncludeEscrows={handleIncludeEscrowsChange}
                baseClosingCosts={rateTermBaseClosingCosts}
                monthlyEscrow={monthlyEscrow}
              />
              {loanType === "conventional" && rateTermFeeWorksheet.cashNeededFor80Ltv > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <strong>Financing costs and escrows raises funded LTV to {rateTermFeeWorksheet.fundedLtvPct?.toFixed(2)}%.</strong>{" "}
                  Estimated PMI is {formatCurrency(rateTermFeeWorksheet.monthlyHousingExpense.mortgageInsurance ?? 0)}/month.
                  To stay at or below 80% LTV, pay at least{" "}
                  <strong>{formatCurrency(rateTermFeeWorksheet.cashNeededFor80Ltv)}</strong> at closing toward costs,
                  escrows, or principal.
                </div>
              )}
              <div className="grid grid-cols-3 gap-3">
                <div className={`rounded-md p-3 text-center ${rateTermMonthlySavings > 0 ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
                  <p className="text-xs text-muted-foreground mb-1">Monthly Savings</p>
                  <p className={`text-xl font-bold ${rateTermMonthlySavings > 0 ? "text-green-700" : "text-red-700"}`}>{rateTermMonthlySavings > 0 ? "+" : ""}{formatCurrency(rateTermMonthlySavings)}</p>
                </div>
                <div className="rounded-md p-3 text-center bg-muted/30 border">
                  <p className="text-xs text-muted-foreground mb-1">Break-Even</p>
                  <p className="text-xl font-bold">{rateTermBreakEven > 0 ? `${rateTermBreakEven} mo` : "N/A"}</p>
                </div>
                <div className={`rounded-md p-3 text-center ${rateTermLifetimeNet > 0 ? "bg-green-50 border border-green-200" : "bg-amber-50 border border-amber-200"}`}>
                  <p className="text-xs text-muted-foreground mb-1">Lifetime Net</p>
                  <p className={`text-xl font-bold ${rateTermLifetimeNet > 0 ? "text-green-700" : "text-amber-700"}`}>{formatCurrency(Math.abs(rateTermLifetimeNet))}{rateTermLifetimeNet < 0 ? " loss" : ""}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Closing costs est. {formatCurrency(rateTermBaseClosingCosts)}{includeEscrows && escrowAmount > 0 ? ` + ${formatCurrency(escrowAmount)} escrow reserve` : ""} {financeFees ? "(rolled into new loan)" : "(paid at closing)"}. Rates include {rateAdj > 0 ? `+${rateAdj.toFixed(3)}% LLPA for ${PROPERTY_TYPE_LABELS[propertyType].toLowerCase()}.` : "no LLPA adjustment for primary home."}</p>
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setRateTermWorksheetOpen(true)}>
                <Receipt className="mr-2 h-4 w-4" />
                View Initial Fees Worksheet
              </Button>
              <RefinanceFeeWorksheetDialog
                open={rateTermWorksheetOpen}
                onOpenChange={setRateTermWorksheetOpen}
                worksheet={rateTermFeeWorksheet}
                meta={{
                  address: loan.propertyAddress,
                  purpose: "Rate & Term Refinance",
                  currentPayoff: currentBalance,
                  baseNewLoanAmount: currentBalance,
                  finalNewLoanAmount: rateTermNewLoanAmount,
                  ratePct: adjustedRate,
                  monthlyPI: rateTermNewMonthlyPI,
                  financeFees,
                }}
              />
            </div>
          )}

          {/* Cash-Out */}
          {!vaAnswerRequired && activeTab === "cash_out" && (
            <div className="space-y-4">
              <CashOutSection loan={{ ...loan, loanType, loanBalance: currentBalance, estimatedHomeValue: homeValue }} newRate={bestRate} displayRate={adjustedRate} homeValue={homeValue} onChangeHomeValue={setHomeValue} financeFees={financeFees} includeEscrows={includeEscrows} monthlyEscrow={monthlyEscrow} onPersistNewLoanAmount={v => onUpdate({ cashOutNewLoanAmount: v })} showDtiCheck={showDtiCheck} />
              <FeeToggles
                idPrefix={`co-${loan.id}`}
                financeFees={financeFees}
                setFinanceFees={handleFinanceFeesChange}
                includeEscrows={includeEscrows}
                setIncludeEscrows={handleIncludeEscrowsChange}
                baseClosingCosts={null}
                monthlyEscrow={monthlyEscrow}
              />
            </div>
          )}

          {/* Home Equity */}
          {!isFreeClear && !vaAnswerRequired && activeTab === "home_equity" && (
            <div className="space-y-4">
              <HomeEquitySection loan={{ ...loan, loanBalance: currentBalance }} heRate={heRate} rateAdjustment={rateAdj} propertyType={propertyType} homeValue={homeValue} onChangeHomeValue={setHomeValue} onPersistProduct={p => onUpdate({ homeEquityProduct: p })} onPersistBorrowAmount={v => onUpdate({ homeEquityBorrowAmount: v })} showDtiCheck={showDtiCheck} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function HomeEquitySection({ loan, heRate, rateAdjustment, propertyType, homeValue, onChangeHomeValue, onPersistProduct, onPersistBorrowAmount, showDtiCheck }: { loan: TrackedLoan; heRate: number; rateAdjustment: number; propertyType: PropertyType; homeValue: number; onChangeHomeValue: (v: number) => void; onPersistProduct: (p: HeProduct) => void; onPersistBorrowAmount: (v: number) => void; showDtiCheck?: boolean }) {
  const usesCdPurchasePrice = isCdPurchasePriceLocked(loan);
  const [product, setProduct] = useState<HeProduct>(loan.homeEquityProduct ?? "heloc");
  const [borrowAmount, setBorrowAmount] = useState(
    typeof loan.homeEquityBorrowAmount === "number" && loan.homeEquityBorrowAmount >= 0
      ? loan.homeEquityBorrowAmount
      : Infinity,
  );
  function handleProductChange(p: HeProduct) {
    setProduct(p);
    onPersistProduct(p);
  }
  const [editing, setEditing] = useState(false);
  const [editInput, setEditInput] = useState(String(Math.round(homeValue)));

  const maxCltv = HE_MAX_CLTV[propertyType];
  const maxHEAmount = Math.max(0, Math.floor(homeValue * maxCltv - loan.loanBalance));
  const clampedBorrow = Math.min(Math.max(borrowAmount === Infinity ? maxHEAmount : borrowAmount, 0), maxHEAmount);
  const cltv = homeValue > 0 ? (loan.loanBalance + clampedBorrow) / homeValue : 1;
  const notEnoughEquity = maxHEAmount <= 0;

  function commitEdit() {
    const parsed = parseFloat(editInput.replace(/[^0-9.]/g, ""));
    if (!isNaN(parsed) && parsed > 0) { onChangeHomeValue(parsed); setBorrowAmount(Infinity); }
    setEditing(false);
  }

  const helocInterestOnly = clampedBorrow > 0 ? clampedBorrow * (heRate / 100 / 12) : 0;
  const helocRepayment = calculateMonthlyPayment(clampedBorrow, heRate, HELOC_REPAY_YEARS);
  const heLoanMonthly = calculateMonthlyPayment(clampedBorrow, heRate, HE_LOAN_TERM_YEARS);
  const heLoanTotalInterest = clampedBorrow > 0 ? heLoanMonthly * HE_LOAN_TERM_YEARS * 12 - clampedBorrow : 0;
  // 2nd liens do not roll fees into the loan — fees come out of the cash disbursed.
  const heClosingCosts = clampedBorrow > 0 ? (clampedBorrow * CLOSING_COST_PERCENT) / 100 + CLOSING_COST_FIXED : 0;
  const heNetCash = Math.max(0, clampedBorrow - heClosingCosts);

  if (notEnoughEquity) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-sm text-red-700">Not enough equity for a 2nd lien product</p>
          <p className="text-sm text-red-600">Your LTV leaves no room below the {(maxCltv * 100).toFixed(0)}% CLTV limit. Pay down your balance or wait for home value to increase.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="flex items-center justify-between p-3 rounded-md border bg-muted/30 flex-wrap gap-2">
          <div className="space-y-0.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">2nd Lien Rate</p>
            <p className="font-bold text-xl">{heRate.toFixed(3)}%</p>
            <p className="text-xs text-muted-foreground">30yr + {HE_RATE_MARGIN.toFixed(3)}% 2nd-lien margin{rateAdjustment > 0 ? ` + ${rateAdjustment.toFixed(3)}% occupancy` : ""}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Max Available</p>
            <p className="font-bold text-xl">{formatCurrency(maxHEAmount)}</p>
            <p className="text-xs text-muted-foreground">{(maxCltv * 100).toFixed(0)}% CLTV limit</p>
          </div>
        </div>
        <div className="flex items-center justify-between p-3 rounded-md border bg-muted/30 flex-wrap gap-2">
          <div className="space-y-0.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {usesCdPurchasePrice ? "Assumed Appraised Value" : "Est. Home Value"}
            </p>
            {editing ? (
              <div className="flex items-center gap-1">
                <span className="text-sm">$</span>
                <input type="text" className="border rounded px-2 py-1 text-sm w-28 bg-background" value={editInput} onChange={e => setEditInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }} autoFocus />
                <Button size="sm" variant="ghost" onClick={commitEdit} className="h-7 px-1"><Check className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="h-7 px-1"><X className="h-3 w-3" /></Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-bold text-xl">{formatCurrency(homeValue)}</span>
                <button onClick={() => { setEditInput(String(Math.round(homeValue))); setEditing(true); }} className="text-muted-foreground hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
              </div>
            )}
            <p className="text-xs text-amber-600">
              {usesCdPurchasePrice
                ? "CD sale price · edit only if appraisal differs"
                : "Estimated value · edit to refine"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Current CLTV</p>
            <p className="font-bold text-xl">{homeValue > 0 ? ((loan.loanBalance / homeValue) * 100).toFixed(1) : "—"}%</p>
          </div>
        </div>
      </div>

      <div className="flex rounded-md border overflow-hidden text-sm font-medium">
        <button className={`flex-1 py-2 px-4 transition-colors ${product === "heloc" ? "bg-yellow-400 text-yellow-900 font-semibold" : "bg-background text-muted-foreground hover:bg-muted"}`} onClick={() => handleProductChange("heloc")}>
          HELOC <span className="text-xs font-normal opacity-80">(variable, interest-only draw)</span>
        </button>
        <button className={`flex-1 py-2 px-4 transition-colors ${product === "he_loan" ? "bg-yellow-400 text-yellow-900 font-semibold" : "bg-background text-muted-foreground hover:bg-muted"}`} onClick={() => handleProductChange("he_loan")}>
          Fixed HE Loan <span className="text-xs font-normal opacity-80">({HE_LOAN_TERM_YEARS}-yr fully amortizing)</span>
        </button>
      </div>

      <div className="space-y-3 p-3 rounded-md border bg-background">
        <div className="flex items-baseline justify-between flex-wrap gap-1">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{product === "heloc" ? "Line Amount" : "Loan Amount"}</p>
            <p className="font-bold text-2xl">{formatCurrency(clampedBorrow)}</p>
          </div>
          {clampedBorrow > 0 && (
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Cash you'd receive <span className="text-muted-foreground/80">(net of fees)</span></p>
              <p className="font-bold text-xl text-green-600">{formatCurrency(heNetCash)}</p>
              <p className="text-xs text-muted-foreground">Less {formatCurrency(heClosingCosts)} closing costs</p>
            </div>
          )}
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Combined LTV after</p>
            <p className={`font-bold text-lg ${cltv > maxCltv ? "text-red-500" : ""}`}>{(cltv * 100).toFixed(1)}%</p>
          </div>
        </div>
        <Slider min={0} max={maxHEAmount} step={1000} value={[clampedBorrow]} onValueChange={([val]) => setBorrowAmount(val)} onValueCommit={([val]) => onPersistBorrowAmount(val)} />
        <div className="flex justify-between text-xs text-muted-foreground"><span>$0</span><span>Max {formatCurrency(maxHEAmount)}</span></div>
        <p className="text-xs text-muted-foreground">Fees are paid from the proceeds at closing — they are not added to your 2nd lien balance, and there is no escrow account.</p>
      </div>

      {clampedBorrow > 0 && product === "heloc" && (
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-lg border bg-yellow-50 border-yellow-200 p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Draw Period · {HELOC_DRAW_YEARS} yrs</p>
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Monthly interest</span><span className="font-bold text-xl">{formatCurrency(helocInterestOnly)}</span></div>
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Rate</span><span className="font-semibold">{heRate.toFixed(3)}%</span></div>
          </div>
          <div className="rounded-lg border bg-yellow-50 border-yellow-200 p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Repayment Period · {HELOC_REPAY_YEARS} yrs</p>
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Monthly P&I</span><span className="font-bold text-xl">{formatCurrency(helocRepayment)}</span></div>
            <div className="flex justify-between border-t pt-2 mt-1"><span className="text-sm font-medium">Combined monthly</span><span className="font-bold">{formatCurrency(loan.currentPI + helocRepayment)}</span></div>
          </div>
        </div>
      )}

      {clampedBorrow > 0 && product === "he_loan" && (
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current 1st Mortgage</p>
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Monthly P&I</span><span className="font-semibold">{formatCurrency(loan.currentPI)}</span></div>
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Balance</span><span className="font-semibold">{formatCurrency(loan.loanBalance)}</span></div>
          </div>
          <div className="rounded-lg border bg-yellow-50 border-yellow-200 p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fixed HE Loan · {HE_LOAN_TERM_YEARS} yrs</p>
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Monthly P&I</span><span className="font-bold text-xl">{formatCurrency(heLoanMonthly)}</span></div>
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Rate</span><span className="font-semibold">{heRate.toFixed(3)}%</span></div>
            <div className="flex justify-between"><span className="text-sm text-muted-foreground">Total interest</span><span className="font-semibold">{formatCurrency(heLoanTotalInterest)}</span></div>
            <div className="flex justify-between border-t pt-2 mt-1"><span className="text-sm font-medium">Combined monthly</span><span className="font-bold">{formatCurrency(loan.currentPI + heLoanMonthly)}</span></div>
          </div>
        </div>
      )}

      {showDtiCheck && clampedBorrow > 0 && (
        <DtiCheck
          // Lenders qualify HELOCs at the fully-amortizing repayment
          // payment, not the interest-only draw payment.
          housingPayment={loan.monthlyPayment + (product === "heloc" ? helocRepayment : heLoanMonthly)}
          paymentLabel="current payment + 2nd lien"
        />
      )}
    </div>
  );
}

interface LoanTrackerProps {
  loans: TrackedLoan[];
  liveRates: LiveRate[];
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<TrackedLoan>) => void;
  maxLoans?: number;
  /** Refinance-wide credit score input — rendered inline with the
   *  "Loan Dashboard" title. The page owns the state and the
   *  fan-out-to-all-loans logic; we just render the control. */
  creditScore?: number;
  onCreditScoreChange?: (raw: string) => void;
  onCreditScoreBlur?: () => void;
  /** Triggered by the inline "Analyze Another Mortgage Statement"
   *  button — the page scrolls the existing analyzer card into view
   *  (or opens it). Kept as a callback so analyzer logic is unchanged. */
  onAnalyzeAnotherClick?: () => void;
  /** Internal (@tateoco.com) users get a per-loan credit score input on
   *  each card — they use the dashboard to track completed loans for
   *  different borrowers. */
  allowPerLoanCreditScore?: boolean;
  /** DTI qualification check on cash-out / 2nd-lien tabs. Hidden for
   *  internal (@tateoco.com) users — they track completed loans, so
   *  qualification questions don't apply. */
  showDtiCheck?: boolean;
}

export function LoanTracker({
  loans, liveRates, onRemove, onUpdate, maxLoans = 10,
  creditScore, onCreditScoreChange, onCreditScoreBlur, onAnalyzeAnotherClick,
  allowPerLoanCreditScore, showDtiCheck,
}: LoanTrackerProps) {
  if (loans.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* Header row: title + Credit Score + Analyze-Another trigger.
          Wraps cleanly under the title on narrow viewports. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-primary" />
          Loan Dashboard
          <Badge variant="secondary">{loans.length}/{maxLoans}</Badge>
        </h3>
        {onCreditScoreChange && (
          <div className="flex items-center gap-2" data-testid="input-credit-score-wrap">
            <Label htmlFor="refi-credit-score" className="text-sm whitespace-nowrap">Credit Score</Label>
            <Input
              id="refi-credit-score"
              data-testid="input-credit-score"
              type="number"
              inputMode="numeric"
              min={300}
              max={850}
              step={1}
              value={creditScore && creditScore > 0 ? creditScore : ""}
              onChange={e => onCreditScoreChange(e.target.value)}
              onBlur={onCreditScoreBlur}
              className="w-24 h-9"
              aria-label="Credit score used for refinance rate estimates"
            />
          </div>
        )}
        {onAnalyzeAnotherClick && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onAnalyzeAnotherClick}
            data-testid="button-analyze-another"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Analyze Another Mortgage Statement
          </Button>
        )}
      </div>
      <div className="space-y-3">
        {loans.map(loan => (
          <LoanCard key={loan.id} loan={loan} liveRates={liveRates} onRemove={() => onRemove(loan.id)} onUpdate={u => onUpdate(loan.id, u)} allowPerLoanCreditScore={allowPerLoanCreditScore} showDtiCheck={showDtiCheck} />
        ))}
      </div>
    </div>
  );
}
