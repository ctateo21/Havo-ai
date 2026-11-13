import { parseOfficialTaxBreakdown } from "./official-property-tax";
import type { OfficialTaxBreakdown } from "@shared/official-tax";

export type QuickTaxStatus = "estimate" | "area_estimate" | "rough_estimate" | "official" | "unavailable";
export interface QuickPropertyTax {
  key: string;
  status: QuickTaxStatus;
  annualTax: number | null;
  monthlyTax: number | null;
  adValorem: number | null;
  nav: number | null;
  navPending: boolean;
  taxYear: number | null;
  ratesYear: number | null;
  district: string | null;
  sourceName: string;
  sourceUrl: string | null;
  label: string;
  reason?: string;
  breakdown?: OfficialTaxBreakdown;
  officialState: "pending" | "complete" | "failed";
  parcelId?: string;
  purchasePrice?: number;
  homestead?: boolean;
  fetchedAt?: string;
}
export function safeTaxUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return ["https:", "http:"].includes(new URL(value).protocol) ? value : null; } catch { return null; }
}
const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Estimates are deliberately not normalized through the official-only parser. */
export function parseQuickPropertyTax(value: unknown): QuickPropertyTax {
  if (!value || typeof value !== "object") throw new Error("Invalid property-tax response.");
  const row = value as Record<string, unknown>;
  if (typeof row.key !== "string" || !row.key ||
      !["estimate", "area_estimate", "rough_estimate", "official", "unavailable"].includes(String(row.status)) ||
      !["pending", "complete", "failed"].includes(String(row.officialState))) {
    throw new Error("Invalid property-tax response. No rates were substituted.");
  }
  const breakdown = parseOfficialTaxBreakdown(row.breakdown);
  const annualTax = row.status === "unavailable" ? null : amount(row.annualTax);
  // An official label alone is not sufficient for an auditable complete bill.
  const verified = row.status === "official" && row.officialState === "complete" &&
    annualTax !== null && breakdown?.total.cents != null &&
    !!breakdown.adValorem.source && !!breakdown.nonAdValorem.source &&
    Math.abs(breakdown.total.cents / 100 - annualTax) < 0.005;
  return {
    key: row.key,
    status: row.status === "official" && !verified ? (annualTax === null ? "unavailable" : "estimate") : row.status as QuickTaxStatus,
    annualTax, monthlyTax: annualTax === null ? null : annualTax / 12,
    adValorem: amount(row.adValorem), nav: amount(row.nav),
    navPending: row.navPending === true,
    taxYear: Number.isInteger(row.taxYear) ? row.taxYear as number : null,
    ratesYear: Number.isInteger(row.ratesYear) ? row.ratesYear as number : null,
    district: typeof row.district === "string" ? row.district : null,
    sourceName: typeof row.sourceName === "string" ? row.sourceName : "Source not supplied",
    sourceUrl: safeTaxUrl(row.sourceUrl),
    label: typeof row.label === "string" ? row.label : "Property tax estimate",
    reason: typeof row.reason === "string" ? row.reason : undefined,
    breakdown, officialState: row.officialState as QuickPropertyTax["officialState"],
    ...(typeof row.parcelId === "string" ? {parcelId:row.parcelId} : {}),
    ...(amount(row.purchasePrice) !== null ? {purchasePrice:row.purchasePrice as number} : {}),
    ...(typeof row.homestead === "boolean" ? {homestead:row.homestead} : {}),
    ...(typeof row.fetchedAt === "string" && Number.isFinite(Date.parse(row.fetchedAt)) ? {fetchedAt:row.fetchedAt} : {}),
  };
}

/** A failed official job must not erase the usable quick estimate. */
export function mergeQuickPropertyTax(previous: QuickPropertyTax, next: QuickPropertyTax): QuickPropertyTax {
  if (previous.key !== next.key) return previous;
  if (next.annualTax === null && previous.annualTax !== null) {
    return { ...previous, officialState: next.officialState, reason: next.reason };
  }
  return next;
}
