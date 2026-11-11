import { useRef, useState } from "react";
import { analyzeDocument } from "@/lib/ai-request";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, Loader2, AlertTriangle, X, FileText } from "lucide-react";

// Compact mortgage-statement uploader for the Sell-Your-Home page.
// Reuses the same backend parser the Refinance tab uses
// (POST /api/analyze-statement) and reports the extracted balance +
// lightweight metadata back to the caller. PDF or text files, 10MB max
// (enforced server-side).

export interface ExtractedStatement {
  /** Current unpaid principal / loan balance pulled from the statement. */
  balance: number;
  lender?: string;
  confidence?: "high" | "medium" | "low";
  fileName?: string;
}

interface MortgageStatementUploadProps {
  onExtracted: (s: ExtractedStatement) => void;
}

export function MortgageStatementUpload({ onExtracted }: MortgageStatementUploadProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (f: File) => {
    if (f.type === "application/pdf" || f.type.startsWith("text/")) {
      setFile(f);
      setError(null);
    } else {
      setError("Please upload a PDF or text file.");
    }
  };

  const analyze = async () => {
    if (!file) { setError("Please choose a mortgage statement first."); return; }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await analyzeDocument("/api/analyze-statement", fd);
      const result = await res.json();
      const balance = Number(result?.analysis?.loanBalance);
      if (result?.success && result.analysis && Number.isFinite(balance) && balance > 0) {
        onExtracted({
          balance: Math.round(balance),
          lender: result.analysis.lender,
          confidence: result.analysis.confidence,
          fileName: file.name,
        });
        setFile(null);
        setOpen(false);
        if (inputRef.current) inputRef.current.value = "";
      } else {
        setError("We could not confidently pull the balance from this statement. Please enter the mortgage payoff manually.");
      }
    } catch (err) {
      console.log("[seller-payoff-statement] save error", err instanceof Error ? err.message : String(err));
      setError("We could not read that file. Please try again or enter the mortgage payoff manually.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Upload className="h-3.5 w-3.5 mr-1.5" />
        Upload Mortgage Statement
      </Button>
    );
  }

  return (
    <div className="rounded-md border p-3 space-y-2 bg-muted/30">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Upload Mortgage Statement</span>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setOpen(false); setFile(null); setError(null); }}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.txt"
        className="hidden"
        onChange={e => e.target.files?.[0] && pick(e.target.files[0])}
      />
      {file ? (
        <div className="flex items-center gap-2 text-sm">
          <FileText className="h-4 w-4 text-green-600" />
          <span className="truncate">{file.name}</span>
        </div>
      ) : (
        <Button type="button" variant="secondary" size="sm" className="w-full" onClick={() => inputRef.current?.click()}>
          Choose PDF or text file
        </Button>
      )}
      {error && (
        <Alert variant="destructive" className="py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
      <Button type="button" size="sm" className="w-full" disabled={busy || !file} onClick={analyze}>
        {busy
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Reading statement…</>
          : <><Upload className="h-4 w-4 mr-2" />Pull balance from statement</>}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        We use the unpaid principal balance — not your monthly payment, escrow, or past-due amount.
      </p>
    </div>
  );
}
