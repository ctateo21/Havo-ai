import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/context/auth-context";
import { saveBorrowerFinances } from "@/lib/auth";
import {
  AFFORDABILITY_ASSUMPTIONS_BY_PROGRAM,
  type AffordabilityProgram,
  calculateBuyerAffordability,
} from "@/lib/buyer-affordability";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function dollars(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function readAmount(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

const PROGRAM_LABELS: Record<AffordabilityProgram, string> = {
  conventional: "Conventional",
  fha: "FHA",
  va: "VA",
};

export function BuyerAffordability() {
  const { user } = useAuth();
  const [program, setProgram] = useState<AffordabilityProgram>("conventional");
  const [income, setIncome] = useState("");
  const [debts, setDebts] = useState("");
  const [vaBudgetLow, setVaBudgetLow] = useState("");
  const [vaBudgetHigh, setVaBudgetHigh] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const seededUserId = useRef<string | null>(null);
  const edited = useRef(false);
  const editVersion = useRef(0);
  const saveAttempt = useRef(0);

  useEffect(() => {
    if (!user || seededUserId.current === user.id) return;
    seededUserId.current = user.id;
    const storedProgram = localStorage.getItem(`buyer-affordability-program:${user.id}`);
    if (storedProgram === "conventional" || storedProgram === "fha" || storedProgram === "va") {
      setProgram(storedProgram);
    }
    if (edited.current) return;
    if (typeof user.monthlyIncome === "number" && user.monthlyIncome > 0) {
      setIncome(String(user.monthlyIncome));
    }
    if (typeof user.monthlyDebts === "number" && user.monthlyDebts >= 0) {
      setDebts(String(user.monthlyDebts));
    }
  }, [user]);

  const parsedIncome = readAmount(income);
  const parsedDebts = debts.trim() ? readAmount(debts) : 0;
  const parsedVaLow = readAmount(vaBudgetLow);
  const parsedVaHigh = readAmount(vaBudgetHigh);
  const invalidVaRange =
    program === "va" &&
    parsedVaLow != null &&
    parsedVaHigh != null &&
    parsedVaLow > parsedVaHigh;
  const assumptions = AFFORDABILITY_ASSUMPTIONS_BY_PROGRAM[program];
  const estimate = useMemo(() => {
    if (parsedDebts == null) return null;
    if (program === "va") {
      return calculateBuyerAffordability(
        parsedIncome ?? 0,
        parsedDebts,
        assumptions,
        {
          program,
          monthlyHousingBudgetLow: parsedVaLow ?? undefined,
          monthlyHousingBudgetHigh: parsedVaHigh ?? undefined,
        },
      );
    }
    return parsedIncome == null
      ? null
      : calculateBuyerAffordability(parsedIncome, parsedDebts, assumptions, program);
  }, [assumptions, parsedDebts, parsedIncome, parsedVaHigh, parsedVaLow, program]);
  const hasInvalidDebt = parsedDebts != null && parsedDebts < 0;
  const canSaveFinances =
    user && parsedIncome != null && parsedIncome > 0 && parsedDebts != null && parsedDebts >= 0;

  function markEdited() {
    edited.current = true;
    editVersion.current += 1;
    setSaveState("idle");
    setSaveMessage("");
  }

  function chooseProgram(value: AffordabilityProgram) {
    setProgram(value);
    if (user) {
      localStorage.setItem(`buyer-affordability-program:${user.id}`, value);
    }
  }

  async function saveInputs() {
    if (!canSaveFinances || parsedIncome == null || parsedDebts == null) return;
    const versionAtStart = editVersion.current;
    const attempt = ++saveAttempt.current;
    setSaveState("saving");
    setSaveMessage("");
    try {
      const result = await saveBorrowerFinances(parsedIncome, parsedDebts);
      if (versionAtStart !== editVersion.current || attempt !== saveAttempt.current) return;
      if (!result.saved) {
        setSaveState("error");
        setSaveMessage(result.error || "Your finances could not be saved. Please try again.");
        return;
      }
      setSaveState("saved");
      setSaveMessage("Income and debt inputs saved to your profile.");
    } catch (error) {
      if (versionAtStart !== editVersion.current || attempt !== saveAttempt.current) return;
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : "Your finances could not be saved.");
    }
  }

  const costDescription =
    program === "fha"
      ? "Principal, interest, property taxes, homeowners insurance, and FHA annual MIP."
      : program === "va"
        ? "Principal, interest, property taxes, and homeowners insurance; no PMI."
        : "Principal, interest, property taxes, homeowners insurance, and PMI.";

  return (
    <Card data-testid="buyer-affordability-calculator" className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-xl">What home price might fit my budget?</CardTitle>
        <p className="text-sm text-muted-foreground">
          Choose a loan program and enter monthly figures for a rough planning range.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Loan program</legend>
          <div className="grid grid-cols-3 gap-2" data-testid="affordability-program-selector">
            {(Object.keys(PROGRAM_LABELS) as AffordabilityProgram[]).map(value => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={program === value ? "default" : "outline"}
                data-testid={`affordability-program-${value}`}
                aria-pressed={program === value}
                onClick={() => chooseProgram(value)}
              >
                {PROGRAM_LABELS[value]}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Program preference is saved only in this browser for this user, not synced to the account.
          </p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 min-w-0">
            <Label htmlFor="affordability-income">
              Gross monthly income{program === "va" ? " (optional context)" : ""}
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
              <Input id="affordability-income" data-testid="affordability-income" inputMode="decimal"
                className="pl-7" value={income} onChange={event => { markEdited(); setIncome(event.target.value); }}
                placeholder="8,000" />
            </div>
          </div>
          <div className="space-y-2 min-w-0">
            <Label htmlFor="affordability-debts">
              Monthly nonhousing debt{program === "va" ? " (optional context)" : ""}
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
              <Input id="affordability-debts" data-testid="affordability-debts" inputMode="decimal"
                className="pl-7" value={debts} onChange={event => { markEdited(); setDebts(event.target.value); }}
                placeholder="0" />
            </div>
            <p className="text-xs text-muted-foreground">Car, student, personal loan, and card payments. Blank means $0.</p>
          </div>
        </div>

        {program === "va" && (
          <div className="space-y-2 rounded-lg border p-3" data-testid="va-budget-inputs">
            <p className="text-sm font-medium">Your monthly all-in housing budget</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="va-budget-low">Low</Label>
                <Input id="va-budget-low" data-testid="va-budget-low" inputMode="decimal"
                  value={vaBudgetLow} onChange={event => setVaBudgetLow(event.target.value)} placeholder="2,000" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="va-budget-high">High</Label>
                <Input id="va-budget-high" data-testid="va-budget-high" inputMode="decimal"
                  value={vaBudgetHigh} onChange={event => setVaBudgetHigh(event.target.value)} placeholder="2,500" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              VA has no fixed mandatory DTI cap. Enter a budget you are comfortable with; residual income,
              lender review, credit, and other factors determine qualification.
            </p>
            {invalidVaRange && <p className="text-sm text-destructive" role="alert">Low budget cannot be greater than high budget.</p>}
          </div>
        )}

        {hasInvalidDebt && <p className="text-sm text-destructive" role="alert">Monthly debt cannot be negative.</p>}

        {estimate && (
          <div data-testid="affordability-results" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border bg-muted/40 p-4 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {program === "va" ? "Your monthly housing budget" : "Estimated monthly housing budget"}
                </p>
                <p data-testid="housing-budget-range" className="mt-1 text-xl font-bold break-words">
                  {dollars(estimate.monthlyHousingBudgetLow)}–{dollars(estimate.monthlyHousingBudgetHigh)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{costDescription}</p>
              </div>
              <div className="rounded-lg border bg-primary/5 p-4 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Approximate purchase price</p>
                <p data-testid="purchase-price-range" className="mt-1 text-xl font-bold text-primary break-words">
                  {dollars(estimate.purchasePriceLow)}–{dollars(estimate.purchasePriceHigh)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Rounded down to $5,000 boundaries.</p>
              </div>
            </div>
            {program === "va" && estimate.actualTotalDtiLow != null && (
              <p data-testid="va-actual-dti" className="text-xs text-muted-foreground">
                Context only: these inputs imply total DTI of {(estimate.actualTotalDtiLow * 100).toFixed(1)}%–
                {(estimate.actualTotalDtiHigh! * 100).toFixed(1)}%. This is not a VA cap or approval standard.
              </p>
            )}
            {estimate.purchasePriceHigh === 0 && (
              <p data-testid="no-affordability-room" className="text-sm font-medium text-amber-700">
                This budget leaves no room for a positive estimated purchase price after fixed housing expenses.
              </p>
            )}
          </div>
        )}

        {program !== "va" && !estimate && income.trim() && !hasInvalidDebt && (
          <p className="text-sm text-destructive" role="alert">Enter a positive monthly income and valid debt amount.</p>
        )}

        <div className="rounded-lg border p-3 text-xs text-muted-foreground space-y-1" data-testid="affordability-assumptions">
          <p className="font-semibold text-foreground">Illustrative assumptions, not a live quote</p>
          {program === "conventional" && <p>Uses requested 43%–49% total DTI planning bands, less monthly nonhousing debt. These are not universal underwriting guarantees.</p>}
          {program === "fha" && <p>Uses requested 45%–55% total DTI planning bands, less monthly nonhousing debt. These are not universal underwriting guarantees.</p>}
          {program === "va" && <p>No automatic income-based range or fixed mandatory DTI cap is used. VA residual income and lender review apply.</p>}
          <p>
            {assumptions.downPaymentPercent}% down, {assumptions.annualInterestRatePercent}% rate,{" "}
            {assumptions.termYears}-year loan, {assumptions.annualPropertyTaxPercent}% annual property taxes, and{" "}
            {dollars(assumptions.monthlyHomeownersInsurance)}/month homeowners insurance.
          </p>
          {program === "conventional" && <p>{assumptions.annualPmiPercentOfLoan}% annual PMI on the loan.</p>}
          {program === "fha" && <p>1.75% upfront MIP is financed and included in principal and interest; 0.55% annual MIP is calculated on the base loan for this 30-year, above-95%-LTV illustration.</p>}
          {program === "va" && <p>No PMI. The VA funding fee is excluded because eligibility and exemption status are unknown; this does not assume every borrower has a $0 fee.</p>}
          <p>Assumes $0 HOA and flood insurance. Those costs reduce affordability. Down payment and closing cash are separate.</p>
        </div>

        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
          {user && (
            <Button type="button" data-testid="save-affordability-inputs" size="sm"
              onClick={saveInputs} disabled={!canSaveFinances || saveState === "saving"}>
              {saveState === "saving" ? "Saving..." : "Save income & debt"}
            </Button>
          )}
          {saveMessage && (
            <p data-testid="affordability-save-status" role="status"
              className={`text-sm ${saveState === "error" ? "text-destructive" : "text-green-700"}`}>
              {saveMessage}
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Rough planning estimate only. This is not a preapproval or lender approval; actual rates, costs, and qualification vary.
        </p>
      </CardContent>
    </Card>
  );
}