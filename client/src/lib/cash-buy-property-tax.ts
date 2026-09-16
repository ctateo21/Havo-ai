import {
  buildPropertyTaxRoutePlan,
} from "./property-tax-routing";

export type CashBuyTaxLookupStatus =
  | "idle"
  | "loading"
  | "verified"
  | "fallback"
  | "manual";

export interface CashBuyTaxRequest {
  address: string;
  purchasePrice: number;
  occupancy: "primary" | "secondary" | "investment";
}

export interface CashBuyTaxLookupState {
  status: CashBuyTaxLookupStatus;
  request?: CashBuyTaxRequest;
  annualTax?: number;
  source?: string;
  taxDistrict?: string;
  parcelId?: string;
  nonAdValoremTax?: number;
  nonAdValoremPending?: boolean;
  millageRate?: number;
  operationalError?: string;
}

interface PurchaseTaxApiResponse {
  annualTax?: unknown;
  source?: unknown;
  taxDistrict?: unknown;
  parcelId?: unknown;
  nonAdValoremTax?: unknown;
  nonAdValoremPending?: unknown;
  millageRate?: unknown;
  operationalError?: unknown;
  useFallback?: unknown;
}

export type CashBuyTaxFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

// Automatic values must come from the official purchase estimator. Parcel
// millage and current-owner bill sources belong to separate products.
/**
 * Official purchase-estimator output is the only accepted automatic value.
 * Unavailable and formula responses intentionally remain unavailable rather
 * than becoming a generic purchase estimate.
 */
/**
 * Only official purchase-estimator outputs are accepted. Parcel millage and
 * current-owner bill sources belong to separate products.
 */
export function isParcelVerifiedTaxSource(source: string | undefined): boolean {
  if (!source) return false;
  return source === "county-estimator" || source === "hcpa-api";
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function responseState(
  request: CashBuyTaxRequest,
  data: PurchaseTaxApiResponse,
): CashBuyTaxLookupState | null {
  const annualTax = asPositiveNumber(data.annualTax);
  if (!annualTax) return null;
  const source = typeof data.source === "string" ? data.source : undefined;
  const parcelId = typeof data.parcelId === "string" ? data.parcelId : undefined;
  const millageRate = asPositiveNumber(data.millageRate);
  return {
    status: isParcelVerifiedTaxSource(source)
      ? "verified"
      : "fallback",
    request,
    annualTax,
    source,
    taxDistrict: typeof data.taxDistrict === "string" ? data.taxDistrict : undefined,
    parcelId,
    nonAdValoremTax: asNumber(data.nonAdValoremTax),
    nonAdValoremPending: data.nonAdValoremPending === true,
    millageRate,
    operationalError:
      typeof data.operationalError === "string"
        ? data.operationalError
        : undefined,
  };
}

/**
 * Look up a Cash Buy purchase estimate through the official county routes.
 * Unavailable or formula responses return `fallback` without an annualTax;
 * the official-only UI leaves the field blank for manual entry.
 */
export async function lookupCashBuyPropertyTax(
  request: CashBuyTaxRequest,
  fetcher: CashBuyTaxFetch = fetch,
): Promise<CashBuyTaxLookupState> {
  const routes = buildPropertyTaxRoutePlan(request.address);
  if (!routes.length) return { status: "fallback", request };

  for (const route of routes) {
    const body: Record<string, unknown> = {
      address: request.address,
      purchasePrice: request.purchasePrice,
      isPrimaryResidence: request.occupancy === "primary",
    };
    if (route.kind === "county") body.county = route.county;

    try {
      const response = await fetcher(route.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) continue;
      const data = await response.json() as PurchaseTaxApiResponse;
      const result = responseState(request, data);
      if (result) return result;
    } catch {
      // A failed strict route can be followed by the next route for shared
      // boundary ZIPs. If all routes fail, the caller leaves taxes unavailable.
    }
  }

  return { status: "fallback", request };
}

export function sameCashBuyTaxRequest(
  a: CashBuyTaxRequest | undefined,
  b: CashBuyTaxRequest,
): boolean {
  return !!a &&
    a.address.trim().toLowerCase() === b.address.trim().toLowerCase() &&
    a.purchasePrice === b.purchasePrice &&
    a.occupancy === b.occupancy;
}

export function canApplyCashBuyTaxResult(
  current: CashBuyTaxRequest,
  request: CashBuyTaxRequest,
  propertyTaxesSource: string | undefined,
): boolean {
  return propertyTaxesSource !== "manual" &&
    sameCashBuyTaxRequest(current, request);
}

export function cashBuyTaxHint(
  status: CashBuyTaxLookupStatus,
  monthlyTax: number,
): string {
  const monthly = `≈ $${Math.round(monthlyTax).toLocaleString("en-US")}/mo`;
  if (status === "manual") {
    return `Manually entered. Editing price or property use won't overwrite this. · ${monthly}`;
  }
  if (status === "loading") {
    return `Looking up the official county purchase estimator. No formula estimate is shown until verification completes. · ${monthly}`;
  }
  if (status === "verified") {
    return `Official county purchase-estimator result. · ${monthly}`;
  }
  return "Official county purchase estimator unavailable — enter the annual bill manually. No formula estimate is shown.";
}

export function cashBuyTaxBadge(
  status: CashBuyTaxLookupStatus,
): string | null {
  if (status === "verified") return "Official estimate";
  if (status === "fallback" || status === "idle") return "Official unavailable";
  if (status === "loading") return "Looking up parcel";
  if (status === "manual") return "Manual";
  return null;
}