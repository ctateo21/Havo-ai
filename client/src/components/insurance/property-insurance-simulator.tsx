// ─────────────────────────────────────────────────────────────────────
// PropertyInsuranceSimulator
//
// Florida homeowners insurance premium simulator. The same engine
// (rates + adjustment tables) and same UI used at the bottom of the
// Purchase / estimate page, factored into a standalone component so it
// can be reused on the Cash Buy detail page without rewiring estimate's
// intricate state model.
//
// The Purchase page (client/src/pages/estimate.tsx) keeps its inline
// copy for now — the constants here are intentionally a duplicate to
// avoid touching that file. If the simulator semantics ever change,
// update both call sites.
// ─────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, AlertTriangle, Info } from "lucide-react";
import { getCountyName } from "@/lib/county-tax-estimator";
import {
  getBaselineHomeownersInsuranceRate,
} from "@/lib/insurance-default";

export type InsRegionKey =
  | "keys" | "sefl" | "swfl" | "tampa" | "nefljax" | "central" | "ncfl";

export interface InsuranceFactors {
  regionKey: InsRegionKey;
  /** 0=under 5y · 1=5-14y (standard) · 2=15-20y · 3=20+y */
  roofIdx: number;
  /** 0=no inspection · 1=basic (standard) · 2=full mitigation */
  windIdx: number;
  /** 0=2% (standard) · 1=3% · 2=5% — hurricane deductible */
  hurrIdx: number;
  /** 0=CBS (preferred) · 1=mixed (standard) · 2=frame */
  constIdx: number;
  /** 0=2002+ · 1=1990-2001 (standard) · 2=1970-1989 · 3=pre-1970 */
  yearIdx: number;
  /** Exact year when known; legacy rows continue to use yearIdx. */
  yearBuilt?: number;
  /** 0=clean · 1=1 claim · 2=2 claims · 3=3+ claims */
  claimsIdx: number;
}

export const DEFAULT_INSURANCE_FACTORS: Omit<InsuranceFactors, "regionKey"> = {
  roofIdx: 1, windIdx: 1, hurrIdx: 0, constIdx: 0, yearIdx: 1, claimsIdx: 0,
};

const INS_REGIONS: Record<InsRegionKey, { name: string; counties: string; low: number; high: number; tier: string; note: string }> = {
  keys:    { name: "Keys / Barrier Islands",    counties: "Monroe, barrier islands",                 low: 0.0495, high: 0.0665, tier: "Extreme",  note: "Extreme hurricane surge risk. Most major carriers have exited this market." },
  sefl:    { name: "SE FL Coastal",             counties: "Miami-Dade, Broward, Palm Beach",         low: 0.0233, high: 0.0407, tier: "High",     note: "Hurricane exposure and high rebuild costs define this market." },
  swfl:    { name: "SW FL Coastal",             counties: "Lee, Collier, Charlotte, Manatee, Sarasota", low: 0.0134, high: 0.0207, tier: "High",  note: "Post-Hurricane Ian reinsurance pricing continues to elevate rates." },
  tampa:   { name: "Tampa Bay Area",            counties: "Hillsborough, Pinellas, Pasco",           low: 0.0110, high: 0.0170, tier: "Mod-High", note: "Growing storm risk recognition and significant flood zone coverage push rates above Central FL." },
  nefljax: { name: "NE FL / Jacksonville",      counties: "Duval, Clay, St. Johns, Flagler",         low: 0.0080, high: 0.0127, tier: "Moderate", note: "Moderate coastal exposure with better carrier availability than South Florida." },
  central: { name: "Central FL Inland",         counties: "Orange, Osceola, Polk, Seminole",         low: 0.0078, high: 0.0122, tier: "Moderate", note: "Good carrier availability and shielded from direct coastal wind." },
  ncfl:    { name: "North-Central FL Inland",   counties: "Alachua, Marion, Sumter, Lake, Columbia", low: 0.0054, high: 0.0080, tier: "Low",      note: "Consistently the lowest rates in Florida — 60+ miles from the coast." },
};

const INS_COUNTY_TO_REGION: Record<string, InsRegionKey> = {
  "monroe": "keys",
  "miami-dade": "sefl", "broward": "sefl", "palm beach": "sefl", "st. lucie": "sefl", "martin": "sefl",
  "lee": "swfl", "collier": "swfl", "charlotte": "swfl", "manatee": "swfl", "sarasota": "swfl",
  "hillsborough": "tampa", "pinellas": "tampa", "pasco": "tampa", "hernando": "tampa",
  "duval": "nefljax", "clay": "nefljax", "st. johns": "nefljax", "st johns": "nefljax", "flagler": "nefljax", "nassau": "nefljax",
  "okaloosa": "nefljax", "santa rosa": "nefljax", "escambia": "nefljax",
  "orange": "central", "osceola": "central", "polk": "central", "seminole": "central", "lake": "central", "volusia": "central",
  "brevard": "central", "indian river": "central",
  "alachua": "ncfl", "marion": "ncfl", "sumter": "ncfl", "columbia": "ncfl", "putnam": "ncfl",
  "leon": "ncfl", "gadsden": "ncfl", "wakulla": "ncfl",
};

export function getInsRegionFromAddress(address: string): InsRegionKey {
  const county = getCountyName(address);
  if (county && INS_COUNTY_TO_REGION[county]) return INS_COUNTY_TO_REGION[county];
  return "tampa";
}

const INS_ROOF_ADJ  = [0.90, 1.00, 1.20, 1.38];
const INS_WIND_ADJ  = [1.14, 1.00, 0.82];
const INS_HURR_ADJ  = [1.10, 1.05, 1.00];
const INS_CLAIM_ADJ = [1.00, 1.14, 1.26, 1.40];

// Roof, wind, deductible, and claims continue to refine the age/construction
// baseline. Construction and age themselves are priced directly below.
const NEUTRAL_FACTOR_PRODUCT =
  INS_ROOF_ADJ[DEFAULT_INSURANCE_FACTORS.roofIdx]   *
  INS_WIND_ADJ[DEFAULT_INSURANCE_FACTORS.windIdx]   *
  INS_HURR_ADJ[DEFAULT_INSURANCE_FACTORS.hurrIdx]   *
  INS_CLAIM_ADJ[DEFAULT_INSURANCE_FACTORS.claimsIdx];

export interface InsurancePremiumResult {
  low: number;
  mid: number;
  high: number;
  monthly: number;
  hurrDeductible: number;
  hurrPct: number;
}

/** Pure premium calc shared with persistence code that doesn't render UI. */
export function calcInsurancePremium(purchasePrice: number, factors: InsuranceFactors): InsurancePremiumResult {
  const rebuild = Math.max(0, purchasePrice);
  const legacyYearBuilt = [2002, 1995, 1980, 1960][factors.yearIdx] ?? 1995;
  const rawAdj =
    INS_ROOF_ADJ[factors.roofIdx]   * INS_WIND_ADJ[factors.windIdx]   * INS_HURR_ADJ[factors.hurrIdx] *
    INS_CLAIM_ADJ[factors.claimsIdx];
  const adj = rawAdj / NEUTRAL_FACTOR_PRODUCT;
  const baselineRate = getBaselineHomeownersInsuranceRate({
    yearBuilt: factors.yearBuilt ?? legacyYearBuilt,
    isFrameConstruction: factors.constIdx === 2,
  });
  const midRate  = baselineRate * adj;
  const lowRate  = midRate * 0.85;
  const highRate = midRate * 1.15;
  return {
    low:   Math.round(rebuild * lowRate),
    mid:   Math.round(rebuild * midRate),
    high:  Math.round(rebuild * highRate),
    monthly:        Math.round(rebuild * midRate / 12),
    hurrDeductible: Math.round(rebuild * [0.02, 0.03, 0.05][factors.hurrIdx]),
    hurrPct:        [2, 3, 5][factors.hurrIdx],
  };
}

interface Props {
  /** Property address — drives region auto-detection. */
  address: string;
  /** Purchase price = rebuild basis for the premium calc. */
  purchasePrice: number;
  /** Persisted factors. Pass `undefined` to use defaults seeded from the address. */
  factors?: InsuranceFactors;
  /** Called when the user changes any factor. */
  onFactorsChange: (next: InsuranceFactors) => void;
  /** Called with the recomputed annual midpoint premium whenever inputs change. */
  onPremiumChange?: (annualMidpoint: number) => void;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

export default function PropertyInsuranceSimulator({
  address, purchasePrice, factors, onFactorsChange, onPremiumChange,
}: Props) {
  // Seed missing factors from the address-derived region + global defaults.
  const effective: InsuranceFactors = useMemo(() => {
    if (factors) return factors;
    return { regionKey: getInsRegionFromAddress(address), ...DEFAULT_INSURANCE_FACTORS };
  }, [factors, address]);

  // Auto-update region whenever the address changes — but only if the user
  // hasn't manually overridden it (we detect "no manual override" by
  // checking equality with the address-derived region for the *previous*
  // address). Simpler heuristic: if there are no persisted factors yet,
  // mirror the address change into the effective region.
  const lastAddressRef = useRef(address);
  useEffect(() => {
    if (!address || address === "Unknown Address") return;
    const prevAddress = lastAddressRef.current;
    if (prevAddress === address) return;
    // Compute prevAuto from the OLD address before we overwrite the ref,
    // otherwise the manual-override detection below collapses (both sides
    // would resolve to the new address's auto-region and never match).
    const prevAuto = getInsRegionFromAddress(prevAddress);
    lastAddressRef.current = address;
    const autoRegion = getInsRegionFromAddress(address);
    if (!factors) {
      onFactorsChange({ ...DEFAULT_INSURANCE_FACTORS, regionKey: autoRegion });
      return;
    }
    // Only auto-flip the region if it currently matches the previous
    // address's auto-region (i.e., the user never picked it manually).
    if (factors.regionKey === prevAuto && factors.regionKey !== autoRegion) {
      onFactorsChange({ ...factors, regionKey: autoRegion });
    }
  }, [address, factors, onFactorsChange]);

  const premium = useMemo(() => calcInsurancePremium(purchasePrice, effective), [purchasePrice, effective]);

  // Surface premium upward whenever it changes (parent uses for cash-to-close
  // ongoing-cost preview, persistence snapshot, etc.).
  useEffect(() => {
    onPremiumChange?.(premium.mid);
  }, [premium.mid, onPremiumChange]);

  function patch(p: Partial<InsuranceFactors>) {
    onFactorsChange({ ...effective, ...p });
  }

  const region = INS_REGIONS[effective.regionKey];
  const safePrice = Math.max(1, purchasePrice);

  return (
    <Card className="border-2 border-primary/20 shadow-md">
      <CardHeader className="pb-3 bg-primary/5 rounded-t-lg">
        <CardTitle className="text-base flex items-center gap-2 text-primary">
          <Shield className="h-4 w-4" />
          Homeowners Insurance Estimate
          <Badge className="ml-auto bg-primary/10 text-primary border-primary/30 font-mono text-sm">
            {fmt(premium.mid)}/yr midpoint
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Adjust the factors below to refine the estimate for roof age, wind mitigation, construction, and claims history.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        {/* Premium hero */}
        <div className="bg-primary rounded-xl p-4 text-white mb-5">
          <div className="text-[10px] font-semibold text-white/60 uppercase tracking-widest mb-1">
            Estimated Annual Premium
          </div>
          <div className="grid grid-cols-3 gap-2 mt-2">
            <div className="bg-white/10 rounded-lg p-3 border border-white/10">
              <div className="text-[9px] font-medium text-white/50 uppercase tracking-wide mb-1">Low</div>
              <div className="text-sm font-bold font-mono">{fmt(premium.low)}</div>
              <div className="text-[9px] text-white/40 mt-0.5">{(premium.low / safePrice * 100).toFixed(2)}% of price</div>
            </div>
            <div className="bg-white/20 rounded-lg p-3 border border-white/30 ring-1 ring-white/30">
              <div className="text-[9px] font-medium text-white/70 uppercase tracking-wide mb-1">Midpoint</div>
              <div className="text-base font-bold font-mono text-yellow-300">{fmt(premium.mid)}</div>
              <div className="text-[9px] text-yellow-300/70 mt-0.5">{(premium.mid / safePrice * 100).toFixed(2)}% of price</div>
            </div>
            <div className="bg-white/10 rounded-lg p-3 border border-white/10">
              <div className="text-[9px] font-medium text-white/50 uppercase tracking-wide mb-1">High</div>
              <div className="text-sm font-bold font-mono">{fmt(premium.high)}</div>
              <div className="text-[9px] text-white/40 mt-0.5">{(premium.high / safePrice * 100).toFixed(2)}% of price</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div className="bg-white/10 rounded-lg p-2.5 border border-white/10">
              <div className="text-[9px] text-white/50 uppercase tracking-wide">Monthly (midpoint)</div>
              <div className="text-sm font-bold font-mono">{fmt(premium.monthly)}/mo</div>
            </div>
            <div className="bg-white/10 rounded-lg p-2.5 border border-white/10">
              <div className="text-[9px] text-white/50 uppercase tracking-wide">Hurricane Deductible ({premium.hurrPct}%)</div>
              <div className="text-sm font-bold font-mono">{fmt(premium.hurrDeductible)}</div>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2 space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">Region / Risk Tier</label>
            <select
              value={effective.regionKey}
              onChange={e => patch({ regionKey: e.target.value as InsRegionKey })}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {(Object.entries(INS_REGIONS) as [InsRegionKey, typeof INS_REGIONS[InsRegionKey]][]).map(([key, r]) => (
                <option key={key} value={key}>{r.name} — {r.counties}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground leading-relaxed pt-1">{region.note}</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">Roof Age</label>
            <select value={effective.roofIdx} onChange={e => patch({ roofIdx: Number(e.target.value) })} className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option value={0}>Under 5 years</option>
              <option value={1}>5–14 years — standard</option>
              <option value={2}>15–20 years</option>
              <option value={3}>20+ years</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">Wind Mitigation</label>
            <select value={effective.windIdx} onChange={e => patch({ windIdx: Number(e.target.value) })} className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option value={0}>No inspection / no features</option>
              <option value={1}>Basic inspection — standard</option>
              <option value={2}>Full mitigation: hip roof, shutters, SWR</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">Hurricane Deductible</label>
            <select value={effective.hurrIdx} onChange={e => patch({ hurrIdx: Number(e.target.value) })} className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option value={0}>2% of dwelling — standard</option>
              <option value={1}>3% of dwelling</option>
              <option value={2}>5% of dwelling</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">Construction Type</label>
            <select value={effective.constIdx} onChange={e => patch({ constIdx: Number(e.target.value) })} className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option value={0}>Concrete block / CBS — preferred</option>
              <option value={1}>Mixed / unknown — standard</option>
              <option value={2}>Frame construction</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">Year Built</label>
            <select value={effective.yearIdx} onChange={e => patch({ yearIdx: Number(e.target.value) })} className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option value={0}>2002 or newer — Florida Building Code</option>
              <option value={1}>1990–2001 — standard</option>
              <option value={2}>1970–1989</option>
              <option value={3}>Pre-1970</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block">Claims History (5 yrs)</label>
            <select value={effective.claimsIdx} onChange={e => patch({ claimsIdx: Number(e.target.value) })} className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option value={0}>No claims — clean history</option>
              <option value={1}>1 claim filed</option>
              <option value={2}>2 claims filed</option>
              <option value={3}>3+ claims</option>
            </select>
          </div>
        </div>

        <div className="flex gap-2.5 bg-amber-50 border border-amber-200 rounded-lg p-3 mt-4">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-900 leading-relaxed">
            <strong>Flood insurance not included.</strong> Properties in AE/VE flood zones require a separate NFIP or private policy — typically $800–$3,500+/year. Check FEMA's flood map for this address.
          </p>
        </div>
        <div className="flex gap-2.5 bg-blue-50 border border-blue-200 rounded-lg p-3 mt-2">
          <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
          <p className="text-xs text-blue-900 leading-relaxed">
            <strong>Risk tier: {region.tier}.</strong> {region.note}
          </p>
        </div>
        <p className="text-[10px] text-muted-foreground mt-3 leading-relaxed">
          Estimates sourced from FL OIR CHOICES filings, 2026. For planning only — not a binding quote.
        </p>
      </CardContent>
    </Card>
  );
}
