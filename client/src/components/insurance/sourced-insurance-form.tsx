import type { ComponentProps } from "react";
import { InsuranceEstimateForm } from "./insurance-estimate-form";

export type FieldEvidence = { value: unknown; source: string; sourceUrl?: string; fetchedAt?: string };
export type PropertyEvidence = Partial<Record<"yearBuilt" | "squareFeetLiving" | "constructionLabel" | "floodZone", FieldEvidence>>;
export type RoofSuggestion = { year?: number; roofYear?: number; permitDate?: string; source?: string; sourceUrl?: string };
type Props = ComponentProps<typeof InsuranceEstimateForm> & {
  hideWindQuestions?: boolean;
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
  onResetRebuild?: () => void;
  roofMaterial?: string;
  onRoofMaterialChange?: (value: string) => void;
  floodNotice?: string;
};
const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelClass = "block text-sm font-medium text-foreground";
export const ROOF_YEAR_ERROR = "Enter a whole year from 2000 to 2027.";
export function validRoofYear(value: number) { return Number.isInteger(value) && value >= 2000 && value <= 2027; }

function Evidence({ evidence, manual }: { evidence?: FieldEvidence; manual?: boolean }) {
  if (!evidence) return <p className="text-xs text-muted-foreground">{manual ? "Your entry; not independently verified." : "Not independently verified. You can edit this value."}</p>;
  let url: string | undefined;
  try {
    const parsed = new URL(evidence.sourceUrl || "");
    if (["https:", "http:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password) url = parsed.href;
  } catch { /* Untrusted URLs are never linked. */ }
  return <p className="text-xs leading-relaxed text-muted-foreground">
    {manual ? "Your entry. Lookup reference: " : "Lookup source: "}
    {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{evidence.source}</a> : evidence.source}
    {evidence.fetchedAt ? ` · Retrieved ${evidence.fetchedAt}` : ""}
    {manual ? ` · Reported value: ${String(evidence.value ?? "Unavailable")}` : ""}
  </p>;
}

export function SourcedInsuranceForm(p: Props) {
  const select = (label: string, value: string, change: (value: string) => void, choices: [string, string][], testId?: string) => (
    <label className="block space-y-1.5"><span className={labelClass}>{label}</span><select aria-label={label} className={inputClass} value={value} onChange={e => change(e.target.value)} data-testid={testId}>{!value && <option value="">Select an answer</option>}{choices.map(([v, text]) => <option value={v} key={v}>{text}</option>)}</select></label>
  );
  const bool = (label: string, value: boolean | null | undefined, change: (value: boolean | null) => void, testId?: string) =>
    select(label, value == null ? "" : value ? "yes" : "no", v => change(v === "" ? null : v === "yes"), [["yes", "Yes"], ["no", "No"]], testId);
  const numericSelect = (label: string, value: number, change: (value: number) => void, choices: [number, string][]) =>
    select(label, value < 0 ? "" : String(value), v => change(Number(v)), choices.map(([v, text]) => [String(v), text]));
  const zone = p.floodZone?.trim();
  return <div className="space-y-5">
    {select("Policy type", p.policyType, v => p.onPolicyTypeChange(v as Props["policyType"]), [["HO3", "Homeowners (HO-3)"], ["HO6", "Condo (HO-6)"], ["DP3", "Dwelling Fire / Landlord Policy (DP-3)"]], "select-policy-type")}
    <p className="text-xs leading-relaxed text-muted-foreground">We assume no insurance claims in the past five years. A claims history can change your premium.</p>
    {bool("Is this a new purchase?", p.newPurchase, p.onNewPurchaseChange, "select-new-purchase")}
    {p.newPurchase === false && <>
      <label className="block space-y-1.5"><span className={labelClass}>Requested policy effective date</span><input type="date" value={p.purchaseDate} onChange={e => p.onPurchaseDateChange(e.target.value)} className={inputClass} data-testid="input-purchase-date" /></label>
      {bool("Is this property currently insured?", p.currentlyInsured, v => p.onCurrentlyInsuredChange?.(v), "select-currently-insured")}
      {p.currentlyInsured && <>
        <label className="block space-y-1.5"><span className={labelClass}>Current carrier</span><input value={p.currentCarrier ?? ""} onChange={e => p.onCurrentCarrierChange?.(e.target.value)} className={inputClass} data-testid="input-current-carrier" /></label>
        <label className="block space-y-1.5"><span className={labelClass}>Current policy expiration date</span><input type="date" value={p.currentPolicyExpirationDate ?? ""} onChange={e => p.onCurrentPolicyExpirationDateChange?.(e.target.value)} className={inputClass} data-testid="input-current-policy-expiration-date" /><span className="text-xs text-muted-foreground">Saved privately to your account for this property.</span></label>
      </>}
    </>}
    <label className="block space-y-1.5"><span className={labelClass}>Property purchase price / current value</span><input type="number" min="1" value={p.purchasePrice || ""} onChange={e => p.onPurchasePriceChange(Number(e.target.value))} className={inputClass} data-testid="input-property-purchase-price" /><span className="text-xs text-muted-foreground">{p.purchasePriceSource ? `Source: ${p.purchasePriceSource}.` : "Enter the purchase price or current property value."} This is not the rebuild cost.</span></label>
    {p.policyType !== "DP3" && select("Residence use", p.residenceUse, v => p.onResidenceUseChange(v as Props["residenceUse"]), [["primary", "Primary residence"], ["secondary", "Secondary residence"], ...(p.policyType === "HO6" ? [["investment", "Investment property"] as [string, string]] : [])], "select-ho6-residence-use")}
    {(p.policyType === "DP3" || p.residenceUse === "investment") && select("Rental term", p.rentalTerm, v => p.onRentalTermChange(v as Props["rentalTerm"]), [["annual", "Annual / long-term"], ["monthly", "Monthly"], ["weekly", "Weekly / short-term"]], "select-rental-term")}
    <label className="block space-y-1.5"><span className={labelClass}>Estimated roof year</span><input type="number" required step="1" min="2000" max="2027" value={p.roofYear || ""} onChange={e => p.onRoofYearChange(e.target.value === "" ? 0 : Number(e.target.value))} className={inputClass} aria-invalid={!validRoofYear(p.roofYear)} aria-describedby={!validRoofYear(p.roofYear) ? "roof-year-error" : undefined} data-testid="input-roof-year" /></label>
    {select("Roof type", p.roofMaterial ?? "Architectural Shingles", v => p.onRoofMaterialChange?.(v), [["Architectural Shingles", "Shingle"], ["Metal", "Metal"], ["Tile", "Tile"], ["Other", "Other"]], "select-roof-material")}
    {!validRoofYear(p.roofYear) && <p id="roof-year-error" className="text-xs text-destructive">{ROOF_YEAR_ERROR}</p>}
    {!!p.roofPermits.length && <p className="text-xs leading-relaxed text-muted-foreground">Roof year may be filled from a county permit. Permit dates are clues, not proof of installation. Please edit the year if needed.</p>}
    {!p.hideWindQuestions && <>
      {numericSelect("Impact-rated windows and doors or shutters?", p.openingProtection, p.onOpeningProtectionChange, [[1, "Yes"], [0, "No/Unsure"]])}
      {numericSelect("Roof shape", p.roofShape === 2 ? 3 : p.roofShape, p.onRoofShapeChange, [[1, "Flat"], [3, "Gable/Other"], [0, "Hip"]])}
      {numericSelect("Secondary water resistance (SWR)?", p.swr === 1 ? 0 : p.swr, p.onSwrChange, [[2, "Yes"], [0, "No/Unsure"]])}
    </>}
    {numericSelect("Construction", p.construction, p.onConstructionChange, [[0, "Block"], [2, "Frame"], [1, "Mixed"]])}
    <label className="block space-y-1.5"><span className={labelClass}>What year was the home built?</span><input type="number" min="1800" max="2027" step="1" value={p.yearBuilt || ""} onChange={e => p.onYearBuiltChange(Number(e.target.value))} className={inputClass} data-testid="input-year-built" /></label>
    <label className="block space-y-1.5"><span className={labelClass}>Living area (square feet)</span><input type="number" min="1" value={p.squareFeet || ""} onChange={e => p.onSquareFeetChange?.(Number(e.target.value))} className={inputClass} data-testid="input-square-feet" /></label>
    {numericSelect("AOP deductible (all other perils)", p.aopDeductible, p.onAopDeductibleChange, [[500, "$500"], [1000, "$1,000"], [2500, "$2,500"], [5000, "$5,000"], [10000, "$10,000"]])}
    {numericSelect("Hurricane deductible", p.hurricaneDeductible, p.onHurricaneDeductibleChange, [[0, "2% of Dwelling"], [1, "5% of Dwelling"], [2, "10% of Dwelling"]])}
    <div className="space-y-1.5"><p className={labelClass}>FEMA flood zone</p><p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="text-flood-zone">{zone || "Not verified yet"}</p><p className="text-xs leading-relaxed text-muted-foreground">{p.floodZoneSource || "We check the FEMA flood map for this address. You can correct the zone under property assumptions."}</p></div>
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">Property assumptions and sources</summary>
      <div className="mt-4 space-y-3">
        <p className="text-xs text-muted-foreground">Property records can be incomplete. The home details above remain editable.</p>
        <p className="text-xs font-medium">Construction</p><Evidence evidence={p.fieldSources.constructionLabel} manual={p.fieldLocks.construction} />
        <p className="text-xs font-medium">Year built</p><Evidence evidence={p.fieldSources.yearBuilt} manual={p.fieldLocks.yearBuilt} />
        <p className="text-xs font-medium">Living area</p><Evidence evidence={p.fieldSources.squareFeetLiving} manual={p.fieldLocks.squareFeet} />
        <label className="block space-y-1.5"><span className={labelClass}>Correct flood zone</span><input value={p.floodZone ?? ""} onChange={e => p.onFloodZoneChange?.(e.target.value.toUpperCase())} className={inputClass} data-testid="input-assumed-flood-zone" /></label>
        <Evidence evidence={p.fieldSources.floodZone} manual={p.fieldLocks.floodZone} />
      </div>
    </details>
    <div className="space-y-3 border-t border-border pt-5">
      <label className="block space-y-1.5"><span className={labelClass}>Estimated rebuild / replacement cost (Coverage A)</span><input type="number" min="1" value={p.rebuild || ""} onChange={e => p.onRebuildChange(Number(e.target.value))} className={inputClass} data-testid="input-coverage-a" /><span className="block text-xs leading-relaxed text-muted-foreground">{p.rebuildExplanation}</span></label>
      {p.onResetRebuild && <button type="button" className="text-xs font-medium text-primary underline underline-offset-2" onClick={p.onResetRebuild}>Reset to calculated rebuild cost</button>}
      <p className="text-xs leading-relaxed text-muted-foreground">Rebuild cost is not market value. Safer construction and mitigation may lower premiums even when rebuilding costs more. Carriers may adjust Coverage A after reviewing the home.</p>
    </div>
    <div className="rounded-2xl bg-primary p-6 text-primary-foreground shadow-lg">
      <div className="text-xs font-semibold uppercase tracking-widest opacity-70">Estimated annual premium</div>
      <div className="mt-2 font-mono text-4xl font-bold" data-testid="estimated-annual-premium">{p.rebuild > 0 ? `$${Math.round(p.annualPremium).toLocaleString()}` : "—"}</div>
      <p className="mt-2 text-xs opacity-80">Midpoint planning estimate{p.rebuild > 0 ? " based on your answers." : " — enter Coverage A first."}</p>
      <div className="mt-4 border-t border-primary-foreground/20 pt-4 text-xs leading-relaxed">
        <strong>Flood insurance is separate and is not included above.</strong>
        <p className="mt-1">{p.floodNotice || (zone && /^[AV]/i.test(zone) ? `This home is in FEMA flood zone ${zone}, a Special Flood Hazard Area. A lender may require flood coverage. We can run flood through QuoteRush too. An insurance agent can quote flood insurance separately.` : zone ? `This home is in FEMA flood zone ${zone}. Flooding can still happen outside high-risk zones. An insurance agent can quote flood insurance separately.` : "The FEMA zone is not verified yet. An insurance agent can verify the zone and quote flood insurance separately.")}</p>
      </div>
    </div>
  </div>;
}
