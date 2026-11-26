import { useState } from "react";
import { Separator } from "@/components/ui/separator";

export type InsurancePolicyType = "HO3" | "HO6" | "DP3" | "";
export type ResidenceUse = "primary" | "secondary" | "investment" | "";
export type RentalTerm = "annual" | "monthly" | "weekly" | "";

export interface InsuranceEstimateFormProps {
  policyType: InsurancePolicyType;
  onPolicyTypeChange: (value: InsurancePolicyType) => void;
  policyTypeNote?: string;
  newPurchase: boolean | null;
  onNewPurchaseChange: (value: boolean | null) => void;
  currentlyInsured?: boolean | null;
  onCurrentlyInsuredChange?: (value: boolean | null) => void;
  currentCarrier?: string;
  onCurrentCarrierChange?: (value: string) => void;
  currentPolicyExpirationDate?: string;
  onCurrentPolicyExpirationDateChange?: (value: string) => void;
  purchaseDate: string;
  onPurchaseDateChange: (value: string) => void;
  purchasePrice: number;
  onPurchasePriceChange: (value: number) => void;
  purchasePriceSource?: string;
  residenceUse: ResidenceUse;
  onResidenceUseChange: (value: ResidenceUse) => void;
  rentalTerm: RentalTerm;
  onRentalTermChange: (value: RentalTerm) => void;
  rebuild: number;
  onRebuildChange: (value: number) => void;
  roofYear: number;
  onRoofYearChange: (value: number) => void;
  openingProtection: number;
  onOpeningProtectionChange: (value: number) => void;
  roofShape: number;
  onRoofShapeChange: (value: number) => void;
  swr: number;
  onSwrChange: (value: number) => void;
  hurricaneDeductible: number;
  onHurricaneDeductibleChange: (value: number) => void;
  construction: number;
  onConstructionChange: (value: number) => void;
  yearBuilt: number;
  onYearBuiltChange: (value: number) => void;
  squareFeet?: number;
  onSquareFeetChange?: (value: number) => void;
  propertyCharacteristicsNote?: string;
  aopDeductible: number;
  onAopDeductibleChange: (value: number) => void;
  floodZone?: string;
  floodZoneSource?: string;
  onFloodZoneChange?: (value: string) => void;
  hasClaims?: boolean | null;
  onHasClaimsChange?: (value: boolean | null) => void;
  claimRecords?: Array<{
    lossDate: string; claimDetail: string; amount: number | "";
    paid: boolean | null; priorResidence: boolean | null;
  }>;
  onClaimRecordsChange?: (records: NonNullable<InsuranceEstimateFormProps["claimRecords"]>) => void;
  annualPremium: number;
  /** Replaces the default caption, e.g. when a recent live quote is used. */
  premiumNote?: string;
}

const CURRENT_YEAR = new Date().getFullYear();
const CLAIM_DATE_MAX = new Date().toISOString().slice(0, 10);
const claimDateMin = new Date();
claimDateMin.setFullYear(claimDateMin.getFullYear() - 5);
const CLAIM_DATE_MIN = claimDateMin.toISOString().slice(0, 10);
const fieldClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelClass =
  "block text-xs font-semibold uppercase tracking-wide text-muted-foreground";

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  options: { value: number; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <label className={labelClass}>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={fieldClass}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function YearField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  testId: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className={labelClass}>{label}</label>
      <input
        type="number"
        inputMode="numeric"
        min={1900}
        max={CURRENT_YEAR}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        onBlur={(e) =>
          onChange(
            Math.min(
              CURRENT_YEAR,
              Math.max(1900, Number(e.target.value) || CURRENT_YEAR),
            ),
          )
        }
        data-testid={testId}
        className={fieldClass}
      />
    </div>
  );
}

function RebuildField({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");
  const commit = () => {
    const next = Number(raw.replace(/[^0-9]/g, ""));
    if (Number.isFinite(next) && next > 0)
      onChange(Math.min(1500000, Math.max(150000, next)));
    setEditing(false);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label className={labelClass}>
          Estimated Rebuild / Replacement Cost (Coverage A)
        </label>
        {editing ? (
          <input
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-32 rounded border border-primary px-2 py-0.5 text-right font-mono text-sm font-bold text-primary focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setRaw(String(value));
              setEditing(true);
            }}
            className="cursor-text rounded-md border border-primary/40 bg-primary/5 px-2.5 py-0.5 font-mono text-sm font-bold text-primary transition-colors hover:border-primary hover:bg-primary/10"
          >
            ${value.toLocaleString()}
          </button>
        )}
      </div>
      <input
        type="range"
        min={150000}
        max={1500000}
        step={25000}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
    </div>
  );
}

export function InsuranceEstimateForm(props: InsuranceEstimateFormProps) {
  const claimRecords = props.claimRecords ?? [];
  const updateClaimRecords = props.onClaimRecordsChange ?? (() => {});
  const policyNote = props.policyTypeNote ?? "";
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <label className={labelClass}>Policy Type</label>
        <select
          value={props.policyType}
          onChange={(e) =>
            props.onPolicyTypeChange(e.target.value as InsurancePolicyType)
          }
          className={fieldClass}
          data-testid="select-policy-type"
        >
          <option value="">— select —</option>
          <option value="HO3">HO3 — Homeowners</option>
          <option value="HO6">HO6 — Condo</option>
          <option value="DP3">DP3 — Dwelling fire</option>
        </select>
        {policyNote && (
          <p className="text-xs text-muted-foreground/80">{policyNote}</p>
        )}
      </div>
      {props.hasClaims !== undefined &&
      props.onHasClaimsChange &&
      props.onClaimRecordsChange ? (
      <div className="space-y-2 rounded-lg border border-border p-3">
        <label className={labelClass}>Any insurance claims in the past five years?</label>
        <select
          value={props.hasClaims === null ? "" : props.hasClaims ? "yes" : "no"}
          onChange={(e) => props.onHasClaimsChange?.(
            e.target.value === "yes" ? true : e.target.value === "no" ? false : null,
          )}
          className={fieldClass}
          data-testid="select-prior-claims"
        >
          <option value="">— select —</option><option value="no">No</option><option value="yes">Yes</option>
        </select>
        {props.hasClaims && claimRecords.map((claim, index) => (
          <div key={index} className="grid grid-cols-2 gap-2 rounded border border-border/70 p-2">
            <input type="date" min={CLAIM_DATE_MIN} max={CLAIM_DATE_MAX} value={claim.lossDate} aria-label={`Claim ${index + 1} loss date`}
              onChange={(e) => updateClaimRecords(claimRecords.map((r, i) => i === index ? {...r, lossDate: e.target.value} : r))} className={fieldClass} />
            <input value={claim.claimDetail} placeholder="Type / cause" aria-label={`Claim ${index + 1} type or cause`}
              onChange={(e) => updateClaimRecords(claimRecords.map((r, i) => i === index ? {...r, claimDetail: e.target.value} : r))} className={fieldClass} />
            <input type="number" min="1" value={claim.amount} placeholder="Amount paid / incurred" aria-label={`Claim ${index + 1} amount`}
              onChange={(e) => updateClaimRecords(claimRecords.map((r, i) => i === index ? {...r, amount: e.target.value ? Number(e.target.value) : ""} : r))} className={fieldClass} />
            <select value={claim.paid === null ? "" : `${claim.paid}`} aria-label={`Claim ${index + 1} paid status`}
              onChange={(e) => updateClaimRecords(claimRecords.map((r, i) => i === index ? {...r, paid: e.target.value === "true"} : r))} className={fieldClass}>
              <option value="">— paid status —</option><option value="true">Paid</option><option value="false">Unpaid</option>
            </select>
            <select value={claim.priorResidence === null ? "" : `${claim.priorResidence}`} aria-label={`Claim ${index + 1} residence`}
              onChange={(e) => updateClaimRecords(claimRecords.map((r, i) => i === index ? {...r, priorResidence: e.target.value === "true"} : r))} className={fieldClass}>
              <option value="">— residence —</option><option value="false">Current residence</option><option value="true">Prior residence</option>
            </select>
            <button type="button" className="text-xs text-primary" onClick={() => updateClaimRecords(claimRecords.filter((_, i) => i !== index))}>Remove</button>
          </div>
        ))}
        {props.hasClaims && claimRecords.length < 3 && (
          <button type="button" className="text-xs font-medium text-primary" onClick={() => updateClaimRecords([...claimRecords, { lossDate: "", claimDetail: "", amount: "", paid: null, priorResidence: null }])}>
            + Add claim
          </button>
        )}
      </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className={labelClass}>Is this a new purchase?</label>
          <select
            value={
              props.newPurchase === null ? "" : props.newPurchase ? "yes" : "no"
            }
            onChange={(e) =>
              props.onNewPurchaseChange(
                e.target.value === "yes"
                  ? true
                  : e.target.value === "no"
                    ? false
                    : null,
              )
            }
            data-testid="select-new-purchase"
            className={fieldClass}
          >
            <option value="">— select —</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        {props.newPurchase !== null && (
          <div className="space-y-1.5">
            <label className={labelClass}>
              {props.newPurchase
                ? "Expected closing date"
                : "Requested policy effective date"}
            </label>
            <input
              type="date"
              value={props.purchaseDate}
              onChange={(e) => props.onPurchaseDateChange(e.target.value)}
              data-testid="input-purchase-date"
              className={fieldClass}
            />
          </div>
        )}
      </div>
      {props.newPurchase === false && props.onCurrentlyInsuredChange ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClass}>Is this property currently insured?</label>
            <select value={props.currentlyInsured === null ? "" : props.currentlyInsured ? "yes" : "no"}
              onChange={(e) => props.onCurrentlyInsuredChange?.(e.target.value === "yes" ? true : e.target.value === "no" ? false : null)}
              data-testid="select-currently-insured" className={fieldClass}>
              <option value="">— select —</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </div>
          {props.currentlyInsured === true && <>
              <div className="space-y-1.5">
                <label className={labelClass}>What carrier?</label>
                <input value={props.currentCarrier ?? ""} onChange={(e) => props.onCurrentCarrierChange?.(e.target.value)}
                  data-testid="input-current-carrier" className={fieldClass} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <label className={labelClass}>Current policy expiration date</label>
                <input type="date" value={props.currentPolicyExpirationDate ?? ""}
                  onChange={(e) => props.onCurrentPolicyExpirationDateChange?.(e.target.value)}
                  data-testid="input-current-policy-expiration-date" className={fieldClass} />
                <p className="text-xs text-muted-foreground">
                  Used first for renewal quotes. This private date is saved only to your account for this property.
                </p>
              </div>
            </>}
        </div>
      ) : null}
      <div className="space-y-1.5">
        <label className={labelClass}>Property purchase price / current value</label>
        <input
          type="number"
          inputMode="decimal"
          min="1"
          value={props.purchasePrice || ""}
          onChange={(e) => props.onPurchasePriceChange(Number(e.target.value) || 0)}
          data-testid="input-property-purchase-price"
          className={fieldClass}
          placeholder="Required for live quotes"
        />
        <p className="text-xs text-muted-foreground">
          {props.purchasePriceSource
            ? `Source: ${props.purchasePriceSource}.`
            : "Enter the confirmed purchase price or current property value."}
        </p>
      </div>
      {(props.policyType === "HO3" || props.policyType === "HO6" || props.policyType === "DP3") && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {props.policyType !== "DP3" && <div className="space-y-1.5">
            <label className={labelClass}>Residence use</label>
            <select
              value={props.residenceUse}
              onChange={(e) =>
                props.onResidenceUseChange(e.target.value as ResidenceUse)
              }
              className={fieldClass}
              data-testid="select-ho6-residence-use"
            >
              <option value="">— select —</option>
              <option value="primary">Primary residence</option>
              <option value="secondary">Secondary residence</option>
                {props.policyType === "HO6" && <option value="investment">Investment property</option>}
            </select>
          </div>}
          {(props.policyType === "DP3" || props.residenceUse === "investment") && (
            <div className="space-y-1.5">
              <label className={labelClass}>What type of rental is this?</label>
              <select
                value={props.rentalTerm}
                onChange={(e) =>
                  props.onRentalTermChange(e.target.value as RentalTerm)
                }
                className={fieldClass}
                data-testid="select-rental-term"
              >
                <option value="">— select —</option>
                <option value="annual">Annual / long-term</option>
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly / short-term</option>
              </select>
            </div>
          )}
        </div>
      )}
      {props.policyType && (
        <div className="rounded-lg border border-primary/15 bg-primary/5 p-3 text-xs leading-relaxed text-foreground">
          <strong>QuoteRUSH defaults:</strong>{" "}
          {props.policyType === "HO3"
            ? props.residenceUse === "secondary" ? "Secondary residence" : "Primary residence"
            : props.policyType === "DP3"
              ? "Investment property"
              : props.residenceUse
                ? `${props.residenceUse[0].toUpperCase()}${props.residenceUse.slice(1)} residence`
                : "Choose the residence use above"}
          {(props.policyType === "DP3" || (props.policyType === "HO6" && props.residenceUse === "investment"))
            ? `, ${props.rentalTerm || "rental term required"} rental term`
            : ""}
          , 9 months or more occupied. Purchase price uses verified property
          value data and is never derived from Coverage A.
        </div>
      )}
      <RebuildField value={props.rebuild} onChange={props.onRebuildChange} />
      <Separator />
      <YearField
        label="What year was the roof installed?"
        value={props.roofYear}
        onChange={props.onRoofYearChange}
        testId="input-roof-year"
      />
      <SelectField
        label="Hurricane impact-rated doors and windows or shutters?"
        value={props.openingProtection}
        onChange={props.onOpeningProtectionChange}
        options={[
          { value: 0, label: "No" },
          { value: 1, label: "Yes" },
        ]}
      />
      <SelectField
        label="What type of roof do you have?"
        value={props.roofShape}
        onChange={props.onRoofShapeChange}
        options={[
          { value: 0, label: "Hip roof" },
          { value: 1, label: "Flat roof" },
          { value: 2, label: "Other / unsure" },
        ]}
      />
      <SelectField
        label="Second Water Resistance Layer (SWR)?"
        value={props.swr}
        onChange={props.onSwrChange}
        options={[
          { value: 2, label: "Yes" },
          { value: 0, label: "No" },
          { value: 1, label: "Unsure" },
        ]}
      />
      <SelectField
        label="Hurricane Deductible"
        value={props.hurricaneDeductible}
        onChange={props.onHurricaneDeductibleChange}
        options={[
          { value: 0, label: "2% of dwelling — standard" },
          { value: 1, label: "5% of dwelling — max allowed for most loans" },
          { value: 2, label: "10% of dwelling" },
        ]}
      />
      <SelectField
        label="Construction Type"
        value={props.construction}
        onChange={props.onConstructionChange}
        options={[
          { value: 0, label: "Concrete Block" },
          { value: 2, label: "Frame" },
          { value: 1, label: "Mix" },
        ]}
      />
      <YearField
        label="What year was the home built?"
        value={props.yearBuilt}
        onChange={props.onYearBuiltChange}
        testId="input-year-built"
      />
      <div className="space-y-1.5">
        <label className={labelClass}>Living area (square feet)</label>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={props.squareFeet || ""}
          placeholder="Enter if known"
          onChange={(e) => {
            const next = Number(e.target.value);
            props.onSquareFeetChange?.(
              Number.isFinite(next) && next > 0 ? Math.round(next) : 0,
            );
          }}
          data-testid="input-square-feet"
          className={fieldClass}
        />
        {props.propertyCharacteristicsNote && (
          <p className="text-xs text-muted-foreground/70">
            {props.propertyCharacteristicsNote}
          </p>
        )}
      </div>
      <SelectField
        label="AOP Deductible (all other perils)"
        value={props.aopDeductible}
        onChange={props.onAopDeductibleChange}
        options={[
          { value: 500, label: "$500" },
          { value: 1000, label: "$1,000" },
          { value: 2500, label: "$2,500" },
          { value: 5000, label: "$5,000 — max allowed for most loans" },
          { value: 10000, label: "$10,000" },
        ]}
      />
      <div className="space-y-1.5">
        <label className={labelClass}>Flood Zone</label>
        <input
          value={props.floodZone ?? ""}
          onChange={(e) => props.onFloodZoneChange?.(e.target.value.toUpperCase())}
          placeholder="Unknown"
          data-testid="text-flood-zone"
          className="w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        />
        {props.floodZoneSource && (
          <p className="text-xs text-muted-foreground/70">
            {props.floodZoneSource}
          </p>
        )}
        <p className="text-xs text-muted-foreground/70">
          Auto-detected for this address from the{" "}
          <a
            href="https://msc.fema.gov/portal/search"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            FEMA flood map
          </a>
          .
        </p>
      </div>
      <div className="rounded-2xl bg-primary p-6 text-white shadow-lg">
        <div className="text-xs font-semibold uppercase tracking-widest text-white/65">
          Estimated Annual Premium
        </div>
        <div
          className="mt-2 font-mono text-4xl font-bold"
          data-testid="estimated-annual-premium"
        >
          ${Math.round(props.annualPremium).toLocaleString()}
        </div>
        <p className="mt-2 text-xs text-white/65" data-testid="estimated-annual-premium-note">
          {props.premiumNote ?? "Midpoint planning estimate based on the answers above."}
        </p>
      </div>
    </div>
  );
}
