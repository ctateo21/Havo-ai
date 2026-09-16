/**
 * Client-side guard for purchase property-tax responses.
 *
 * A purchase estimate may only display a number when the server identifies a
 * result from the approved official county-estimator adapter, or a clearly
 * labelled formula estimate from a county that has not been verified yet.
 * Parcel-cache, bill-scrape, and millage estimates are not a tax value that
 * can be presented to a borrower. Keep this check in one small,
 * dependency-free helper so every purchase surface applies the same rule.
 */

export type PropertyTaxProvenance = "official" | "estimated";

export type OfficialPropertyTaxResolution =
  | {
      status: "available";
      annualTax: number;
      source: string;
      /** Stable UI/storage provenance; formula fallbacks are not official. */
      provenance?: PropertyTaxProvenance;
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
 * A resolved response is only current when the amount written into the
 * purchase inputs still matches that response. The tuple guard in the
 * purchase page uses this in addition to address/price/occupancy matching so
 * a changed official amount or formula estimate cannot briefly leave stale
 * annual taxes marked complete before the sync effect runs.
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
 * `${county}-county-estimator` label is official. Formula fallback is
 * accepted only when the server explicitly identifies it as unverified and
 * names one of the supported counties. Explicit bill, situs, and parcel
 * labels are rejected even if annualTax happens to be greater than zero.
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

function formulaCounty(source: string, data: TaxResponse): string | null {
  const normalized = source.trim().toLowerCase();
  const sourceMatch = /^([a-z-]+)-formula(?:-fallback)?(?:-.+)?$/.exec(normalized);
  const responseCountyRaw =
    typeof data.county === "string"
      ? data.county
      : typeof data.countyName === "string"
        ? data.countyName
        : "";
  const responseCounty = responseCountyRaw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+county$/, "");
  const sourceCounty = sourceMatch?.[1];
  if (sourceCounty && responseCounty && sourceCounty !== responseCounty) {
    return null;
  }
  const county = sourceCounty ?? responseCounty;
  return OFFICIAL_COUNTIES.has(county) ? county : null;
}

function isUnverifiedFormulaSource(
  source: string,
  data: TaxResponse,
): boolean {
  // Do not infer an unverified response from a missing flag. This keeps an
  // unexpected/legacy fallback payload unavailable until the server sends the
  // explicit per-county gate result.
  if (data.estimatorVerified !== false) return false;
  const normalized = source.trim().toLowerCase();
  const hasFormulaLabel =
    normalized === "formula" ||
    normalized.includes("formula-fallback") ||
    normalized.endsWith("-formula");
  return hasFormulaLabel && formulaCounty(source, data) !== null;
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
 * `useFallback` response, an explicit `status: "unavailable"`, an
 * unrecognized formula source, or a missing source is never converted into a
 * numeric zero. A gated formula fallback is returned as a numeric estimate so
 * purchase calculations can continue without presenting it as official.
 */
export function parseOfficialPropertyTaxResponse(
  value: unknown,
): OfficialPropertyTaxResolution {
  const data = asRecord(value);
  if (!data) return unavailable();

  const status = typeof data.status === "string"
    ? data.status.trim().toLowerCase()
    : "";
  const source = typeof data.source === "string" ? data.source : "";
  const estimated = isUnverifiedFormulaSource(source, data);
  if (
    ((status === "unavailable" || status === "error") && !estimated) ||
    (data.useFallback === true && !estimated) ||
    (data.official === false && !estimated)
  ) {
    return unavailable(data);
  }

  if (data.annualTax == null) {
    return unavailable(data);
  }
  const annualTax = data.annualTax;
  if (
    typeof annualTax !== "number" ||
    !Number.isFinite(annualTax) ||
    annualTax < 0 ||
    (!isOfficialSource(source) && !estimated) ||
    (data.official === false && !estimated)
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
    ...(estimated ? { provenance: "estimated" as const } : {}),
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
