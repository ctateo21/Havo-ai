import React, { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { OfficialTaxDisclosure } from "./official-tax-disclosure";
import type { OfficialTaxBreakdown } from "@shared/official-tax";
import type { QuickPropertyTax } from "@/lib/quick-property-tax";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
export interface PropertyTaxRowProps {
  result?: QuickPropertyTax;
  breakdown?: OfficialTaxBreakdown;
  loading: boolean;
  reason?: string | null;
  propertyUse?: "primary" | "secondary" | "investment";
  annualTax: number | null;
  manual?: boolean;
  onManualChange: (value: number | null) => void;
  onRefresh?: () => void;
  testId?: string;
  warnings?: ReactNode;
}
export function PropertyTaxRow({ result, breakdown, loading, reason, propertyUse, annualTax, manual, onManualChange, onRefresh, testId, warnings }: PropertyTaxRowProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const visibleAnnual = propertyUse ? annualTax : null;
  const tag = manual && propertyUse ? "Your bill" : result?.status === "official" ? "Official"
    : loading || result?.officialState === "pending" ? "Est. · updating" : "Estimated";
  return <div data-testid={testId ?? "property-tax-row"}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}
      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span className="text-muted-foreground">Property Taxes</span>
      <span className="flex min-w-0 items-center justify-end gap-2">
        <span className="text-right"><span className="block font-semibold tabular-nums">{visibleAnnual !== null ? `${money(visibleAnnual / 12)}/mo` : "—"}</span>
          <span className="block text-[10px] leading-4 text-muted-foreground">{tag}</span></span>
        <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </span>
    </button>
    {open && <div id={id} className="space-y-3 rounded-md bg-muted/30 p-3 mb-2 text-xs">
      {visibleAnnual !== null && <p className="flex justify-between gap-3"><span>Annual property taxes</span><strong>{money(visibleAnnual)}/yr</strong></p>}
      <p className="text-muted-foreground">{propertyUse ? `Homestead: ${propertyUse === "primary" ? "yes (primary residence)" : "no"}` : "Select Property Use to calculate property taxes."}</p>
      {loading && <div role="status" className="space-y-1"><span>Checking property tax sources…</span><div className="h-2 w-3/5 animate-pulse rounded bg-muted" /></div>}
      {reason && <p role="status" className="text-muted-foreground">{reason}</p>}
      {propertyUse && result?.status === "unavailable" && <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
        No property tax figure is available. No fallback rate has been substituted.
        {result.officialState === "pending" ? " Official county verification is still running." : " Check the county source or ask an administrator to review rate setup, then refresh or enter your bill."}
      </p>}
      {propertyUse && result && <div className="space-y-2">
        <p className="font-medium">{result.label}</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt>Ad valorem</dt><dd className="text-right">{result.adValorem === null ? "Unavailable" : `${money(result.adValorem)}/yr`}</dd>
          <dt>Non-ad valorem</dt><dd className="text-right">{result.nav === null ? result.navPending ? "Pending" : "Unavailable" : `${money(result.nav)}/yr`}</dd>
          <dt>Tax / rates year</dt><dd className="text-right">{result.taxYear ?? "Not supplied"} / {result.ratesYear ?? "Not supplied"}</dd>
          <dt>District</dt><dd className="text-right">{result.district ?? "Not supplied"}</dd>
        </dl>
        <p className="break-words text-muted-foreground">{result.sourceUrl
          ? <a href={result.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{result.sourceName}</a> : result.sourceName}</p>
        {result.parcelId && <p className="break-words text-muted-foreground">Parcel {result.parcelId}{result.purchasePrice !== undefined ? ` · Purchase price used: ${money(result.purchasePrice)}` : ""}</p>}
        {result.status !== "official" && <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">Planning estimate, not a verified county bill. {result.navPending ? "CDD and other non-ad valorem assessments are pending and may increase this amount." : "Verify assessments, exemptions, and the applicable tax year before underwriting."}</p>}
        {result.officialState === "failed" && <p className="text-amber-900">Official verification did not complete. The estimate remains available.</p>}
      </div>}
      {propertyUse && (breakdown || result?.breakdown) && <OfficialTaxDisclosure breakdown={result?.breakdown ?? breakdown} loading={false} reason={reason} propertyUse={propertyUse} />}
      {manual && <p className="text-muted-foreground">The payment uses your bill, not the background estimate. Your bill is not county verified and will not be overwritten.</p>}
      {warnings}
      {onRefresh && <Button type="button" size="sm" variant="outline" disabled={loading || !propertyUse} onClick={onRefresh}>Refresh official county data</Button>}
      <label className="block space-y-1" htmlFor={`${id}-bill`}><span>Annual property tax bill ($)</span>
        <Input id={`${id}-bill`} data-testid="input-purchase-annual-property-tax" type="number" min="0" step="0.01" inputMode="decimal"
          placeholder="Enter your annual bill" value={manual && annualTax !== null ? annualTax : ""}
          onChange={event => {
            const raw = event.target.value;
            if (!raw) { onManualChange(null); return; }
            const value = Number(raw);
            if (Number.isFinite(value) && value >= 0) onManualChange(Math.round(value * 100) / 100);
          }} />
      </label>
      <p className="text-[11px] text-muted-foreground">Enter the full annual bill, including non-ad valorem assessments. Clear this field to use the current lookup.</p>
    </div>}
  </div>;
}
