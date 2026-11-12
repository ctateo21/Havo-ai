import type { OfficialTaxBreakdown, TaxPart, TaxSource } from "@shared/official-tax";

/**
 * Client-side guard for purchase property-tax responses.
 *
 * A purchase estimate may only display a number when the server identifies a
 * result from the approved official county-estimator adapter. Formula,
 * parcel-cache, bill-scrape, and millage estimates are not a tax value that
 * can be presented to a borrower. Keep this check in one small,
 * dependency-free helper so every purchase surface applies the same rule.
 */

export type OfficialPropertyTaxResolution =
  | {
      status: "available";
      annualTax: number;
      source: string;
      municipality?: string;
      millageRate?: number;
      nonAdValoremTax: number;
      nonAdValoremPending: boolean;
      operationalError?: string;
      breakdown?: OfficialTaxBreakdown;
    }
  | {
      status: "unavailable";
      reason?: string;
      breakdown?: OfficialTaxBreakdown;
    };

/**
 * An official response is only current when the amount written into the
 * purchase inputs still matches that response. The tuple guard in the
 * purchase page uses this in addition to address/price/occupancy matching so
 * a changed official amount cannot briefly leave stale annual taxes marked
 * complete before the sync effect runs.
 */
export function hasMatchingOfficialAnnualTax(
  officialAnnualTax: unknown,
  currentAnnualTax: unknown,
): boolean {
  return (
    typeof officialAnnualTax === "number" &&
    Number.isFinite(officialAnnualTax) &&
    officialAnnualTax >= 0 &&
    typeof currentAnnualTax === "number" &&
    Number.isFinite(currentAnnualTax) &&
    currentAnnualTax >= 0 &&
    currentAnnualTax === officialAnnualTax
  );
}

/** Include scenario identity as well as every provider input so responses
 * cannot cross tabs or survive price/address/homestead edits.
 */
export function officialTaxRequestKey(
  scenarioId: string,
  address: string,
  purchasePrice: number,
  homestead: boolean,
): string {
  return JSON.stringify([scenarioId, address, purchasePrice, homestead]);
}

/** A manual bill is independent of background requests. Official amounts
 * require the current request AND the complete, matching cents total.
 */
export function resolvePurchasePropertyTaxSource(
  annualTax: number,
  recordedSource: string | undefined,
  currentKey: string,
  resolved: { key: string; breakdown?: OfficialTaxBreakdown } | null,
): "manual" | "official" | "unavailable" {
  if (!Number.isFinite(annualTax) || annualTax < 0) return "unavailable";
  if (recordedSource === "manual") return "manual";
  if (recordedSource !== "official" || resolved?.key !== currentKey ||
      resolved.breakdown?.total.cents == null) return "unavailable";
  return hasMatchingOfficialAnnualTax(resolved.breakdown.total.cents / 100, annualTax)
    ? "official" : "unavailable";
}

type TaxResponse = Record<string, unknown>;

function asRecord(value: unknown): TaxResponse | null {
  return value !== null && typeof value === "object"
    ? value as TaxResponse
    : null;
}

function validCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSource(value: unknown): TaxSource | undefined {
  const source = asRecord(value);
  if (!source || typeof source.name !== "string" || typeof source.url !== "string" ||
      typeof source.fetchedAt !== "string" || !Number.isFinite(Date.parse(source.fetchedAt)) ||
      !Number.isInteger(source.taxYear) || typeof source.parcelId !== "string") return undefined;
  try {
    if (!["http:", "https:"].includes(new URL(source.url).protocol)) return undefined;
  } catch { return undefined; }
  return {
    name: source.name, url: source.url, fetchedAt: source.fetchedAt,
    taxYear: source.taxYear as number, parcelId: source.parcelId,
    ...(typeof source.purchasePrice === "number" && Number.isFinite(source.purchasePrice)
      ? { purchasePrice: source.purchasePrice } : {}),
    ...(typeof source.homestead === "boolean" ? { homestead: source.homestead } : {}),
  };
}

/** Validate the cents contract without coercing missing values to zero.
 * The total must agree with BOTH components; a legacy annualTax cannot fill a gap.
 */
export function parseOfficialTaxBreakdown(value: unknown): OfficialTaxBreakdown | undefined {
  const data = asRecord(value);
  if (!data) return undefined;
  const part = (value: unknown): TaxPart => {
    const data = asRecord(value);
    const source = parseSource(data?.source);
    const cents = validCents(data?.cents) ? data.cents : null;
    return {
      cents,
      ...(cents === null ? { reason: typeof data?.reason === "string" && data.reason.trim()
        ? data.reason : "Official tax component missing" } : {}),
      ...(source ? { source } : {}),
      ...(Array.isArray(data?.lines) ? {
        lines: data.lines.flatMap((line: unknown) => {
          const row = asRecord(line);
          return row && typeof row.name === "string" && validCents(row.amount)
            ? [{ name: row.name, amount: row.amount }] : [];
        }),
      } : {}),
    };
  };
  const adValorem = part(data.adValorem);
  const nonAdValorem = part(data.nonAdValorem);
  const total = part(data.total);
  if (adValorem.cents === null || nonAdValorem.cents === null) {
    total.cents = null;
    total.reason = [adValorem.cents === null && adValorem.reason,
      nonAdValorem.cents === null && nonAdValorem.reason].filter(Boolean).join("; ");
  } else if (!validCents(adValorem.cents + nonAdValorem.cents) ||
      total.cents !== adValorem.cents + nonAdValorem.cents) {
    total.cents = null;
    total.reason ||= "Official total missing or does not match its components";
  }
  return {
    adValorem, nonAdValorem, total,
    warnings: Array.isArray(data.warnings)
      ? data.warnings.filter((warning): warning is string => typeof warning === "string") : [],
  };
}

/**
 * Only the exact approved `county-estimator` label or a supported
 * `${county}-county-estimator` label is official. Explicit formula/fallback,
 * bill, situs, and parcel labels are rejected even if annualTax happens to be
 * greater than zero.
 */
const OFFICIAL_COUNTIES = new Set([
  "hillsborough",
  "pinellas",
  "manatee",
  "pasco",
  "hernando",
  "sarasota",
  "lee",
  "collier",
  "polk",
]);

function isOfficialSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  if (normalized === "county-estimator") return true;
  const match = /^([a-z-]+)-county-estimator$/.exec(normalized);
  return match !== null && OFFICIAL_COUNTIES.has(match[1]);
}

function unavailableReason(data: TaxResponse): string | undefined {
  for (const key of ["reason", "error", "message", "operationalError"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function unavailable(data?: TaxResponse): OfficialPropertyTaxResolution {
  const reason = data ? unavailableReason(data) : undefined;
  const breakdown = parseOfficialTaxBreakdown(data?.breakdown);
  if (breakdown) return { status: "unavailable", reason: reason ?? breakdown.total.reason, breakdown };
  return reason
    ? { status: "unavailable", reason }
    : { status: "unavailable" };
}

/**
 * Normalize the current and next server contracts.  In particular, a
 * `useFallback` response, an explicit `status: "unavailable"`, a formula
 * source, or a missing source is never converted into a numeric zero.
 */
export function parseOfficialPropertyTaxResponse(
  value: unknown,
): OfficialPropertyTaxResolution {
  const data = asRecord(value);
  if (!data) return unavailable();

  const status = typeof data.status === "string"
    ? data.status.trim().toLowerCase()
    : "";
  if (
    status === "unavailable" ||
    status === "error" ||
    data.useFallback === true ||
    data.official === false
  ) {
    return unavailable(data);
  }

  const source = typeof data.source === "string" ? data.source : "";
  const breakdown = parseOfficialTaxBreakdown(data.breakdown);
  if (breakdown) {
    if (breakdown.total.cents === null) return unavailable(data);
    return {
      status: "available",
      annualTax: breakdown.total.cents / 100,
      source,
      nonAdValoremTax: breakdown.nonAdValorem.cents! / 100,
      nonAdValoremPending: data.nonAdValoremPending === true,
      breakdown,
    };
  }
  if (data.annualTax == null) {
    return unavailable(data);
  }
  const annualTax = data.annualTax;
  if (
    typeof annualTax !== "number" ||
    !Number.isFinite(annualTax) ||
    annualTax < 0 ||
    !isOfficialSource(source) ||
    data.official === false
  ) {
    return unavailable(data);
  }

  const nonAdValoremTax = typeof data.nonAdValoremTax === "number"
    ? data.nonAdValoremTax
    : Number(data.nonAdValoremTax ?? 0);
  const millageRate = typeof data.millageRate === "number"
    ? data.millageRate
    : Number(data.millageRate);

  return {
    status: "available",
    annualTax,
    source,
    municipality:
      typeof data.taxDistrict === "string" ? data.taxDistrict :
      typeof data.municipality === "string" ? data.municipality :
      undefined,
    millageRate: Number.isFinite(millageRate) ? millageRate : undefined,
    nonAdValoremTax:
      Number.isFinite(nonAdValoremTax) && nonAdValoremTax >= 0
        ? nonAdValoremTax
        : 0,
    nonAdValoremPending: data.nonAdValoremPending === true,
    operationalError:
      typeof data.operationalError === "string"
        ? data.operationalError
        : undefined,
  };
}
