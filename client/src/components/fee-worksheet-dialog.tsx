// Initial Fees Worksheet popup — modeled on a lender "Initial Fees
// Worksheet / Loan Estimate". Rendered from the shared fee-worksheet
// model so every figure stays in lockstep with the estimate page calc.
import { useEffect, useRef, useState } from "react";
import {MortgageCompliance} from "./mortgage-compliance";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { CalendarClock, Download, FileText, Loader2, Save, Share2 } from "lucide-react";
import type { FeeWorksheet, FeeSection, FeeLine } from "@/lib/fee-worksheet";
import { money } from "@/lib/fee-worksheet";
import {
  resolvePurchaseLenderInfo,
  type PurchaseLenderInfo,
} from "@/lib/lender-info";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import AuthDialog from "@/components/ui/auth-dialog";
import { getSession } from "@/lib/auth";
import { formatAprParenthetical } from "@/lib/apr-disclosure";

function LineRow({ line, indent }: { line: FeeLine; indent?: boolean }) {
  return (
    <div className={`flex justify-between items-baseline gap-2 py-[3px] ${indent ? "pl-3" : ""}`}>
      <span className="text-xs text-muted-foreground leading-snug">
        {line.label}
        {line.note && <span className="ml-1 opacity-70">({line.note})</span>}
      </span>
      <span className="text-xs tabular-nums whitespace-nowrap">{money(line.amount)}</span>
    </div>
  );
}

function SectionBlock({ section }: { section: FeeSection }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="flex justify-between items-baseline mb-1.5">
        <h4 className="text-xs font-bold uppercase tracking-wide text-primary">{section.title}</h4>
        <span className="text-xs font-bold tabular-nums">{money(section.subtotal)}</span>
      </div>
      {section.lines.map((l, i) => (
        <LineRow key={i} line={l} />
      ))}
      {section.groups?.map((g, gi) => (
        <div key={gi} className="mt-1.5">
          <p className="text-[11px] font-semibold text-foreground/80 mb-0.5">{g.heading}</p>
          {g.lines.map((l, i) => (
            <LineRow key={i} line={l} indent />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface FeeWorksheetMeta {
  address?: string;
  purchasePrice: number;
  loanAmount: number;
  loanTypeLabel: string;
  ratePct: number;
  aprPct: number;
  occupancyLabel?: string;
}

export type IfwActivityAction = "save" | "download" | "share";

interface PendingIfwAction {
  action: IfwActivityAction;
  save?: () => void | Promise<void>;
  createPdfFile?: (lenderInfo: PurchaseLenderInfo) => File | null;
  notify?: (action: IfwActivityAction) => void | Promise<void>;
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function FeeWorksheetDialog({
  open,
  onOpenChange,
  worksheet,
  meta,
  escrowsEnabled,
  onEscrowsEnabledChange,
  escrowsRequired,
  lenderInfo,
  onSave,
  createPdfFile,
  onActivity,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  worksheet: FeeWorksheet | null;
  meta: FeeWorksheetMeta | null;
  escrowsEnabled: boolean;
  onEscrowsEnabledChange: (enabled: boolean) => void;
  escrowsRequired: boolean;
  lenderInfo: PurchaseLenderInfo;
  onSave?: () => void | Promise<void>;
  createPdfFile?: (lenderInfo: PurchaseLenderInfo) => File | null;
  onActivity?: (action: IfwActivityAction) => void | Promise<void>;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [authOpen, setAuthOpen] = useState(false);
  const [workingAction, setWorkingAction] = useState<IfwActivityAction | null>(null);
  const pendingActionRef = useRef<PendingIfwAction | null>(null);

  const runAction = async (
    pending: PendingIfwAction,
    currentLenderInfo: PurchaseLenderInfo,
  ) => {
    setWorkingAction(pending.action);
    try {
      if (pending.action === "save") {
        await pending.save?.();
        void pending.notify?.("save");
        toast({
          title: "IFW saved",
          description: "This purchase scenario is saved to your dashboard.",
        });
        return;
      }

      const file = pending.createPdfFile?.(currentLenderInfo);
      if (!file) throw new Error("Add a property address and loan details before creating the IFW.");

      if (pending.action === "download") {
        downloadFile(file);
        void pending.notify?.("download");
        toast({
          title: "IFW downloaded",
          description: "Your Initial Fees Worksheet PDF is ready.",
        });
        return;
      }

      const shareData = {
        files: [file],
        title: "Initial Fees Worksheet",
        text: meta?.address ? `Initial Fees Worksheet for ${meta.address}` : "Initial Fees Worksheet",
      };
      if (
        typeof navigator.share === "function" &&
        (typeof navigator.canShare !== "function" || navigator.canShare(shareData))
      ) {
        try {
          await navigator.share(shareData);
          void pending.notify?.("share");
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // Browsers can expose Web Share but reject it after an async sign-in
          // because the original user gesture expired. Preserve the selected
          // action by falling back to a downloaded attachment.
          if (!(error instanceof DOMException && error.name === "NotAllowedError")) throw error;
        }
      }

      downloadFile(file);
      void pending.notify?.("share");
      toast({
        title: "IFW downloaded for sharing",
        description: "Direct file sharing is not available in this browser. Attach the downloaded PDF to your message.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast({
        title: `${pending.action === "save" ? "Save" : pending.action === "share" ? "Share" : "Download"} failed`,
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setWorkingAction(null);
    }
  };

  const handleAction = (action: IfwActivityAction) => {
    const pending: PendingIfwAction = {
      action,
      save: onSave,
      createPdfFile,
      notify: onActivity,
    };
    if (!user) {
      pendingActionRef.current = pending;
      setAuthOpen(true);
      return;
    }
    void runAction(pending, lenderInfo);
  };

  useEffect(() => {
    if (!user || !pendingActionRef.current) return;
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    setAuthOpen(false);
    void runAction(pending, resolvePurchaseLenderInfo(user));
    // Run only when authentication changes; the pending object snapshots
    // the exact IFW callbacks from the guest's click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!worksheet || !meta) return null;
  const fmt0 = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  const earnestMoneyEstimate = Math.round(meta.purchasePrice * 0.01);
  const inspectionFee =
    worksheet.otherFees.lines.find((line) => line.label === "Home Inspection")?.amount ?? 600;
  const appraisalFee =
    worksheet.thirdPartyFees.groups
      ?.flatMap((group) => group.lines)
      .find((line) => line.label === "Appraisal Fee")?.amount ?? 595;
  const isVaLoan = /\bVA\b/i.test(meta.loanTypeLabel);
  const estimatedPaidBeforeClosing =
    earnestMoneyEstimate + inspectionFee + (isVaLoan ? 0 : appraisalFee);
  const estimatedClosingDayRemainder = Math.max(
    0,
    worksheet.fundsToClose.estimatedCash - estimatedPaidBeforeClosing,
  );
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-fee-worksheet">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-primary">
            <FileText className="h-5 w-5" />
            Initial Fees Worksheet
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            Your actual rate, payment and costs could be higher. Get an official Loan Estimate before choosing a loan.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 rounded-md border border-primary/20 bg-primary/5 p-3 text-xs sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Lender
            </p>
            <p className="font-bold text-foreground">{lenderInfo.companyName}</p>
            <p className="text-muted-foreground">NMLS #{lenderInfo.companyNmls}</p>
            <p className="mt-1 text-muted-foreground">{lenderInfo.addressLine1}</p>
            <p className="text-muted-foreground">{lenderInfo.addressLine2}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Loan Officer
            </p>
            <p className="font-bold text-foreground">{lenderInfo.loanOfficerName}</p>
            <p className="text-muted-foreground">{lenderInfo.loanOfficerTitle}</p>
            <p className="text-muted-foreground">
              Individual MLO NMLS #{lenderInfo.loanOfficerNmls}
            </p>
          </div>
        </div>

        {/* Summary header — mirrors the top block of a lender worksheet */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 rounded-md border p-3 text-xs">
          <div>
            <p className="text-muted-foreground text-[10px] uppercase tracking-wide">Loan Purpose</p>
            <p className="font-semibold">Purchase</p>
          </div>
          <div>
            <p className="text-muted-foreground text-[10px] uppercase tracking-wide">Purchase Price</p>
            <p className="font-semibold tabular-nums">{fmt0(meta.purchasePrice)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-[10px] uppercase tracking-wide">Loan Amount</p>
            <p className="font-semibold tabular-nums">{fmt0(meta.loanAmount)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-[10px] uppercase tracking-wide">Product</p>
            <p className="font-semibold">30 Year {meta.loanTypeLabel} Fixed</p>
          </div>
          <div data-testid="worksheet-rate-disclosure">
            <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
              Interest Rate{" "}
              <em className="normal-case">{formatAprParenthetical(meta.aprPct)}</em>
            </p>
            <p className="font-semibold tabular-nums" data-testid="worksheet-rate-disclosure-value">
              {meta.ratePct.toFixed(3)}%
            </p>
          </div>
          {meta.occupancyLabel && (
            <div>
              <p className="text-muted-foreground text-[10px] uppercase tracking-wide">Occupancy</p>
              <p className="font-semibold">{meta.occupancyLabel}</p>
            </div>
          )}
          {meta.address && (
            <div className="col-span-2 sm:col-span-3">
              <p className="text-muted-foreground text-[10px] uppercase tracking-wide">Property</p>
              <p className="font-semibold">{meta.address}</p>
            </div>
          )}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-3">
            <SectionBlock section={worksheet.lenderFees} />
            <SectionBlock section={worksheet.thirdPartyFees} />
          </div>
          <div className="space-y-3">
            <SectionBlock section={worksheet.govFees} />
            {!escrowsRequired && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <label htmlFor="purchase-ifw-escrows" className="text-xs font-bold text-foreground">
                      Include escrow reserves
                    </label>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                      Prepaids always apply. Turn this off to remove the three-month insurance and property-tax reserves.
                    </p>
                  </div>
                  <Switch
                    id="purchase-ifw-escrows"
                    checked={escrowsEnabled}
                    onCheckedChange={onEscrowsEnabledChange}
                    data-testid="switch-purchase-ifw-escrows"
                  />
                </div>
              </div>
            )}
            <SectionBlock section={worksheet.prepaids} />
            <SectionBlock section={worksheet.otherFees} />
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {/* Monthly housing expense */}
          <div className="rounded-md border p-3">
            <h4 className="text-xs font-bold uppercase tracking-wide text-primary mb-1.5">
              {worksheet.monthlyHousing.title}
            </h4>
            {worksheet.monthlyHousing.lines.map((l, i) => (
              <LineRow key={i} line={l} />
            ))}
            <Separator className="my-1.5" />
            <div className="flex justify-between items-baseline">
              <span className="text-xs font-bold">Total Approximated Monthly Payment</span>
              <span className="text-sm font-bold tabular-nums text-primary">{money(worksheet.totalMonthly)}</span>
            </div>
          </div>

          {/* Funds to close */}
          <div className="rounded-md border p-3">
            <h4 className="text-xs font-bold uppercase tracking-wide text-primary mb-1.5">Estimated Funds to Close</h4>
            {worksheet.fundsToClose.lines.map((l, i) => (
              <LineRow key={i} line={l} />
            ))}
            <div className="flex justify-between items-baseline pt-1">
              <span className="text-xs font-semibold">Funds Due from Borrower (A)</span>
              <span className="text-xs font-semibold tabular-nums">{money(worksheet.fundsToClose.fundsFromBorrower)}</span>
            </div>
            <Separator className="my-1.5" />
            {worksheet.fundsToClose.credits.map((l, i) => (
              <LineRow key={i} line={l} />
            ))}
            <div className="flex justify-between items-baseline pt-1">
              <span className="text-xs font-semibold">Total Credits Applied (B)</span>
              <span className="text-xs font-semibold tabular-nums">{money(worksheet.fundsToClose.totalCredits)}</span>
            </div>
            <Separator className="my-1.5" />
            <div className="flex justify-between items-baseline">
              <span className="text-xs font-bold">Estimated Cash from Borrower (A − B)</span>
              <span className="text-sm font-bold tabular-nums text-primary">{money(worksheet.fundsToClose.estimatedCash)}</span>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-primary/20 bg-primary/5 p-4">
          <div className="mb-3 flex items-start gap-2">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <h4 className="text-sm font-bold text-primary">When You May Need Money During the Transaction</h4>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                Buying a home usually requires several smaller payments before closing—not one surprise payment at the end.
                The timing and actual amounts depend on your contract and service providers.
              </p>
            </div>
          </div>

          <div className="space-y-3 border-l-2 border-primary/20 pl-4">
            <div>
              <p className="text-xs font-bold">1. Within 3 days of going under contract</p>
              <p className="text-xs text-foreground">
                Earnest Money Deposit (estimated at 1%): <strong>{money(earnestMoneyEstimate)}</strong>
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                An EMD is required to secure the contract regardless of the negotiated amount. It is not an extra fee—it is
                credited toward your down payment and closing costs.
              </p>
            </div>
            <div>
              <p className="text-xs font-bold">2. During the first 7 days</p>
              <p className="text-xs text-foreground">
                Home inspection: typically $500–$1,000 based on the home’s size; this estimate uses <strong>{money(inspectionFee)}</strong>.
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                This is usually paid directly to the inspector and is already included in Section H above, so it reduces the
                amount still needed at closing rather than adding to it.
              </p>
            </div>
            <div>
              <p className="text-xs font-bold">3. After the inspection period</p>
              <p className="text-xs text-foreground">
                Appraisal: approximately <strong>{money(appraisalFee)}</strong>
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {isVaLoan
                  ? "For this VA loan estimate, the appraisal is not shown as an upfront payment. VA covers it initially and the borrower pays it back as part of the transaction."
                  : "This is commonly paid when the appraisal is ordered and is already included in the Third Party Fees above."}
              </p>
            </div>
            <div>
              <p className="text-xs font-bold">4. Closing day or the day before</p>
              <div className="mt-1 flex items-baseline justify-between gap-3 rounded border bg-background/80 px-3 py-2">
                <span className="text-xs font-semibold">Estimated remaining amount due</span>
                <span className="text-sm font-bold tabular-nums text-primary">{money(estimatedClosingDayRemainder)}</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                This is the estimated cash from borrower above, less the estimated 1% EMD and costs typically paid earlier.
                Transaction, survey, title, prepaid, escrow, and any applicable elevation-certificate costs are reflected in
                the worksheet and are generally settled from the remaining funds.
              </p>
            </div>
          </div>

          <div className="mt-3 rounded border bg-background/70 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <strong className="text-foreground">Plan ahead:</strong> keep funds available from contract through closing.
            Before sending money, confirm the exact amount, deadline, and wiring instructions with your lender, title company,
            or closing agent. Never rely on emailed wiring changes without independently verifying them.
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Note: this worksheet itemizes estimated fees line by line, so its totals may differ slightly from the
          simplified "Estimated Closing Costs (~3%)" figure shown on the estimate page.
        </p>
        <MortgageCompliance/>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          This estimate is provided for illustrative and informational purposes only based on the loan scenario provided.
          This is not a loan approval or commitment to lend. Rates are subject to change. Annual Percentage Rate (APR) is an
          estimate calculated by factoring in applicable fees (origination, underwriting, and other prepaid finance charges)
          plus the interest rate itself. Until you lock your rate, APR and terms are subject to change or may not be
          available at commitment or closing.
        </p>

        <div className="sticky bottom-0 -mx-6 -mb-6 border-t bg-background/95 px-6 py-4 backdrop-blur">
          <p className="mb-3 text-center text-[11px] text-muted-foreground">
            An account is required to save, download, or share this worksheet.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Button
              variant="outline"
              className="gap-2"
              disabled={workingAction !== null}
              onClick={() => handleAction("save")}
              data-testid="button-ifw-save"
            >
              {workingAction === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save IFW
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              disabled={workingAction !== null}
              onClick={() => handleAction("download")}
              data-testid="button-ifw-download"
            >
              {workingAction === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download PDF
            </Button>
            <Button
              className="gap-2"
              disabled={workingAction !== null}
              onClick={() => handleAction("share")}
              data-testid="button-ifw-share"
            >
              {workingAction === "share" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              Share IFW
            </Button>
          </div>
        </div>
        </DialogContent>
      </Dialog>
      <AuthDialog
        open={authOpen}
        onOpenChange={(next) => {
          if (!next && !getSession()) pendingActionRef.current = null;
          setAuthOpen(next);
        }}
        onAuthenticated={() => {
          const pending = pendingActionRef.current;
          const sessionUser = getSession();
          if (!pending || !sessionUser) return;
          pendingActionRef.current = null;
          void runAction(pending, resolvePurchaseLenderInfo(sessionUser));
        }}
        redirectAfterRegister={false}
        defaultTab="register"
      />
    </>
  );
}
