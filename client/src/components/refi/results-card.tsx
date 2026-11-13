import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TrendingDown, TrendingUp, Clock, DollarSign, Percent, AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";
import type { RefinanceResult } from "@/lib/refi-calculations";
import { formatCurrency, formatCurrencyWithCents } from "@/lib/refi-calculations";
import { cn } from "@/lib/utils";

interface ResultsCardProps {
  results: RefinanceResult;
  refinanceType: "rate_and_term" | "cash_out";
}

export function ResultsCard({ results, refinanceType }: ResultsCardProps) {
  const hasSavings = results.monthlySavings > 0;
  const isHighLtv = results.ltvRatio > 80;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-lg">Monthly Payment Comparison</span>
            {hasSavings ? (
              <Badge className="bg-green-600"><TrendingDown className="h-3 w-3 mr-1" />Savings</Badge>
            ) : (
              <Badge variant="secondary"><TrendingUp className="h-3 w-3 mr-1" />Higher Payment</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="text-center flex-1 min-w-[120px]">
              <p className="text-sm text-muted-foreground mb-1">Current Payment</p>
              <p className="text-2xl font-bold">{formatCurrencyWithCents(results.monthlyPaymentCurrent)}</p>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0" />
            <div className="text-center flex-1 min-w-[120px]">
              <p className="text-sm text-muted-foreground mb-1">New Payment</p>
              <p className="text-2xl font-bold">{formatCurrencyWithCents(results.monthlyPaymentNew)}</p>
            </div>
          </div>
          <Separator />
          <div className={cn("p-4 rounded-md text-center", hasSavings ? "bg-green-50" : "bg-amber-50")}>
            <p className="text-sm text-muted-foreground mb-1">{hasSavings ? "Monthly Savings" : "Additional Monthly Cost"}</p>
            <p className={cn("text-3xl font-bold", hasSavings ? "text-green-600" : "text-amber-600")}>
              {formatCurrencyWithCents(Math.abs(results.monthlySavings))}
            </p>
            <p className="text-sm mt-3">Matched remaining term ({results.matchedTermYears} years): {formatCurrencyWithCents(results.matchedTermPayment)}/mo; monthly difference {formatCurrencyWithCents(results.matchedTermSavings)}. Extending the term can lower the payment while increasing lifetime interest.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2"><DollarSign className="h-5 w-5" />Loan Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">New Loan Amount</span>
            <span className="font-semibold">{formatCurrency(results.newLoanAmount)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Total Closing Costs</span>
            <span className="font-semibold">{formatCurrency(results.totalClosingCosts)}</span>
          </div>
          <Separator />
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground flex items-center gap-2"><Percent className="h-4 w-4" />Loan-to-Value (LTV)</span>
            <div className="flex items-center gap-2">
              <span className={cn("font-semibold", isHighLtv ? "text-amber-600" : "text-green-600")}>
                {results.ltvRatio.toFixed(1)}%
              </span>
              {isHighLtv && <AlertTriangle className="h-4 w-4 text-amber-500" />}
            </div>
          </div>
          {refinanceType === "cash_out" && (
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Max Cash-Out Available</span>
              <span className="font-semibold">{formatCurrency(results.cashOutAvailable)}</span>
            </div>
          )}
          {isHighLtv && (
            <Alert variant="destructive" className="mt-3">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>LTV exceeds 80%. This may require Private Mortgage Insurance (PMI) and could affect loan approval.</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2"><Clock className="h-5 w-5" />Break-Even Analysis</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasSavings ? (
            <>
              <div className="p-4 bg-muted rounded-md text-center">
                <p className="text-sm text-muted-foreground mb-1">Break-Even Point</p>
                <p className="text-2xl font-bold">{results.breakEvenMonths} {results.breakEvenMonths === 1 ? "month" : "months"}</p>
                <p className="text-xs text-muted-foreground mt-1">({(results.breakEvenMonths / 12).toFixed(1)} years)</p>
              </div>
              {results.breakEvenMonths <= 24 && (
                <div className="flex items-center gap-2 text-green-600 text-sm">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Great! You'll recover closing costs in under 2 years.</span>
                </div>
              )}
            </>
          ) : (
            <div className="p-4 bg-amber-50 rounded-md text-center">
              <AlertTriangle className="h-6 w-6 text-amber-500 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">This refinance may not save you money. Consider a lower rate.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-lg">Total Interest Comparison</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Current Loan Interest</span>
            <span className="font-semibold">{formatCurrency(results.totalInterestCurrent)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">New Loan Interest</span>
            <span className="font-semibold">{formatCurrency(results.totalInterestNew)}</span>
          </div>
          <Separator />
          <div className="flex justify-between items-center">
            <span className="font-medium">Net Savings (After Closing Costs)</span>
            <span className={cn("text-lg font-bold", results.totalSavings > 0 ? "text-green-600" : "text-amber-600")}>
              {formatCurrency(Math.abs(results.totalSavings))}{results.totalSavings < 0 && " (Loss)"}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
