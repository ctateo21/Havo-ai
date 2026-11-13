import { useMemo, useState, useRef, useEffect } from "react";
import { useSearch, useLocation } from "wouter";
import ScenarioActions from "@/components/scenario-actions";
import { useQuoteAccess } from "@/context/quote-access-context";
import { useAnonymousDraft, useAnonymousDraftRef } from "@/hooks/use-anonymous-draft";
import { rememberAnonymousAccountDraft, confirmAnonymousAccountDraftSaved, hasPendingAnonymousAccountDraft } from "@/lib/anonymous-account-draft";
import {
  getInsuranceScenarios, saveInsuranceScenarios, type InsuranceScenario,
  getPurchaseScenarios, getCashBuyScenarios, getTrackedLoans,
  getSession, normalizeDateOfBirth, saveDateOfBirth, hasSavedDateOfBirth,
} from "@/lib/auth";
import { notifyNewScenario } from "@/lib/notify-scenario";
import { authedFetch } from "@/lib/authed-fetch";
import {
  clearQRCache,
  type QRCacheEntry,
} from "@/lib/quoterush-auto";
import {
  getBaselineHomeownersInsuranceRate,
} from "@/lib/insurance-default";
import {
  getDefaultInsurancePolicyType,
  resolveInsurancePropertyTypeForAddress,
  INSURANCE_POLICY_TYPE_LABELS,
  type InsurancePolicyType,
} from "@/lib/insurance-policy-type";
import { Helmet } from "react-helmet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ArrowLeft, Shield, MapPin, Home, AlertTriangle,
  Share2, Save, Plus, X, Pencil, Upload,
} from "lucide-react";
import { getCountyName } from "@/lib/county-tax-estimator";
import { normalizePropertyKey } from "@/lib/property-key";
import {
  isInsuranceAddressDismissed,
  readDismissedInsuranceKeys,
} from "@/lib/insurance-dismissals";
import { useGooglePlaces } from "@/hooks/use-google-places";
import LeadCaptureDialog from "@/components/ui/lead-capture-dialog";
import { trackEvent } from "@/lib/posthog";
import { useToast } from "@/hooks/use-toast";
import {
  resolveQuoteRushPropertyDefaults,
  type QuoteRushPurchasePrice,
  type QuoteRushResidenceUse,
  type QuoteRushRentalTerm,
} from "@shared/quoterush-property-defaults";
import { resolvePurchasePriceProvenance } from "@shared/purchase-price-provenance";
import { SourcedInsuranceForm as InsuranceEstimateForm, validRoofYear, ROOF_YEAR_ERROR, type PropertyEvidence, type RoofSuggestion } from "@/components/insurance/sourced-insurance-form";
import { useAuth } from "@/context/auth-context";
import {
  FLOOD_HOA_ASSUMPTION_NOTE,
  suppressSeparateFloodInsurance,
} from "@shared/flood-insurance-policy";

// ─── Data ─────────────────────────────────────────────────────────────────────

type RegionKey = "keys" | "sefl" | "swfl" | "tampa" | "nefljax" | "central" | "ncfl";

interface Region {
  name: string; counties: string; low: number; high: number;
  tier: string; tierColor: string; note: string;
}

const REGIONS: Record<RegionKey, Region> = {
  keys:    { name: "Keys / Barrier Islands",    counties: "Monroe, barrier islands",                low: 0.0495, high: 0.0665, tier: "Extreme",  tierColor: "bg-red-100 text-red-800",      note: "Extreme hurricane surge risk, very limited reinsurance appetite, and a small pool of insurable units produce premiums unlike anywhere else in the state. Most major carriers have exited this market." },
  sefl:    { name: "SE FL Coastal",             counties: "Miami-Dade, Broward, Palm Beach",        low: 0.0233, high: 0.0407, tier: "High",     tierColor: "bg-orange-100 text-orange-800", note: "Hurricane exposure, high rebuild costs, and older housing stock define this market. Miami-Dade, Broward, and Palm Beach are among the most expensive mainland ZIP codes in the U.S." },
  swfl:    { name: "SW FL Coastal",             counties: "Lee, Collier, Charlotte",                low: 0.0134, high: 0.0207, tier: "High",     tierColor: "bg-orange-100 text-orange-800", note: "Post-Hurricane Ian reinsurance pricing continues to elevate rates across Lee, Collier, and Charlotte counties. Barrier island properties run significantly higher than the county average." },
  tampa:   { name: "Tampa Bay Area",            counties: "Hillsborough, Pinellas, Pasco",          low: 0.0110, high: 0.0170, tier: "Mod-High", tierColor: "bg-yellow-100 text-yellow-800",  note: "Growing storm risk recognition, high population density, and significant flood zone coverage in low-lying areas push rates above Central Florida. Pinellas peninsula properties carry the highest exposure within this region." },
  nefljax: { name: "NE FL / Jacksonville",      counties: "Duval, Clay, St. Johns, Flagler",        low: 0.0080, high: 0.0127, tier: "Moderate", tierColor: "bg-blue-100 text-blue-800",     note: "Moderate coastal exposure with better carrier availability than South Florida. St. Johns County waterfront properties trend toward the upper end; inland Duval and Clay closer to the lower bound." },
  central: { name: "Central FL Inland",         counties: "Orange, Osceola, Polk, Seminole",        low: 0.0078, high: 0.0122, tier: "Moderate", tierColor: "bg-blue-100 text-blue-800",     note: "Shielded from direct coastal wind, though sinkhole risk in parts of Polk adds cost. Good carrier availability and the lowest hurricane deductibles of any Florida coastal-adjacent region." },
  ncfl:    { name: "North-Central FL Inland",   counties: "Alachua, Marion, Sumter, Lake, Columbia", low: 0.0054, high: 0.0080, tier: "Low",     tierColor: "bg-green-100 text-green-800",   note: "Consistently the lowest rates in Florida. These counties sit 60+ miles from the coast, dramatically limiting hurricane exposure. Strong carrier competition keeps premiums in check." },
};

const ROOF_ADJ  = [0.90, 1.00, 1.20, 1.38];
const OPENING_PROTECTION_ADJ = [1.00, 0.92]; // no, yes
const ROOF_SHAPE_ADJ = [0.92, 1.06, 1.00]; // hip, flat, other / unsure
const SWR_ADJ = [1.00, 1.00, 0.94]; // no, unsure, yes
const HURR_ADJ  = [1.10, 1.05, 1.00];
const CURRENT_YEAR = new Date().getFullYear();

const COUNTY_TO_REGION: Record<string, RegionKey> = {
  "monroe": "keys",
  "miami-dade": "sefl", "broward": "sefl", "palm beach": "sefl",
  "lee": "swfl", "collier": "swfl", "charlotte": "swfl", "manatee": "swfl", "sarasota": "swfl",
  "hillsborough": "tampa", "pinellas": "tampa", "pasco": "tampa", "hernando": "tampa",
  "duval": "nefljax", "clay": "nefljax", "st. johns": "nefljax", "st johns": "nefljax", "flagler": "nefljax", "nassau": "nefljax",
  "okaloosa": "nefljax", "santa rosa": "nefljax", "escambia": "nefljax",
  "orange": "central", "osceola": "central", "polk": "central", "seminole": "central", "lake": "central", "volusia": "central",
  "brevard": "central", "indian river": "central",
  "st. lucie": "sefl", "martin": "sefl",
  "alachua": "ncfl", "marion": "ncfl", "sumter": "ncfl", "columbia": "ncfl", "putnam": "ncfl",
  "leon": "ncfl", "gadsden": "ncfl", "wakulla": "ncfl",
};

function getRegionFromAddress(address: string): RegionKey {
  const county = getCountyName(address);
  if (county && COUNTY_TO_REGION[county]) return COUNTY_TO_REGION[county];
  return "tampa";
}

// Product of the non-baseline factors at their default index. Home age and
// frame construction are priced directly by the baseline rate helper.
const NEUTRAL_FACTOR_PRODUCT =
  ROOF_ADJ[1] *
  OPENING_PROTECTION_ADJ[0] *
  ROOF_SHAPE_ADJ[2] *
  SWR_ADJ[1] *
  HURR_ADJ[0];

function roofFactorIndex(roofYear: number): number {
  const age = CURRENT_YEAR - roofYear;
  if (age < 5) return 0;
  if (age <= 14) return 1;
  if (age <= 20) return 2;
  return 3;
}

function yearBuiltFactorIndex(yearBuilt: number): number {
  if (yearBuilt >= 2002) return 0;
  if (yearBuilt >= 1990) return 1;
  if (yearBuilt >= 1970) return 2;
  return 3;
}

function windMitigationIndex(
  openingProtectionIdx: number,
  roofShapeIdx: number,
  swrIdx: number,
): number {
  if (openingProtectionIdx === 1 && roofShapeIdx === 0 && swrIdx === 2) return 2;
  if (openingProtectionIdx === 0 && roofShapeIdx !== 0 && swrIdx === 0) return 0;
  return 1;
}

// Look up the best-known property value for an address across the
// other scenario tabs (Purchase with Loan, Cash Buy, Refinance) and
// any existing Insurance scenario for that same address. Returns 0
// if nothing is known so callers can fall back to URL ?price=.
// Match two addresses by normalized property key (so differently
// formatted strings for the SAME property correlate), falling back to
// exact trimmed/lowercased equality when either address can't be parsed.
// Never collapses onto an empty key.
function isSamePropertyAddress(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const ka = normalizePropertyKey(a).key;
  const kb = normalizePropertyKey(b).key;
  if (ka && kb) return ka === kb;
  const sa = (a ?? "").trim().toLowerCase();
  const sb = (b ?? "").trim().toLowerCase();
  return !!sa && sa === sb;
}

function deriveMortgageForAddress(address: string): boolean | undefined {
  const purchase = getPurchaseScenarios().find(p => isSamePropertyAddress(p.address, address));
  if (purchase) return true;
  const cash = getCashBuyScenarios().find(c => isSamePropertyAddress(c.address, address));
  if (cash) return false;
  const loan = getTrackedLoans().find(l => isSamePropertyAddress(l.propertyAddress, address));
  if (!loan) return undefined;
  return !(loan.freeAndClear || loan.entryMethod === "free_and_clear" || loan.loanBalance <= 0);
}

function getKnownPurchasePriceForAddress(address: string): {
  value: number | null;
  source: QuoteRushPurchasePrice["source"];
} {
  if (!address || !address.trim()) return { value: null, source: "unknown" };

  const purchase = getPurchaseScenarios().find(
    p => isSamePropertyAddress(p.address, address)
  );
  const cash = getCashBuyScenarios().find(
    c => isSamePropertyAddress(c.address, address)
  );
  const loan = getTrackedLoans().find(
    l => isSamePropertyAddress(l.propertyAddress, address)
  );
  return resolvePurchasePriceProvenance({
    purchaseScenario: purchase,
    cashBuyScenario: cash,
    trackedLoan: loan,
  });
}

function getKnownPropertyValueForAddress(address: string): number {
  return getKnownPurchasePriceForAddress(address).value ?? 0;
}

// Resolve the policy type (HO3 / HO6 / DP3) for an address from saved
// insurance state, then a matching Purchase / Cash / Loan scenario, then
// the shared default rule. Module-level so both the Rebuild Cost seeding
// (`defaultRebuildFor`) and the component can share one implementation.
function resolvePolicyTypeForAddress(addr: string): {
  policyType: InsurancePolicyType | "";
  source: "default_rule" | "manual" | null;
} {
  if (!addr || !addr.trim()) return { policyType: "", source: null };
  const ins = getInsuranceScenarios().find(
    s => isSamePropertyAddress(s.address, addr)
  );
  // A manual policy-type pick always wins — never recompute or override.
  if (ins?.policyType && ins.policyTypeSource === "manual") {
    return { policyType: ins.policyType, source: "manual" };
  }
  // Gather matching source scenarios for the SAME normalized property key
  // (address fallback). Their `propertyType` carries the Zillow /
  // property_cache physical type (Purchase/Cash/Refi were seeded from
  // `/api/zillow-property-lookup`). Refinance physical type lives on
  // `physicalPropertyType` (its `propertyType` is occupancy).
  const purchase = getPurchaseScenarios().find(
    p => isSamePropertyAddress(p.address, addr)
  );
  const cash = getCashBuyScenarios().find(
    c => isSamePropertyAddress(c.address, addr)
  );
  const loan = getTrackedLoans().find(
    l => isSamePropertyAddress(l.propertyAddress, addr)
  );
  const occupancy =
    cash?.occupancyType ?? (loan?.propertyType as any) ?? ins?.occupancyType ?? (purchase ? "primary" : undefined);
  const resolved = resolveInsurancePropertyTypeForAddress({
    insurancePropertyType: ins?.propertyType,
    insurancePropertyTypeSource: ins?.propertyTypeSource,
    sourcePropertyTypes: [purchase?.propertyType, cash?.propertyType, loan?.physicalPropertyType],
  });
  const def = getDefaultInsurancePolicyType({
    occupancyType: occupancy,
    propertyType: resolved.propertyType,
  });
  // Condo / townhome forces HO6 over any stale, non-manual persisted
  // value (spec example 5). Otherwise keep the persisted policy type if
  // present, else use the freshly computed default.
  if (def === "HO6") return { policyType: "HO6", source: "default_rule" };
  if (ins?.policyType) {
    return { policyType: ins.policyType, source: ins.policyTypeSource ?? "default_rule" };
  }
  return { policyType: def ?? "", source: def ? "default_rule" : null };
}

function resolvePhysicalPropertyTypeForAddress(addr: string): string {
  if (!addr || !addr.trim()) return "";
  const ins = getInsuranceScenarios().find(
    s => isSamePropertyAddress(s.address, addr)
  );
  const purchase = getPurchaseScenarios().find(
    p => isSamePropertyAddress(p.address, addr)
  );
  const cash = getCashBuyScenarios().find(
    c => isSamePropertyAddress(c.address, addr)
  );
  const loan = getTrackedLoans().find(
    l => isSamePropertyAddress(l.propertyAddress, addr)
  );
  return resolveInsurancePropertyTypeForAddress({
    insurancePropertyType: ins?.propertyType,
    insurancePropertyTypeSource: ins?.propertyTypeSource,
    sourcePropertyTypes: [
      purchase?.propertyType,
      cash?.propertyType,
      loan?.physicalPropertyType,
    ],
  }).propertyType;
}

function defaultRebuildFor(address: string, priceParam: string | null): number {
  // Only an explicitly manual Coverage A may seed the form. Never market value.
  void priceParam;
  const saved = getInsuranceScenarios().find(s => isSamePropertyAddress(s.address, address));
  return saved?.coverageASource === "manual" &&
    saved.userAnswerSources?.coverage_a_input_source !== "confirmed_rebuild_rate" &&
    Number(saved.coverageA) > 0 ? Number(saved.coverageA) : 0;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface InsuranceSettings {
  regionKey: RegionKey; rebuild: number;
  roofIdx: number; windIdx: number; hurrIdx: number;
  constIdx: number; yearIdx: number; claimsIdx: number;
  roofYear: number; yearBuilt: number;
  openingProtectionIdx: number; roofShapeIdx: number; swrIdx: number;
}

interface Scenario {
  id: string; address: string; savedSettings: InsuranceSettings | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) { return "$" + Math.round(n).toLocaleString(); }
type SourcedQuote = QRCacheEntry["quotes"][number] & { returnedCoverageA?: number };
function sortQuotes(quotes: SourcedQuote[]): SourcedQuote[] {
  return [...quotes].sort((a, b) => a.annualPremium - b.annualPremium);
}

function shortLabel(addr: string) {
  const parts = addr.split(",")[0].trim().split(" ");
  return parts.slice(0, 3).join(" ");
}

// All-Other-Perils (AOP) deductible — the standard Florida HO deductible
// for non-hurricane claims. Both it and the FEMA-resolved flood zone are
// persisted inside the `insurance_scenarios.user_answer_sources` jsonb
// column (no new DB column needed).
const DEFAULT_AOP_DEDUCTIBLE = 2500;

// ─── Sub-components ───────────────────────────────────────────────────────────

function SliderRow({ label, value, onChange, min, max, step }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");

  function startEdit() { setRaw(String(value)); setEditing(true); }
  function commitEdit() {
    const parsed = parseInt(raw.replace(/[^0-9]/g, ""), 10);
    if (!isNaN(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
    setEditing(false);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</span>
        {editing ? (
          <input
            autoFocus type="text" value={raw}
            onChange={e => setRaw(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }}
            className="w-32 text-right text-sm font-bold text-primary font-mono border border-primary rounded px-2 py-0.5 focus:outline-none"
          />
        ) : (
          <button
            onClick={startEdit}
            title="Click to edit"
            className="text-sm font-bold text-primary font-mono border border-primary/40 bg-primary/5 hover:bg-primary/10 hover:border-primary rounded-md px-2.5 py-0.5 cursor-text transition-colors"
          >
            ${value.toLocaleString()}
          </button>
        )}
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none bg-gray-200 accent-primary cursor-pointer"
      />
    </div>
  );
}

function SelectRow({ label, value, onChange, options }: {
  label: string; value: number; onChange: (v: number) => void;
  options: { value: number; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">{label}</label>
      <select
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function YearInputRow({ label, value, onChange, testId }: {
  label: string; value: number; onChange: (v: number) => void; testId: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">
        {label}
      </label>
      <input
        type="number"
        inputMode="numeric"
        min={1900}
        max={CURRENT_YEAR}
        value={value}
        onChange={e => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        onBlur={e => {
          const next = Number(e.target.value);
          onChange(Math.min(CURRENT_YEAR, Math.max(1900, Number.isFinite(next) ? next : CURRENT_YEAR)));
        }}
        data-testid={testId}
        className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function InsuranceDashboard() {
  const { user } = useAuth();
  const isAuthenticated = !!user;
  const { authorize, requireAccount } = useQuoteAccess();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(search);
  const addressParam = params.get("address") || "";
  // An account arriving while this anonymous draft is mounted must not replace
  // the buyer's edits with empty (or older) account values.
  const anonymousDraftAddress = useRef(!user || hasPendingAnonymousAccountDraft() ? addressParam : null);
  const priceParam = params.get("price");
  const physicalPropertyType = resolvePhysicalPropertyTypeForAddress(addressParam);
  const normalizedPhysicalPropertyType = physicalPropertyType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const isLand =
    normalizedPhysicalPropertyType === "land" ||
    normalizedPhysicalPropertyType === "lot" ||
    normalizedPhysicalPropertyType.includes("vacantland") ||
    normalizedPhysicalPropertyType.includes("vacantlot") ||
    normalizedPhysicalPropertyType.includes("residentialland") ||
    normalizedPhysicalPropertyType.includes("residentiallot");
  const assumesHoaFloodCoverage =
    suppressSeparateFloodInsurance(physicalPropertyType) && !isLand;
  // Restore only an explicitly manual Coverage A. Property market value and
  // URL prices cannot establish replacement cost.
  function initialRebuildFor(addr: string, price: string | null): number {
    const key = (addr ?? "").trim().toLowerCase();
    if (key) {
      const ins = getInsuranceScenarios().find(
        s => (s.address ?? "").trim().toLowerCase() === key
      );
      if (ins && ins.coverageASource === "manual"
          && ins.userAnswerSources?.coverage_a_input_source !== "confirmed_rebuild_rate"
          && typeof ins.coverageA === "number" && ins.coverageA > 0) {
        return ins.coverageA;
      }
    }
    return defaultRebuildFor(addr, price);
  }
  const initialRebuild = initialRebuildFor(addressParam, priceParam);

  const { toast } = useToast();

  // ── Scenario state ───────────────────────────────────────────────────────
  const [scenarios, setScenarios] = useAnonymousDraft<Scenario[]>("scenarios", [
    { id: "sc0", address: addressParam, savedSettings: null },
  ]);
  const [activeScenarioId, setActiveScenarioId] = useAnonymousDraft("activeScenarioId", "sc0");
  const [showAddressPrompt, setShowAddressPrompt] = useState(false);
  const [newScenarioAddress, setNewScenarioAddress] = useState("");
  const { bindInputRef: newScenarioInputRef } = useGooglePlaces({
    enabled: showAddressPrompt,
    onPlaceSelected: place => setNewScenarioAddress(place.formatted_address),
  });

  // Keep active scenario address in sync with URL
  useEffect(() => {
    setScenarios(prev =>
      prev.map(s => s.id === activeScenarioId ? { ...s, address: addressParam } : s)
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressParam]);

  // ── Settings state ───────────────────────────────────────────────────────
  const [regionKey, setRegionKey] = useAnonymousDraft<RegionKey>("regionKey", getRegionFromAddress(addressParam));
  const [rebuild, setRebuild] = useAnonymousDraft("rebuild", initialRebuild);
  const manualCoverageA = useAnonymousDraftRef("manualCoverageA", initialRebuild > 0);
  const manualRoofYear = useAnonymousDraftRef("manualRoofYear", false);
  const [sqFtConfirmed, setSqFtConfirmed] = useAnonymousDraft("sqFtConfirmed", false);
  const [floodZoneUnknown, setFloodZoneUnknown] = useAnonymousDraft("floodZoneUnknown", false);
  const [fieldSources, setFieldSources] = useAnonymousDraft<PropertyEvidence>("fieldSources", {});
  const [constructionSourced, setConstructionSourced] = useAnonymousDraft("constructionSourced", false);
  const [constructionConfirmed, setConstructionConfirmed] = useAnonymousDraft("constructionConfirmed", false);
  const [roofPermits, setRoofPermits] = useState<RoofSuggestion[]>([]);
  const [rebuildRate, setRebuildRate] = useState<{
    county: string; countyName: string; frame_cost_per_sqft: number | null;
    masonry_cost_per_sqft: number | null; source_note: string; updated_at: string;
  } | null>(null);
  const [rateError, setRateError] = useState("");
  const [rateRetry, setRateRetry] = useState(0);

  // ── Manual Annual Premium override ───────────────────────────────────────
  // When the user types a dollar amount into the editable Annual Premium
  // input, we persist that value and stamp `premiumSource = "manual"` on
  // save. The cross-tab property-value sync helper then skips the premium
  // (see `isInsurancePremiumOverridable` in lib/property-value-sync.ts) so
  // a Refinance / Purchase / Cash / Seller value change can update
  // Coverage A without overwriting the user's manual premium.
  //
  // `null` means "not manual — show the calculated midpoint". A saved
  // InsuranceScenario with `premiumSource === "manual"` hydrates the
  // input on mount / address change.
  function resolveManualPremiumFor(addr: string): number | null {
    const key = (addr ?? "").trim().toLowerCase();
    if (!key) return null;
    const ins = getInsuranceScenarios().find(
      s => (s.address ?? "").trim().toLowerCase() === key
    );
    if (ins?.premiumSource === "manual" && typeof ins.annualPremium === "number"
        && Number.isFinite(ins.annualPremium) && ins.annualPremium > 0) {
      return ins.annualPremium;
    }
    return null;
  }
  const [manualAnnualPremium, setManualAnnualPremium] = useAnonymousDraft<number | null>("manualAnnualPremium",
    resolveManualPremiumFor(addressParam)
  );
  // Re-hydrate from saved state when the address switches.
  useEffect(() => {
    if (anonymousDraftAddress.current === addressParam) return;
    const v = resolveManualPremiumFor(addressParam);
    setManualAnnualPremium(v);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressParam]);

  // ── Policy type (HO3 / HO6 / DP3) ────────────────────────────────────────
  // Defaulted from occupancy + propertyType using the shared rule helper.
  // Hydrates from a saved InsuranceScenario when present (so a manual
  // override survives logout/login). When the user picks a value from
  // the Select, we mark policyTypeSource = "manual" and persist on save.
  // (Resolution logic lives in the module-level `resolvePolicyTypeForAddress`
  // so Rebuild Cost seeding and this component stay in lockstep.)
  const initialPolicy = resolvePolicyTypeForAddress(addressParam);
  const [policyType, setPolicyType] = useAnonymousDraft<InsurancePolicyType | "">("policyType", initialPolicy.policyType);
  const [policyTypeSource, setPolicyTypeSource] = useAnonymousDraft<"default_rule" | "manual" | null>("policyTypeSource",
    initialPolicy.source
  );
  // Re-hydrate from the new address's own saved/default state whenever
  // the address changes. We do NOT carry over a previous address's
  // manual override — that would leak Property A's manual HO6 onto
  // Property B. `resolvePolicyTypeForAddress` reads the saved
  // InsuranceScenario for this address (preserving manual overrides
  // saved to Supabase) before falling back to the rule helper.
  useEffect(() => {
    if (anonymousDraftAddress.current === addressParam) return;
    const next = resolvePolicyTypeForAddress(addressParam);
    setPolicyType(next.policyType);
    setPolicyTypeSource(next.source);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressParam]);

  // ── Factor dropdowns (roof / wind / hurricane / construction / year
  //    / claims). These ARE the discounts/mitigation surface in this
  //    UI — moving them changes the calculated midpoint premium.
  //    Persisted inside `insurance_scenarios.user_answer_sources` jsonb
  //    under `factor_<name>` keys (no new column needed). When any are
  //    changed by the user we stamp `discountsSource = "manual"` so a
  //    future property-value sync can't reset them.
  function resolveFactorsFor(addr: string): {
    roof: number; wind: number; hurr: number; cons: number; year: number; claims: number;
    roofYear: number; yearBuilt: number;
    openingProtection: number; roofShape: number; swr: number;
  } {
    const defaults = {
      roof: 1, wind: 1, hurr: 0, cons: 0, year: 1, claims: 0,
      roofYear: 0,
      yearBuilt: 0,
      openingProtection: 0,
      roofShape: 2,
      swr: 1,
    };
    const key = (addr ?? "").trim().toLowerCase();
    if (!key) return defaults;
    const ins = getInsuranceScenarios().find(
      s => (s.address ?? "").trim().toLowerCase() === key
    );
    const ua = ins?.userAnswerSources;
    if (!ua) return defaults;
    const pick = (k: string, d: number) => {
      const v = ua[k];
      return typeof v === "number" && Number.isFinite(v) ? v : d;
    };
    const legacyRoof = pick("factor_roofIdx", defaults.roof);
    const legacyWind = pick("factor_windIdx", defaults.wind);
    const legacyYear = pick("factor_yearIdx", defaults.year);
    return {
      roof: legacyRoof,
      wind: legacyWind,
      hurr: pick("factor_hurrIdx", defaults.hurr),
      cons: ua.property_characteristics_construction_source === "manual" ? pick("factor_constIdx", defaults.cons) : defaults.cons,
      year: legacyYear,
      claims: 0,
      roofYear: ua.roof_year_source === "manual" ? pick("roof_year", 0) : 0,
      yearBuilt: ua.property_characteristics_year_built_source === "manual" ? pick("year_built", 0) : 0,
      openingProtection: pick(
        "opening_protection_idx",
        legacyWind === 2 ? 1 : defaults.openingProtection,
      ),
      roofShape: pick("roof_shape_idx", legacyWind === 2 ? 0 : defaults.roofShape),
      swr: pick("swr_idx", legacyWind === 2 ? 2 : legacyWind === 0 ? 0 : defaults.swr),
    };
  }
  const initialFactors = resolveFactorsFor(addressParam);
  const [hurrIdx, setHurrIdx]     = useAnonymousDraft("hurrIdx", initialFactors.hurr);
  const [constIdx, setConstIdx]   = useAnonymousDraft("constIdx", initialFactors.cons);
  const [roofYear, setRoofYear] = useAnonymousDraft("roofYear", initialFactors.roofYear);
  const [yearBuilt, setYearBuilt] = useAnonymousDraft("yearBuilt", initialFactors.yearBuilt);
  const [squareFeet, setSquareFeet] = useAnonymousDraft("squareFeet", 0);
  const [propertyCharacteristicsNote, setPropertyCharacteristicsNote] =
    useState("");
  const propertyCharacteristicLocksRef = useAnonymousDraftRef("propertyCharacteristicLocks", {
    floodZone: false,
    yearBuilt: false,
    squareFeet: false,
    construction: false,
  });
  const [openingProtectionIdx, setOpeningProtectionIdx] = useAnonymousDraft("openingProtectionIdx", initialFactors.openingProtection);
  const [roofShapeIdx, setRoofShapeIdx] = useAnonymousDraft("roofShapeIdx", initialFactors.roofShape);
  const [swrIdx, setSwrIdx] = useAnonymousDraft("swrIdx", initialFactors.swr);
  const roofIdx = roofFactorIndex(roofYear);
  const yearIdx = yearBuiltFactorIndex(yearBuilt);
  const windIdx = windMitigationIndex(openingProtectionIdx, roofShapeIdx, swrIdx);
  const [hasClaims, setHasClaims] = useAnonymousDraft<boolean | null>("hasClaims", null);
  const [claimRecords, setClaimRecords] = useAnonymousDraft<Array<{
    lossDate: string; claimDetail: string; amount: number | ""; paid: boolean | null; priorResidence: boolean | null;
  }>>("claimRecords", []);
  const claimsIdx = hasClaims ? Math.min(3, claimRecords.length) : 0;

  // AOP deductible uses the existing `user_answer_sources` jsonb scratch map.
  function resolveExtrasFor(addr: string): { aop: number } {
    const key = (addr ?? "").trim().toLowerCase();
    const ins = key
      ? getInsuranceScenarios().find(s => (s.address ?? "").trim().toLowerCase() === key)
      : undefined;
    const ua = ins?.userAnswerSources;
    const aopRaw = ua?.aop_deductible;
    return {
      aop: typeof aopRaw === "number" && Number.isFinite(aopRaw) && aopRaw > 0
        ? aopRaw : DEFAULT_AOP_DEDUCTIBLE,
    };
  }
  const initialExtras = resolveExtrasFor(addressParam);
  const [aopDeductible, setAopDeductible] = useAnonymousDraft<number>("aopDeductible", initialExtras.aop);

  function resolveQuotePropertyAnswersFor(addr: string): {
    newPurchase: boolean | null;
    purchaseDate: string;
    ho6ResidenceUse: QuoteRushResidenceUse | "";
    ho6RentalTerm: QuoteRushRentalTerm | "";
    purchasePrice: number;
    purchasePriceSource: QuoteRushPurchasePrice["source"] | "";
    currentlyInsured: boolean | null;
    currentCarrier: string;
  } {
    const key = (addr ?? "").trim().toLowerCase();
    const ins = key
      ? getInsuranceScenarios().find(s => (s.address ?? "").trim().toLowerCase() === key)
      : undefined;
    const ua = ins?.userAnswerSources;
    const savedNewPurchase = ua?.quote_new_purchase;
    const savedResidenceUse = ua?.quote_usage_type ?? ua?.quote_ho6_residence_use;
    const savedRentalTerm = ua?.quote_rental_term ?? ua?.quote_ho6_rental_term;
    const savedPurchasePrice = ua?.quote_purchase_price;
    const savedPurchasePriceSource = ua?.quote_purchase_price_source;
    const savedManualSource =
      savedPurchasePriceSource === "user-confirmed-contract" ||
      savedPurchasePriceSource === "user-confirmed-property-value";
    const knownPurchasePrice = savedManualSource
      ? resolvePurchasePriceProvenance({
          manual: {
            value: typeof savedPurchasePrice === "number" ? savedPurchasePrice : null,
            newPurchase:
              savedPurchasePriceSource === "user-confirmed-contract",
          },
        })
      : getKnownPurchasePriceForAddress(addr);
    const purchase = getPurchaseScenarios().find(
      p => isSamePropertyAddress(p.address, addr)
    );
    const cash = getCashBuyScenarios().find(
      c => isSamePropertyAddress(c.address, addr)
    );
    const loan = getTrackedLoans().find(
      l => isSamePropertyAddress(l.propertyAddress, addr)
    );
    const sourceOccupancy =
      cash?.occupancyType ??
      loan?.occupancyType ??
      (loan?.propertyType as QuoteRushResidenceUse | undefined) ??
      ins?.occupancyType ??
      (purchase ? "primary" : undefined);
    return {
      newPurchase:
        typeof savedNewPurchase === "boolean" ? savedNewPurchase : null,
      purchaseDate:
        typeof ua?.quote_purchase_date === "string" ? ua.quote_purchase_date : "",
      ho6ResidenceUse:
        savedResidenceUse === "primary" ||
        savedResidenceUse === "secondary" ||
        savedResidenceUse === "investment"
          ? savedResidenceUse
          : sourceOccupancy === "primary" ||
              sourceOccupancy === "secondary" ||
              sourceOccupancy === "investment"
            ? sourceOccupancy
            : "",
      ho6RentalTerm:
        savedRentalTerm === "annual" ||
        savedRentalTerm === "monthly" ||
        savedRentalTerm === "weekly"
          ? savedRentalTerm
          : "",
      purchasePrice:
        knownPurchasePrice.value ?? 0,
      purchasePriceSource:
        knownPurchasePrice.value ? knownPurchasePrice.source : "",
      currentlyInsured:
        typeof ua?.quote_currently_insured === "boolean"
          ? ua.quote_currently_insured : null,
      currentCarrier:
        typeof ua?.quote_current_carrier === "string" ? ua.quote_current_carrier : "",
    };
  }

  // Lazily resolve saved/scenario values once for the initial address. The
  // address-change hydration effect below resolves again only when needed.
  const [initialQuotePropertyAnswers] = useState(() =>
    resolveQuotePropertyAnswersFor(addressParam),
  );
  const [newPurchase, setNewPurchase] = useAnonymousDraft<boolean | null>("newPurchase",
    initialQuotePropertyAnswers.newPurchase,
  );
  const [purchaseDate, setPurchaseDate] = useAnonymousDraft("purchaseDate",
    initialQuotePropertyAnswers.purchaseDate,
  );
  const [ho6ResidenceUse, setHo6ResidenceUse] =
    useAnonymousDraft<QuoteRushResidenceUse | "">("ho6ResidenceUse",
      initialQuotePropertyAnswers.ho6ResidenceUse,
    );
  const [ho6RentalTerm, setHo6RentalTerm] =
    useAnonymousDraft<QuoteRushRentalTerm | "">("ho6RentalTerm",
      initialQuotePropertyAnswers.ho6RentalTerm,
    );
  const [purchasePrice, setPurchasePrice] = useAnonymousDraft("purchasePrice",
    initialQuotePropertyAnswers.purchasePrice,
  );
  const [purchasePriceSource, setPurchasePriceSource] = useAnonymousDraft<
    QuoteRushPurchasePrice["source"] | ""
  >("purchasePriceSource", initialQuotePropertyAnswers.purchasePriceSource);
  const [currentlyInsured, setCurrentlyInsured] = useAnonymousDraft<boolean | null>("currentlyInsured",
    initialQuotePropertyAnswers.currentlyInsured,
  );
  const [currentCarrier, setCurrentCarrier] = useAnonymousDraft("currentCarrier",
    initialQuotePropertyAnswers.currentCarrier,
  );
  const [currentPolicyExpirationDate, setCurrentPolicyExpirationDate] =
    useState("");
  const [currentPolicyExpirationLoading, setCurrentPolicyExpirationLoading] =
    useState(true);
  const [currentPolicyExpirationSaving, setCurrentPolicyExpirationSaving] =
    useState(false);
  const currentPolicyExpirationSaveRef = useRef<Promise<boolean>>(
    Promise.resolve(true),
  );
  const currentPolicyExpirationDirtyRef = useRef(false);
  const windMitigationLocksRef = useAnonymousDraftRef("windMitigationLocks", {
    openingProtection: false,
    secondaryWaterResistance: false,
  });

  function withQuotePropertyAnswers(
    existing: Record<string, any> | undefined,
  ): Record<string, any> {
    return {
      ...(existing ?? {}),
      // saveInsuranceScenarios stamps every changed Coverage A as manual.
      // Keep the actual input provenance so an automatic rate estimate cannot
      // masquerade as a manual lock after an address switch or reload.
      coverage_a_input_source: manualCoverageA.current ? "manual" : "confirmed_rebuild_rate",
      quote_new_purchase: newPurchase,
      quote_purchase_date: purchaseDate,
      quote_purchase_price: purchasePrice,
      quote_purchase_price_source: purchasePriceSource,
      quote_usage_type: ho6ResidenceUse,
      quote_rental_term: ho6RentalTerm,
      quote_ho6_residence_use: ho6ResidenceUse,
      quote_ho6_rental_term: ho6RentalTerm,
      quote_has_claims: hasClaims,
      quote_claim_records: claimRecords,
      quote_currently_insured: currentlyInsured,
      quote_current_carrier: currentCarrier,
    };
  }

  function currentQuoteRushPropertyDefaults() {
    if (quoteValidationMessages.length) throw new Error(quoteValidationMessages[0]);
    if (!policyType) {
      throw new Error("Select a policy type before requesting live quotes.");
    }
    if (newPurchase === null) {
      throw new Error("Select whether this is a new purchase.");
    }
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      throw new Error("Enter the property's confirmed purchase price or current value.");
    }
    if (newPurchase && !purchaseDate) throw new Error("Enter the confirmed closing date.");
    if (!newPurchase && currentlyInsured === null) {
      throw new Error("Answer whether this property is currently insured.");
    }
    if (!newPurchase && currentlyInsured && !currentCarrier.trim()) {
      throw new Error("Enter the current insurance carrier.");
    }
    if (hasClaims === null) {
      throw new Error("Answer whether you have had insurance claims in the past five years.");
    }
    if (hasClaims && (claimRecords.length < 1 || claimRecords.some(c =>
      !c.lossDate || !c.claimDetail.trim() || !Number.isFinite(c.amount) || Number(c.amount) <= 0 ||
      typeof c.paid !== "boolean" || typeof c.priorResidence !== "boolean",
    ))) {
      throw new Error("Complete every claim's loss date, type/cause, amount, paid status, and residence.");
    }
    return resolveQuoteRushPropertyDefaults({
      policyType,
      rebuildCost: rebuild,
      newPurchase,
      policyEffectiveDate: purchaseDate || undefined,
      usageType: ho6ResidenceUse,
      rentalTerm: ho6RentalTerm,
      purchasePrice: purchasePrice || undefined,
      purchasePriceSource: purchasePriceSource || undefined,
    });
  }

  // Flood zone resolved from FEMA (or a previously-saved value). Empty
  // string = unknown / still resolving (the UI shows "—").
  const [floodZone, setFloodZone]             = useAnonymousDraft<string>("floodZone", "");
  const [floodZoneSource, setFloodZoneSource] = useAnonymousDraft<string>("floodZoneSource", "");

  // ── QuoteRUSH live quotes ──────────────────
  const [qrLeadId, setQrLeadId] =
    useState<number | null>(null);
  const [qrQuotes, setQrQuotes] = useState<SourcedQuote[]>([]);
  const [qrCarrierTotal, setQrCarrierTotal] = useState<number | null>(null);
  const [qrRespondedCarriers, setQrRespondedCarriers] = useState<number | null>(null);
  const [qrResultsEpoch, setQrResultsEpoch] = useState(-1);
  const [qrStillWorking, setQrStillWorking] = useState(false);
  const [qrStatus, setQrStatus] = useState<
    | "idle"
    | "starting"
    | "pending"
    | "success"
    | "error"
    | "expired"
  >("idle");
  const [qrElapsed, setQrElapsed] = useState(0);
  const [qrQuoteCounter, setQrQuoteCounter] =
    useState(0);
  const [qrExpiresAt, setQrExpiresAt] =
    useState<string | null>(null);
  const [qrRefreshing, setQrRefreshing] =
    useState(false);
  const [qrSharedContext, setQrSharedContext] = useState<{
    propertyDataSnapshot: Record<string, unknown>;
    propertyDataProvenance: Record<string, unknown>;
    consumerPropertyAnswers: Record<string, unknown>;
    quoteProfileVersion?: string;
    assumptions: string[];
  } | null>(null);
  const [agentVerification, setAgentVerification] = useState<string[]>([]);
  const [dobPromptOpen, setDobPromptOpen] = useState(false);
  const [dobInput, setDobInput] = useState("");
  const [dobError, setDobError] = useState("");
  const [dobSaving, setDobSaving] = useState(false);
  const windMitigationReportConfirmed =
    qrSharedContext?.propertyDataProvenance
      ?.windMitigationReportConfirmed === true;
  const qrPollRef = useRef<
    ReturnType<typeof setInterval> | null
  >(null);
  const qrTimerRef = useRef<
    ReturnType<typeof setInterval> | null
  >(null);
  const qrPrevCounterRef = useRef(0);
  const qrStableRef = useRef(0);
  // Tracks the retry timer used while waiting for another concurrent
  // request to publish the shared-cache leadId (lost-claim-race case).
  const qrWaitRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const qrPendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quoteAccessTokenRef = useRef<string | null>(null);
  const qrRunStartedAtRef = useRef(0);
  // Guards the auto-trigger effect so a given address is processed once.
  const qrAutoRef = useRef<string>("");
  // Re-hydrate factors when the active address changes (mirrors the
  // manual-premium / policy-type rehydration pattern above) so
  // switching between scenario tabs restores each property's saved
  // dropdown picks.
  useEffect(() => {
    if (anonymousDraftAddress.current === addressParam) return;
    if (qrPollRef.current)
      clearInterval(qrPollRef.current);
    if (qrTimerRef.current)
      clearInterval(qrTimerRef.current);
    if (qrWaitRef.current)
      clearTimeout(qrWaitRef.current);
    qrAutoRef.current = "";
    setQrQuotes([]);
    setQrStatus("idle");
    setQrLeadId(null);
    setQrQuoteCounter(0);
    setQrExpiresAt(null);
    const f = resolveFactorsFor(addressParam);
    const seededCoverage = initialRebuildFor(addressParam, null);
    manualCoverageA.current = seededCoverage > 0;
    setRebuild(seededCoverage);
    setSqFtConfirmed(false);
    setFloodZoneUnknown(false);
    setFieldSources({});
    setConstructionSourced(false);
    setConstructionConfirmed(false);
    setRoofPermits([]);
    setRebuildRate(null);
    setQrSharedContext(null);
    setDobPromptOpen(false);
    setDobInput("");
    setHurrIdx(f.hurr);
    setConstIdx(f.cons);
    setRoofYear(f.roofYear);
    setYearBuilt(f.yearBuilt);
    setOpeningProtectionIdx(f.openingProtection);
    setRoofShapeIdx(f.roofShape);
    setSwrIdx(f.swr);
    const savedScenario = getInsuranceScenarios().find(
      s => (s.address ?? "").trim().toLowerCase() ===
        (addressParam ?? "").trim().toLowerCase(),
    );
    const answers = savedScenario?.userAnswerSources ?? {};
    manualRoofYear.current = answers.roof_year_source === "manual";
    setCurrentlyInsured(
      typeof answers.quote_currently_insured === "boolean"
        ? answers.quote_currently_insured : null,
    );
    setCurrentCarrier(
      typeof answers.quote_current_carrier === "string"
        ? answers.quote_current_carrier : "",
    );
    windMitigationLocksRef.current = {
      openingProtection: answers.opening_protection_source === "manual",
      secondaryWaterResistance: answers.swr_source === "manual",
    };
    propertyCharacteristicLocksRef.current = {
      floodZone: answers.property_characteristics_flood_zone_source === "manual",
      yearBuilt: answers.property_characteristics_year_built_source === "manual",
      squareFeet: answers.property_characteristics_square_feet_source === "manual",
      construction: answers.property_characteristics_construction_source === "manual",
    };
    setSquareFeet(
      typeof answers.square_feet_living === "number" && answers.square_feet_living > 0
        ? answers.square_feet_living : 0,
    );
    setPropertyCharacteristicsNote("");
    const ex = resolveExtrasFor(addressParam);
    setAopDeductible(ex.aop);
    const quoteProperty = resolveQuotePropertyAnswersFor(addressParam);
    setNewPurchase(quoteProperty.newPurchase);
    setPurchaseDate(quoteProperty.purchaseDate);
    setHo6ResidenceUse(quoteProperty.ho6ResidenceUse);
    setHo6RentalTerm(quoteProperty.ho6RentalTerm);
    setPurchasePrice(quoteProperty.purchasePrice);
    setPurchasePriceSource(quoteProperty.purchasePriceSource);
    setHasClaims(
      answers.quote_has_claims === true ? true :
        answers.quote_has_claims === false ? false : null,
    );
    setClaimRecords(
      Array.isArray(answers.quote_claim_records)
        ? answers.quote_claim_records.slice(0, 3) : [],
    );
    console.debug("[insurance-user-load] loaded user fields", {
      address: addressParam, factors: f, aop: ex.aop, quoteProperty,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressParam, user?.id]);

  // Auto-detect region when address changes
  useEffect(() => {
    if (addressParam) setRegionKey(getRegionFromAddress(addressParam));
  }, [addressParam]);

  // One-time note: AOP deductible, property details, and flood zone reuse the
  // existing `user_answer_sources` jsonb column — no schema migration
  // was required to add them.
  useEffect(() => {
  }, []);

  // ── Address editing ──────────────────────────────────────────────────────
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [editAddressVal, setEditAddressVal] = useState(addressParam);
  const [showEmptyAddInput, setShowEmptyAddInput] = useState(false);
  const {
    bindInputRef: addressInputRef,
    inputRef: addressInputElementRef,
  } = useGooglePlaces({
    enabled: isEditingAddress || showEmptyAddInput,
    onPlaceSelected: async place => {
      if (!await authorize("insurance", place.formatted_address)) return;
      setIsEditingAddress(false);
      setShowEmptyAddInput(false);
      setLocation(`/insurance?address=${encodeURIComponent(place.formatted_address)}`);
    },
  });

  const address = scenarios.find(s => s.id === activeScenarioId)?.address || addressParam;

  // ── Property-characteristics resolution ───────────────────────────────────
  // Resolve the FEMA flood zone for the active address. Priority:
  //   1. a value already saved on this insurance scenario
  //   2. the shared `/api/flood-zone` FEMA lookup (same source the
  //      Purchase-with-Loan / Cash-Buy flows use; cached server-side 24h)
  //   3. unknown → "" (the UI renders "—", never fake data)
  // The resolved zone is then persisted by the autosave effect below.
  useEffect(() => {
    const addr = (address ?? "").trim();
    if (!addr) { setFloodZone(""); setFloodZoneSource(""); return; }
    let cancelled = false;
    let floodPoll:ReturnType<typeof setTimeout>|undefined;
    const saved = getInsuranceScenarios().find(
      s => (s.address ?? "").trim().toLowerCase() === addr.toLowerCase(),
    );
    const savedZone = saved?.userAnswerSources?.flood_zone;
    if (
      propertyCharacteristicLocksRef.current.floodZone &&
      typeof savedZone === "string" &&
      savedZone.trim()
    ) {
      setFloodZone(savedZone.trim());
      setFloodZoneSource("Manual entry");
    } else if (!propertyCharacteristicLocksRef.current.floodZone) {
      setFloodZone(""); setFloodZoneSource("");
    }
    async function fallbackFlood() {
      try {
        const response = await authedFetch(`/api/flood-zone?address=${encodeURIComponent(addr)}`, { credentials: "include" });
        if (!response.ok) throw new Error("FEMA lookup failed");
        const result = await response.json();
        if(cancelled||propertyCharacteristicLocksRef.current.floodZone)return;
        if(result.status==="checking"){
          setFloodZone("");setFloodZoneSource("Checking FEMA flood map…");
          floodPoll=setTimeout(()=>void fallbackFlood(),20000);return;
        }
        if(result.status==="unavailable"){
          setFloodZone("");setFloodZoneSource("Unavailable — select your zone or ask your agent");return;
        }
        if (!result.zone && !result.floodZone) throw new Error("Missing zone");
        if (cancelled || propertyCharacteristicLocksRef.current.floodZone) return;
        const zone = String(result.zone || result.floodZone);
        const queriedAt = result.queriedAt || new Date().toISOString();
        setFloodZone(zone);
        setFloodZoneSource(`${result.source||"FEMA National Flood Hazard Layer"} · Queried ${queriedAt}`);
        setFieldSources(previous => ({ ...previous, floodZone: { value: zone, source: "FEMA National Flood Hazard Layer", sourceUrl: result.sourceUrl, fetchedAt: queriedAt } }));
      } catch {
        if (!cancelled && !propertyCharacteristicLocksRef.current.floodZone) {
          setFloodZone("");
          setFloodZoneSource("Checking FEMA flood map…");
          floodPoll=setTimeout(()=>void fallbackFlood(),20000);
        }
      }
    }
    authedFetch(`/api/insurance/property-characteristics?address=${encodeURIComponent(addr)}`, { credentials: "include" })
      .then(async res => res.ok ? res.json() : null)
      .then(async profile => {
        if (cancelled) return;
        if (!profile) { await fallbackFlood(); return; }
        setFieldSources(profile.fieldSources ?? {});
        setRoofPermits(Array.isArray(profile.roofPermits) ? profile.roofPermits : []);
        const locks = propertyCharacteristicLocksRef.current;
        const zone = profile.fieldSources?.floodZone?.value ?? profile.floodZone;
        if (!locks.floodZone && typeof zone === "string" && zone) {
          setFloodZone(zone);
          setFloodZoneSource(`${profile.fieldSources?.floodZone?.source||"FEMA National Flood Hazard Layer"} · Queried ${profile.fieldSources?.floodZone?.fetchedAt || profile.queriedAt || new Date().toISOString()}`);
        }
        const built = profile.fieldSources?.yearBuilt?.value ?? profile.yearBuilt;
        if (!locks.yearBuilt && Number.isInteger(built) && built >= 1800) {
          setYearBuilt(built);
        }
        const living = profile.fieldSources?.squareFeetLiving?.value ?? profile.squareFeetLiving;
        if (!locks.squareFeet && Number.isFinite(living) && living > 0) {
          setSquareFeet(Math.round(living));
          setSqFtConfirmed(false);
        }
        const construction = String(profile.fieldSources?.constructionLabel?.value ?? profile.constructionLabel ?? "").trim().toUpperCase();
        const constructionIndex =
          ["CONCRETE BLOCK", "CONCRETE", "MASONRY"].includes(construction) ? 0
            : ["FRAME", "WOOD FRAME", "WOOD"].includes(construction) ? 2
              : ["MIXED", "MIXED MASONRY / FRAME"].includes(construction) ? 1 : null;
        const constructionSource = profile.fieldSources?.constructionLabel?.source;
        const sourcedConstructionValue = profile.fieldSources?.constructionLabel?.value;
        const knownSource = typeof constructionSource === "string" &&
          typeof sourcedConstructionValue === "string" && sourcedConstructionValue.trim().length > 0 &&
          constructionSource.trim().length > 0 &&
          !/\bassum|\bdefault\b|\bunknown\b|\bunavailable\b|\bconfirm\b/i.test(constructionSource);
        setConstructionSourced(constructionIndex != null && knownSource);
        if (!locks.construction && constructionIndex != null) setConstIdx(constructionIndex);
        const notes = [
          profile.yearBuiltEffective && profile.yearBuiltEffective !== profile.yearBuilt
            ? `Effective year: ${profile.yearBuiltEffective}.` : "",
          profile.buildingDataSource ? `Building source: ${profile.buildingDataSource}.` : "",
        ].filter(Boolean);
        setPropertyCharacteristicsNote(notes.join(" "));
        if (!zone) await fallbackFlood();
      })
      .catch(fallbackFlood);
    return () => { cancelled = true; if(floodPoll)clearTimeout(floodPoll); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, user?.id]);

  useEffect(() => {
    let cancelled = false;
    setRebuildRate(null);
    setRateError("");
    if (!address) return;
    authedFetch(`/api/insurance/rebuild-rate?address=${encodeURIComponent(address)}`, { credentials: "include" })
      .then(async response => {
        if (!response.ok) throw new Error("County rebuild rates could not be loaded. Enter Coverage A manually or retry.");
        return response.json();
      })
      .then(rate => { if (!cancelled) setRebuildRate(rate); })
      .catch(error => { if (!cancelled) setRateError(error.message); });
    return () => { cancelled = true; };
  }, [address, user?.id, rateRetry]);
  const [assumedCreditScore,setAssumedCreditScore]=useState("Excellent");
  useEffect(()=>{
    let active=true;
    authedFetch("/api/insurance/quote-assumptions").then(async r=>{
      if(!r.ok)throw Error("Assumptions unavailable");
      const data=await r.json();if(active)setAssumedCreditScore(data.assumedCreditScore||"Excellent");
    }).catch(()=>{if(active)setAssumedCreditScore("Unavailable");});
    return()=>{active=false;};
  },[]);
  const costPerSqFt = constIdx === 2 ? rebuildRate?.frame_cost_per_sqft
    : constIdx === 0 || constIdx === 1 ? rebuildRate?.masonry_cost_per_sqft : null;
  const constructionKnown = [0, 1, 2].includes(constIdx) &&
    (constructionSourced || constructionConfirmed || propertyCharacteristicLocksRef.current.construction);
  const policyAnswered = !!policyType && policyTypeSource === "manual";
  const computedCoverage = sqFtConfirmed && constructionKnown && squareFeet > 0 && typeof costPerSqFt === "number" && costPerSqFt > 0
    ? Math.round(squareFeet * costPerSqFt / 1000) * 1000 : 0;
  useEffect(() => {
    if (!manualCoverageA.current) setRebuild(computedCoverage);
  }, [computedCoverage]);
  const rebuildExplanation = (manualCoverageA.current
    ? "Source: Manual Coverage A — your value is retained and will not be replaced by a lookup."
    : computedCoverage > 0
      ? `${squareFeet.toLocaleString()} confirmed sq. ft. × $${costPerSqFt!.toLocaleString("en-US", { maximumFractionDigits: 6 })} per sq. ft. = $${(squareFeet * costPerSqFt!).toLocaleString("en-US", { maximumFractionDigits: 2 })}; rounded to nearest $1,000: ${fmt(computedCoverage)}. ${rebuildRate?.countyName || rebuildRate?.county} · ${rebuildRate?.source_note || "Source note unavailable"} · Updated ${rebuildRate?.updated_at || "date unavailable"}.`
      : "Coverage A is required. Confirm living area and construction to use a configured county rate, or enter your rebuild estimate manually. Missing rate means no estimate — never market value.") +
    " Not an appraisal — your carrier may adjust Coverage A.";

  useEffect(() => {
    if (!isEditingAddress) return;
    setEditAddressVal(address);
    const timer = setTimeout(() => addressInputElementRef.current?.select(), 30);
    return () => clearTimeout(timer);
  }, [address, addressInputElementRef, isEditingAddress]);

  // ── Scenario helpers ─────────────────────────────────────────────────────
  function currentSettings(): InsuranceSettings {
    return {
      regionKey, rebuild, roofIdx, windIdx, hurrIdx, constIdx, yearIdx, claimsIdx,
      roofYear, yearBuilt, openingProtectionIdx, roofShapeIdx, swrIdx,
    };
  }

  function applySettings(s: InsuranceSettings) {
    setRegionKey(s.regionKey); setRebuild(s.rebuild);
    setHurrIdx(s.hurrIdx);
    setConstIdx(s.constIdx);
    setRoofYear(s.roofYear ?? 0);
    setYearBuilt(s.yearBuilt ?? 0);
    setOpeningProtectionIdx(s.openingProtectionIdx ?? (s.windIdx === 2 ? 1 : 0));
    setRoofShapeIdx(s.roofShapeIdx ?? (s.windIdx === 2 ? 0 : 2));
    setSwrIdx(s.swrIdx ?? (s.windIdx === 2 ? 2 : s.windIdx === 0 ? 0 : 1));
  }

  function switchScenario(targetId: string) {
    if (targetId === activeScenarioId) return;
    const target = scenarios.find(s => s.id === targetId);
    if (!target) return;
    setScenarios(prev => prev.map(s => s.id === activeScenarioId ? { ...s, savedSettings: currentSettings() } : s));
    setActiveScenarioId(targetId);
    setLocation(`/insurance?address=${encodeURIComponent(target.address)}`);
    if (target.savedSettings) applySettings(target.savedSettings);
    else {
      setRegionKey(getRegionFromAddress(target.address));
      setRebuild(defaultRebuildFor(target.address, null));
    }
  }

  function removeScenario(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (scenarios.length === 1) return;
    const idx = scenarios.findIndex(s => s.id === id);
    const remaining = scenarios.filter(s => s.id !== id);
    setScenarios(remaining);
    if (id === activeScenarioId) {
      const next = remaining[Math.max(0, idx - 1)];
      setActiveScenarioId(next.id);
      setLocation(`/insurance?address=${encodeURIComponent(next.address)}`);
      if (next.savedSettings) applySettings(next.savedSettings);
      else {
        setRegionKey(getRegionFromAddress(next.address));
        setRebuild(defaultRebuildFor(next.address, null));
      }
    }
  }

  function requestAddScenario() {
    if (scenarios.length >= 5) {
      toast({ title: "Maximum 5 properties", description: "Remove a tab to add a new property." });
      return;
    }
    setShowAddressPrompt(true);
  }

  async function confirmNewScenario() {
    const addr = newScenarioAddress.trim();
    if (!addr) return;
    if (!await authorize("insurance", addr)) return;
    const newId = `sc_${Date.now()}`;
    setScenarios(prev => [
      ...prev.map(s => s.id === activeScenarioId ? { ...s, savedSettings: currentSettings() } : s),
      { id: newId, address: addr, savedSettings: null },
    ]);
    setActiveScenarioId(newId);
    setLocation(`/insurance?address=${encodeURIComponent(addr)}`);
    setRegionKey(getRegionFromAddress(addr));
    setRebuild(defaultRebuildFor(addr, null));
    setRoofYear(0);
    setYearBuilt(0);
    setOpeningProtectionIdx(0);
    setRoofShapeIdx(2);
    setSwrIdx(1);
    setHurrIdx(0);
    setConstIdx(0);
    setNewScenarioAddress("");
    setShowAddressPrompt(false);
  }

  // ── Share / Save ─────────────────────────────────────────────────────────
  const [leadDialogOpen, setLeadDialogOpen] = useState(false);
  const [leadDialogAction, setLeadDialogAction] = useState<"share" | "save">("share");
  useEffect(() => {
    let active = true;
    setAgentVerification([]);
    if (!isAuthenticated || !address || !policyType || !qrLeadId) {
      return () => { active = false; };
    }
    authedFetch(
      `/api/insurance/qr-agent-verification?address=${encodeURIComponent(address)}` +
        `&policyType=${encodeURIComponent(policyType)}`,
    )
      .then(async response => response.ok ? response.json() : null)
      .then(data => {
        if (active && Array.isArray(data?.fields)) {
          setAgentVerification(
            data.fields.filter((field: unknown): field is string =>
              typeof field === "string",
            ),
          );
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [isAuthenticated, address, policyType, qrLeadId]);
  useEffect(() => {
    let active = true;
    currentPolicyExpirationDirtyRef.current = false;
    setCurrentPolicyExpirationDate("");
    setCurrentPolicyExpirationLoading(true);
    if (!isAuthenticated || !address) {
      setCurrentPolicyExpirationLoading(false);
      return () => { active = false; };
    }
    authedFetch(
      `/api/profile/insurance-property?address=${encodeURIComponent(address)}`,
    )
      .then(async response => response.ok ? response.json() : null)
      .then(data => {
        if (active && !currentPolicyExpirationDirtyRef.current) {
          setCurrentPolicyExpirationDate(
            typeof data?.currentPolicyExpirationDate === "string"
              ? data.currentPolicyExpirationDate
              : "",
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setCurrentPolicyExpirationLoading(false);
      });
    return () => { active = false; };
  }, [isAuthenticated, address]);

  function saveCurrentPolicyExpirationDate(value: string): void {
    currentPolicyExpirationDirtyRef.current = true;
    setCurrentPolicyExpirationDate(value);
    if (!isAuthenticated || !address) return;
    setCurrentPolicyExpirationSaving(true);
    const savePromise =
      currentPolicyExpirationSaveRef.current
      .then(() => authedFetch(
        "/api/profile/insurance-property",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address,
            currentPolicyExpirationDate: value || null,
          }),
        },
      ))
      .then(response => {
        if (!response.ok) throw new Error("save failed");
        return true;
      })
      .catch(() => {
        toast({
          title: "Policy expiration date not saved",
          description: "Please try selecting the date again before requesting live quotes.",
          variant: "destructive",
        });
        return false;
      });
    currentPolicyExpirationSaveRef.current = savePromise;
    void savePromise.finally(() => {
      if (currentPolicyExpirationSaveRef.current === savePromise) {
        setCurrentPolicyExpirationSaving(false);
      }
    });
  }

  function setInsuranceQRCache(
    addr: string,
    patch: Partial<QRCacheEntry>,
    quotePolicyType?: string,
  ): void {
    // Do not write private quotes to an address-only browser cache.
    void addr; void patch; void quotePolicyType;
  }

  // ── Logged-in landing behavior (no address param) ────────────────────────
  // 1) If the user has saved Insurance scenarios, auto-jump to the first
  //    one so they land directly on their property instead of a blank
  //    simulator. Only runs while addressParam is empty so the redirect
  //    can't loop (after navigation, addressParam is set and the guard
  //    short-circuits).
  // 2) If the user has zero saved scenarios, an empty state is rendered
  //    below (no redirect, no auto-mounting of the simulator content).
  // 3) Guests are untouched — they keep the simulator-first experience.
  const currentUserId = getSession()?.id ?? null;
  const visibleSavedInsuranceScenarios = () => {
    const dismissed = readDismissedInsuranceKeys(currentUserId);
    return getInsuranceScenarios().filter(s => {
      const normalizedKey = normalizePropertyKey(s.address).key;
      return !isInsuranceAddressDismissed(dismissed, s.address, normalizedKey);
    });
  };
  const savedInsuranceCount = isAuthenticated && !addressParam
    ? visibleSavedInsuranceScenarios().length
    : -1; // sentinel: don't read when not needed
  useEffect(() => {
    if (!isAuthenticated) return;
    if (addressParam) return;
    const saved = visibleSavedInsuranceScenarios();
    if (saved.length === 0) return;
    const first = saved[0];
    const target = first?.address;
    if (!target) return;
    setLocation(`/insurance?address=${encodeURIComponent(target)}`, { replace: true });
  }, [isAuthenticated, addressParam, setLocation]);

  // ── Address-tab hydration (spec: insurance-detail-address-tabs-sync) ─────
  // The top scenario tabs need to mirror the Insurance overview cards.
  // Without this, `scenarios` only ever contains the single tab the user
  // arrived on (initial useState above), so a user with three saved
  // Insurance properties would still only see one tab in the detail view.
  //
  // We hydrate once per mount when the user is authenticated and an
  // address is in the URL. We dedupe by normalized address (same key the
  // overview's `buildInsuranceRows` uses) so duplicate insurance_scenarios
  // rows collapse to a single tab — we never delete the underlying rows
  // here (spec: "do not delete/merge duplicates in this task").
  const didHydrateTabsRef = useRef(false);
  useEffect(() => {
    if (didHydrateTabsRef.current) return;
    if (!isAuthenticated) return;
    if (!addressParam) return; // wait for the auto-jump above to land us on an address
    const dismissed = readDismissedInsuranceKeys(currentUserId);
    const saved = visibleSavedInsuranceScenarios();
    didHydrateTabsRef.current = true;

    // Use the SAME normalization primitive the overview uses
    // (`normalizePropertyKey` from lib/property-key.ts — same helper
    // `buildInsuranceRows` and `insurance_scenarios.normalized_property_key`
    // are keyed on). Plain `trim().toLowerCase()` would let "123 Main St"
    // and "123 main st, st petersburg, fl" land in different buckets and
    // produce parity drift vs the overview cards.
    const keyFor = (addr: string) => normalizePropertyKey(addr).key
      || (addr ?? "").trim().toLowerCase();
    const activeKey = keyFor(addressParam);
    const activeIsDismissed = isInsuranceAddressDismissed(
      dismissed,
      addressParam,
      activeKey,
    );
    if (saved.length === 0 && activeIsDismissed) {
      didHydrateTabsRef.current = true;
      setScenarios([]);
      setLocation("/dashboard?tab=insurance", { replace: true });
      return;
    }
    if (saved.length === 0) return;
    const seen = new Map<string, string>(); // key → address (kept tab)
    const tabs: Scenario[] = [];
    let activeId = "";
    let dupCount = 0;
    for (const s of saved) {
      const addr = (s.address ?? "").trim();
      if (!addr) continue;
      const k = keyFor(addr);
      if (!k) continue;
      if (seen.has(k)) {
        dupCount += 1;
        continue;
      }
      seen.set(k, addr);
      const id = s.id || `sc_saved_${tabs.length}`;
      tabs.push({ id, address: addr, savedSettings: null });
      if (activeKey && activeKey === k) activeId = id;
    }
    // URL address isn't in saved scenarios yet (e.g. brand-new property the
    // user navigated into but hasn't saved) — keep it as a tab so we don't
    // strand them on a blank UI.
    if (activeKey && !seen.has(activeKey) && !activeIsDismissed) {
      const id = `sc_current_${Date.now()}`;
      tabs.unshift({ id, address: addressParam, savedSettings: null });
      seen.set(activeKey, addressParam);
      activeId = id;
    }
    if (!activeId) activeId = tabs[0].id;
    if (activeIsDismissed && tabs[0]?.address) {
      setLocation(
        `/insurance?address=${encodeURIComponent(tabs[0].address)}`,
        { replace: true },
      );
    }

    // Parity check: any overview-source address whose normalized key is
    // not represented in the detail tab set. Should be empty after the
    // dedupe loop above — this log exists so we can spot drift quickly.
    const tabKeys = new Set(tabs.map(t => keyFor(t.address)));
    const missing = saved
      .map(s => ({ address: (s.address ?? "").trim(), key: keyFor((s.address ?? "").trim()) }))
      .filter(x => x.address && x.key && !tabKeys.has(x.key));
    if (dupCount > 0) {
    }
    setScenarios(tabs);
    setActiveScenarioId(activeId);
  }, [isAuthenticated, addressParam]);

  useEffect(() => {
    if (!showEmptyAddInput) return;
    const timer = setTimeout(() => addressInputElementRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [addressInputElementRef, showEmptyAddInput]);

  const showInsuranceEmptyState =
    isAuthenticated && !addressParam && savedInsuranceCount === 0;

  function openLeadDialog(action: "share" | "save") {
    setLeadDialogAction(action);
    setLeadDialogOpen(true);
  }

  function handleLeadSuccess() {
    if (leadDialogAction === "share") {
      navigator.clipboard.writeText(window.location.href).catch(() => {});
      toast({ title: "Link copied!", description: "Share the URL with anyone to show this estimate." });
    } else {
      toast({ title: "Scenario saved!", description: "Your insurance estimate has been saved." });
    }
  }

  function handleShare() {
    if (isAuthenticated) {
      navigator.clipboard.writeText(window.location.href).catch(() => {});
      toast({ title: "Link copied!", description: "Share the URL with anyone to show this estimate." });
    } else {
      openLeadDialog("share");
    }
  }

  function handleSave() {
    if (isAuthenticated) {
      toast({ title: "Scenario saved!", description: "Your insurance estimate has been saved." });
    } else {
      openLeadDialog("save");
    }
  }

  // PostHog: scenario_calculated (insurance). Fires once per address the
  // first time the rebuild-derived premium becomes meaningful (> 0). Keying
  // by address (rather than a page-level boolean) lets a second scenario
  // emit on the same mount if the user navigates between addresses.
  const phInsuranceCalcFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!(rebuild > 0)) return;
    const key = (address || "").trim().toLowerCase();
    if (!key) return;
    if (phInsuranceCalcFiredRef.current.has(key)) return;
    phInsuranceCalcFiredRef.current.add(key);
    trackEvent("scenario_calculated", { type: "insurance" });
  }, [rebuild, address]);

  // ── Autosave ─────────────────────────────────────────────────────────────
  // Debounced 600 ms writer that mirrors the Save button payload so
  // every editable field (Coverage A, factor dropdowns, policy type,
  // manual annual premium) round-trips to `insurance_scenarios`
  // without the user clicking Save. Gated on:
  //   1. `isAuthenticated` — guests don't have a Supabase user_id
  //   2. `hydratedRef.current` — first render after address change
  //      seeds defaults; saving before hydration would clobber the
  //      saved row with placeholder values (same race-prevention
  //      pattern used in seller-estimate.tsx).
  const insuranceHydratedRef = useRef(false);
  useEffect(() => {
    // Mark hydrated one tick after the address-change rehydration
    // effect above has run. That effect updates state synchronously,
    // so by the time this microtask resolves the new factor/premium
    // values are in place.
    insuranceHydratedRef.current = false;
    const t = window.setTimeout(() => { insuranceHydratedRef.current = true; }, 0);
    return () => window.clearTimeout(t);
  }, [addressParam]);

  useEffect(() => {
    if (!insuranceHydratedRef.current) return;
    const addr = (address ?? "").trim();
    if (!addr) return;
    const t = window.setTimeout(() => {
      const existing = getInsuranceScenarios();
      const key = addr.toLowerCase();
      const match = existing.find(s => s.address.trim().toLowerCase() === key);
      const incomingKey = normalizePropertyKey(addr).key || undefined;
      // Roll a fresh midpoint from current factors so a coverage-only
      // change keeps annual premium consistent (mirrors the Save
      // button). When the user has typed a manual premium, that wins.
      const midNow = (() => {
        const rawAdj = ROOF_ADJ[roofIdx]
          * OPENING_PROTECTION_ADJ[openingProtectionIdx]
          * ROOF_SHAPE_ADJ[roofShapeIdx]
          * SWR_ADJ[swrIdx]
          * HURR_ADJ[hurrIdx];
        const adj = rawAdj / NEUTRAL_FACTOR_PRODUCT;
        const baselineRate = getBaselineHomeownersInsuranceRate({
          yearBuilt,
          isFrameConstruction: constIdx === 2,
        });
        return rebuild * baselineRate * adj;
      })();
      // Detect manual factor edits by comparing against defaults
      // (1,1,0,0,1,0). Any drift stamps discountsSource = "manual"
      // so future syncs leave them alone. If the user resets back to
      // all-defaults, we still preserve a prior manual stamp on the
      // existing row so they don't lose the lock by accident.
      const factorsChangedFromDefault =
        roofYear !== 0 ||
        yearBuilt !== 0 ||
        openingProtectionIdx !== 0 ||
        roofShapeIdx !== 2 ||
        swrIdx !== 1 ||
        hurrIdx !== 0 ||
        constIdx !== 0;
      const discountsSource =
        factorsChangedFromDefault || match?.discountsSource === "manual"
          ? "manual" as const
          : match?.discountsSource;
      // AOP deductible: stamp "manual" once edited away from the default,
      // preserving any prior manual lock on the existing row.
      const aopSourceNow =
        aopDeductible !== DEFAULT_AOP_DEDUCTIBLE || match?.aopDeductibleSource === "manual"
          ? "manual" as const
          : match?.aopDeductibleSource;
      const updated: InsuranceScenario = {
        id: match?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        address: addr,
        savedAt: new Date().toISOString(),
        // Spec: insurance-ho6-half-coverage-and-premium — manual / quote
        // premium MUST be preserved when policy type recomputes Coverage A.
        // Manual input wins, then a prior quote upload (locked dollar
        // value, not just label), else the calculated midpoint.
        annualPremium:
          manualAnnualPremium != null
            ? manualAnnualPremium
            : match?.premiumSource === "quote" && typeof match.annualPremium === "number"
              ? match.annualPremium
              : Math.round(midNow),
        coverageA: rebuild,
        coverageASource: manualCoverageA.current ? "manual" : "default",
        premiumSource:
          manualAnnualPremium != null
            ? "manual"
            : match?.premiumSource === "quote" ? "quote" : "default_0_75_percent",
        coverageType: region.name,
        ...(incomingKey ? { normalizedPropertyKey: incomingKey } : {}),
        ...(policyType
          ? { policyType, policyTypeSource: policyTypeSource ?? "default_rule" }
          : {}),
        ...(match?.occupancyType ? { occupancyType: match.occupancyType } : {}),
        ...(match?.propertyType ? { propertyType: match.propertyType } : {}),
        // Carry forward all previously-stamped source fields so we
        // don't wipe locks set by future UI work (AOP /
        // deductibles / quote details).
        ...(match?.occupancyTypeSource ? { occupancyTypeSource: match.occupancyTypeSource } : {}),
        ...(match?.propertyTypeSource ? { propertyTypeSource: match.propertyTypeSource } : {}),
        // AOP source: stamp "manual" once the user changes the value away
        // from the default, and keep a prior manual stamp.
        ...(aopSourceNow ? { aopDeductibleSource: aopSourceNow } : {}),
        ...(match?.hurricaneDeductibleSource ? { hurricaneDeductibleSource: match.hurricaneDeductibleSource } : {}),
        ...(match?.floodDeductibleSource ? { floodDeductibleSource: match.floodDeductibleSource } : {}),
        ...(match?.quoteDetailsSource ? { quoteDetailsSource: match.quoteDetailsSource } : {}),
        ...(discountsSource ? { discountsSource } : {}),
        // Persist the estimate answers inside the jsonb scratch map.
        // Keys are namespaced with `factor_` so they don't collide
        // with any future source-tag entries the cash-buy / seller
        // pattern might add to the same column. AOP deductible and the
        // FEMA flood zone live here too (no dedicated value
        // column needed).
        userAnswerSources: {
          ...withQuotePropertyAnswers(match?.userAnswerSources),
          factor_roofIdx: roofIdx,
          factor_windIdx: windIdx,
          factor_hurrIdx: hurrIdx,
          factor_constIdx: constIdx,
          factor_yearIdx: yearIdx,
          factor_claimsIdx: hasClaims ? claimRecords.length : 0,
          roof_year: roofYear,
          roof_year_source: manualRoofYear.current ? "manual" : "unknown",
          year_built: yearBuilt,
           square_feet_living: squareFeet,
           property_characteristics_flood_zone_source:
             propertyCharacteristicLocksRef.current.floodZone ? "manual" : "auto",
           property_characteristics_year_built_source:
             propertyCharacteristicLocksRef.current.yearBuilt ? "manual" : "auto",
           property_characteristics_square_feet_source:
             propertyCharacteristicLocksRef.current.squareFeet ? "manual" : "auto",
           property_characteristics_construction_source:
             propertyCharacteristicLocksRef.current.construction ? "manual" : "auto",
          opening_protection_idx: openingProtectionIdx,
           opening_protection_source:
             windMitigationLocksRef.current.openingProtection ? "manual" : "auto",
          roof_shape_idx: roofShapeIdx,
          swr_idx: swrIdx,
           swr_source:
             windMitigationLocksRef.current.secondaryWaterResistance ? "manual" : "auto",
          ...(factorsChangedFromDefault ? { factor_source: "manual" } : {}),
          aop_deductible: aopDeductible,
          // Only write a flood zone once one is actually resolved so the
          // empty mid-lookup state never wipes a previously-saved value.
          ...(floodZone
            ? { flood_zone: floodZone, flood_zone_source: floodZoneSource || "fema" }
            : {}),
        },
      };
      console.debug("[insurance-user-save] scenario id", updated.id);
      console.debug("[insurance-user-save] normalized property key", incomingKey);
      console.debug("[insurance-user-save] changed field", "(autosave snapshot)");
      console.debug("[insurance-user-save] value", {
        coverageA: rebuild, policyType, manualAnnualPremium,
        factors: {
          roofYear, yearBuilt, openingProtectionIdx, roofShapeIdx, swrIdx,
          hurrIdx, constIdx,
        },
      });
      console.debug("[insurance-user-save] source", {
        coverageA: updated.coverageASource, policy: updated.policyTypeSource,
        premium: updated.premiumSource, discounts: updated.discountsSource,
      });
      const next = match
        ? existing.map(s => (s.id === match.id ? updated : s))
        : [...existing, updated];
      if (!getSession()) {
        rememberAnonymousAccountDraft("insurance", updated);
        return;
      }
      confirmAnonymousAccountDraftSaved("insurance", () => saveInsuranceScenarios(next)).catch(err => {
        console.debug("[insurance-user-save] upsert error", err?.message ?? err);
      });
      // New scenario only (!match fires once): notify the assigned agent
      // (non-blocking, fire-and-forget).
      if (!match) notifyNewScenario("Insurance", address, "Saved an insurance scenario");
      trackEvent("scenario_saved", { type: "insurance" });
    }, 600);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isAuthenticated, address, rebuild, policyType, policyTypeSource,
    manualAnnualPremium, roofYear, yearBuilt, openingProtectionIdx, roofShapeIdx,
    swrIdx, hurrIdx, constIdx, aopDeductible, floodZone, floodZoneSource,
     newPurchase, purchaseDate, purchasePrice, purchasePriceSource,
      ho6ResidenceUse, ho6RentalTerm, squareFeet, currentlyInsured, currentCarrier,
  ]);

  // Quote results belong to an authenticated user AND the complete answer set.
  // Never hydrate an address-only local or shared cache. qr-start alone gates reuse.
  const quoteIdentity = JSON.stringify([
    user?.id, address, rebuild, policyType, policyAnswered, roofYear, yearBuilt, constIdx, constructionKnown,
    openingProtectionIdx, roofShapeIdx, swrIdx, hurrIdx, aopDeductible,
    floodZone, floodZoneUnknown, squareFeet, sqFtConfirmed, newPurchase,
    purchaseDate, purchasePrice, purchasePriceSource, ho6ResidenceUse,
    ho6RentalTerm, currentlyInsured, currentCarrier, currentPolicyExpirationDate,
    hasClaims, claimRecords,
  ]);
  const quoteIdentityRef = useRef(quoteIdentity);
  const quoteEpochRef = useRef(0);
  if (quoteIdentityRef.current !== quoteIdentity) quoteEpochRef.current += 1;
  quoteIdentityRef.current = quoteIdentity;
  const quoteValidationMessages = [
    ...(!policyAnswered ? ["Select or confirm a policy type."] : []),
    ...(newPurchase === null ? ["Select whether this is a new purchase."] : []),
    ...(newPurchase && !purchaseDate ? ["Enter the confirmed closing date."] : []),
    ...(!Number.isFinite(purchasePrice) || purchasePrice <= 0 || !purchasePriceSource ? ["Enter a confirmed property value with its source."] : []),
    ...(policyType !== "DP3" && !ho6ResidenceUse ? ["Select residence use."] : []),
    ...((policyType === "DP3" || ho6ResidenceUse === "investment") && !ho6RentalTerm ? ["Select the rental term."] : []),
    ...(newPurchase === false && currentlyInsured === null ? ["Answer whether the property is currently insured."] : []),
    ...(newPurchase === false && currentlyInsured && !currentCarrier.trim() ? ["Enter the current insurance carrier."] : []),
    ...(newPurchase === false && currentlyInsured && !currentPolicyExpirationDate ? ["Enter the current policy expiration date."] : []),
    ...(hasClaims === null ? ["Answer the claims-history question."] : []),
    ...(hasClaims && (!claimRecords.length || claimRecords.some(c => !c.lossDate || !c.claimDetail.trim() || Number(c.amount) <= 0 || !Number.isFinite(Number(c.amount)) || typeof c.paid !== "boolean" || typeof c.priorResidence !== "boolean")) ? ["Complete every claim's loss date, type/cause, amount, paid status, and residence."] : []),
    ...(!Number.isInteger(yearBuilt) || yearBuilt < 1800 || yearBuilt > 2027 ? ["Enter the home's year built."] : []),
    ...(!validRoofYear(roofYear) ? [ROOF_YEAR_ERROR] : []),
    ...(!sqFtConfirmed || !Number.isFinite(squareFeet) || squareFeet <= 0 ? ["Confirm the living area square footage."] : []),
    ...(!constructionKnown ? ["Select or confirm a known construction type; the default is only assumed."] : []),
    ...(!Number.isFinite(rebuild) || rebuild <= 0 ? ["Enter Coverage A or confirm square footage and a configured rebuild rate."] : []),
  ];
  useEffect(() => {
    if (qrPollRef.current) clearInterval(qrPollRef.current);
    if (qrTimerRef.current) clearInterval(qrTimerRef.current);
    if (qrWaitRef.current) clearTimeout(qrWaitRef.current);
    if (qrPendingRef.current) clearTimeout(qrPendingRef.current);
    quoteAccessTokenRef.current = null;
    setQrQuotes([]);
    setQrLeadId(null);
    setQrStatus("idle");
    setQrSharedContext(null);
    setQrExpiresAt(null);
    setQrRefreshing(false);
    setQrElapsed(0);
    setQrQuoteCounter(0);
    setQrStillWorking(false);
    setQrCarrierTotal(null);
    setQrRespondedCarriers(null);
    return () => {
      if (qrPollRef.current) clearInterval(qrPollRef.current);
      if (qrTimerRef.current) clearInterval(qrTimerRef.current);
      if (qrWaitRef.current) clearTimeout(qrWaitRef.current);
      if (qrPendingRef.current) clearTimeout(qrPendingRef.current);
      quoteAccessTokenRef.current = null;
    };
  }, [quoteIdentity]);

  // ── QuoteRUSH quoting ─────────────────────

  function updateCarrierProgress(data: { expectedCarriers?: unknown; respondedCarriers?: unknown; totalCarriers?: unknown; carrierCount?: unknown }) {
    const expected = data.expectedCarriers ?? data.totalCarriers ?? data.carrierCount;
    if (typeof expected === "number" && Number.isInteger(expected) && expected > 0) setQrCarrierTotal(expected);
    if (typeof data.respondedCarriers === "number" && Number.isInteger(data.respondedCarriers) && data.respondedCarriers >= 0) setQrRespondedCarriers(data.respondedCarriers);
  }

  // Pending starts may be resolved only with the run-scoped secret granted by
  // qr-start, never by an address-only cache read.
  function pollPendingLead(epoch: number, accessToken: string): void {
    if (qrPendingRef.current) clearTimeout(qrPendingRef.current);
    const deadline = qrRunStartedAtRef.current + 360000;
    if (epoch !== quoteEpochRef.current || quoteAccessTokenRef.current !== accessToken) return;
    if (Date.now() >= deadline) {
      setQrStillWorking(true);
      if (qrTimerRef.current) clearInterval(qrTimerRef.current);
      return;
    }
    if (qrWaitRef.current) clearTimeout(qrWaitRef.current);
    qrWaitRef.current = setTimeout(() => {
      if (epoch !== quoteEpochRef.current) return;
      setQrStillWorking(true);
      if (qrPendingRef.current) clearTimeout(qrPendingRef.current);
      if (qrTimerRef.current) clearInterval(qrTimerRef.current);
    }, deadline - Date.now());
    qrPendingRef.current = setTimeout(async () => {
      try {
        if (epoch !== quoteEpochRef.current || quoteAccessTokenRef.current !== accessToken) return;
        const response = await authedFetch(`/api/insurance/qr-cache?address=${encodeURIComponent(address)}&policyType=${encodeURIComponent(policyType || "HO3")}`, {
          credentials: "include", headers: { "X-Quote-Access": accessToken },
        });
        const data = await response.json();
        if (epoch !== quoteEpochRef.current || quoteAccessTokenRef.current !== accessToken || Date.now() >= deadline) return;
        if (!response.ok) throw new Error("Quote status unavailable");
        updateCarrierProgress(data);
        if (data.found && data.status === "success" && data.quotes?.length) {
          setQrQuotes(sortQuotes(data.quotes));
          setQrQuoteCounter(data.quoteCounter ?? data.quotes.length);
          setQrLeadId(data.leadId ?? null);
          setQrStatus("success");
          if (data.expiresAt) setQrExpiresAt(data.expiresAt);
          if (qrTimerRef.current) clearInterval(qrTimerRef.current);
          if (qrWaitRef.current) clearTimeout(qrWaitRef.current);
          return;
        }
        if (data.found && data.status === "error") {
          setQrStatus("error");
          if (qrTimerRef.current) clearInterval(qrTimerRef.current);
          if (qrWaitRef.current) clearTimeout(qrWaitRef.current);
          return;
        }
        if (data.found && data.leadId) {
          setQrLeadId(data.leadId);
          startPolling(data.leadId);
          return;
        }
      } catch {
        // A transient status failure does not authorize a new paid submission.
      }
      if (epoch === quoteEpochRef.current) pollPendingLead(epoch, accessToken);
    }, Math.min(10000, deadline - Date.now()));
  }

  // Refresh — pulls the latest carrier results for an existing lead
  // WITHOUT re-submitting (no new cost). Fixes "only 1 carrier showing".
  async function refreshQuotes(): Promise<void> {
    const accessToken = quoteAccessTokenRef.current;
    if (!qrLeadId || qrRefreshing || !accessToken) return;
    const epoch = quoteEpochRef.current;
    setQrRefreshing(true);
    try {
      const res = await authedFetch(
        "/api/insurance/qr-refresh",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-Quote-Access": accessToken },
          body: JSON.stringify({
            leadId: qrLeadId,
            address,
              policyType: policyType || "HO3",
          }),
        }
      );
      const data = await res.json();
      if (epoch !== quoteEpochRef.current) return;
      if (!res.ok) throw new Error("Carrier refresh failed");
      updateCarrierProgress(data);
      if ((data.quotes?.length ?? 0) > 0) {
        setQrQuotes(sortQuotes(data.quotes));
        setQrQuoteCounter(data.quoteCounter);
        setQrStatus("success");
        setInsuranceQRCache(address, {
          status: "success",
          quotes: data.quotes,
          quoteCounter: data.quoteCounter,
        }, policyType);
      }
    } catch (e) {
      if (epoch === quoteEpochRef.current) toast({ title: "Carrier refresh failed", description: "Please retry. Existing quotes have been retained.", variant: "destructive" });
    } finally {
      if (epoch === quoteEpochRef.current) setQrRefreshing(false);
    }
  }

  // Read only the authenticated lead granted by qr-start, for at most six minutes.
  function startPolling(leadId: number): void {
    const epoch = quoteEpochRef.current;
    const accessToken = quoteAccessTokenRef.current;
    if (!accessToken) return;
    const deadline = qrRunStartedAtRef.current + 360000;
    if (qrPollRef.current)
      clearInterval(qrPollRef.current);
    if (qrTimerRef.current)
      clearInterval(qrTimerRef.current);

    setQrElapsed(Math.floor((Date.now() - qrRunStartedAtRef.current) / 1000));
    qrPrevCounterRef.current = 0;
    qrStableRef.current = 0;

    qrTimerRef.current = setInterval(() => {
      setQrElapsed(Math.floor((Date.now() - qrRunStartedAtRef.current) / 1000));
    }, 1000);
    if (qrWaitRef.current) clearTimeout(qrWaitRef.current);
    qrWaitRef.current = setTimeout(() => {
      if (epoch !== quoteEpochRef.current) return;
      if (qrPollRef.current) clearInterval(qrPollRef.current);
      if (qrTimerRef.current) clearInterval(qrTimerRef.current);
      setQrStillWorking(true);
    }, Math.max(0, deadline - Date.now()));

    let pollCount = 0;
    const MAX_POLLS = 36; // Ten-second reads, at most six minutes.
    let inFlight = false;

    const doPoll = async () => {
      if (inFlight || epoch !== quoteEpochRef.current) return;
      inFlight = true;
      pollCount++;
      try {
        const res = await authedFetch(
          "/api/insurance/qr-quotes",
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-Quote-Access": accessToken },
            body: JSON.stringify({
              leadId,
              address,
              policyType: policyType || "HO3",
            }),
          }
        );
        const data = await res.json();
        if (epoch !== quoteEpochRef.current || pollCount > MAX_POLLS || Date.now() >= deadline) return;
        if (!res.ok) throw new Error("Carrier status unavailable");
        const counter: number = data.quoteCounter ?? 0;
        const serverStatus = data.status ?? "pending";
        setQrQuotes(sortQuotes(data.quotes ?? []));
        setQrQuoteCounter(counter);
        updateCarrierProgress(data);
        setInsuranceQRCache(address, {
          status: serverStatus === "success" ? "success" : "pending",
          quotes: data.quotes ?? [],
          quoteCounter: counter,
        }, policyType);

        if (serverStatus === "success") {
          setQrStatus("success");
          if (qrWaitRef.current) clearTimeout(qrWaitRef.current);
          if (qrPollRef.current)
            clearInterval(qrPollRef.current);
          if (qrTimerRef.current)
            clearInterval(qrTimerRef.current);
        } else if (serverStatus === "error") {
          setQrStatus("error");
          if (qrWaitRef.current) clearTimeout(qrWaitRef.current);
          if (qrPollRef.current)
            clearInterval(qrPollRef.current);
          if (qrTimerRef.current)
            clearInterval(qrTimerRef.current);
        } else if (pollCount >= MAX_POLLS) {
          setQrStillWorking(true);
          // The server owns the terminal timeout. Stop this reader timer but
          // leave the durable row untouched so a reconnect can see its final
          // state.
          if (qrPollRef.current)
            clearInterval(qrPollRef.current);
          if (qrTimerRef.current)
            clearInterval(qrTimerRef.current);
        }
      } catch (e) {
        console.error("[qr-poll]", e);
      } finally {
        inFlight = false;
      }
    };

    qrPollRef.current = setInterval(doPoll, 10000);
  }

  async function startQuoteRush(): Promise<void> {
    if (!getSession() && !await requireAccount()) return;
    if (!address || !rebuild)
      return;

    try {
      currentQuoteRushPropertyDefaults();
    } catch (error) {
      toast({
        title: "Complete the property information",
        description:
          error instanceof Error ? error.message : "Complete the required property questions.",
        variant: "destructive",
      });
      return;
    }

    const epoch = quoteEpochRef.current;
    if (!(await currentPolicyExpirationSaveRef.current) || epoch !== quoteEpochRef.current) {
      return;
    }

    const hasDateOfBirth =
      getSession()?.hasDateOfBirth ||
      await hasSavedDateOfBirth();
    if (epoch !== quoteEpochRef.current) return;
    if (!hasDateOfBirth) {
      setDobError("");
      setDobPromptOpen(true);
      return;
    }

    await submitQuoteRush();
  }

  async function submitQuoteRush(): Promise<void> {
    const epoch = quoteEpochRef.current;
    let propertyDefaults;
    try {
      propertyDefaults = currentQuoteRushPropertyDefaults();
    } catch (error) {
      setQrStatus("idle");
      toast({
        title: "Complete the property information",
        description:
          error instanceof Error ? error.message : "Complete the required property questions.",
        variant: "destructive",
      });
      return;
    }

    if (qrPollRef.current)
      clearInterval(qrPollRef.current);
    if (qrTimerRef.current)
      clearInterval(qrTimerRef.current);

    setQrStatus("starting");
    setQrResultsEpoch(epoch);
    quoteAccessTokenRef.current = null;
    qrRunStartedAtRef.current = Date.now();
    setQrSharedContext(null);
    setQrQuotes([]);
    setQrQuoteCounter(0);
    setQrElapsed(0);
    setQrStillWorking(false);
    qrTimerRef.current = setInterval(() => setQrElapsed(value => value + 1), 1000);
    clearQRCache(address, policyType);

    try {
      const startRes = await authedFetch(
        "/api/insurance/qr-start",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            address,
            coverageA: rebuild,
            policyType: policyType || "HO3",
            // Send the answers as entered. The index fields remain for
            // compatibility with older callers of this endpoint.
            yearBuilt,
            roofYear,
            openingProtection: openingProtectionIdx === 1,
            roofShape: ["Hip", "Flat", "Gable"][roofShapeIdx] ?? "Gable",
            secondaryWaterResistance:
              swrIdx === 2 ? "Yes" : swrIdx === 0 ? "No" : "Unknown",
            windMitigationLocks: windMitigationLocksRef.current,
            yearIdx,
            roofIdx,
            constIdx,
            windIdx,
            hurrIdx,
            hasClaims,
            claimRecords,
            ...(deriveMortgageForAddress(address) !== undefined
              ? { hasMortgage: deriveMortgageForAddress(address) }
              : {}),
            aopDeductible,
            floodZone,
            floodZoneUnknown:floodZoneUnknown||!floodZone.trim(),
            sqFt: squareFeet,
            sqFtConfirmed: true,
            assumedCredit: "Excellent (no credit check performed)",
            propertyCharacteristicLocks: propertyCharacteristicLocksRef.current,
            newPurchase: propertyDefaults.newPurchase === "Yes",
            ...(propertyDefaults.newPurchase === "No"
              ? {
                  currentlyInsured,
                  ...(currentlyInsured && currentCarrier.trim()
                    ? { currentCarrier: currentCarrier.trim() }
                    : {}),
                }
              : {}),
            policyEffectiveDate: purchaseDate || undefined,
            ...(ho6ResidenceUse
              ? { usageType: ho6ResidenceUse }
              : {}),
            ...((policyType === "DP3" || ho6ResidenceUse === "investment") &&
            ho6RentalTerm
              ? { rentalTerm: ho6RentalTerm }
              : {}),
            ...(purchasePrice > 0 && purchasePriceSource
              ? {
                  purchasePrice,
                  purchasePriceSource,
                }
              : {}),
          }),
        }
      );

      const data = await startRes.json();
      if (epoch !== quoteEpochRef.current) return;

      if (!startRes.ok) {
        if (
          startRes.status === 428 &&
          data.code === "DOB_REQUIRED"
        ) {
          setQrStatus("idle");
          setDobError("");
          setDobPromptOpen(true);
          return;
        }
        setQrStatus("error");
        if (qrTimerRef.current)
          clearInterval(qrTimerRef.current);
        return;
      }
      if (typeof data.quoteAccessToken !== "string" || !data.quoteAccessToken.trim()) {
        setQrStatus("error");
        if (qrTimerRef.current) clearInterval(qrTimerRef.current);
        toast({ title: "Quote access could not be verified", description: "The server did not provide secure access for this run. Please retry.", variant: "destructive" });
        return;
      }
      quoteAccessTokenRef.current = data.quoteAccessToken;
      updateCarrierProgress(data);

      // Lost the claim race — another concurrent request is submitting
      // this address but its leadId isn't published yet. Wait for it
      // rather than firing a second (paid) submission.
      if (!data.leadId) {
        if (data.status === "pending") {
          setQrStatus("pending");
          pollPendingLead(epoch, data.quoteAccessToken);
        } else {
          setQrStatus("error");
          if (qrTimerRef.current)
            clearInterval(qrTimerRef.current);
        }
        return;
      }

      const leadId: number = data.leadId;
      setQrLeadId(leadId);
      setQrSharedContext(data.propertyDataSnapshot ? {
        propertyDataSnapshot: data.propertyDataSnapshot ?? {},
        propertyDataProvenance: data.propertyDataProvenance ?? {},
        consumerPropertyAnswers: data.consumerPropertyAnswers ?? {},
        quoteProfileVersion: data.quoteProfileVersion,
        assumptions: data.assumptions ?? [],
      } : null);
      updateCarrierProgress(data);
      setInsuranceQRCache(
        address,
        { leadId, status: "pending" },
        policyType,
      );

      // Server may return cached quotes for a shared address.
      if (data.fromCache && (data.quotes?.length ?? 0) > 0) {
        setQrQuotes(sortQuotes(data.quotes));
        setQrQuoteCounter(data.quoteCounter);
        setQrStatus("success");
        if (data.expiresAt) setQrExpiresAt(data.expiresAt);
        setInsuranceQRCache(address, {
          leadId,
          status: "success",
          quotes: data.quotes,
          quoteCounter: data.quoteCounter,
          ...(data.expiresAt
            ? { expiresAt: data.expiresAt }
            : {}),
        }, policyType);
        if (qrTimerRef.current) clearInterval(qrTimerRef.current);
        return;
      }

      setQrStatus("pending");
      startPolling(leadId);
    } catch (err) {
      if (epoch !== quoteEpochRef.current) return;
      console.error("[qr-start]", err);
      setQrStatus("error");
      if (qrTimerRef.current)
        clearInterval(qrTimerRef.current);
    }
  }

  async function handleDobPreflight(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setDobError("");
    if (!normalizeDateOfBirth(dobInput)) {
      setDobError("Please enter a valid date of birth.");
      return;
    }

    setDobSaving(true);
    const result = await saveDateOfBirth(dobInput);
    setDobSaving(false);
    if (!result.ok) {
      setDobError(result.error || "We couldn't save your date of birth.");
      return;
    }

    setDobPromptOpen(false);
    setDobInput("");
    await submitQuoteRush();
  }

  // ── Calculations ─────────────────────────────────────────────────────────
  const region = REGIONS[regionKey];

  const calc = useMemo(() => {
    // Start with the six home-age bands and add 0.15% for frame homes.
    // Roof, wind, and deductible selections refine that baseline.
    // Claims are not a user input: general estimates always assume no
    // claims during the past five years.
    const rawAdj = ROOF_ADJ[roofIdx]
      * OPENING_PROTECTION_ADJ[openingProtectionIdx]
      * ROOF_SHAPE_ADJ[roofShapeIdx]
      * SWR_ADJ[swrIdx]
      * HURR_ADJ[hurrIdx];
    const adj = rawAdj / NEUTRAL_FACTOR_PRODUCT;
    const baselineRate = getBaselineHomeownersInsuranceRate({
      yearBuilt,
      isFrameConstruction: constIdx === 2,
    });
    const midRate  = baselineRate * adj;
    const hurrDeductiblePct = [0.02, 0.05, 0.10][hurrIdx];
    return {
      mid: rebuild * midRate,
      hurrDeductible: rebuild * hurrDeductiblePct,
      hurrPct: hurrDeductiblePct * 100,
    };
  }, [
    rebuild, roofIdx, openingProtectionIdx, roofShapeIdx, swrIdx,
    hurrIdx, constIdx, yearBuilt,
  ]);

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <>
      <Helmet><title>Insurance Estimate — {address || "Havo"}</title></Helmet>

      {showInsuranceEmptyState ? (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
          <Card className="w-full max-w-md">
            <CardContent className="py-10 px-6 flex flex-col items-center text-center gap-4">
              <Shield className="h-12 w-12 text-primary" />
              <div className="space-y-1">
                <h2 className="text-xl font-bold">No properties added yet</h2>
                <p className="text-sm text-muted-foreground">
                  Add a property address to get an insurance estimate
                </p>
              </div>
              {!showEmptyAddInput ? (
                <Button
                  className="mt-2"
                  onClick={() => setShowEmptyAddInput(true)}
                  data-testid="insurance-empty-add-property"
                >
                  Add Property Address
                </Button>
              ) : (
                <div className="w-full mt-2">
                  <div className="flex items-center gap-2 border rounded-md px-3 py-2 bg-white">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                    <input
                      ref={addressInputRef}
                      type="text"
                      placeholder="Enter a property address"
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          const val = (e.target as HTMLInputElement).value.trim();
                          if (val) {
                            setShowEmptyAddInput(false);
                            setLocation(`/insurance?address=${encodeURIComponent(val)}`);
                          }
                        } else if (e.key === "Escape") {
                          setShowEmptyAddInput(false);
                        }
                      }}
                      className="flex-1 bg-transparent outline-none text-sm"
                      autoComplete="off"
                      data-testid="insurance-empty-address-input"
                    />
                  </div>
                  <button
                    onClick={() => setShowEmptyAddInput(false)}
                    className="text-xs text-muted-foreground hover:text-foreground mt-2"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
      <div className="min-h-screen bg-gray-50">

        {/* ── Sticky top bar (same pattern as estimate page) ── */}
        <div className="bg-white border-b shadow-sm sticky top-[73px] z-40">

          {/* Scenario tabs */}
          <div className="container mx-auto px-4 pt-2 flex items-center gap-1 overflow-x-auto scrollbar-none">
            {scenarios.map((sc) => (
              <div
                key={sc.id}
                onClick={() => switchScenario(sc.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-md text-xs font-medium cursor-pointer whitespace-nowrap border border-b-0 transition-colors ${
                  sc.id === activeScenarioId
                    ? "bg-white border-border text-foreground shadow-sm -mb-px relative z-10"
                    : "bg-gray-100 border-transparent text-muted-foreground hover:bg-gray-200"
                }`}
              >
                <MapPin className="h-3 w-3 shrink-0" />
                <span>{shortLabel(sc.address) || "New property"}</span>
                {scenarios.length > 1 && (
                  <button
                    onClick={(e) => removeScenario(sc.id, e)}
                    className="ml-0.5 rounded-full hover:bg-black/10 p-0.5 transition-colors"
                    aria-label="Remove"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
            ))}
            {scenarios.length < 5 && (
              <button
                onClick={requestAddScenario}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-t-md text-xs text-muted-foreground hover:text-primary hover:bg-gray-100 border border-transparent border-b-0 transition-colors"
                title="Compare another property"
              >
                <Plus className="h-3.5 w-3.5" /> Add Property
              </button>
            )}
          </div>

          {/* Address + action bar */}
          <div className="container mx-auto px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              {/* Back routing matches Cash Buy / Seller / Purchase: a
                  logged-in user is always inside a dashboard scenario, so
                  Back returns to Dashboard → Insurance tab. Only the
                  logged-out flow (entered via the six-service picker)
                  should land back on /select-service. */}
              <button
                onClick={() => {
                  if (isAuthenticated) {
                    setLocation("/dashboard?tab=insurance");
                  } else {
                    setLocation(
                      `/select-service${addressParam ? `?address=${encodeURIComponent(addressParam)}` : ""}`
                    );
                  }
                }}
                className="text-muted-foreground hover:text-primary transition-colors"
                aria-label={isAuthenticated ? "Back to Insurance dashboard" : "Back to Services"}
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium flex items-center gap-1.5">
                  <Shield className="h-3 w-3" /> Insurance Estimate
                </p>
                {isEditingAddress ? (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
                    <input
                      ref={addressInputRef}
                      type="text"
                      value={editAddressVal}
                      onChange={e => setEditAddressVal(e.target.value)}
                      onKeyDown={async e => {
                        if (e.key === "Enter") {
                          const val = editAddressVal.trim();
                          if (val && await authorize("insurance", val)) setLocation(`/insurance?address=${encodeURIComponent(val)}`);
                          setIsEditingAddress(false);
                        } else if (e.key === "Escape") {
                          setIsEditingAddress(false);
                        }
                      }}
                      onBlur={() => setTimeout(() => setIsEditingAddress(false), 200)}
                      className="text-sm font-semibold bg-transparent border-b border-primary outline-none w-72 max-w-full leading-tight pb-0.5"
                      autoComplete="off"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setIsEditingAddress(true)}
                    className="group flex items-center gap-1.5 mt-0.5 hover:text-primary transition-colors text-left"
                  >
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
                    <span className="font-semibold text-sm leading-tight">{address || "Enter an address"}</span>
                    <Pencil className="h-3 w-3 text-muted-foreground/50 group-hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Standard Share + Save Scenario pair, identical to
                  the other four detail views. Save persists one row
                  per address into `insurance_scenarios`; the call is
                  awaited so the success toast only fires after the
                  Supabase write returns OK. */}
              <ScenarioActions
                scenarioType="insurance"
                getPdfData={() => {
                  if (!address || !address.trim()) return null;
                  const annualPremium =
                    manualAnnualPremium != null
                      ? manualAnnualPremium
                      : Math.round(calc.mid);
                  // Occupancy / structure type aren't held in component
                  // state — derive them from the saved source scenarios
                  // for this address, mirroring the default-policy helper.
                  const pdfKey = address.trim().toLowerCase();
                  const pdfPurchase = getPurchaseScenarios().find(
                    p => (p.address ?? "").trim().toLowerCase() === pdfKey,
                  );
                  const pdfCash = getCashBuyScenarios().find(
                    c => (c.address ?? "").trim().toLowerCase() === pdfKey,
                  );
                  const pdfLoan = getTrackedLoans().find(
                    l => (l.propertyAddress ?? "").trim().toLowerCase() === pdfKey,
                  );
                  const occupancy =
                    pdfCash?.occupancyType ??
                    (pdfLoan?.propertyType as string | undefined) ??
                    (pdfPurchase ? "primary" : undefined);
                  const propertyType =
                    pdfPurchase?.propertyType ?? pdfLoan?.physicalPropertyType;
                  const POLICY_LABELS: Record<string, string> = {
                    HO3: "HO-3 (Homeowners)",
                    HO6: "HO-6 (Condo / Townhome)",
                    DP3: "DP-3 (Dwelling / Rental)",
                  };
                  const OCCUPANCY_LABELS: Record<string, string> = {
                    primary: "Primary residence",
                    secondary: "Secondary home",
                    investment: "Investment property",
                  };
                  return {
                    address,
                    sections: [
                      {
                        heading: "Policy Summary",
                        rows: [
                          { label: "Policy type", value: policyType ? POLICY_LABELS[policyType] ?? policyType : "—" },
                          { label: "Occupancy", value: occupancy ? OCCUPANCY_LABELS[occupancy] ?? occupancy : "—" },
                          { label: "Property type", value: propertyType || "—" },
                          { label: "Coverage A / Rebuild cost", value: fmt(rebuild) },
                          { label: "Annual premium", value: fmt(annualPremium) },
                          { label: "AOP deductible", value: fmt(aopDeductible) },
                          { label: "Flood zone", value: floodZone || "—" },
                        ],
                      },
                    ],
                    disclaimer:
                      "These are estimates only based on regional data, property characteristics, and standard assumptions. Results vary by specific property inspection and market availability. Not a binding quote. Coverage is not effective until confirmed by a licensed agent. Tateo Insurance Corp (Company) - License #L132640. Paul Christian Tateo (Agent) - License #W142842.",
                  };
                }}
                onSave={async () => {
                  if (!address || !address.trim()) {
                    throw new Error("Enter an address before saving.");
                  }
                  const key = address.trim().toLowerCase();
                  const existing = getInsuranceScenarios();
                  const match = existing.find(
                    s => s.address.trim().toLowerCase() === key
                  );
                  const updated: InsuranceScenario = {
                    id: match?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    address,
                    savedAt: new Date().toISOString(),
                    // If the user has typed a manual Annual Premium,
                    // persist that exact value and stamp the source.
                    // Otherwise fall back to the calculated midpoint
                    // (Coverage A × 0.75% × factor adjustment) — the
                    // sync helper is free to recompute this later.
                    annualPremium:
                      manualAnnualPremium != null
                        ? manualAnnualPremium
                        : match?.premiumSource === "quote" && typeof match.annualPremium === "number"
                          ? match.annualPremium
                          : Math.round(calc.mid),
                    // Persist Coverage A so the Phase 1 cross-tab value
                    // sync can read/protect it. Source carries forward
                    // from the saved scenario; if the user moved the
                    // Rebuild Cost slider this save call,
                    // `_stampManualOnValueDiff` in saveInsuranceScenarios
                    // will detect the diff vs `match.coverageA` and
                    // stamp coverageASource = "manual". If unchanged,
                    // the prior source ("property_value_sync" /
                    // "default" / "manual") is preserved.
                    coverageA: rebuild,
                    coverageASource: manualCoverageA.current ? "manual" : "default",
                    // Stamp premium provenance from the manual-input
                    // state, preserving any prior "quote" upload that
                    // the page can't override today.
                    premiumSource:
                      manualAnnualPremium != null
                        ? "manual"
                        : match?.premiumSource === "quote"
                          ? "quote"
                          : "default_0_75_percent",
                    coverageType: region.name,
                    ...(policyType
                      ? {
                          policyType,
                          policyTypeSource: policyTypeSource ?? "default_rule",
                        }
                      : {}),
                    ...(match?.occupancyType ? { occupancyType: match.occupancyType } : {}),
                    ...(match?.propertyType ? { propertyType: match.propertyType } : {}),
                    userAnswerSources: withQuotePropertyAnswers(
                      match?.userAnswerSources,
                    ),
                  };
                  const next = match
                    ? existing.map(s => (s.id === match.id ? updated : s))
                    : [...existing, updated];
                  await confirmAnonymousAccountDraftSaved("insurance", () => saveInsuranceScenarios(next));
                }}
              />
            </div>
          </div>
        </div>

        {/* ── Main content ── */}
        <div className="container mx-auto px-4 py-6 space-y-6">

          {/* Page indicator */}
          <div className="max-w-2xl mx-auto lg:max-w-none">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-foreground">Insurance Estimate</p>
              <p className="text-xs text-muted-foreground font-medium">Page 1 of 1</p>
            </div>
            <div className="h-1.5 w-full rounded-full bg-primary" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">

            {/* ── SECTION 1: General estimate ── */}
            <Card className="border shadow-sm overflow-hidden">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Home className="h-4 w-4 text-primary" /> General Insurance Estimate
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Adjust the property details below to refine your planning estimate.
                </p>
              </CardHeader>
              <CardContent className="space-y-5">
                <InsuranceEstimateForm
                  policyType={policyType}
                  onPolicyTypeChange={(value) => {
                    setPolicyType(value);
                    setPolicyTypeSource(value ? "manual" : null);
                  }}
                  policyTypeNote={policyTypeSource === "manual" ? "Manual selection." : policyType ? "Auto-defaulted from this property's details." : "QuoteRUSH policy defaults are applied automatically when this selection changes."}
                  newPurchase={newPurchase}
                  onNewPurchaseChange={(value) => {
                    setNewPurchase(value); setPurchaseDate("");
                     if (
                       purchasePriceSource === "user-confirmed-contract" ||
                       purchasePriceSource === "user-confirmed-property-value"
                     ) {
                       setPurchasePriceSource(
                         value === true
                           ? "user-confirmed-contract"
                           : value === false
                             ? "user-confirmed-property-value"
                             : "",
                       );
                     }
                    if (value !== false) { setCurrentlyInsured(null); setCurrentCarrier(""); }
                  }}
                  currentlyInsured={currentlyInsured}
                  onCurrentlyInsuredChange={(value) => {
                    setCurrentlyInsured(value);
                    if (value !== true) {
                      setCurrentCarrier("");
                      saveCurrentPolicyExpirationDate("");
                    }
                  }}
                  currentCarrier={currentCarrier}
                  onCurrentCarrierChange={setCurrentCarrier}
                  currentPolicyExpirationDate={currentPolicyExpirationDate}
                  onCurrentPolicyExpirationDateChange={
                    saveCurrentPolicyExpirationDate
                  }
                  purchaseDate={purchaseDate}
                  onPurchaseDateChange={setPurchaseDate}
                   purchasePrice={purchasePrice}
                   onPurchasePriceChange={(value) => {
                     setPurchasePrice(value);
                     setPurchasePriceSource(
                        newPurchase === true
                          ? "user-confirmed-contract"
                          : newPurchase === false
                            ? "user-confirmed-property-value"
                            : "",
                     );
                   }}
                   purchasePriceSource={purchasePriceSource}
                  residenceUse={ho6ResidenceUse}
                  onResidenceUseChange={(value) => { setHo6ResidenceUse(value); if (value !== "investment") setHo6RentalTerm(""); }}
                  rentalTerm={ho6RentalTerm}
                  onRentalTermChange={setHo6RentalTerm}
                  rebuild={rebuild}
                  onRebuildChange={value => { manualCoverageA.current = true; setRebuild(value); }}
                  rebuildExplanation={rebuildExplanation}
                  fieldSources={fieldSources}
                  fieldLocks={propertyCharacteristicLocksRef.current}
                  constructionKnown={constructionKnown}
                  policyAnswered={policyAnswered}
                  roofPermits={roofPermits}
                  sqFtConfirmed={sqFtConfirmed}
                  onSqFtConfirmedChange={setSqFtConfirmed}
                  floodZoneUnknown={floodZoneUnknown}
                  onFloodZoneUnknownChange={unknown => {
                    propertyCharacteristicLocksRef.current.floodZone = true;
                    setFloodZoneUnknown(unknown);
                    if (unknown) { setFloodZone(""); setFloodZoneSource("Zone omitted — ask your agent to verify."); }
                  }}
                  roofYear={roofYear}
                  onRoofYearChange={value => { manualRoofYear.current = true; setRoofYear(value); }}
                  openingProtection={openingProtectionIdx}
                  onOpeningProtectionChange={(value) => {
                    windMitigationLocksRef.current.openingProtection = true;
                    setOpeningProtectionIdx(value);
                  }}
                  roofShape={roofShapeIdx}
                  onRoofShapeChange={setRoofShapeIdx}
                  swr={swrIdx}
                  onSwrChange={(value) => {
                    windMitigationLocksRef.current.secondaryWaterResistance = true;
                    setSwrIdx(value);
                  }}
                  hurricaneDeductible={hurrIdx}
                  onHurricaneDeductibleChange={setHurrIdx}
                  construction={constIdx}
                   onConstructionChange={(value) => {
                     propertyCharacteristicLocksRef.current.construction = true;
                     setConstructionConfirmed(true);
                     setConstIdx(value);
                   }}
                  yearBuilt={yearBuilt}
                   onYearBuiltChange={(value) => {
                     propertyCharacteristicLocksRef.current.yearBuilt = true;
                     setYearBuilt(value);
                   }}
                   squareFeet={squareFeet}
                   onSquareFeetChange={(value) => {
                     propertyCharacteristicLocksRef.current.squareFeet = true;
                     setSquareFeet(value);
                   }}
                   propertyCharacteristicsNote={propertyCharacteristicsNote}
                  aopDeductible={aopDeductible}
                  onAopDeductibleChange={setAopDeductible}
                  floodZone={floodZone}
                  floodZoneSource={floodZoneSource}
                   onFloodZoneChange={(value) => {
                     propertyCharacteristicLocksRef.current.floodZone = true;
                     setFloodZone(value);
                     setFloodZoneSource("Manual entry");
                   }}
                   hasClaims={hasClaims}
                   onHasClaimsChange={(value) => {
                     setHasClaims(value);
                     if (value === false) setClaimRecords([]);
                     if (value === true && claimRecords.length === 0) {
                       setClaimRecords([{ lossDate: "", claimDetail: "", amount: "", paid: null, priorResidence: null }]);
                     }
                   }}
                   claimRecords={claimRecords}
                   onClaimRecordsChange={setClaimRecords}
                  annualPremium={calc.mid}
                />
                {rateError && <div className="mt-3 rounded-lg border border-destructive/30 p-3 text-xs" role="alert">{rateError}<button type="button" className="ml-2 text-primary underline" onClick={() => setRateRetry(v => v + 1)}>Retry county rate</button></div>}
              </CardContent>
            </Card>

            {/* ── SECTION 2: Live carrier quotes ── */}
            <Card className="border shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Shield className="h-4 w-4 text-primary shrink-0" />
                        {qrSharedContext
                          ? "Preliminary carrier quote from last 30 days"
                          : "Live Carrier Quotes"}
                      </CardTitle>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                        {qrStatus === "idle" &&
                          "Get real-time rates from your Florida-appointed carriers."}
                        {qrStatus === "starting" &&
                          "We're getting your quotes. This takes a few minutes. We'll email you the results, and they'll be here when you come back."}
                        {qrStatus === "pending" &&
                          `We're getting your quotes. This takes a few minutes. We'll email you the results, and they'll be here when you come back. ${qrQuoteCounter} quote${qrQuoteCounter !== 1 ? "s" : ""} so far · ${qrElapsed}s`}
                        {qrStatus === "success" &&
                          `${qrQuoteCounter} carrier${qrQuoteCounter !== 1 ? "s" : ""} quoted${
                            qrExpiresAt
                              ? ` · saved rates, valid ${Math.max(
                                  0,
                                  Math.ceil(
                                    (new Date(qrExpiresAt).getTime() -
                                      Date.now()) /
                                      86400000
                                  )
                                )} more day${
                                  Math.ceil(
                                    (new Date(qrExpiresAt).getTime() -
                                      Date.now()) /
                                      86400000
                                  ) !== 1
                                    ? "s"
                                    : ""
                                }`
                              : " · checking for more…"
                          }`}
                        {qrStatus === "expired" &&
                          "These saved rates are over 30 days old — re-run for current pricing."}
                        {qrStatus === "error" &&
                          "Quote request failed — call us for a custom quote."}
                      </p>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {qrStatus === "idle" && (
                        <Button
                          size="sm"
                          onClick={startQuoteRush}
                          disabled={isAuthenticated && (
                            !address ||
                            !rebuild ||
                            quoteValidationMessages.length > 0
                          )}
                        >
                          Get Live Quotes
                        </Button>
                      )}
                      {(qrStatus === "starting" ||
                        qrStatus === "pending") && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <div className="h-2.5 w-2.5 rounded-full bg-primary/50 animate-pulse" />
                          Working…
                        </div>
                      )}
                      {qrStatus === "success" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={refreshQuotes}
                          disabled={
                            qrRefreshing || !qrLeadId
                          }
                        >
                          {qrRefreshing
                            ? "Refreshing…"
                            : "Refresh"}
                        </Button>
                      )}
                      {(qrStatus === "expired" ||
                        qrStatus === "error") && (
                        <Button
                          size="sm"
                          onClick={startQuoteRush}
                          disabled={isAuthenticated && quoteValidationMessages.length > 0}
                        >
                          Re-run
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="mb-3 text-xs text-muted-foreground">Assumed credit: {assumedCreditScore} (no credit check performed).</p>
                  {user&&<a className="text-xs underline" href="/admin/rebuild-cost-rates">Rebuild rates (admin only)</a>}
                  {quoteValidationMessages.length > 0 && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950" aria-label="Required quote information"><strong>Before sending to carriers</strong><ul className="mt-2 list-disc space-y-1 pl-4">{quoteValidationMessages.map(message => <li key={message}>{message}</li>)}</ul></div>}
                  <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-xs leading-relaxed text-blue-950">
                    {qrSharedContext && qrResultsEpoch === quoteEpochRef.current ? (
                      <>
                        <strong>Original preliminary quote inputs:</strong>{" "}
                        {String(
                          qrSharedContext.consumerPropertyAnswers.policyType ??
                            policyType ??
                            "HO3",
                        )}{" "}
                        with Coverage A of{" "}
                        {fmt(Number(
                          qrSharedContext.consumerPropertyAnswers.coverageA ??
                            rebuild,
                        ))}, home built{" "}
                        {String(
                          qrSharedContext.propertyDataSnapshot.yearBuilt ??
                            "not confirmed",
                        )}, roof year{" "}
                        {String(
                          qrSharedContext.propertyDataSnapshot.roofYear ??
                            "not confirmed",
                        )}, flood zone{" "}
                        {String(
                          qrSharedContext.propertyDataSnapshot.floodZone ??
                            "not confirmed",
                        )}, and{" "}
                        {Number(qrSharedContext.propertyDataSnapshot.sqFt ?? 0) > 0
                          ? `${Number(qrSharedContext.propertyDataSnapshot.sqFt).toLocaleString()} sq. ft.`
                          : "square footage not confirmed"}
                        .
                        {qrSharedContext.quoteProfileVersion ? (
                          <span className="block mt-1 text-blue-800">
                            Quote profile: {qrSharedContext.quoteProfileVersion}
                          </span>
                        ) : null}
                        {qrSharedContext.assumptions.length > 0 ? (
                          <>
                            <strong className="mt-2 block text-blue-900">
                              Fields requiring verification:
                            </strong>
                            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-blue-800">
                              {qrSharedContext.assumptions.map((assumption) => (
                                <li key={assumption}>{assumption}</li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        <span className="block mt-1 text-blue-800">
                          These saved rates reflect the original request, not
                          later edits on this page.
                        </span>
                      </>
                    ) : (
                      <>
                    <strong>New live quote requests use:</strong>{" "}
                    roof installed {roofYear > 0 ? roofYear : "Unavailable — please enter"}, home built {yearBuilt > 0 ? yearBuilt : "Unavailable — please enter"},{" "}
                    {openingProtectionIdx === 1
                      ? "impact protection"
                      : "no impact protection"}
                    , {["hip", "flat", "gable (other / unsure)"][roofShapeIdx] ?? "gable"} roof,{" "}
                    SWR {swrIdx === 2 ? "yes" : swrIdx === 0 ? "no" : "needs confirmation"},{" "}
                    {["concrete block", "mixed masonry / frame", "frame"][constIdx] ?? "concrete block"} construction,{" "}
                    {["2%", "5%", "10%"][hurrIdx] ?? "2%"} hurricane deductible, and{" "}
                    {fmt(aopDeductible)} AOP deductible.
                    {roofShapeIdx === 2 || swrIdx === 1 ? (
                      <span className="block mt-1 text-blue-800">
                        <strong>Carrier default to confirm:</strong>{" "}
                        {roofShapeIdx === 2
                          ? "the unspecified roof shape is sent as gable"
                          : ""}
                        {roofShapeIdx === 2 && swrIdx === 1 ? "; " : ""}
                        {swrIdx === 1
                          ? "SWR is sent as unknown for carrier confirmation"
                          : ""}
                        .
                      </span>
                    ) : null}
                    {constIdx !== 0 ? (
                      <span className="block mt-1 text-blue-800">
                        <strong>Construction subtype default to confirm:</strong>{" "}
                        {constIdx === 1
                          ? "mixed construction includes verified concrete-block masonry; the frame subtype is omitted"
                          : "the structural frame subtype is omitted until confirmed"}
                        .
                      </span>
                    ) : null}
                    <span className="block mt-1 text-blue-800">
                      <strong>Other defaults to confirm:</strong>{" "}
                      {!policyType
                        ? "policy type required"
                        : policyType === "HO3"
                          ? "primary residence"
                          : policyType === "DP3"
                            ? "investment property"
                            : ho6ResidenceUse
                              ? `${ho6ResidenceUse} residence`
                              : "HO6 residence use required"}
                      {policyType === "HO6" && ho6ResidenceUse === "investment"
                        ? `, ${ho6RentalTerm || "rental term required"}`
                        : ""}
                      , {newPurchase === null
                        ? "purchase status required"
                        : newPurchase
                          ? `new purchase closing ${purchaseDate || "date required"}`
                          : currentPolicyExpirationDate
                            ? `current policy expiration ${currentPolicyExpirationDate} (preferred over requested date ${purchaseDate || "not provided"})`
                            : `requested effective date ${purchaseDate || "30-day fallback disclosed at quote time"}`},
                      9 months or more occupied, purchase price{" "}
                      {purchasePrice > 0 ? fmt(purchasePrice) : "required"},
                       composite-shingle roof, slab foundation, and{" "}
                       {hasClaims === null
                         ? "claims history required"
                         : hasClaims
                           ? `${claimRecords.length} reported claim${claimRecords.length === 1 ? "" : "s"}`
                           : "no claims in the past five years"}.
                      {squareFeet > 0
                        ? ` Square footage is ${squareFeet.toLocaleString()} sq. ft.`
                        : " Square footage is omitted until a trusted source or manual answer is available."}
                    </span>
                    <details className="mt-1 text-blue-800">
                      <summary className="cursor-pointer font-semibold">
                        View additional carrier assumptions
                      </summary>
                      <span className="block mt-1">
                         For a new purchase, prior insurance is marked as a New Purchase assumption, while existing-home carrier answers remain private;
                         mortgage status is omitted when Havo cannot derive it; no alarms;
                        Exposure B terrain with nearby fire protection; and standard ancillary
                         coverages and endorsements{policyType === "HO6" ? ", including a $2,000 loss-assessment assumption" : ""}. Wind-mitigation-form status is inferred from the
                        property answers above. Confirm these details with the carrier or licensed agent.
                      </span>
                    </details>
                      </>
                    )}
                  </div>
                  {agentVerification.length > 0 ? (
                    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                      <strong className="block">Agent-only verification</strong>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {agentVerification.map(field => (
                          <li key={field}>{field}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {/* Progress bar */}
                  {(qrStatus === "starting" ||
                    qrStatus === "pending") && (
                    <div className="mb-4 space-y-2">
                      <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                        <div
                          className="h-full origin-left bg-primary rounded-full transition-transform duration-1000"
                          style={{
                            transform: `scaleX(${Math.min(
                              (qrElapsed / 360) * 100,
                              90
                            ) / 100})`,
                          }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground text-center">
                        {qrStillWorking ? "Still working — we'll email your top 3 when carriers finish. You can close this page."
                          : qrStatus === "starting" ? "Sending to carriers"
                            : qrCarrierTotal != null
                              ? `Carriers quoting ${qrRespondedCarriers ?? qrQuoteCounter} of ${qrCarrierTotal}`
                              : `Carriers quoting · ${qrQuoteCounter} quote${qrQuoteCounter === 1 ? "" : "s"} received`}
                        {!qrStillWorking && ` · ${Math.floor(qrElapsed / 60)}:${String(qrElapsed % 60).padStart(2, "0")} elapsed. Usually 2–5 minutes. You can close this page; we'll email your top 3.`}
                      </p>
                    </div>
                  )}

                  {/* Not authenticated */}
                  {!isAuthenticated &&
                    qrStatus === "idle" && (
                    <p className="text-xs text-muted-foreground text-center py-3">
                      Create a free account to get live carrier quotes from your Florida-appointed insurers.
                    </p>
                  )}

                  {/* Quotes (top 3) */}
                  {qrStatus === "success" && <p className="mb-3 text-xs font-semibold text-primary">Ranking top 3 · Lowest annual premium first</p>}
                  {qrQuotes.length > 0 && qrResultsEpoch === quoteEpochRef.current && (
                    <div className="space-y-2">
                      {qrQuotes.slice(0, 3).map((q, i) => (
                        <div
                          key={q.siteName + i}
                          className={`p-3 rounded-lg border ${
                            i === 0
                              ? "border-yellow-300 bg-yellow-50"
                              : "border-border bg-muted/20"
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex items-start gap-3">
                              <span className="text-base mt-0.5">
                                {i + 1}
                              </span>
                              <div>
                                <div className="text-sm font-semibold">
                                  {q.siteName}
                                </div>
                                <div className="text-xs text-muted-foreground mt-0.5 space-y-0.5">
                                  {q.hurricaneDeductible && (
                                    <div>
                                      Hurricane deductible:{" "}
                                      {q.hurricaneDeductible}
                                    </div>
                                  )}
                                  {q.aop && (
                                    <div>
                                      AOP deductible: {q.aop}
                                    </div>
                                  )}
                                    <div>
                                      Coverage A:{" "}
                                      {typeof q.returnedCoverageA === "number" && Number.isFinite(q.returnedCoverageA) && q.returnedCoverageA > 0 ? new Intl.NumberFormat(
                                        "en-US",
                                        {
                                          style: "currency",
                                          currency: "USD",
                                          maximumFractionDigits: 0,
                                        }
                                      ).format(q.returnedCoverageA) : "Unavailable"}
                                      <span className="block text-muted-foreground">Not an appraisal — your carrier may adjust Coverage A.</span>
                                    </div>
                                </div>
                              </div>
                            </div>
                            <div className="text-right shrink-0 ml-2">
                              <div className="text-base font-bold font-mono text-primary">
                                {new Intl.NumberFormat(
                                  "en-US",
                                  {
                                    style: "currency",
                                    currency: "USD",
                                    maximumFractionDigits: 0,
                                  }
                                ).format(q.annualPremium)}
                                /yr
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {new Intl.NumberFormat(
                                  "en-US",
                                  {
                                    style: "currency",
                                    currency: "USD",
                                    maximumFractionDigits: 0,
                                  }
                                ).format(q.monthlyPremium)}
                                /mo
                              </div>
                              {q.quoteUrl && (
                                <a
                                  href={q.quoteUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-primary underline mt-1 block"
                                >
                                  View quote →
                                </a>
                              )}
                            </div>
                          </div>
                          {i === 0 && !windMitigationReportConfirmed && (
                            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left">
                              <p className="text-xs leading-relaxed text-amber-950">
                                This estimate assumes wind mitigation credits based on the home's age. A wind mitigation inspection is required to confirm them — without one, your premium may be higher.
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-2 h-8 border-amber-300 bg-white text-xs hover:bg-amber-100"
                                asChild
                              >
                                <a
                                  href={`mailto:christian@tateoco.com?subject=${encodeURIComponent("Wind mitigation report")}&body=${encodeURIComponent(`Property: ${address || "Please add the property address"}\n\nPlease attach the wind mitigation inspection report for review.`)}`}
                                >
                                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                                  Send wind mitigation report
                                </a>
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                      {qrStatus === "pending" && (
                        <p className="text-xs text-muted-foreground text-center">
                          More quotes may still be arriving…
                        </p>
                      )}
                      <p className="text-[10px] text-muted-foreground text-center leading-relaxed pt-1">
                        Real-time carrier rates via Tateo &amp; Co ·
                        Tateo Insurance Corp · License #L132640 ·
                        Not a binding quote. Coverage not effective
                        until confirmed by a licensed agent.
                      </p>
                    </div>
                  )}

                  {/* Error / no quotes fallback */}
                  {qrStatus === "error" &&
                    qrQuotes.length === 0 && (
                    <div className="text-center py-4 space-y-3">
                      <p className="text-sm text-muted-foreground">
                        This property may need a custom quote.
                        Contact Tateo &amp; Co directly.
                      </p>
                      <div className="flex gap-2 justify-center">
                        <Button
                          size="sm"
                          variant="outline"
                          asChild
                        >
                          <a href="tel:+18132148356">
                            (813) 214-8356
                          </a>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          asChild
                        >
                          <a href="mailto:christian@tateoco.com">
                            Email Us
                          </a>
                        </Button>
                      </div>
                    </div>
                  )}

                </CardContent>
            </Card>
          </div>

          {/* Flood warning */}
          <div className="flex gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-900 leading-relaxed">
              {assumesHoaFloodCoverage ? (
                <>
                  <strong>No separate flood premium is estimated.</strong>{" "}
                  {FLOOD_HOA_ASSUMPTION_NOTE} FEMA flood-zone and risk information
                  still applies; confirm any elevation-certificate fees with your agent.
                </>
              ) : isLand ? (
                <>
                  <strong>No building flood premium is estimated for land.</strong>{" "}
                  FEMA flood-zone and risk information still applies. Confirm any
                  required coverage and elevation-certificate fees with your agent.
                </>
              ) : (
                <>
                  <strong>Flood insurance is not included in this estimate.</strong> Properties in AE or VE flood zones require a separate NFIP or private flood policy — often $800–$3,500+/year depending on zone and elevation. Ask your agent about an elevation certificate to reduce flood premiums.
                </>
              )}
            </p>
          </div>

          <p className="text-xs text-muted-foreground text-center leading-relaxed pb-4">
            These are estimates only based on regional data, property characteristics, and standard assumptions. Results vary by specific property inspection and market availability. Not a binding quote. Coverage not effective until confirmed by a licensed agent. Tateo Insurance Corp (Company) - License #L132640. Paul Christian Tateo (Agent) - License #W142842.
          </p>

        </div>
      </div>
      )}

      {/* ── Lead capture dialog ── */}
      <LeadCaptureDialog
        open={leadDialogOpen}
        onOpenChange={setLeadDialogOpen}
        action={leadDialogAction}
        address={address}
        onSuccess={handleLeadSuccess}
      />

      {/* ── Existing-account live-quote DOB preflight ── */}
      <Dialog
        open={dobPromptOpen}
        onOpenChange={(open) => {
          if (dobSaving) return;
          setDobPromptOpen(open);
          if (!open) {
            setDobInput("");
            setDobError("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Date of birth required</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleDobPreflight} className="space-y-4 pt-1">
            <p className="text-sm text-muted-foreground">
              Insurance carriers require the applicant's date of birth. Save it
              once to continue this live quote request.
            </p>
            <div className="space-y-1.5">
              <label
                htmlFor="live-quote-date-of-birth"
                className="text-sm font-medium"
              >
                Date of Birth
              </label>
              <input
                id="live-quote-date-of-birth"
                name="bday"
                type="date"
                min="1900-01-01"
                max={new Date().toISOString().slice(0, 10)}
                value={dobInput}
                onChange={(event) => setDobInput(event.target.value)}
                required
                autoComplete="bday"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            {dobError ? (
              <p className="text-sm text-destructive" role="alert">
                {dobError}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setDobPromptOpen(false)}
                disabled={dobSaving}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={dobSaving || !dobInput}
              >
                {dobSaving ? "Saving…" : "Save & Continue"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Add property dialog ── */}
      <Dialog open={showAddressPrompt} onOpenChange={setShowAddressPrompt}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add New Property</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <p className="text-sm text-muted-foreground">Enter the address for your new scenario (up to 5 total).</p>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                ref={newScenarioInputRef}
                type="text"
                value={newScenarioAddress}
                onChange={e => setNewScenarioAddress(e.target.value)}
                onKeyDown={e => e.key === "Enter" && confirmNewScenario()}
                placeholder="123 Main St, City, State…"
                autoComplete="off"
                className="w-full pl-9 pr-3 py-2 text-sm border rounded-md outline-none focus:ring-2 ring-primary/30 focus:border-primary"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => { setShowAddressPrompt(false); setNewScenarioAddress(""); }}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={confirmNewScenario} disabled={!newScenarioAddress.trim()}>
                Add Property
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
