import React, { useId } from "react";

const field = "mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

export function PropertyTaxExemptionControls({ value, onChange, disabled }: {
  value: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  disabled: boolean;
}) {
  const id = useId();
  const manatee = String(value.county ?? "").trim().toLowerCase() === "manatee";
  return <fieldset disabled={disabled} className="mb-5 space-y-3 rounded-md border border-border bg-muted/20 p-3">
    <legend className="px-1 text-xs font-semibold">Exemption assumptions</legend>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <label className="text-xs font-medium" htmlFor={`${id}-mode`}>Exemption mode
        <select id={`${id}-mode`} className={field} value={String(value.exemption_mode ?? "county_estimator")}
          aria-describedby={`${id}-mode-note`} onChange={event => onChange({ exemption_mode: event.target.value })}>
          <option value="county_estimator">County estimator (default)</option>
          <option value="statutory_2026">Statutory · 2026</option>
        </select>
      </label>
      <label className="text-xs font-medium" htmlFor={`${id}-additional`}>Additional non-school homestead exemption ($)
        <input id={`${id}-additional`} className={field} type="number" min="0" step="0.01" inputMode="decimal"
          value={value.non_school_additional_hx == null ? "" : String(value.non_school_additional_hx)}
          aria-describedby={manatee ? `${id}-manatee-note` : `${id}-mode-note`}
          onChange={event => {
            const raw = event.target.value;
            const amount = Number(raw);
            if (raw && (!Number.isFinite(amount) || amount < 0)) return;
            onChange({ non_school_additional_hx: raw ? amount : null });
          }} />
      </label>
    </div>
    <p id={`${id}-mode-note`} className="text-xs leading-relaxed text-muted-foreground">
      County estimator is the default. Statutory 2026 is an explicit alternative; changing modes here does not rewrite the saved additional exemption. Source and millage years remain those supplied by the server.
    </p>
    {manatee && <p id={`${id}-manatee-note`} className="rounded border border-amber-200 bg-amber-50 p-2 text-xs leading-relaxed text-amber-900">
      Manatee’s saved county-estimator assumption uses a $25,000 school exemption plus a $25,000 additional non-school exemption ($50,000 total for non-school taxes). The reference sheet shows $51,411 total. Which amount should govern is undecided; keep the saved $25,000 additional amount unless a documented decision authorizes a change.
    </p>}
    <div className="space-y-2 border-t border-border pt-3">
      <label className="flex items-center gap-2 text-xs font-medium" htmlFor={`${id}-amendment`}>
        <input id={`${id}-amendment`} type="checkbox" checked={value.amendment3_2027 === true}
          aria-describedby={`${id}-amendment-note`} onChange={event => onChange({ amendment3_2027: event.target.checked })} />
        Amendment 3 · 2027 scenario
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{value.amendment3_2027 === true ? "On" : "Off (default)"}</span>
      </label>
      <p id={`${id}-amendment-note`} className="text-xs leading-relaxed text-muted-foreground">
        Off by default. The 2027 scenario uses a $150,000 non-school exemption and a $25,000 school exemption. Eligibility and residency exceptions have not been determined. Do not infer or apply a nonhomestead assessment cap from purchase price alone.
      </p>
    </div>
  </fieldset>;
}
