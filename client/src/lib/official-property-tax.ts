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
    }
  | {
      status: "unavailable";
      reason?: string;
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

type TaxResponse = Record<string, unknown>;

function asRecord(value: unknown): TaxResponse | null {
  return value !== null && typeof value === "object"
    ? value as TaxResponse
    : null;
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
