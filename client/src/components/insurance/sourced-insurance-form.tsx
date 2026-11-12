import type { ComponentProps } from "react";
import { InsuranceEstimateForm } from "./insurance-estimate-form";

export type FieldEvidence = { value: unknown; source: string; sourceUrl?: string; fetchedAt?: string };
export type PropertyEvidence = Partial<Record<"yearBuilt" | "squareFeetLiving" | "constructionLabel" | "floodZone", FieldEvidence>>;
export type RoofSuggestion = { year?: number; roofYear?: number; permitDate?: string; source?: string; sourceUrl?: string };
type Props = ComponentProps<typeof InsuranceEstimateForm> & {
  fieldSources: PropertyEvidence;
  fieldLocks: { yearBuilt: boolean; squareFeet: boolean; construction: boolean; floodZone: boolean };
  constructionKnown: boolean;
  policyAnswered: boolean;
  roofPermits: RoofSuggestion[];
  sqFtConfirmed: boolean;
  onSqFtConfirmedChange: (value: boolean) => void;
  floodZoneUnknown: boolean;
  onFloodZoneUnknownChange: (value: boolean) => void;
  rebuildExplanation: string;
};
const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelClass = "block text-xs font-semibold uppercase tracking-wide text-muted-foreground";
export const ROOF_YEAR_ERROR = "Enter a whole year from 2000 to 2027.";
export function validRoofYear(value: number) { return Number.isInteger(value) && value >= 2000 && value <= 2027; }

function Evidence({ evidence, manual }: { evidence?: FieldEvidence; manual?: boolean }) {
  if (!evidence) return <p className="text-xs text-muted-foreground">{manual ? "Source: Manual entry." : "Source unavailable — please verify."}</p>;
  let url: string | undefined;
  try {
    if (typeof evidence.sourceUrl === "string") {
      const parsed = new URL(evidence.sourceUrl);
      if (["https:", "http:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password) url = parsed.href;
    }
  } catch { /* Invalid source URLs remain readable attribution, not links. */ }
  return <p className="text-xs leading-relaxed text-muted-foreground">
    {manual ? "Manual entry. Lookup reference: " : "Source: "}
    {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{evidence.source}</a> : evidence.source}
    {evidence.fetchedAt ? ` · Retrieved ${evidence.fetchedAt}` : ""}
    {manual ? ` · Reported value: ${String(evidence.value ?? "Unavailable")}` : ""}
  </p>;
}

export function SourcedInsuranceForm(p: Props) {
  const claims = p.claimRecords ?? [];
  const updateClaim = (index: number, patch: Partial<(typeof claims)[number]>) => p.onClaimRecordsChange?.(claims.map((claim, i) => i === index ? { ...claim, ...patch } : claim));
  const select = (label: string, value: string, change: (value: string) => void, choices: [string, string][], testId?: string) => (
    <label className="block space-y-1.5"><span className={labelClass}>{label}</span><select className={inputClass} value={value} onChange={e => change(e.target.value)} data-testid={testId}><option value="">— select —</option>{choices.map(([v, text]) => <option value={v} key={v}>{text}</option>)}</select></label>
  );
  const bool = (label: string, value: boolean | null | undefined, change: (value: boolean | null) => void, testId?: string) =>
    select(label, value == null ? "" : value ? "yes" : "no", v => change(v === "" ? null : v === "yes"), [["yes", "Yes"], ["no", "No"]], testId);
  const numericSelect = (label: string, value: number, change: (value: number) => void, choices: [number, string][]) =>
    select(label, value < 0 ? "" : String(value), v => change(v === "" ? -1 : Number(v)), choices.map(([v, text]) => [String(v), text]));
  return <div className="space-y-5">
    {select("Policy Type", p.policyType, v => p.onPolicyTypeChange(v as Props["policyType"]), [["HO3", "HO3 — Homeowners"], ["HO6", "HO6 — Condo"], ["DP3", "DP3 — Dwelling fire"]], "select-policy-type")}
    {!p.policyAnswered && <div className="space-y-2 text-xs"><p className="text-destructive">Required — select or confirm the policy type. The default has not been answered.</p>{p.policyType && <button type="button" className="rounded border border-primary/30 px-3 py-1.5 text-primary" onClick={() => p.onPolicyTypeChange(p.policyType)}>Confirm policy type: {p.policyType}</button>}</div>}
    {p.policyTypeNote && <p className="text-xs text-muted-foreground">{p.policyTypeNote}</p>}
    {bool("Any insurance claims in the past five years?", p.hasClaims, v => p.onHasClaimsChange?.(v), "select-prior-claims")}
    {p.hasClaims && <div className="space-y-3 rounded-lg border border-border p-3">
      {claims.map((claim, i) => <fieldset key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-2"><legend className="mb-2 text-sm font-semibold">Claim {i + 1}</legend>
        <label className="text-xs">Loss date<input type="date" className={inputClass} value={claim.lossDate} onChange={e => updateClaim(i, { lossDate: e.target.value })} /></label>
        <label className="text-xs">Type / cause<input className={inputClass} value={claim.claimDetail} onChange={e => updateClaim(i, { claimDetail: e.target.value })} /></label>
        <label className="text-xs">Amount<input type="number" min="1" className={inputClass} value={claim.amount} onChange={e => updateClaim(i, { amount: e.target.value ? Number(e.target.value) : "" })} /></label>
        {bool("Paid?", claim.paid, paid => updateClaim(i, { paid }))}
        {bool("At a prior residence?", claim.priorResidence, priorResidence => updateClaim(i, { priorResidence }))}
        <button type="button" className="text-left text-xs text-primary" onClick={() => p.onClaimRecordsChange?.(claims.filter((_, n) => n !== i))}>Remove claim</button>
      </fieldset>)}
      {claims.length < 3 && <button type="button" className="text-sm text-primary" onClick={() => p.onClaimRecordsChange?.([...claims, { lossDate: "", claimDetail: "", amount: "", paid: null, priorResidence: null }])}>Add claim</button>}
    </div>}
    {bool("Is this a new purchase?", p.newPurchase, p.onNewPurchaseChange, "select-new-purchase")}
    {p.newPurchase !== null && <label className="block space-y-1.5"><span className={labelClass}>{p.newPurchase ? "Expected closing date" : "Requested policy effective date"}</span><input type="date" value={p.purchaseDate} onChange={e => p.onPurchaseDateChange(e.target.value)} className={inputClass} data-testid="input-purchase-date" /></label>}
    {p.newPurchase === false && <>
      {bool("Is this property currently insured?", p.currentlyInsured, v => p.onCurrentlyInsuredChange?.(v), "select-currently-insured")}
      {p.currentlyInsured && <>
        <label className="block space-y-1.5"><span className={labelClass}>Current carrier</span><input value={p.currentCarrier ?? ""} onChange={e => p.onCurrentCarrierChange?.(e.target.value)} className={inputClass} data-testid="input-current-carrier" /></label>
        <label className="block space-y-1.5"><span className={labelClass}>Current policy expiration date</span><input type="date" value={p.currentPolicyExpirationDate ?? ""} onChange={e => p.onCurrentPolicyExpirationDateChange?.(e.target.value)} className={inputClass} data-testid="input-current-policy-expiration-date" /><span className="text-xs text-muted-foreground">Saved privately to your account for this property.</span></label>
      </>}
    </>}
    <label className="block space-y-1.5"><span className={labelClass}>Property purchase price / current value</span><input type="number" min="1" value={p.purchasePrice || ""} onChange={e => p.onPurchasePriceChange(Number(e.target.value))} className={inputClass} data-testid="input-property-purchase-price" /><span className="text-xs text-muted-foreground">Source: {p.purchasePriceSource || "Required — enter a confirmed value."} This is not the rebuild cost.</span></label>
    {p.policyType !== "DP3" && select("Residence use", p.residenceUse, v => p.onResidenceUseChange(v as Props["residenceUse"]), [["primary", "Primary residence"], ["secondary", "Secondary residence"], ...(p.policyType === "HO6" ? [["investment", "Investment property"] as [string, string]] : [])], "select-ho6-residence-use")}
    {(p.policyType === "DP3" || p.residenceUse === "investment") && select("Rental term", p.rentalTerm, v => p.onRentalTermChange(v as Props["rentalTerm"]), [["annual", "Annual / long-term"], ["monthly", "Monthly"], ["weekly", "Weekly / short-term"]], "select-rental-term")}
    <label className="block space-y-1.5"><span className={labelClass}>Estimated Rebuild / Replacement Cost (Coverage A)</span><input type="number" min="1" value={p.rebuild || ""} onChange={e => p.onRebuildChange(Number(e.target.value))} className={inputClass} data-testid="input-coverage-a" /><span className="block text-xs text-muted-foreground">{p.rebuildExplanation}</span></label>
    <div className="rounded-lg border border-primary/15 bg-primary/5 p-3 text-xs leading-relaxed">Rebuild cost can be higher while a carrier's premium is lower: safer construction and mitigation can reduce insured risk. Rebuild cost is not market value; carriers may adjust Coverage A after reviewing the property.</div>
    <label className="block space-y-1.5"><span className={labelClass}>Estimated roof year</span><input type="number" step="1" min="2000" max="2027" value={p.roofYear || ""} onChange={e => p.onRoofYearChange(e.target.value === "" ? 0 : Number(e.target.value))} className={inputClass} aria-invalid={!validRoofYear(p.roofYear)} aria-describedby="roof-year-error" data-testid="input-roof-year" /></label>
    {!validRoofYear(p.roofYear) && <p id="roof-year-error" className="text-xs text-destructive">{ROOF_YEAR_ERROR}</p>}
    {!!p.roofPermits.length && <div className="space-y-2 rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">County roof permits are suggestions, not confirmed roof ages. Select a year only if it matches your property.</p>{p.roofPermits.map((permit, i) => {
      const year = permit.year ?? permit.roofYear ?? Number(permit.permitDate?.slice(0, 4));
      return validRoofYear(year) ? <button key={i} type="button" className="mr-2 rounded border border-primary/30 px-3 py-1 text-xs text-primary" onClick={() => p.onRoofYearChange(year)}>Use {year}{permit.source ? ` · ${permit.source}` : ""}</button> : null;
    })}</div>}
    {numericSelect("Hurricane impact-rated doors and windows or shutters?", p.openingProtection, p.onOpeningProtectionChange, [[0, "No"], [1, "Yes"]])}
    {numericSelect("Roof shape", p.roofShape, p.onRoofShapeChange, [[0, "Hip roof"], [1, "Flat roof"], [2, "Other / unsure"]])}
    {numericSelect("Second Water Resistance Layer (SWR)?", p.swr, p.onSwrChange, [[2, "Yes"], [0, "No"], [1, "Unsure"]])}
    {numericSelect("Hurricane deductible", p.hurricaneDeductible, p.onHurricaneDeductibleChange, [[0, "2% of dwelling — standard"], [1, "5% of dwelling"], [2, "10% of dwelling"]])}
    {numericSelect("Construction Type", p.construction, p.onConstructionChange, [[0, "Concrete Block"], [2, "Frame"], [1, "Mix"]])}
    {!p.constructionKnown && <div className="space-y-2 text-xs"><p className="text-destructive">Assumed — confirm. Select or confirm construction before estimating Coverage A.</p>{[0, 1, 2].includes(p.construction) && <button type="button" className="rounded border border-primary/30 px-3 py-1.5 text-primary" onClick={() => p.onConstructionChange(p.construction)}>Confirm construction type: {["Concrete Block", "Mix", "Frame"][p.construction]}</button>}</div>}
    <Evidence evidence={p.fieldSources.constructionLabel} manual={p.fieldLocks.construction} />
    <label className="block space-y-1.5"><span className={labelClass}>What year was the home built?</span><input type="number" min="1800" max="2027" step="1" value={p.yearBuilt || ""} onChange={e => p.onYearBuiltChange(Number(e.target.value))} className={inputClass} data-testid="input-year-built" /></label>
    <Evidence evidence={p.fieldSources.yearBuilt} manual={p.fieldLocks.yearBuilt} />
    <label className="block space-y-1.5"><span className={labelClass}>Living area (square feet)</span><input type="number" min="1" value={p.squareFeet || ""} onChange={e => { p.onSquareFeetChange?.(Number(e.target.value)); p.onSqFtConfirmedChange(false); }} className={inputClass} data-testid="input-square-feet" /></label>
    <Evidence evidence={p.fieldSources.squareFeetLiving} manual={p.fieldLocks.squareFeet} />
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" required aria-required="true" className="mt-1 accent-primary" checked={p.sqFtConfirmed} onChange={e => p.onSqFtConfirmedChange(e.target.checked)} data-testid="confirm-square-footage" /><span>I confirm the living area square footage for this property.</span></label>
    {!p.sqFtConfirmed && <p className="text-xs text-destructive">Confirm square footage before requesting quotes.</p>}
    {p.propertyCharacteristicsNote && <p className="text-xs text-muted-foreground">{p.propertyCharacteristicsNote}</p>}
    {numericSelect("AOP Deductible (all other perils)", p.aopDeductible, p.onAopDeductibleChange, [[500, "$500"], [1000, "$1,000"], [2500, "$2,500"], [5000, "$5,000"], [10000, "$10,000"]])}
    <label className="block space-y-1.5"><span className={labelClass}>Flood zone</span><input value={p.floodZone ?? ""} disabled={p.floodZoneUnknown} onChange={e => p.onFloodZoneChange?.(e.target.value.toUpperCase())} className={inputClass} data-testid="text-flood-zone" /><span className="block text-xs text-muted-foreground">{p.floodZoneSource}</span></label>
    <Evidence evidence={p.fieldSources.floodZone} manual={p.fieldLocks.floodZone} />
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={p.floodZoneUnknown} onChange={e => p.onFloodZoneUnknownChange(e.target.checked)} className="mt-1 accent-primary" /><span>I don't know my flood zone — ask my agent to verify.</span></label>
    <div className="rounded-2xl bg-primary p-6 text-primary-foreground shadow-lg"><div className="text-xs font-semibold uppercase tracking-widest opacity-70">Estimated Annual Premium</div><div className="mt-2 font-mono text-4xl font-bold" data-testid="estimated-annual-premium">{p.rebuild > 0 ? `$${Math.round(p.annualPremium).toLocaleString()}` : "—"}</div><p className="mt-2 text-xs opacity-70">Midpoint planning estimate{p.rebuild > 0 ? " based on your answers." : " — enter Coverage A first."}</p></div>
  </div>;
}
