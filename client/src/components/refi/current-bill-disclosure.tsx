import React from "react";
import type { OfficialTaxBreakdown, TaxPart } from "@shared/official-tax";

const money = (cents: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(cents / 100);

function BillPart({ label, part }: { label: string; part: TaxPart }) {
  const source = part.source;
  return (
    <div className="space-y-1.5 border-t border-border pt-2 min-w-0">
      <div className="flex flex-wrap justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{part.cents == null ? "Unavailable" : `${money(part.cents)}/yr`}</span>
      </div>
      {part.reason && <p className="text-xs text-muted-foreground">{part.reason}</p>}
      {part.lines?.map((line, index) => (
        <div key={`${line.name}-${index}`} className="flex justify-between gap-3 pl-2 text-xs text-muted-foreground">
          <span className="min-w-0 break-words">{line.name}</span>
          <span className="shrink-0 tabular-nums">{money(line.amount)}</span>
        </div>
      ))}
      {source ? (
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground break-words">
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {source.name || "Official county bill"} — open source
          </a>
          <p>Tax year {source.taxYear} · Parcel {source.parcelId}</p>
          <p>Fetched {new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York", dateStyle: "medium", timeStyle: "long",
          }).format(new Date(source.fetchedAt))} (America/New_York)</p>
        </div>
      ) : <p className="text-xs text-muted-foreground">Source evidence unavailable — county source details were not supplied.</p>}
    </div>
  );
}

/** Current-owner bill language, deliberately separate from purchase estimator disclosures. */
export function CurrentBillDisclosure({ breakdown, manual = false, partial = false }: {
  breakdown?: OfficialTaxBreakdown;
  manual?: boolean;
  partial?: boolean;
}) {
  return (
    <section aria-label={partial ? "Latest county lookup evidence" : "Current bill source evidence"}
      className="space-y-2 rounded-md border border-border bg-background/60 p-3"
      data-testid="current-bill-disclosure">
      <p className="text-xs font-semibold">{partial ? "Latest lookup — incomplete county evidence" : "Current bill source evidence"}</p>
      {manual && !partial ? <p className="text-xs text-muted-foreground">Manual amount in use. No official county provenance is claimed for this value.</p>
        : breakdown ? <>
          <BillPart label="Ad valorem — current bill" part={breakdown.adValorem} />
          <BillPart label="Non-ad valorem / assessments — current bill" part={breakdown.nonAdValorem} />
          {breakdown.total.source && <BillPart label="Total annual bill" part={breakdown.total} />}
          {breakdown.warnings.map((warning, index) => <p key={index}
            className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">{warning}</p>)}
        </> : <p className="text-xs text-muted-foreground">Official bill link, parcel and county fetch time were not saved with this value. Look up the current bill to retrieve source evidence.</p>}
      {partial && <p className="text-xs text-muted-foreground">This lookup did not replace the annual amount in use.</p>}
    </section>
  );
}
