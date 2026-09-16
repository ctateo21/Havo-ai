import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { useLocation, useSearch } from "wouter";
import ScenarioActions from "@/components/scenario-actions";
import {
  ArrowLeft, MapPin, Save, AlertCircle, Loader2, Banknote, Camera, Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext,
} from "@/components/ui/carousel";
import { ScheduleShowingButton } from "@/components/ui/schedule-showing-button";
import { useAuth } from "@/context/auth-context";
import {
  getCashBuyScenarios, saveCashBuyScenarios,
  type CashBuyScenario, type CashBuyOccupancyType, type SellerConcessionsMode,
  type CashBuyInsuranceFactors,
  clearUnvalidatedCashBuyPropertyTax, hasValidatedCashBuyPropertyTax,
} from "@/lib/auth";
import { notifyNewScenario } from "@/lib/notify-scenario";
import { normalizePropertyKey } from "@/lib/property-key";
import { trackEvent } from "@/lib/posthog";
import {
  cashBuyTaxBadge,
  cashBuyTaxHint,
  canApplyCashBuyTaxResult,
  lookupCashBuyPropertyTax,
  sameCashBuyTaxRequest,
  type CashBuyTaxLookupState,
} from "@/lib/cash-buy-property-tax";
import { calculateDefaultHomeownersInsurance } from "@/lib/insurance-default";
import { apiRequest } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { PHYSICAL_PROPERTY_TYPE_OPTIONS, zillowToPhysicalPropertyType } from "@/lib/property-type-options";
import PropertyInsuranceSimulator, {
  DEFAULT_INSURANCE_FACTORS, getInsRegionFromAddress, calcInsurancePremium,
  type InsuranceFactors,
} from "@/components/insurance/property-insurance-simulator";

// ─── helpers ─────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n);
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cashbuy_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Legacy Cash Buy rows may carry an "official" marker without the exact
 * address/price/occupancy request tuple that produced it. Do not hydrate
 * those values as verified bills. The parcel-specific official lookup is
 * intentionally owned by the separate Cash Buy task.
 */
function hydrateOfficialOnlyPropertyTax(scenario: CashBuyScenario): CashBuyScenario {
  return clearUnvalidatedCashBuyPropertyTax(scenario);
}

function sellerConcessionsApplied(s: CashBuyScenario): number {
  const price = s.purchasePrice ?? 0;
  const closing = s.closingCosts ?? 0;
  const mode: SellerConcessionsMode = s.sellerConcessionsMode ?? "percent";
  const raw = mode === "amount"
    ? (s.sellerConcessionsAmount ?? 0)
    : price * ((s.sellerConcessionsPercent ?? 0) / 100);
  return Math.max(0, Math.min(raw, closing));
}

/** Cash-to-close formula per spec:
 *  Purchase Price + Estimated Closing Costs − Seller Concessions.
 *  Taxes / insurance / HOA are surfaced separately as ongoing costs and
 *  intentionally NOT folded in (avoids baking unverified proration
 *  assumptions into the headline number). */
function cashToCloseOf(s: CashBuyScenario): number {
  const price = s.purchasePrice ?? 0;
  const closing = s.closingCosts ?? 0;
  return Math.max(0, Math.round(price + closing - sellerConcessionsApplied(s)));
}

const DEFAULT_CLOSING_PERCENT = 2.0;

/** ─── Zillow LookedUpProperty shape — kept loose so server changes don't
 *  immediately break this page. Mirrors property-lookup-dialog. */
interface LookedUpPropertyLite {
  address?: string;
  zestimate?: number | null;
  listingPrice?: number | null;
  purchasePrice?: number | null;
  soldPrice?: number | null;
  isSold?: boolean;
  hoaMonthly?: number | null;
  photos?: string[];
  /** Zillow `homeType` (e.g. "CONDO", "TOWNHOUSE", "SINGLE_FAMILY")
   *  — Phase 2 uses this to seed the Physical Property Type select. */
  propertyType?: string | null;
  yearBuilt?: number | null;
}

function inferPriceSource(
  p: LookedUpPropertyLite, zPrice: number | null, fromCache: boolean,
): CashBuyScenario["purchasePriceSource"] {
  if (fromCache) return "zillow_cache";
  if (zPrice == null) return "zillow_zestimate";
  if (p.isSold && p.soldPrice != null && p.soldPrice === zPrice) return "zillow_sold";
  if (p.listingPrice != null && p.listingPrice === zPrice) return "zillow_listing";
  return "zillow_zestimate";
}

function legacyInsuranceYearIndex(yearBuilt: number): number {
  if (yearBuilt >= 2002) return 0;
  if (yearBuilt >= 1990) return 1;
  if (yearBuilt >= 1970) return 2;
  return 3;
}

// ─── Number row (slider + numeric input) ─────────────────────────────

interface NumRowProps {
  label: string;
  hint?: string;
  testId?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  badge?: React.ReactNode;
  /** For unavailable official-only values, leave the editable field blank
   *  instead of rendering the internal zero sentinel as a verified amount. */
  unavailable?: boolean;
  /** When false, hides the slider and shows just an editable number
   *  field (user types the value). Defaults to true. */
  slider?: boolean;
}

function NumRow({
  label, hint, testId, value, onChange, min, max, step = 1,
  prefix, suffix, decimals = 0, badge, slider = true,
  unavailable = false,
}: NumRowProps) {
  const [text, setText] = useState<string>(() =>
    unavailable ? "" : decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString("en-US"),
  );
  const focused = useRef(false);

  useEffect(() => {
    if (focused.current) return;
    setText(unavailable ? "" : decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString("en-US"));
  }, [value, decimals, unavailable]);

  function commit(raw: string) {
    const n = parseFloat(raw.replace(/,/g, ""));
    if (Number.isNaN(n)) return;
    const rounded = decimals > 0 ? parseFloat(n.toFixed(decimals)) : Math.round(n);
    onChange(Math.min(max, Math.max(min, rounded)));
  }

  // Standard slider layout (global spec): label row on top, then
  // a 3fr/1fr grid below with the slider on the left (75% width)
  // and the editable value pill on the right (25%). Mobile stacks
  // so the slider never gets cramped.
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="flex items-center gap-2 flex-wrap">
        <Label className="text-xs font-medium">{label}</Label>
        {badge}
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      <div className={slider ? "grid grid-cols-1 md:grid-cols-[3fr_1fr] items-center gap-2 md:gap-3" : ""}>
        {slider && (
          <Slider
            className="w-full"
            min={min} max={max} step={step}
            value={[Math.min(max, Math.max(min, value))]}
            onValueChange={([v]) => onChange(v)}
          />
        )}
        <div className="flex items-center gap-0.5 bg-muted rounded-md px-2 py-1 min-w-[120px] md:justify-end">
          {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
          <input
            className="w-full bg-transparent text-xs font-semibold text-right outline-none min-w-0"
            value={text}
            inputMode="decimal"
            onFocus={e => { focused.current = true; e.target.select(); }}
            onChange={e => { setText(e.target.value); commit(e.target.value); }}
            onBlur={() => {
              focused.current = false;
              setText(unavailable ? "" : decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString("en-US"));
            }}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
          {suffix && <span className="text-xs text-muted-foreground ml-0.5">{suffix}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Photo block ─────────────────────────────────────────────────────

function PhotoCarousel({
  photos, primary, status,
}: {
  photos: string[]; primary?: string; status: "idle" | "loading" | "loaded" | "error";
}) {
  const all = useMemo(() => {
    const list = [primary, ...photos].filter((p): p is string => !!p);
    return Array.from(new Set(list));
  }, [photos, primary]);

  if (status === "loading" && all.length === 0) {
    return (
      <div className="rounded-xl border bg-muted/40 aspect-[16/9] flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading property photos…
      </div>
    );
  }
  if (all.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-muted/30 aspect-[16/9] flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
        <Camera className="h-5 w-5" />
        <span>No photos found for this property.</span>
      </div>
    );
  }
  if (all.length === 1) {
    return (
      <div className="rounded-xl overflow-hidden border bg-muted/20">
        <img src={all[0]} alt="" className="w-full aspect-[16/9] object-cover" />
      </div>
    );
  }
  return (
    <Carousel className="w-full">
      <CarouselContent>
        {all.map((src, i) => (
          <CarouselItem key={`${i}-${src}`}>
            <div className="rounded-xl overflow-hidden border bg-muted/20">
              <img src={src} alt="" className="w-full aspect-[16/9] object-cover" />
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  );
}

// ─── Main page ───────────────────────────────────────────────────────

export default function CashBuyPage() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const isAuthenticated = !!user;

  const { addressFromUrl, idFromUrl } = useMemo(() => {
    const p = new URLSearchParams(search);
    return {
      addressFromUrl: p.get("address") ?? "",
      idFromUrl: p.get("id") ?? "",
    };
  }, [search]);

  // Resolve initial scenario: existing by id → by address → new draft.
  const [scenario, setScenario] = useState<CashBuyScenario>(() => {
    const all = getCashBuyScenarios();
    const byId = idFromUrl ? all.find(s => s.id === idFromUrl) : undefined;
    if (byId) return hydrateOfficialOnlyPropertyTax(byId);
    const byAddr = addressFromUrl
      ? all.find(s => s.address.toLowerCase().trim() === addressFromUrl.toLowerCase().trim())
      : undefined;
    if (byAddr) return hydrateOfficialOnlyPropertyTax(byAddr);
    const now = new Date().toISOString();
    return {
      id: makeId(),
      address: addressFromUrl || "Unknown Address",
      normalizedPropertyKey: addressFromUrl ? normalizePropertyKey(addressFromUrl).key || undefined : undefined,
      savedAt: now,
      updatedAt: now,
      purchasePrice: 0,
      purchasePriceSource: "default",
      occupancyType: "primary",
      propertyTaxes: undefined,
      homeownersInsurance: 0,
      hoaMonthly: 0,
      hoaSource: "unknown",
      closingCosts: 0,
      closingCostsPercent: DEFAULT_CLOSING_PERCENT,
      closingCostsSource: "default_percent",
      sellerConcessionsMode: "percent",
      sellerConcessionsPercent: 0,
      sellerConcessionsAmount: 0,
    };
  });

  // An official tax value is only valid for the exact lookup context that
  // produced it. Manual values (including $0) are intentionally untouched.
  // Context changes can come from navigation/Zillow flows rather than the
  // field setters below, so guard all three tuple fields here as well.
  const taxContextRef = useRef({
    address: scenario.address,
    purchasePrice: scenario.purchasePrice,
    occupancyType: scenario.occupancyType,
  });
  useEffect(() => {
    const previous = taxContextRef.current;
    const changed =
      previous.address !== scenario.address ||
      previous.purchasePrice !== scenario.purchasePrice ||
      previous.occupancyType !== scenario.occupancyType;
    taxContextRef.current = {
      address: scenario.address,
      purchasePrice: scenario.purchasePrice,
      occupancyType: scenario.occupancyType,
    };
    if (!changed) return;
    setScenario(prev => clearUnvalidatedCashBuyPropertyTax(prev));
  }, [scenario.address, scenario.purchasePrice, scenario.occupancyType]);

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // Tax lookup state is separate from the editable scenario value. The
  // scenario stores only an official result tied to its exact request tuple;
  // a manual value always wins over an in-flight response.
  const [taxLookup, setTaxLookup] = useState<CashBuyTaxLookupState>({
    status: "idle",
  });
  const taxLookupGenerationRef = useRef(0);

  useEffect(() => {
    const request = {
      address: scenario.address,
      purchasePrice: scenario.purchasePrice ?? 0,
      occupancy: scenario.occupancyType ?? "primary",
    } as const;
    const generation = ++taxLookupGenerationRef.current;

    if (scenario.propertyTaxesSource === "manual") {
      setTaxLookup({ status: "manual", request });
      return;
    }

    // A persisted official result is already authoritative for this exact
    // tuple; do not replace it with a second request during Zillow/photo
    // hydration.
    if (
      hasValidatedCashBuyPropertyTax(scenario) &&
      scenario.propertyTaxesRequest
    ) {
      setTaxLookup({
        status: "verified",
        request,
        annualTax: scenario.propertyTaxes,
        source: "county-estimator",
      });
      return;
    }

    if (
      !request.address ||
      request.address === "Unknown Address" ||
      request.purchasePrice <= 0
    ) {
      setTaxLookup({ status: "fallback", request });
      return;
    }

    let cancelled = false;
    setTaxLookup({ status: "loading", request });
    lookupCashBuyPropertyTax(request).then(result => {
      if (cancelled || generation !== taxLookupGenerationRef.current) return;
      setTaxLookup(result);
      const resolvedRequest = result.request;
      if (
        result.status !== "verified" ||
        result.annualTax == null ||
        !resolvedRequest
      ) return;

      setScenario(prev => {
        const current = {
          address: prev.address,
          purchasePrice: prev.purchasePrice ?? 0,
          occupancy: prev.occupancyType ?? "primary",
        } as const;
        if (!canApplyCashBuyTaxResult(current, resolvedRequest, prev.propertyTaxesSource)) {
          return prev;
        }
        return {
          ...prev,
          propertyTaxes: result.annualTax,
          propertyTaxesSource: "official",
          propertyTaxesRequest: {
            address: resolvedRequest.address,
            purchasePrice: resolvedRequest.purchasePrice,
            occupancyType: resolvedRequest.occupancy,
          },
        };
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    scenario.address,
    scenario.purchasePrice,
    scenario.occupancyType,
    scenario.propertyTaxes,
    scenario.propertyTaxesSource,
    scenario.propertyTaxesRequest,
  ]);

  // ─── Debounced auto-save (mirrors seller-estimate / Phase 1 guards) ───
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) { firstRenderRef.current = false; return; }
    if (!isAuthenticated) return;
    if (!scenario.address || scenario.address === "Unknown Address") return;
    setSaveStatus("saving");
    const t = window.setTimeout(() => {
      try {
        const all = getCashBuyScenarios();
        const stamped: CashBuyScenario = {
          ...scenario,
          updatedAt: new Date().toISOString(),
          cashToClose: cashToCloseOf(scenario),
        };
        const idx = all.findIndex(s => s.id === stamped.id);
        const next = idx >= 0
          ? all.map(s => s.id === stamped.id ? stamped : s)
          : [stamped, ...all];
        saveCashBuyScenarios(next);
        // New scenario only (idx < 0 fires once): notify the assigned
        // agent (non-blocking, fire-and-forget).
        if (idx < 0) notifyNewScenario("Cash Buy", stamped.address, "Saved a cash buy scenario");
        trackEvent("scenario_saved", { type: "cash_buy" });
        if (isMountedRef.current) {
          setSaveStatus("saved");
          window.setTimeout(() => {
            if (isMountedRef.current) setSaveStatus(s => (s === "saved" ? "idle" : s));
          }, 1500);
        }
      } catch (err) {
        console.warn("[cash-buy] auto-save failed:", err);
        if (isMountedRef.current) setSaveStatus("error");
      }
    }, 600);
    return () => window.clearTimeout(t);
  }, [scenario, isAuthenticated]);

  // ─── Zillow auto-pull on mount / address change ───
  //
  // Fires once per (scenarioId|address) if the price hasn't been
  // user-edited and Zillow hasn't already populated this scenario.
  // Server returns cached results from `property_cache` when available
  // (no network call), so this is cheap to call.
  const zillowFiredRef = useRef<Set<string>>(new Set());
  const userTouchedInsuranceSimRef = useRef(false);
  const [zillowStatus, setZillowStatus] = useState<CashBuyScenario["zillowStatus"]>(scenario.zillowStatus);

  useEffect(() => {
    const addr = scenario.address;
    if (!addr || addr === "Unknown Address") return;
    const key = `${scenario.id}|${addr.trim().toLowerCase()}`;
    if (zillowFiredRef.current.has(key)) return;
    // A saved price is not proof that photos were saved. Preserve all
    // user-entered values, but still hydrate Zillow photos for older rows.
    const hasPhotos = Boolean(
      scenario.primaryPhotoUrl ||
      scenario.propertyPhotos?.some(photo => typeof photo === "string" && photo.length > 0),
    );
    const hasYearBuilt =
      typeof scenario.insuranceFactors?.yearBuilt === "number" &&
      Number.isFinite(scenario.insuranceFactors.yearBuilt);
    if (scenario.purchasePriceSource === "user" && hasPhotos && hasYearBuilt) return;
    if (
      hasPhotos &&
      hasYearBuilt &&
      scenario.purchasePriceSource &&
      scenario.purchasePriceSource.startsWith("zillow")
    ) {
      zillowFiredRef.current.add(key);
      return;
    }
    // After reload from Supabase, `purchasePriceSource` is gone (not in
    // the canonical table). Use a non-zero price as a proxy for "already
    // populated" so a reload doesn't clobber the saved value with a
    // fresh Zillow scrape.
    if (hasPhotos && hasYearBuilt && (scenario.purchasePrice ?? 0) > 0) {
      zillowFiredRef.current.add(key);
      return;
    }
    zillowFiredRef.current.add(key);
    setZillowStatus("loading");
    setScenario(prev => ({ ...prev, zillowStatus: "loading" }));

    (async () => {
      try {
        const res = await apiRequest("POST", "/api/zillow-property-lookup", { addressOrUrl: addr });
        const body = await res.json();
        const p: LookedUpPropertyLite | undefined = body?.property;
        const fromCache: boolean = body?.cached === true;
        if (!p) {
          if (isMountedRef.current) {
            setZillowStatus("error");
            setScenario(prev => ({ ...prev, zillowStatus: "error" }));
          }
          return;
        }
        const zPrice = p.purchasePrice ?? p.listingPrice ?? p.zestimate ?? null;
        const zHoa = p.hoaMonthly ?? null;
        const photos = Array.isArray(p.photos) ? p.photos.filter(x => typeof x === "string") : [];
        const primary = photos[0];
        const priceSource = inferPriceSource(p, zPrice, fromCache);
        const nextStatus: CashBuyScenario["zillowStatus"] =
          fromCache ? "loaded_from_cache" : "loaded_from_zillow";

        if (!isMountedRef.current) return;
        setZillowStatus(nextStatus);

        // Merge — never overwrite user-edited fields.
        setScenario(prev => {
          const next: CashBuyScenario = { ...prev, zillowStatus: nextStatus };
          // Price: overwrite only if not user-edited.
          if (zPrice != null && prev.purchasePriceSource !== "user") {
            next.purchasePrice = zPrice;
            next.purchasePriceSource = priceSource;
            // Recompute 2% closing default unless user has overridden.
            if ((prev.closingCostsSource ?? "default_percent") === "default_percent") {
              const pct = prev.closingCostsPercent ?? DEFAULT_CLOSING_PERCENT;
              next.closingCosts = Math.round(zPrice * (pct / 100));
            }
          }
          // HOA: overwrite only if user hasn't manually set it.
          if (zHoa != null && (prev.hoaSource ?? "unknown") !== "manual") {
            next.hoaMonthly = zHoa;
            next.hoaSource = "zillow";
          }
          // Photos: always refresh from Zillow (cached or fresh).
          if (primary) next.primaryPhotoUrl = primary;
          if (photos.length > 0) next.propertyPhotos = photos;
          // Phase 2: seed Physical Property Type from Zillow homeType,
          // but never overwrite a value the user has already picked.
          // We treat any existing prev.propertyType as the user's pick
          // (the only other writer is this same Zillow path, which is
          // gated by `zillowFiredRef` to run at most once per session).
          if (!prev.propertyType) {
            const mapped = zillowToPhysicalPropertyType(p.propertyType);
            if (mapped) next.propertyType = mapped;
          }
          if (
            typeof p.yearBuilt === "number" &&
            Number.isFinite(p.yearBuilt) &&
            !userTouchedInsuranceSimRef.current
          ) {
            next.insuranceFactors = {
              regionKey: getInsRegionFromAddress(prev.address),
              ...DEFAULT_INSURANCE_FACTORS,
              ...(prev.insuranceFactors ?? {}),
              yearIdx: legacyInsuranceYearIndex(p.yearBuilt),
              yearBuilt: Math.round(p.yearBuilt),
            };
          }
          return clearUnvalidatedCashBuyPropertyTax(next);
        });

        if (zPrice != null) {
          toast({
            title: fromCache ? "Property data loaded from cache" : "Zillow data applied",
            description: `Updated purchase price to ${formatCurrency(zPrice)}.`,
          });
        }
      } catch (err) {
        console.warn("[cash-buy] zillow lookup failed:", err);
        if (isMountedRef.current) {
          setZillowStatus("error");
          setScenario(prev => ({ ...prev, zillowStatus: "error" }));
        }
      }
    })();
  }, [
    scenario.id,
    scenario.address,
    scenario.purchasePriceSource,
    scenario.primaryPhotoUrl,
    scenario.propertyPhotos,
    toast,
  ]);

  // NOTE: Automatic QuoteRUSH pre-warming is disabled. Live carrier
  // quotes now run only when the user explicitly requests them from the
  // Insurance tab's detailed view.

  // ─── Flood zone + flood insurance ───
  // Reuses the exact same FEMA flood-zone source as Purchase with Loan
  // (server `/api/flood-zone`). Flood insurance is system-estimated with
  // the same $2,000/yr default convention used in estimate.tsx; $0 when
  // the property is not in a required-insurance flood zone.
  const { data: floodData } = useQuery<{ zone: string; subtype: string; requiresFloodInsurance: boolean }>({
    queryKey: ["/api/flood-zone", scenario.address],
    queryFn: () =>
      fetch(`/api/flood-zone?address=${encodeURIComponent(scenario.address)}`).then((r) => {
        if (!r.ok) throw new Error("Flood zone not found");
        return r.json();
      }),
    enabled: !!scenario.address && scenario.address !== "Unknown Address",
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
  });

  // Sync flood insurance with zone data whenever the address changes.
  // Mirrors estimate.tsx: clear to $0 outside a flood zone, seed the
  // $2,000/yr default inside one (only when nothing is set, so a saved /
  // future-manual value survives).
  const floodLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!floodData || !scenario.address) return;
    if (floodLoadedRef.current === scenario.address) return;
    floodLoadedRef.current = scenario.address;
    console.debug("[cash-buy-flood] address", scenario.address);
    console.debug("[cash-buy-flood] normalized property key", scenario.normalizedPropertyKey);
    console.debug("[cash-buy-flood] existing purchase-loan flood helper found", "/api/flood-zone (shared)");
    console.debug("[cash-buy-flood] flood zone result", floodData.zone, floodData.requiresFloodInsurance);
    console.debug("[cash-buy-flood] flood zone source", "FEMA NFHL");
    setScenario((prev) => {
      if (!floodData.requiresFloodInsurance) {
        console.debug("[cash-buy-flood] not a flood zone — flood insurance $0");
        return (prev.annualFloodIns ?? 0) === 0 ? prev : { ...prev, annualFloodIns: 0 };
      }
      const next = (prev.annualFloodIns ?? 0) === 0 ? 2000 : prev.annualFloodIns;
      console.debug("[cash-buy-flood] annual flood insurance", next);
      console.debug("[cash-buy-flood] monthly flood insurance", Math.round((next ?? 0) / 12));
      console.debug("[cash-buy-flood] added to ongoing costs", true);
      return prev.annualFloodIns === next ? prev : { ...prev, annualFloodIns: next };
    });
  }, [floodData, scenario.address, scenario.normalizedPropertyKey]);

  // ─── Field updaters ───

  function update<K extends keyof CashBuyScenario>(field: K, value: CashBuyScenario[K]) {
    setScenario(prev => ({ ...prev, [field]: value }));
  }

  // Price change from the user (slider/input). Side-effects: mark source
  // as "user", recompute default closing costs (if not manually overridden),
  // and invalidate any stale official tax result.
  function setPurchasePrice(v: number) {
    setScenario(prev => {
      const next: CashBuyScenario = { ...prev, purchasePrice: v, purchasePriceSource: "user" };
      if ((prev.closingCostsSource ?? "default_percent") === "default_percent") {
        const pct = prev.closingCostsPercent ?? DEFAULT_CLOSING_PERCENT;
        next.closingCosts = Math.round(v * (pct / 100));
      }
      return clearUnvalidatedCashBuyPropertyTax(next);
    });
  }

  function setOccupancy(occ: CashBuyOccupancyType) {
    setScenario(prev => {
      const next: CashBuyScenario = { ...prev, occupancyType: occ, occupancyTypeSource: "manual" };
      return clearUnvalidatedCashBuyPropertyTax(next);
    });
  }

  // Phase 2: physical property type select. Saved to
  // cash_buy_scenarios.property_type via the 2026_05_27 migration and
  // fed to the Insurance auto-default rule so Condo / Townhouse force
  // HO6. The Zillow merge above only seeds when prev.propertyType is
  // empty, so a manual pick here permanently sticks.
  function setPropertyType(pt: string) {
    setScenario(prev => ({ ...prev, propertyType: pt, propertyTypeSource: "manual" }));
  }

  function setPropertyTaxes(v: number) {
    setScenario(prev => ({ ...prev, propertyTaxes: v, propertyTaxesSource: "manual" }));
  }

  function setHomeownersInsurance(v: number) {
    setScenario(prev => ({
      ...prev,
      homeownersInsurance: v,
      homeownersInsuranceSource: "manual",
    }));
  }

  function setClosingCosts(v: number) {
    // Dollar-mode entry. Stamps the source as "manual" so the bootstrap
    // effect below won't recompute it from percent.
    setScenario(prev => ({ ...prev, closingCosts: v, closingCostsSource: "manual" }));
  }
  function setClosingCostsPercent(pct: number) {
    setScenario(prev => {
      const next: CashBuyScenario = {
        ...prev,
        closingCostsPercent: pct,
        // Editing the percent implies the user wants percent-mode behavior,
        // even if they had previously typed a manual dollar amount.
        closingCostsSource: "default_percent",
        closingCosts: Math.round((prev.purchasePrice ?? 0) * (pct / 100)),
      };
      return next;
    });
  }
  function setClosingMode(mode: "percent" | "dollar") {
    setScenario(prev => {
      if (mode === "percent") {
        const pct = prev.closingCostsPercent ?? DEFAULT_CLOSING_PERCENT;
        return {
          ...prev,
          closingCostsSource: "default_percent",
          closingCostsPercent: pct,
          closingCosts: Math.round((prev.purchasePrice ?? 0) * (pct / 100)),
        };
      }
      // Switching to dollar mode preserves the current dollar amount.
      return { ...prev, closingCostsSource: "manual" };
    });
  }

  function setHoaMonthly(v: number) {
    setScenario(prev => ({ ...prev, hoaMonthly: v, hoaSource: "manual" }));
  }

  // ─── Bootstrap effect: defaults for closing costs ───
  // Property taxes intentionally have no automatic default. A missing
  // official result stays unavailable until the borrower enters a bill.
  //
  // Rules:
  // 1. closingCostsSource = "manual" → never overwrite (user-entered $).
  // 2. Property taxes are never written here.
  useEffect(() => {
    const price = scenario.purchasePrice ?? 0;
    if (price <= 0) return;
    const patch: Partial<CashBuyScenario> = {};

    if ((scenario.closingCostsSource ?? "default_percent") !== "manual") {
      const pct = scenario.closingCostsPercent ?? DEFAULT_CLOSING_PERCENT;
      const expected = Math.round(price * (pct / 100));
      if ((scenario.closingCosts ?? 0) !== expected) {
        patch.closingCosts = expected;
        patch.closingCostsPercent = pct;
        patch.closingCostsSource = "default_percent";
        console.debug("[cash-buy-closing-costs] mode", "percent");
        console.debug("[cash-buy-closing-costs] percent", pct);
        console.debug("[cash-buy-closing-costs] final amount", expected);
      }
    } else {
      console.debug("[cash-buy-closing-costs] mode", "dollar");
      console.debug("[cash-buy-closing-costs] dollar amount", scenario.closingCosts ?? 0);
    }

    if (Object.keys(patch).length > 0) {
      setScenario(prev => ({ ...prev, ...patch }));
    }
    // NOTE: do not include scenario.closingCosts / scenario.propertyTaxes
    // in the dep list — the equality check inside is the loop guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scenario.purchasePrice, scenario.address, scenario.occupancyType,
    scenario.closingCostsSource, scenario.closingCostsPercent,
  ]);

  // Tracks whether the user has actively engaged the insurance simulator.
  const handleInsuranceFactors = useCallback((factors: InsuranceFactors) => {
    userTouchedInsuranceSimRef.current = true;
    setScenario(prev => ({ ...prev, insuranceFactors: factors as CashBuyInsuranceFactors }));
  }, []);
  const handleInsurancePremium = useCallback((annual: number) => {
    // Don't auto-overwrite until the user has actively engaged the
    // simulator. The 0.75% default already covers the no-touch case
    // via `insMidpoint` below.
    if (!userTouchedInsuranceSimRef.current) return;
    setScenario(prev => {
      // Manual lock: a user-entered annualHomeownersInsurance must not
      // be overwritten by the simulator. Still record the simulator's
      // own premium so the sim UI stays consistent.
      if (prev.homeownersInsuranceSource === "manual") {
        console.debug("[cash-buy-default] skipped insurance sync because manual value exists");
        return prev.insurancePremiumAnnual === annual
          ? prev
          : { ...prev, insurancePremiumAnnual: annual };
      }
      return prev.insurancePremiumAnnual === annual && prev.homeownersInsurance === annual
        ? prev
        : { ...prev, insurancePremiumAnnual: annual, homeownersInsurance: annual };
    });
  }, []);

  // ─── Derived display state ───

  const price = scenario.purchasePrice ?? 0;
  const closing = scenario.closingCosts ?? 0;
  const concessionApplied = sellerConcessionsApplied(scenario);
  const ctc = cashToCloseOf(scenario);
  // Derived from `closingCostsSource` — that field is the single source
  // of truth for the percent/dollar toggle and survives the round-trip
  // through Supabase via the 2026_05_27 column.
  const closingMode: "percent" | "dollar" =
    scenario.closingCostsSource === "manual" ? "dollar" : "percent";

  // Debug: trace the cash-to-close math whenever any input changes.
  useEffect(() => {
    if (!scenario.id || price <= 0) return;
    console.debug("[cash-buy-cash-to-close] purchase price", price);
    console.debug("[cash-buy-cash-to-close] closing costs included", closing);
    console.debug("[cash-buy-cash-to-close] seller concessions applied", concessionApplied);
    console.debug("[cash-buy-cash-to-close] final cash needed", ctc);
  }, [scenario.id, price, closing, concessionApplied, ctc]);

  // PostHog: scenario_calculated (cash_buy). Fires once per scenario id the
  // first time the cash-to-close result is meaningful (price > 0).
  const phCashBuyCalcFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!scenario.id || !(price > 0)) return;
    if (phCashBuyCalcFiredRef.current.has(scenario.id)) return;
    phCashBuyCalcFiredRef.current.add(scenario.id);
    trackEvent("scenario_calculated", { type: "cash_buy" });
  }, [scenario.id, price]);
  const sliderMax = Math.max(2_000_000, Math.round((price || 500_000) * 2));
  const closingMax = Math.max(50_000, Math.round((price || 500_000) * 0.06));
  const concessionMode: SellerConcessionsMode = scenario.sellerConcessionsMode ?? "percent";
  const concessionMax = concessionMode === "amount" ? Math.max(1, closing || 1) : 9;
  const isPlaceholder = !scenario.address || scenario.address === "Unknown Address";

  const photoStatus: "idle" | "loading" | "loaded" | "error" =
    zillowStatus === "loading" ? "loading"
    : zillowStatus === "error" ? "error"
    : zillowStatus ? "loaded" : "idle";

  const effectiveFactors: InsuranceFactors = (scenario.insuranceFactors as InsuranceFactors | undefined) ?? {
    regionKey: getInsRegionFromAddress(scenario.address),
    ...DEFAULT_INSURANCE_FACTORS,
  };
  // Insurance midpoint preview — used in the ongoing-costs summary
  // even before the user scrolls down to the simulator. Order of
  // precedence:
  //   1. Manually entered `homeownersInsurance` (preserved)
  //   2. Simulator-supplied `insurancePremiumAnnual` (only set after
  //      the user engages the simulator)
  //   3. Age/construction baseline using Zillow's exact year when present.
  // Legacy rows without a source tag are considered manual only when their
  // value differs from the old flat default; old auto-default rows migrate.
  const oldFlatInsurance = calculateDefaultHomeownersInsurance(price).annualInsurance;
  const legacyManualInsurance =
    scenario.homeownersInsuranceSource == null &&
    (scenario.homeownersInsurance ?? 0) > 0 &&
    Math.abs((scenario.homeownersInsurance ?? 0) - oldFlatInsurance) > 1;
  const manualIns =
    scenario.homeownersInsuranceSource === "manual" || legacyManualInsurance
      ? scenario.homeownersInsurance
      : undefined;
  const simIns = scenario.insurancePremiumAnnual && scenario.insurancePremiumAnnual > 0
    ? scenario.insurancePremiumAnnual
    : undefined;
  const baselineInsurance = calcInsurancePremium(price, effectiveFactors).mid;
  const insMidpoint = manualIns
    ?? simIns
    ?? baselineInsurance;
  const hasPropertyTax = hasValidatedCashBuyPropertyTax(scenario);
  const displayedTaxRequest = {
    address: scenario.address,
    purchasePrice: price,
    occupancy: scenario.occupancyType ?? "primary",
  } as const;
  const taxLookupStatus =
    scenario.propertyTaxesSource === "manual"
      ? "manual"
      : taxLookup.status === "verified" &&
          sameCashBuyTaxRequest(taxLookup.request, displayedTaxRequest)
        ? "verified"
        : taxLookup.status;
  const ongoingMonthly = hasPropertyTax
    ? Math.round(
      (scenario.propertyTaxes ?? 0) / 12 +
      (insMidpoint / 12) +
      (scenario.hoaMonthly ?? 0) +
      ((scenario.annualFloodIns ?? 0) / 12),
    )
    : null;

  // Persist the corrected untouched baseline so dashboards and future visits
  // do not retain an older flat 0.75% snapshot. Manual and simulator values win.
  useEffect(() => {
    if (userTouchedInsuranceSimRef.current || manualIns != null || simIns != null) return;
    setScenario(prev => {
      if (
        prev.homeownersInsurance === baselineInsurance &&
        prev.homeownersInsuranceSource === "default"
      ) {
        return prev;
      }
      return {
        ...prev,
        homeownersInsurance: baselineInsurance,
        homeownersInsuranceSource: "default",
      };
    });
  }, [baselineInsurance, manualIns, simIns]);

  const priceSourceLabel: Record<NonNullable<CashBuyScenario["purchasePriceSource"]>, string> = {
    default: "Default",
    user: "Manually entered",
    zillow_cache: "Zillow (cached)",
    zillow_listing: "Zillow listing price",
    zillow_sold: "Zillow sold price",
    zillow_zestimate: "Zillow Zestimate",
  };

  return (
    <div className="min-h-screen bg-muted/30">
      <Helmet>
        <title>Cash Buy — {scenario.address.split(",")[0]}</title>
      </Helmet>

      <div className="container mx-auto px-4 py-6 max-w-3xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 -ml-2"
            onClick={() => {
              // Logged-in users came from the dashboard's Cash Buy
              // tab. Logged-out users came through the six-option
              // service picker after entering an address — send them
              // back there with the address preserved (not to the
              // dashboard, which would bounce them to login).
              if (isAuthenticated) {
                setLocation("/dashboard?tab=cash_buy");
              } else {
                setLocation(
                  scenario.address
                    ? `/select-service?address=${encodeURIComponent(scenario.address)}`
                    : "/select-service",
                );
              }
            }}
          >
            <ArrowLeft className="h-4 w-4" />{" "}
            {isAuthenticated ? "Back to Cash Buy" : "Back to Services"}
          </Button>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {isAuthenticated && saveStatus === "saving" && (<><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>)}
              {isAuthenticated && saveStatus === "saved" && (<><Save className="h-3 w-3 text-green-600" /> Saved</>)}
              {isAuthenticated && saveStatus === "error" && (<><AlertCircle className="h-3 w-3 text-destructive" /> Save failed</>)}
            </div>
            {/* Share + Save buttons — auth-gated for logged-out users;
                draft state survives the auth dialog because the
                dialog renders inside this component tree. */}
            <ScenarioActions
              scenarioType="cash_buy"
              getPdfData={() => {
                if (
                  !scenario.address ||
                  !scenario.address.trim() ||
                  scenario.address === "Unknown Address"
                ) {
                  return null;
                }
                return {
                  address: scenario.address,
                  sections: [
                    {
                      heading: "Purchase",
                      rows: [
                        { label: "Purchase price", value: formatCurrency(price) },
                        { label: "Estimated closing costs", value: formatCurrency(closing) },
                        { label: "Seller concessions", value: formatCurrency(concessionApplied) },
                        { label: "Cash to close / total cash needed", value: formatCurrency(ctc) },
                      ],
                    },
                    {
                      heading: "Ongoing Costs",
                      rows: [
                        {
                          label: "Annual property taxes",
                          value: hasPropertyTax
                            ? formatCurrency(scenario.propertyTaxes ?? 0)
                            : "Unavailable — enter manually",
                        },
                        { label: "Homeowners insurance (annual)", value: formatCurrency(insMidpoint) },
                        ...((scenario.annualFloodIns ?? 0) > 0
                          ? [{ label: "Flood insurance (annual)", value: formatCurrency(scenario.annualFloodIns ?? 0) }]
                          : []),
                        { label: "Monthly HOA", value: formatCurrency(scenario.hoaMonthly ?? 0) },
                        {
                          label: "Ongoing monthly costs",
                          value: ongoingMonthly == null
                            ? "Unavailable — enter annual property taxes manually"
                            : formatCurrency(ongoingMonthly),
                        },
                      ],
                    },
                  ],
                  disclaimer:
                    "These are estimates only based on regional data, property characteristics, and standard assumptions. Actual costs vary by specific property, title company, and market conditions. Not a binding quote.",
                };
              }}
            />
          </div>
        </div>

        {/* Stacked, one-column layout */}
        <div className="space-y-4">

          {/* 1. Property photos at top */}
          <PhotoCarousel
            photos={scenario.propertyPhotos ?? []}
            primary={scenario.primaryPhotoUrl}
            status={photoStatus}
          />

          {/* Schedule-showing CTA — always shown for cash buyers, directly
              below the photo gallery. */}
          <ScheduleShowingButton
            service="purchase_with_cash"
            address={scenario.address}
            estimatedPrice={scenario.purchasePrice}
            normalizedPropertyKey={scenario.normalizedPropertyKey}
            className="text-center"
          />

          {/* 2. Property/address summary */}
          <Card>
            <CardContent className="py-4">
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm leading-snug">{scenario.address}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    {scenario.purchasePriceSource && (
                      <Badge variant="outline" className="text-[10px] font-normal h-5">
                        Price source: {priceSourceLabel[scenario.purchasePriceSource]}
                      </Badge>
                    )}
                    {zillowStatus === "loading" && (
                      <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Looking up Zillow…</span>
                    )}
                    {zillowStatus === "loaded_from_cache" && (
                      <span className="flex items-center gap-1"><Sparkles className="h-3 w-3 text-primary" /> Loaded from saved records</span>
                    )}
                    {zillowStatus === "loaded_from_zillow" && (
                      <span className="flex items-center gap-1"><Sparkles className="h-3 w-3 text-primary" /> Fresh Zillow data</span>
                    )}
                    {zillowStatus === "error" && (
                      <span className="flex items-center gap-1 text-amber-700"><AlertCircle className="h-3 w-3" /> Zillow lookup unavailable</span>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 3. Estimated Cash to Close */}
          <Card className="bg-primary/5 border-primary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Banknote className="h-4 w-4 text-primary" /> Estimated Cash to Close
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-primary tabular-nums">{formatCurrency(ctc)}</p>
              <div className="mt-3 text-xs text-muted-foreground space-y-1">
                <div className="flex justify-between"><span>Purchase price</span><span>{formatCurrency(price)}</span></div>
                <div className="flex justify-between"><span>+ Closing costs</span><span>{formatCurrency(closing)}</span></div>
                {concessionApplied > 0 && (
                  <div className="flex justify-between text-green-700"><span>− Seller concessions</span><span>−{formatCurrency(concessionApplied)}</span></div>
                )}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Cash purchase — no loan, no monthly mortgage payment. Taxes, insurance, and HOA are
                ongoing costs and are shown separately below.
              </p>
            </CardContent>
          </Card>

          {/* 4. Real Estate */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Real Estate</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <NumRow
                label="Purchase Price"
                testId="cash-buy-purchase-price"
                value={price}
                onChange={setPurchasePrice}
                min={0} max={sliderMax} step={1000} prefix="$"
              />

              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Property Use</Label>
                <Select
                  value={scenario.occupancyType ?? "primary"}
                  onValueChange={(v) => setOccupancy(v as CashBuyOccupancyType)}
                >
                  <SelectTrigger className="h-9 text-sm" data-testid="select-cash-occupancy"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">Primary Residence</SelectItem>
                    <SelectItem value="secondary">Secondary Home</SelectItem>
                    <SelectItem value="investment">Investment</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Primary residences get homestead tax rates; secondary &amp; investment use
                  non-homestead rates.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Property Type</Label>
                <Select
                  value={scenario.propertyType ?? "Single Family Residence"}
                  onValueChange={setPropertyType}
                >
                  <SelectTrigger className="h-9 text-sm" data-testid="select-cash-property-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PHYSICAL_PROPERTY_TYPE_OPTIONS.map(opt => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                    {scenario.propertyType &&
                      !PHYSICAL_PROPERTY_TYPE_OPTIONS.includes(scenario.propertyType as any) && (
                        <SelectItem value={scenario.propertyType}>{scenario.propertyType}</SelectItem>
                      )}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Condo / Townhouse defaults Insurance to HO6.
                </p>
              </div>

              {/* Estimated Closing Costs — single control with Percent/Dollar toggle.
                  Mirrors the seller-concessions pattern. closingCostsSource is
                  the mode signal: "default_percent" = percent mode (auto-recompute
                  from price), "manual" = dollar mode (frozen at user-entered $). */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs font-medium">Estimated Closing Costs</Label>
                  <div className="flex rounded-md border bg-background text-[11px] overflow-hidden">
                    <button
                      type="button"
                      data-testid="btn-closing-mode-percent"
                      className={`px-2.5 py-1 ${closingMode === "percent" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      onClick={() => setClosingMode("percent")}
                    >
                      Percentage
                    </button>
                    <button
                      type="button"
                      data-testid="btn-closing-mode-dollar"
                      className={`px-2.5 py-1 border-l ${closingMode === "dollar" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      onClick={() => setClosingMode("dollar")}
                    >
                      Dollar Amount
                    </button>
                  </div>
                </div>
                {closingMode === "percent" ? (
                  <NumRow
                    label="Percent of Price"
                    testId="cash-buy-closing-percent"
                    hint={`≈ ${formatCurrency(closing)} on the current purchase price.`}
                    value={scenario.closingCostsPercent ?? DEFAULT_CLOSING_PERCENT}
                    onChange={setClosingCostsPercent}
                    min={0} max={6} step={0.05} suffix="%" decimals={2}
                  />
                ) : (
                  <NumRow
                    label="Dollar Amount"
                    testId="cash-buy-closing-dollar"
                    hint={`≈ ${(price > 0 ? (closing / price * 100) : 0).toFixed(2)}% of purchase price.`}
                    value={closing}
                    onChange={setClosingCosts}
                    min={0} max={closingMax} step={100} prefix="$"
                  />
                )}
                <p className="text-[11px] text-muted-foreground">
                  Title, recording, doc stamps, inspection, appraisal — buyer side. Included in Total Cash Needed.
                </p>
              </div>

              {/* Seller concessions toggle */}
              <div className="space-y-2 pt-2 border-t">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs font-medium">Seller Concessions (% of Purchase Price)</Label>
                  <div className="flex rounded-md border bg-background text-[11px] overflow-hidden">
                    <button
                      type="button"
                      className={`px-2.5 py-1 ${concessionMode === "percent" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      onClick={() => update("sellerConcessionsMode", "percent")}
                    >
                      Percentage
                    </button>
                    <button
                      type="button"
                      className={`px-2.5 py-1 border-l ${concessionMode === "amount" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      onClick={() => update("sellerConcessionsMode", "amount")}
                    >
                      Dollar Amount
                    </button>
                  </div>
                </div>
                {concessionMode === "percent" ? (
                  <NumRow
                    label="Percent of Price"
                    hint="Seller credits are capped at your closing costs."
                    value={scenario.sellerConcessionsPercent ?? 0}
                    onChange={v => setScenario(prev => ({ ...prev, sellerConcessionsPercent: v, sellerConcessionsSource: "manual" }))}
                    min={0} max={concessionMax} step={0.05} suffix="%" decimals={2}
                  />
                ) : (
                  <NumRow
                    label="Dollar Amount"
                    hint="Seller credits are capped at your closing costs."
                    value={scenario.sellerConcessionsAmount ?? 0}
                    onChange={v => setScenario(prev => ({ ...prev, sellerConcessionsAmount: v, sellerConcessionsSource: "manual" }))}
                    min={0} max={concessionMax} step={50} prefix="$"
                  />
                )}
                {concessionApplied > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    Applied credit: <span className="font-semibold text-foreground">{formatCurrency(concessionApplied)}</span>
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 5. Ongoing Costs */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Ongoing Costs</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <NumRow
                label="Annual Property Taxes"
                testId="cash-buy-property-taxes"
                hint={cashBuyTaxHint(
                  taxLookupStatus,
                  Math.round((scenario.propertyTaxes ?? 0) / 12),
                )}
                value={scenario.propertyTaxes ?? 0}
                onChange={setPropertyTaxes}
                min={0} max={50_000} step={50} prefix="$" suffix="/yr"
                unavailable={!hasPropertyTax}
                slider={false}
                badge={(() => {
                  const label = cashBuyTaxBadge(taxLookupStatus);
                  return label ? (
                    <Badge variant="outline" className="text-[10px] font-normal h-5">
                      {label}
                    </Badge>
                  ) : null;
                })()}
              />
              <NumRow
                label="Annual Homeowners Insurance"
                hint={scenario.homeownersInsuranceSource === "manual"
                  ? "Manually entered. Simulator changes won't overwrite this."
                  : "Synced from the insurance simulator midpoint below."}
                value={scenario.homeownersInsuranceSource === "manual"
                  ? (scenario.homeownersInsurance ?? 0)
                  : insMidpoint}
                onChange={setHomeownersInsurance}
                min={0} max={20_000} step={25} prefix="$" suffix="/yr"
                slider={false}
              />
              <NumRow
                label="HOA / Condo Fees"
                hint={
                  scenario.hoaSource === "zillow"
                    ? "Pulled from Zillow. Editing this will mark it as a manual override."
                    : "Edit to set a manual override."
                }
                value={scenario.hoaMonthly ?? 0}
                onChange={setHoaMonthly}
                min={0} max={2_000} step={5} prefix="$" suffix="/mo"
                slider={false}
                badge={
                  scenario.hoaSource === "zillow" ? (
                    <Badge variant="outline" className="text-[10px] font-normal h-5">From Zillow</Badge>
                  ) : scenario.hoaSource === "manual" ? (
                    <Badge variant="outline" className="text-[10px] font-normal h-5">Manual</Badge>
                  ) : null
                }
              />

              {(floodData?.requiresFloodInsurance || (scenario.annualFloodIns ?? 0) > 0) && (
                <NumRow
                  label="Annual Flood Insurance"
                  hint={`${floodData?.zone
                    ? `Estimated — property is in a FEMA flood zone (Zone ${floodData.zone}).`
                    : "Estimated flood insurance premium."} · ≈ ${formatCurrency(Math.round((scenario.annualFloodIns ?? 0) / 12))}/mo`}
                  value={scenario.annualFloodIns ?? 0}
                  onChange={(v) => update("annualFloodIns", v)}
                  min={0} max={50_000} step={50} prefix="$" suffix="/yr"
                  slider={false}
                />
              )}

              <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground mb-1">
                  Monthly carrying cost{hasPropertyTax ? " (estimate)" : " (incomplete)"}
                </p>
                {ongoingMonthly == null ? (
                  <p className="font-medium text-amber-700">
                    Unavailable — enter annual property taxes manually
                  </p>
                ) : (
                  <p className="tabular-nums">{formatCurrency(ongoingMonthly)}/mo</p>
                )}
                <p className="mt-1 text-[11px]">
                  {hasPropertyTax
                    ? <>Taxes + insurance + HOA
                      {(scenario.annualFloodIns ?? 0) > 0 ? " + flood insurance" : ""} only. No mortgage payment because there is no loan.</>
                    : "Taxes are unavailable, so no complete carrying-cost total is shown."}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* 6. Insurance simulator (same engine as Purchase tab) */}
          <PropertyInsuranceSimulator
            address={scenario.address}
            purchasePrice={price}
            factors={scenario.insuranceFactors as InsuranceFactors | undefined}
            onFactorsChange={handleInsuranceFactors}
            onPremiumChange={handleInsurancePremium}
          />

          {isPlaceholder && (
            <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5" />
              Enter an address from the Cash Buy dashboard to save this scenario.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
