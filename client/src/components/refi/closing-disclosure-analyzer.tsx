import { useState, useRef } from "react";
import { analyzeDocument } from "@/lib/ai-request";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, FileText, Loader2, CheckCircle2, AlertTriangle, Sparkles, X } from "lucide-react";
import { formatCurrency } from "@/lib/refi-calculations";
import { cn } from "@/lib/utils";
import {
  monthlyPI,
  remainingBalance,
  paymentsMadeFromFirstPaymentDate,
  paymentsMadeSince,
  remainingYears,
} from "@/lib/amortization";
import type { MortgageAnalysis } from "./loan-tracker";
import type { TrackedLoan } from "@/lib/auth";

/** Shape returned by POST /api/analyze-closing-disclosure. */
interface ClosingDisclosureAnalysis {
  propertyAddress: string;
  lender: string;
  closingDate: string | null;
  firstPaymentDate: string | null;
  prepaidInterestThroughDate: string | null;
  purchasePrice: number;
  loanAmount: number;
  interestRate: number;
  loanTermMonths: number;
  principalAndInterest: number;
  escrowAmount: number;
  loanNumber: string | null;
  /** Loan program from the CD's page-1 "Loan Type" checkbox; null when
   *  absent/unreadable (treated as conventional downstream). */
  loanType: "conventional" | "fha" | "va" | null;
  confidence: "high" | "medium" | "low";
  rawExtractedData: Record<string, string | number>;
}

interface ClosingDisclosureAnalyzerProps {
  onAnalyzed: (analysis: MortgageAnalysis, extras: Partial<TrackedLoan>) => void;
  trackedLoanCount?: number;
  maxLoans?: number;
}

/** Derive today's loan picture from the CD's origination details via a
 *  standard amortization schedule. */
function cdToAnalysis(cd: ClosingDisclosureAnalysis): { analysis: MortgageAnalysis; extras: Partial<TrackedLoan> } {
  const termMonths = cd.loanTermMonths > 0 ? Math.round(cd.loanTermMonths) : 360;
  const monthsElapsed = cd.firstPaymentDate
    ? paymentsMadeFromFirstPaymentDate(cd.firstPaymentDate)
    : cd.closingDate
      ? paymentsMadeSince(cd.closingDate)
      : 0;
  const balance = remainingBalance(cd.loanAmount, cd.interestRate, termMonths, monthsElapsed);
  const pi = cd.principalAndInterest > 0
    ? cd.principalAndInterest
    : monthlyPI(cd.loanAmount, cd.interestRate, termMonths);
  const analysis: MortgageAnalysis = {
    loanBalance: Math.round(balance),
    interestRate: cd.interestRate,
    monthlyPayment: pi + Math.max(0, cd.escrowAmount || 0),
    principalAndInterest: pi,
    escrowAmount: Math.max(0, cd.escrowAmount || 0),
    currentEscrowBalance: null,
    propertyAddress: cd.propertyAddress,
    lender: cd.lender,
    estimatedRemainingYears: Math.round(remainingYears(termMonths, monthsElapsed) * 10) / 10,
    // The CD sale price is the assumed appraised value for refinance LTV.
    estimatedHomeValue: cd.purchasePrice > 0 ? cd.purchasePrice : 0,
    loanNumber: cd.loanNumber,
    confidence: cd.confidence,
    recommendation: "",
    potentialSavings: 0,
    rawExtractedData: cd.rawExtractedData ?? {},
  };
  const extras: Partial<TrackedLoan> = {
    entryMethod: "closing_disclosure",
    purchaseDate: cd.closingDate ?? undefined,
    firstPaymentDate: cd.firstPaymentDate ?? undefined,
    originalPurchasePrice: cd.purchasePrice > 0 ? cd.purchasePrice : undefined,
    originalLoanAmount: cd.loanAmount > 0 ? cd.loanAmount : undefined,
    originalRate: cd.interestRate > 0 ? cd.interestRate : undefined,
    originalTermMonths: termMonths,
    // CD's loan-type checkbox — the financed FHA MIP / VA funding fee is
    // already inside the page-1 Loan Amount, so no fee is re-added here;
    // capturing the program keeps FHA/VA streamline pricing correct.
    loanType: cd.loanType ?? undefined,
    estimatedHomeValueSource: cd.purchasePrice > 0 ? "statement" : undefined,
    amortizedBalanceCheck: Math.round(balance),
    balanceConfirmed: false,
  };
  return { analysis, extras };
}

export function ClosingDisclosureAnalyzer({ onAnalyzed }: ClosingDisclosureAnalyzerProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ cd: ClosingDisclosureAnalysis; balance: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(e.type === "dragenter" || e.type === "dragover");
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragActive(false);
    if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
  };
  const handleFile = (file: File) => {
    if (file.type === "application/pdf" || file.type.startsWith("text/")) {
      setUploadedFile(file); setError(null);
    } else {
      setError("Please upload a PDF or text file.");
    }
  };

  const analyze = async () => {
    if (!uploadedFile) { setError("Please upload your Final Closing Disclosure."); return; }
    setIsAnalyzing(true); setError(null);
    try {
      const formData = new FormData();
      formData.append("file", uploadedFile);
      const response = await analyzeDocument("/api/analyze-closing-disclosure", formData);
      const json = await response.json();
      if (json.success && json.analysis) {
        const cd = json.analysis as ClosingDisclosureAnalysis;
        const { analysis, extras } = cdToAnalysis(cd);
        setResult({ cd, balance: analysis.loanBalance });
        onAnalyzed(analysis, extras);
        setUploadedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      } else {
        setError(json.error || "Failed to analyze closing disclosure");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />Final Closing Disclosure
        </CardTitle>
        <CardDescription>
          Upload the Final Closing Disclosure from your purchase — we'll pull your original loan terms and estimate today's balance from the amortization schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={cn(
            "border-2 border-dashed rounded-md p-6 text-center transition-colors cursor-pointer",
            dragActive ? "border-primary bg-accent" : "border-border hover:border-primary/50 hover:bg-accent/30",
            uploadedFile && "border-green-500 bg-green-50"
          )}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => !uploadedFile && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
            className="hidden"
          />
          {uploadedFile ? (
            <div className="flex items-center justify-center gap-2">
              <FileText className="h-5 w-5 text-green-600" />
              <span className="font-medium text-sm">{uploadedFile.name}</span>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => { e.stopPropagation(); setUploadedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm font-medium mb-1">Drag and drop your Closing Disclosure here</p>
              <p className="text-xs text-muted-foreground">or click to browse · PDF or text files</p>
            </>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button onClick={analyze} disabled={isAnalyzing || !uploadedFile} className="w-full" data-testid="btn-analyze-cd">
          {isAnalyzing
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Analyzing...</>
            : <><Sparkles className="h-4 w-4 mr-2" />Analyze Closing Disclosure</>}
        </Button>

        {result && (
          <div className="space-y-3 pt-2 border-t">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="font-medium text-sm">Analysis Complete</span>
              </div>
              <Badge variant={result.cd.confidence === "high" ? "default" : result.cd.confidence === "medium" ? "secondary" : "outline"}>
                {result.cd.confidence} confidence
              </Badge>
            </div>
            <div className="p-3 bg-muted rounded-md">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><p className="text-muted-foreground text-xs">Original Loan</p><p className="font-semibold">{formatCurrency(result.cd.loanAmount)}</p></div>
                <div><p className="text-muted-foreground text-xs">Note Rate</p><p className="font-semibold">{Number(result.cd.interestRate).toFixed(3)}%</p></div>
                <div>
                  <p className="text-muted-foreground text-xs">Est. Balance Today</p>
                  <p className="font-semibold">{formatCurrency(result.balance)}</p>
                  <p className="text-xs text-amber-600">amortized estimate · verify &amp; edit</p>
                </div>
                <div><p className="text-muted-foreground text-xs">Lender</p><p className="font-semibold truncate">{result.cd.lender}</p></div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
