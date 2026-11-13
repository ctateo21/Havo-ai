import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddressAutocompleteInput } from "@/components/ui/address-autocomplete-input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Pencil, AlertTriangle, CheckCircle2, Calculator } from "lucide-react";
import { formatCurrency } from "@/lib/refi-calculations";
import { monthlyPI, remainingBalance, paymentsMadeSince, remainingYears } from "@/lib/amortization";
import type { MortgageAnalysis } from "./loan-tracker";
import type { TrackedLoan } from "@/lib/auth";
import { useAnonymousDraft } from "@/hooks/use-anonymous-draft";

interface ManualLoanEntryProps {
  onAnalyzed: (analysis: MortgageAnalysis, extras: Partial<TrackedLoan>) => void;
}

/** Manual origination-details entry with an amortization-table balance
 *  check before the loan is tracked. */
export function ManualLoanEntry({ onAnalyzed }: ManualLoanEntryProps) {
  const [address, setAddress] = useAnonymousDraft("manual.address", new URLSearchParams(window.location.search).get("address") || "");
  const [purchaseDate, setPurchaseDate] = useAnonymousDraft("manual.purchaseDate", "");
  const [purchasePrice, setPurchasePrice] = useAnonymousDraft("manual.purchasePrice", "");
  const [loanAmount, setLoanAmount] = useAnonymousDraft("manual.loanAmount", "");
  // Loan amount can be entered as a dollar figure or a % of purchase price.
  const [loanAmountMode, setLoanAmountMode] = useAnonymousDraft<"dollar" | "percent">("manual.loanAmountMode", "dollar");
  // Loan program — FHA/VA finance a funding fee into the original loan
  // amount that most users don't know to include, so we add it for them.
  const [loanType, setLoanType] = useAnonymousDraft<"conventional" | "fha" | "va" | "dscr" | "bank_statement">("manual.loanType", "conventional");
  // VA funding fee depends on usage; VA-disability-exempt pays none.
  const [vaUse, setVaUse] = useAnonymousDraft<"first" | "subsequent" | "exempt">("manual.vaUse", "first");
  const [rate, setRate] = useAnonymousDraft("manual.rate", "");
  const [termYears, setTermYears] = useAnonymousDraft("manual.termYears", "30");
  const [balance, setBalance] = useAnonymousDraft("manual.balance", "");
  const [monthlyEscrow, setMonthlyEscrow] = useAnonymousDraft("manual.monthlyEscrow", "");
  const [error, setError] = useState<string | null>(null);
  // Verification step state — set after "Verify Balance" is pressed.
  const [check, setCheck] = useState<{ amortized: number; entered: number; monthsElapsed: number } | null>(null);

  const num = (s: string) => {
    const n = parseFloat(s.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };

  // Base loan amount before any financed funding fee.
  const baseLoanAmount = loanAmountMode === "percent"
    ? Math.round(num(purchasePrice) * num(loanAmount) / 100)
    : num(loanAmount);

  // Financed funding fee: FHA UFMIP 1.75%; VA 2.15% first use / 3.3%
  // subsequent / 0% with VA disability exemption.
  const fundingFeePct =
    loanType === "fha" ? 1.75 :
    loanType === "va" ? (vaUse === "first" ? 2.15 : vaUse === "subsequent" ? 3.3 : 0) :
    0;
  const fundingFee = Math.round(baseLoanAmount * fundingFeePct / 100);
  // Total note amount that actually amortizes.
  const totalLoanAmount = baseLoanAmount + fundingFee;

  function validate(): string | null {
    if (!address.trim()) return "Enter the property address.";
    if (!purchaseDate) return "Enter the purchase date.";
    if (new Date(purchaseDate).getTime() > Date.now()) return "Purchase date can't be in the future.";
    if (num(purchasePrice) <= 0) return "Enter the original purchase price.";
    if (loanAmountMode === "percent" && (num(loanAmount) <= 0 || num(loanAmount) > 100)) return "Enter the loan as a percent of the purchase price (e.g. 80).";
    if (baseLoanAmount <= 0) return "Enter the original loan amount.";
    const r = num(rate);
    if (r <= 0 || r > 15) return "Enter the interest rate (e.g. 6.5).";
    const t = num(termYears);
    if (t <= 0 || t > 40) return "Enter the loan term in years (e.g. 30).";
    if (num(balance) <= 0) return "Enter your current loan balance.";
    return null;
  }

  function verifyBalance() {
    const err = validate();
    if (err) { setError(err); setCheck(null); return; }
    setError(null);
    const termMonths = Math.round(num(termYears) * 12);
    const monthsElapsed = paymentsMadeSince(purchaseDate);
    // Amortize the full note amount including any financed funding fee.
    const amortized = Math.round(remainingBalance(totalLoanAmount, num(rate), termMonths, monthsElapsed));
    setCheck({ amortized, entered: num(balance), monthsElapsed });
  }

  function track(useBalance: number, confirmed: boolean) {
    if (!check) return;
    const termMonths = Math.round(num(termYears) * 12);
    const pi = monthlyPI(totalLoanAmount, num(rate), termMonths);
    const analysis: MortgageAnalysis = {
      loanBalance: Math.round(useBalance),
      interestRate: num(rate),
      monthlyPayment: pi + num(monthlyEscrow),
      principalAndInterest: pi,
      escrowAmount: num(monthlyEscrow),
      currentEscrowBalance: null,
      propertyAddress: address.trim(),
      lender: "",
      estimatedRemainingYears: Math.round(remainingYears(termMonths, check.monthsElapsed) * 10) / 10,
      // No value source in manual entry — the auto Zillow pull after
      // tracking fills this in; fall back to purchase price meanwhile.
      estimatedHomeValue: num(purchasePrice),
      loanNumber: null,
      confidence: "high",
      recommendation: "",
      potentialSavings: 0,
      rawExtractedData: {},
    };
    const extras: Partial<TrackedLoan> = {
      entryMethod: "manual",
      purchaseDate,
      originalPurchasePrice: num(purchasePrice),
      originalLoanAmount: totalLoanAmount,
      originalRate: num(rate),
      loanType,
      originalTermMonths: termMonths,
      amortizedBalanceCheck: check.amortized,
      balanceConfirmed: confirmed,
    };
    onAnalyzed(analysis, extras);
    setCheck(null);
  }

  const diffPct = check && check.amortized > 0
    ? Math.abs(check.entered - check.amortized) / check.amortized * 100
    : 0;
  const closeEnough = diffPct <= 2;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Pencil className="h-5 w-5 text-primary" />Enter Loan Details Manually
        </CardTitle>
        <CardDescription>
          Enter your original loan details and current balance — we'll verify the balance against a standard amortization schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="manual-address">Property address</Label>
            <AddressAutocompleteInput id="manual-address" data-testid="input-manual-address" placeholder="123 Main St, Tampa, FL" value={address} onValueChange={setAddress} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-purchase-date">Purchase date</Label>
            <Input id="manual-purchase-date" data-testid="input-manual-purchase-date" type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-purchase-price">Original purchase price</Label>
            <Input id="manual-purchase-price" data-testid="input-manual-purchase-price" inputMode="numeric" placeholder="$450,000" value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="manual-loan-amount">Original loan amount</Label>
              <div className="flex rounded-md border overflow-hidden text-xs">
                {(["dollar", "percent"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`btn-loan-amount-mode-${m}`}
                    onClick={() => { setLoanAmountMode(m); setLoanAmount(""); setCheck(null); }}
                    className={`px-2 py-0.5 font-semibold transition-colors ${loanAmountMode === m ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
                  >
                    {m === "dollar" ? "$" : "% of price"}
                  </button>
                ))}
              </div>
            </div>
            <Input
              id="manual-loan-amount"
              data-testid="input-manual-loan-amount"
              inputMode="decimal"
              placeholder={loanAmountMode === "dollar" ? "$360,000" : "80"}
              value={loanAmount}
              onChange={e => { setLoanAmount(e.target.value); setCheck(null); }}
            />
            {loanAmountMode === "percent" && baseLoanAmount > 0 && (
              <p className="text-xs text-muted-foreground">= {formatCurrency(baseLoanAmount)}</p>
            )}
          </div>

          {/* Loan type — FHA/VA finance a funding fee into the note that
              most borrowers don't know to include. */}
          <div className="sm:col-span-2 space-y-1">
            <div className="flex items-center gap-3 flex-wrap">
              <Label>Loan type:</Label>
              {([["conventional", "Conventional"], ["fha", "FHA"], ["va", "VA"], ["dscr", "DSCR"], ["bank_statement", "Bank Statement"]] as const).map(([lt, label]) => (
                <button
                  key={lt}
                  type="button"
                  data-testid={`btn-manual-loan-type-${lt}`}
                  onClick={() => { setLoanType(lt); setCheck(null); }}
                  className={`px-3 py-1 rounded-md text-xs font-semibold border transition-colors ${loanType === lt ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {loanType === "va" && (
              <div className="flex items-center gap-3 flex-wrap pt-1">
                <Label className="text-xs text-muted-foreground">VA funding fee:</Label>
                {([["first", "First use (2.15%)"], ["subsequent", "Second+ use (3.3%)"], ["exempt", "VA disability (no fee)"]] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    data-testid={`btn-va-use-${v}`}
                    onClick={() => { setVaUse(v); setCheck(null); }}
                    className={`px-3 py-1 rounded-md text-xs font-semibold border transition-colors ${vaUse === v ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {fundingFee > 0 && baseLoanAmount > 0 && (
              <p className="text-xs text-amber-600">
                {loanType === "fha" ? `FHA upfront MIP (1.75%)` : `VA funding fee (${fundingFeePct}%)`} of {formatCurrency(fundingFee)} is financed into the loan — total note amount {formatCurrency(totalLoanAmount)}.
              </p>
            )}
            {loanType === "va" && vaUse === "exempt" && (
              <p className="text-xs text-muted-foreground">No funding fee added — VA disability exemption.</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-rate">Interest rate (%)</Label>
            <Input id="manual-rate" data-testid="input-manual-rate" inputMode="decimal" placeholder="6.500" value={rate} onChange={e => setRate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-term">Loan term (years)</Label>
            <Input id="manual-term" data-testid="input-manual-term" inputMode="numeric" value={termYears} onChange={e => setTermYears(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-balance">Current loan balance</Label>
            <Input id="manual-balance" data-testid="input-manual-balance" inputMode="numeric" placeholder="$340,000" value={balance} onChange={e => { setBalance(e.target.value); setCheck(null); }} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-monthly-escrow">Current monthly escrow payment</Label>
            <Input
              id="manual-monthly-escrow"
              data-testid="input-manual-monthly-escrow"
              inputMode="numeric"
              placeholder="$650"
              value={monthlyEscrow}
              onChange={e => setMonthlyEscrow(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Used to estimate a possible escrow refund at two months.</p>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!check && (
          <Button onClick={verifyBalance} className="w-full" data-testid="btn-verify-balance">
            <Calculator className="h-4 w-4 mr-2" />Verify Balance
          </Button>
        )}

        {check && (
          <div className="space-y-3 pt-2 border-t">
            <div className="flex items-center gap-2">
              {closeEnough
                ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                : <AlertTriangle className="h-4 w-4 text-amber-600" />}
              <span className="font-medium text-sm">
                {closeEnough ? "Balance checks out" : "Balance differs from the amortization schedule"}
              </span>
            </div>
            <div className="p-3 bg-muted rounded-md grid grid-cols-2 gap-2 text-sm">
              <div><p className="text-muted-foreground text-xs">Your balance</p><p className="font-semibold">{formatCurrency(check.entered)}</p></div>
              <div><p className="text-muted-foreground text-xs">Amortization schedule says</p><p className="font-semibold">{formatCurrency(check.amortized)}</p><p className="text-xs text-muted-foreground">after {check.monthsElapsed} payments</p></div>
            </div>
            {!closeEnough && (
              <p className="text-xs text-muted-foreground">
                A gap usually means extra principal payments or a recast. Use whichever number matches your servicer.
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <Button onClick={() => track(check.entered, true)} data-testid="btn-use-my-balance">
                Use my balance ({formatCurrency(check.entered)})
              </Button>
              <Button variant="outline" onClick={() => track(check.amortized, false)} data-testid="btn-use-amortized">
                Use schedule ({formatCurrency(check.amortized)})
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
