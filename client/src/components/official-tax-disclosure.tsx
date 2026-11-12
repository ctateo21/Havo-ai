import React from "react";
import { Loader2 } from "lucide-react";
import type { OfficialTaxBreakdown, TaxPart } from "@shared/official-tax";

const dollars = (cents: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(cents / 100);

function Part({ label, part, provenance = true }: { label: string; part?: TaxPart; provenance?: boolean }) {
  const source = part?.source;
  return (
    <div className="space-y-1 border-t border-border pt-2">
      <div className="flex flex-wrap justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        {part?.cents != null
          ? <span>{dollars(part.cents)}/yr</span>
          : <span className="text-muted-foreground">Unavailable — {part?.reason || "Official county data not returned"}</span>}
      </div>
      {part?.lines?.map((line, index) => (
        <div key={`${line.name}-${index}`} className="flex justify-between gap-3 pl-2 text-[11px] text-muted-foreground">
          <span>{line.name}</span><span>{dollars(line.amount)}</span>
        </div>
      ))}
      {source && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>
          {" · "}Tax year {source.taxYear}{" · "}Parcel {source.parcelId}
          <br />
          Fetched {new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York", dateStyle: "medium", timeStyle: "long",
          }).format(new Date(source.fetchedAt))} (America/New_York)
          <br />
          Purchase price: {source.purchasePrice != null
            ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(source.purchasePrice)
            : "not supplied"}{" · "}Homestead: {source.homestead === undefined ? "not supplied" : source.homestead ? "yes" : "no"}
        </p>
      )}
      {provenance && !source && part?.cents != null && (
        <p className="text-[11px] text-muted-foreground">Provenance unavailable — county source details were not supplied.</p>
      )}
    </div>
  );
}

export function OfficialTaxDisclosure({ breakdown, loading, reason }: {
  breakdown?: OfficialTaxBreakdown;
  loading: boolean;
  reason?: string | null;
}) {
  return (
    <section aria-label="Official property tax breakdown" aria-busy={loading} className="space-y-2 rounded-md border border-border p-3" data-testid="official-tax-breakdown">
      <p className="text-xs font-semibold">Official county tax disclosures</p>
      {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />Checking official county sources…
      </p>}
      <Part label="Ad valorem — county estimator" part={breakdown?.adValorem} />
      <Part label="Non-ad valorem — tax collector" part={breakdown?.nonAdValorem} />
      <Part label="Total annual property tax" provenance={false} part={breakdown?.total ?? { cents: null, reason: reason || "Official tax components missing" }} />
      {breakdown?.warnings.map((warning, index) => (
        <p key={index} className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900">{warning}</p>
      ))}
    </section>
  );
}
