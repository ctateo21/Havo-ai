/**
 * Authoritative current-owner annual property-tax bill lookup.
 *
 * This service is intentionally address-only and never receives or uses a
 * purchase price. Eight Tyler TaxSys counties share the same bill path. Polk
 * uses the Phenix collector (polk.floridatax.us). The eight Tyler counties
 * require APIFY_TOKEN in production; Cloudflare blocks a plain fetch, and
 * a missing token is returned as live-bill-service-not-configured rather
 * than a zero bill.
 */
import { supabaseAdmin } from "../supabase";
import { nextTaxRefreshBoundary } from "./property-tax-cache";
import {
  identifyCountyCandidatesFromAddress,
  resolveParcel,
  type CountySlug,
  type ParcelIdentity,
} from "./parcel-resolver";
import {
  getNonAdValoremForFolio,
  type NonAdValoremLookup,
} from "./tax-bill-scraper";
import { getPolkPhenixTaxBill } from "./polk-phenix-tax";
import type { OfficialTaxBreakdown } from "../../shared/official-tax";

export type CurrentTaxBillResponse =
  | {
      state: "ready";
      annualTax: number;
      monthlyTax: number;
      taxYear: number;
      adValoremTax?: number;
      nonAdValoremTax?: number;
      source: "tax-collector-bill-scrape" | "user-provided";
      sourceLabel?: string;
      county: string;
      parcelId: string;
      breakdown?: OfficialTaxBreakdown;
    }
  | {
      state: "pending";
      county: string;
      source: "tax-collector-bill-scrape";
    }
  | {
      state: "unavailable";
      manualEntryRequired: true;
      county?: string;
      reason: string;
      operationalError?: string;
      breakdown?: OfficialTaxBreakdown;
    };

interface CurrentBillRow {
  county: string;
  parcelId: string;
  taxYear: number;
  annualTaxCents: number;
  adValoremTaxCents: number | null;
  nonAdValoremTaxCents: number | null;
  source: "tax-collector-bill-scrape-situs-v2" | "user-provided";
  expiresAt: Date;
}

function normalizeAddress(address: string): string {
  return address.trim().toUpperCase().replace(/\s+/g, " ");
}

async function readCurrentBillCache(
  county: CountySlug,
  parcelId: string,
  now: Date,
): Promise<CurrentBillRow | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("current_tax_bills")
      .select("*")
      .eq("county", county)
      .eq("parcel_id", parcelId)
      .maybeSingle();
    if (error || !data) return null;
    const expiresAt = new Date(String(data.expires_at ?? ""));
    const source = String(data.source ?? "");
    const row: CurrentBillRow = {
      county,
      parcelId: String(data.parcel_id ?? ""),
      taxYear: Number(data.tax_year ?? 0),
      annualTaxCents: Number(data.annual_tax_cents ?? 0),
      adValoremTaxCents:
        data.ad_valorem_tax_cents == null
          ? null
          : Number(data.ad_valorem_tax_cents),
      nonAdValoremTaxCents:
        data.non_ad_valorem_tax_cents == null
          ? null
          : Number(data.non_ad_valorem_tax_cents),
      source: source as CurrentBillRow["source"],
      expiresAt,
    };
    if (
      expiresAt <= now ||
      !Number.isFinite(expiresAt.getTime()) ||
      !row.parcelId ||
      !Number.isInteger(row.taxYear) ||
      row.taxYear < 2000 ||
      !Number.isInteger(row.annualTaxCents) ||
      row.annualTaxCents <= 0 ||
      ![
        "tax-collector-bill-scrape-situs-v2",
        "user-provided",
      ].includes(row.source)
    ) {
      return null;
    }
    return row;
  } catch (error: any) {
    console.error("[current-bill] cache read failed:", error?.message);
    return null;
  }
}

async function writeCurrentBillCache(params: {
  county: CountySlug;
  parcelId: string;
  address: string;
  taxYear: number;
  annualTaxCents: number;
  adValoremTaxCents: number | null;
  nonAdValoremTaxCents: number | null;
  now: Date;
}): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from("current_tax_bills").upsert(
      {
        county: params.county,
        parcel_id: params.parcelId,
        address_normalized: normalizeAddress(params.address),
        address_display: params.address.trim(),
        tax_year: params.taxYear,
        annual_tax_cents: params.annualTaxCents,
        ad_valorem_tax_cents: params.adValoremTaxCents,
        non_ad_valorem_tax_cents: params.nonAdValoremTaxCents,
        source: "tax-collector-bill-scrape-situs-v2",
        queried_at: params.now.toISOString(),
        expires_at: nextTaxRefreshBoundary(params.now).toISOString(),
      },
      { onConflict: "county,parcel_id" },
    );
    if (error) {
      console.error("[current-bill] cache write failed:", error.message);
    }
  } catch (error: any) {
    console.error("[current-bill] cache write failed:", error?.message);
  }
}

function readyFromCache(row: CurrentBillRow): CurrentTaxBillResponse {
  const annualTax = row.annualTaxCents / 100;
  return {
    state: "ready",
    annualTax,
    monthlyTax: Math.round((annualTax / 12) * 100) / 100,
    taxYear: row.taxYear,
    adValoremTax:
      row.adValoremTaxCents == null
        ? undefined
        : row.adValoremTaxCents / 100,
    nonAdValoremTax:
      row.nonAdValoremTaxCents == null
        ? undefined
        : row.nonAdValoremTaxCents / 100,
    source: row.source === "user-provided"
      ? "user-provided"
      : "tax-collector-bill-scrape",
    sourceLabel: row.source === "user-provided"
      ? "Entered manually"
      : `${row.county} Tax Collector annual bill, tax year ${row.taxYear} (ad valorem + non-ad valorem, including CDD).`,
    county: row.county,
    parcelId: row.parcelId,
  };
}

async function resolveVerifiedIdentity(
  address: string,
  resolveParcelFn: typeof resolveParcel = resolveParcel,
): Promise<ParcelIdentity | null> {
  const candidates = identifyCountyCandidatesFromAddress(address);
  for (const county of candidates) {
    try {
      const identity = await resolveParcelFn(county, address);
      if (identity.status === "found" && identity.parcelId) return identity;
    } catch (error: any) {
      console.error(
        `[current-bill] ${county} parcel lookup failed:`,
        error?.message,
      );
    }
  }
  return null;
}

export interface CurrentTaxBillOptions {
  resolveParcelFn?: typeof resolveParcel;
  getBillFn?: (
    parcelId: string,
    county: CountySlug,
    taxYear?: number,
    options?: {
      requireAdValoremTotal?: boolean;
      expectedSitus?: {
        county: string;
        situsAddress: string;
        situsCity: string;
      };
    },
  ) => Promise<NonAdValoremLookup>;
  skipCache?: boolean;
}

export async function resolveCurrentTaxBill(
  address: string,
  now: Date = new Date(),
  options: CurrentTaxBillOptions = {},
): Promise<CurrentTaxBillResponse> {
  const candidates = identifyCountyCandidatesFromAddress(address);
  if (!candidates.length) {
    return {
      state: "unavailable",
      manualEntryRequired: true,
      reason: "county-not-supported",
    };
  }

  const identity = await resolveVerifiedIdentity(
    address,
    options.resolveParcelFn,
  );
  if (!identity?.parcelId) {
    return {
      state: "unavailable",
      manualEntryRequired: true,
      county: candidates.length === 1 ? candidates[0] : undefined,
      reason: "parcel-not-found",
    };
  }
  const { county, parcelId } = identity;
  if (!options.resolveParcelFn && !options.getBillFn) {
    const { officialParcelTax } = await import("./official-tax-pipeline");
    const { currentBillYear } = await import("./official-tax-cache");
    const collectorParcel = ["hillsborough","hernando"].includes(county) ? identity.folio : parcelId;
    if (!collectorParcel) return {state:"unavailable",manualEntryRequired:true,county,reason:"Collector parcel identifier missing"};
    const breakdown = await officialParcelTax({county,parcelId:collectorParcel,address,purchasePrice:0,homestead:false,taxYear:currentBillYear(now)},true);
    if (breakdown.total.cents === null) return {state:"unavailable",manualEntryRequired:true,county,reason:breakdown.total.reason || "Current official bill unavailable",breakdown};
    return {state:"ready",county,parcelId:collectorParcel,taxYear:currentBillYear(now),
      annualTax:breakdown.total.cents/100,monthlyTax:Math.round(breakdown.total.cents/12)/100,
      adValoremTax:breakdown.adValorem.cents!/100,nonAdValoremTax:breakdown.nonAdValorem.cents!/100,
      source:"tax-collector-bill-scrape",sourceLabel:breakdown.total.source?.name,breakdown};
  }

  if (!options.skipCache) {
    const cached = await readCurrentBillCache(county, parcelId, now);
    if (cached) return readyFromCache(cached);
  }

  const expectedSitus = {
    county: county.charAt(0).toUpperCase() + county.slice(1),
    situsAddress: identity.situsAddress ?? address.split(",")[0] ?? "",
    situsCity: identity.situsCity ?? address.split(",")[1] ?? "",
  };
  const getBillFn = options.getBillFn;
  const bill = getBillFn
    ? await getBillFn(parcelId, county, undefined, {
        requireAdValoremTotal: true,
        expectedSitus,
      })
    : county === "polk"
      ? await getPolkPhenixTaxBill(parcelId, expectedSitus)
      : await getNonAdValoremForFolio(parcelId, county, undefined, {
          requireAdValoremTotal: true,
          expectedSitus,
        });
  if (bill.state === "pending") {
    return {
      state: "pending",
      county,
      source: "tax-collector-bill-scrape",
    };
  }
  if (bill.state === "unavailable") {
    const missingToken = bill.reason === "apify_token_missing";
    return {
      state: "unavailable",
      manualEntryRequired: true,
      county,
      reason: missingToken
        ? "live-bill-service-not-configured"
        : "bill-scrape-unavailable",
      operationalError: missingToken
        ? "Live property-tax bills require APIFY_TOKEN in this environment."
        : undefined,
    };
  }

  const adValoremTaxCents =
    bill.data.totalAdValorem == null
      ? null
      : Math.round(bill.data.totalAdValorem * 100);
  if (adValoremTaxCents == null) {
    return {
      state: "unavailable",
      manualEntryRequired: true,
      county,
      reason: "ad-valorem-dollar-total-not-in-bill",
    };
  }

  const nonAdValoremTaxCents = Math.round(bill.data.total * 100);
  const annualTaxCents =
    adValoremTaxCents + nonAdValoremTaxCents;
  const taxYear =
    bill.data.billYear ?? Math.max(2000, now.getUTCFullYear() - 1);
  if (!options.skipCache) {
    await writeCurrentBillCache({
      county,
      parcelId,
      address,
      taxYear,
      annualTaxCents,
      adValoremTaxCents,
      nonAdValoremTaxCents,
      now,
    });
  }

  const annualTax = annualTaxCents / 100;
  return {
    state: "ready",
    annualTax,
    monthlyTax: Math.round((annualTax / 12) * 100) / 100,
    taxYear,
    adValoremTax: adValoremTaxCents / 100,
    nonAdValoremTax: nonAdValoremTaxCents / 100,
    source: "tax-collector-bill-scrape",
    sourceLabel:
      `${county} Tax Collector annual bill, tax year ${taxYear} ` +
      `(ad valorem $${(adValoremTaxCents / 100).toFixed(2)} + non-ad valorem ` +
      `$${(nonAdValoremTaxCents / 100).toFixed(2)}, including CDD).` +
      (county === "polk"
        ? ""
        : " Tyler counties require APIFY_TOKEN in production."),
    county,
    parcelId,
  };
}