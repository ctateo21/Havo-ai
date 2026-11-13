/**
 * Universal parcel identity resolver for the nine supported Florida counties.
 *
 * Parcel identity is cached separately from annual tax rates because parcel
 * identifiers are durable while millage expires each tax year.
 */
import { supabaseAdmin } from "../supabase";
import { lookupPIN, streetAddressMatches } from "./hillsborough-tax";
import {
  lookupManateeParcel,
  lookupPinellasParcel,
} from "./county-parcel-lookup";

export const SUPPORTED_COUNTY_SLUGS = [
  "hillsborough",
  "pinellas",
  "manatee",
  "pasco",
  "hernando",
  "sarasota",
  "lee",
  "collier",
  "polk",
] as const;

export type CountySlug = (typeof SUPPORTED_COUNTY_SLUGS)[number];

export interface ParcelIdentity {
  status: "found" | "not-found" | "unavailable";
  county: CountySlug;
  parcelId: string | null;
  folio: string | null;
  taxDistrict: string | null;
  situsAddress: string | null;
  situsCity: string | null;
  source: string;
  justValue?: number;
  assessedValue?: number;
  /** Current Collier parcel-layer millage components, when available. */
  countyMillage?: number;
  schoolMillage?: number;
  municipalMillage?: number;
  otherMillage?: number;
  millageArea?: string;
  taxYear?: number;
  reason?: string;
  fromCache?: boolean;
}

type FetchImplementation = typeof fetch;
type Attributes = Record<string, unknown>;

const TIMEOUT_MS = 8_000;
const IDENTITY_CACHE_YEARS = 5;
const SWFWMD_BASE =
  "https://www25.swfwmd.state.fl.us/arcgis12/rest/services/" +
  "BaseVector/parcel_search/MapServer";
const SWFWMD_LAYERS: Partial<Record<CountySlug, number>> = {
  hernando: 5,
  manatee: 10,
  pasco: 12,
  pinellas: 13,
  polk: 14,
  sarasota: 15,
};
const LEE_LAYER =
  "https://services2.arcgis.com/LvWGAAhHwbCJ2GMP/ArcGIS/rest/services/" +
  "Lee_County_Parcels/FeatureServer/0";
const COLLIER_LAYER =
  "https://services2.arcgis.com/SlIq32SqARUHIhSx/ArcGIS/rest/services/" +
  "Parcel/FeatureServer/2";

function normalizeCity(value: string): string {
  return value
    .toUpperCase()
    .replace(/\bFL(?:ORIDA)?\b/g, " ")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function requestedCity(address: string): string {
  return normalizeCity(address.split(",")[1] ?? "");
}

function requestedStreet(address: string): string {
  return (address.split(",")[0] ?? "").trim();
}

const COLLIER_STREET_SUFFIXES = new Set([
  "ALY", "ALLEY", "AVE", "AVENUE", "BLVD", "BOULEVARD", "CIR", "CIRCLE",
  "CT", "COURT", "DR", "DRIVE", "LN", "LANE", "LOOP", "PKWY", "PARKWAY",
  "PL", "PLACE", "RD", "ROAD", "ST", "STREET", "TER", "TERRACE",
  "TRL", "TRAIL", "WAY",
]);

function collierSearchParts(address: string): {
  houseNumber: string | null;
  streetName: string;
} {
  const street = requestedStreet(address)
    .replace(/\s+(?:#|APT(?:ARTMENT)?|UNIT|STE|SUITE)\s*[-A-Z0-9]*.*$/i, "")
    .trim()
    .toUpperCase();
  const tokens = street.split(/\s+/).filter(Boolean);
  const first = tokens.shift() ?? "";
  const houseNumber = /^\d+$/.test(first) ? first : null;
  if (
    tokens.length > 1 &&
    COLLIER_STREET_SUFFIXES.has(tokens[tokens.length - 1]!)
  ) {
    tokens.pop();
  }
  return { houseNumber, streetName: tokens.join(" ") };
}

function collierCandidateStreet(attributes: Attributes): string {
  const streetAddress = String(attributes.SiteStreetAddress ?? "").trim();
  const unit = String(attributes.SiteUnit ?? "").trim();
  // ParcelJoin stores the unit separately for some condos. Add it only when
  // the formatted address does not already contain a unit marker.
  if (
    !unit ||
    /(?:^|\s)(?:#|APT|APARTMENT|UNIT|STE|SUITE)\s*[-A-Z0-9]+/i.test(
      streetAddress,
    )
  ) {
    return streetAddress;
  }
  return `${streetAddress} UNIT ${unit}`;
}

export function normalizeParcelAddress(address: string): string {
  return address
    .trim()
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ");
}

export function isStrictParcelAddressMatch(
  requestedAddress: string,
  candidateStreet: string,
  candidateCity: string,
): boolean {
  const city = requestedCity(requestedAddress);
  return (
    Boolean(city) &&
    streetAddressMatches(requestedAddress, candidateStreet) &&
    normalizeCity(candidateCity) === city
  );
}

function asPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function missing(county: CountySlug, source: string): ParcelIdentity {
  return {
    status: "not-found",
    county,
    parcelId: null,
    folio: null,
    taxDistrict: null,
    situsAddress: null,
    situsCity: null,
    source,
  };
}

function foundFromAttributes(params: {
  county: CountySlug;
  attributes: Attributes;
  parcelIdField: string;
  folioField?: string;
  streetField: string;
  cityField: string;
  source: string;
  taxDistrictField?: string;
  justValueField?: string;
  assessedValueField?: string;
  countyMillageField?: string;
  schoolMillageField?: string;
  municipalMillageField?: string;
  otherMillageField?: string;
  millageAreaField?: string;
  taxYearField?: string;
}): ParcelIdentity | null {
  const value = params.attributes[params.parcelIdField];
  if (value == null || !String(value).trim()) return null;
  return {
    status: "found",
    county: params.county,
    parcelId: String(value).trim(),
    folio: params.folioField &&
      params.attributes[params.folioField] != null
      ? String(params.attributes[params.folioField]).trim() || null
      : null,
    taxDistrict: params.taxDistrictField &&
      params.attributes[params.taxDistrictField] != null
      ? String(params.attributes[params.taxDistrictField]).trim() || null
      : null,
    situsAddress: String(params.attributes[params.streetField] ?? "").trim(),
    situsCity: normalizeCity(
      String(params.attributes[params.cityField] ?? ""),
    ),
    source: params.source,
    ...(params.justValueField &&
    asPositiveNumber(params.attributes[params.justValueField]) != null
      ? {
          justValue: asPositiveNumber(
            params.attributes[params.justValueField],
          ),
        }
      : {}),
    ...(params.assessedValueField &&
    asPositiveNumber(params.attributes[params.assessedValueField]) != null
      ? {
          assessedValue: asPositiveNumber(
            params.attributes[params.assessedValueField],
          ),
        }
      : {}),
    ...(params.countyMillageField &&
    asNonNegativeNumber(params.attributes[params.countyMillageField]) != null
      ? {
          countyMillage: asNonNegativeNumber(
            params.attributes[params.countyMillageField],
          ),
        }
      : {}),
    ...(params.schoolMillageField &&
    asNonNegativeNumber(params.attributes[params.schoolMillageField]) != null
      ? {
          schoolMillage: asNonNegativeNumber(
            params.attributes[params.schoolMillageField],
          ),
        }
      : {}),
    ...(params.municipalMillageField &&
    asNonNegativeNumber(params.attributes[params.municipalMillageField]) != null
      ? {
          municipalMillage: asNonNegativeNumber(
            params.attributes[params.municipalMillageField],
          ),
        }
      : {}),
    ...(params.otherMillageField &&
    asNonNegativeNumber(params.attributes[params.otherMillageField]) != null
      ? {
          otherMillage: asNonNegativeNumber(
            params.attributes[params.otherMillageField],
          ),
        }
      : {}),
    ...(params.millageAreaField &&
    params.attributes[params.millageAreaField] != null
      ? {
          millageArea: String(params.attributes[params.millageAreaField]),
        }
      : {}),
    ...(params.taxYearField &&
    asPositiveNumber(params.attributes[params.taxYearField]) != null
      ? {
          taxYear: Math.round(
            asPositiveNumber(params.attributes[params.taxYearField])!,
          ),
        }
      : {}),
  };
}

async function queryArcGis(params: {
  url: string;
  where: string;
  outFields: string;
  fetchImpl: FetchImplementation;
}): Promise<Attributes[]> {
  const query = new URLSearchParams({
    where: params.where,
    outFields: params.outFields,
    returnGeometry: "false",
    resultRecordCount: "100",
    f: "json",
  });
  const response = await params.fetchImpl(`${params.url}/query?${query}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    features?: Array<{ attributes?: Attributes }>;
  };
  return (data.features ?? [])
    .map((feature) => feature.attributes)
    .filter((value): value is Attributes => Boolean(value));
}

async function lookupSwfwmd(
  county: CountySlug,
  address: string,
  fetchImpl: FetchImplementation,
): Promise<ParcelIdentity> {
  const layer = SWFWMD_LAYERS[county];
  if (layer == null) return missing(county, "swfwmd-parcel-search");
  const street = requestedStreet(address).toUpperCase().replace(/'/g, "''");
  const firstStreetToken = street.split(/\s+/)[0] ?? "";
  const houseNumber = /^\d+[A-Z-]*$/.test(firstStreetToken)
    ? firstStreetToken
    : "";
  // Hernando commonly stores two spaces between the house number and street
  // name. Query by house number so ArcGIS returns those rows, then rely on the
  // strict normalized street/unit/city matcher below to select the parcel.
  const streetPrefix = houseNumber ? `${houseNumber} ` : street;
  const city = requestedCity(address).replace(/'/g, "''");
  const source = `swfwmd-layer-${layer}`;
  try {
    const candidates = await queryArcGis({
      url: `${SWFWMD_BASE}/${layer}`,
      where: `SITEADD LIKE '${streetPrefix}%' AND SCITY='${city}'`,
      outFields:
        "PARNO,SITEADD,SCITY,SZIP,PARVAL,ASSD_TOT,JV_HMSTD," +
        "TAX_AUTH_CD,ALTKEY,PIN",
      fetchImpl,
    });
    const attributes = candidates.find((candidate) =>
      isStrictParcelAddressMatch(
        address,
        String(candidate.SITEADD ?? ""),
        String(candidate.SCITY ?? ""),
      ),
    );
    if (!attributes) return missing(county, source);

    const parcelIdField = county === "hernando" ? "ALTKEY" : "PARNO";
    return (
      foundFromAttributes({
        county,
        attributes,
        parcelIdField,
        folioField: "PARNO",
        streetField: "SITEADD",
        cityField: "SCITY",
        taxDistrictField: "TAX_AUTH_CD",
        justValueField: "PARVAL",
        assessedValueField: "ASSD_TOT",
        source,
      }) ?? missing(county, source)
    );
  } catch (error: any) {
    console.error(`[parcel] ${county} SWFWMD lookup failed:`, error?.message);
    return missing(county, source);
  }
}

async function lookupLee(
  address: string,
  fetchImpl: FetchImplementation,
): Promise<ParcelIdentity> {
  const county: CountySlug = "lee";
  const source = "lee-county-parcels";
  const street = requestedStreet(address).toUpperCase().replace(/'/g, "''");
  const firstStreetToken = street.split(/\s+/)[0] ?? "";
  const houseNumber = /^\d+[A-Z-]*$/.test(firstStreetToken)
    ? firstStreetToken
    : "";
  const streetPrefix = houseNumber || street;
  const city = requestedCity(address).replace(/'/g, "''");
  try {
    const candidates = await queryArcGis({
      url: LEE_LAYER,
      where: `SITEADDR LIKE '${streetPrefix}%' AND SITECITY='${city}'`,
      outFields:
        "STRAP,FOLIOID,SITEADDR,SITECITY,SITEZIP,JUST,ASSESSED," +
        "TAXABLE,HSTDAMOUNT,TAXINGDIST,TAXDISTDES",
      fetchImpl,
    });
    const attributes = candidates.find((candidate) =>
      isStrictParcelAddressMatch(
        address,
        String(candidate.SITEADDR ?? ""),
        String(candidate.SITECITY ?? ""),
      ),
    );
    return attributes
      ? foundFromAttributes({
          county,
          attributes,
          parcelIdField: "STRAP",
          folioField: "FOLIOID",
          streetField: "SITEADDR",
          cityField: "SITECITY",
          taxDistrictField: "TAXINGDIST",
          justValueField: "JUST",
          assessedValueField: "ASSESSED",
          source,
        }) ?? missing(county, source)
      : missing(county, source);
  } catch (error: any) {
    console.error("[parcel] Lee lookup failed:", error?.message);
    return missing(county, source);
  }
}

async function lookupCollier(
  address: string,
  fetchImpl: FetchImplementation,
): Promise<ParcelIdentity> {
  const county: CountySlug = "collier";
  const source = "collier-pa-arcgis-parcel";
  const { houseNumber, streetName } = collierSearchParts(address);
  const city = requestedCity(address).replace(/'/g, "''");
  const escapedStreetName = streetName.replace(/'/g, "''");
  try {
    const candidates = await queryArcGis({
      url: COLLIER_LAYER,
      where:
        `SiteStreetAddress LIKE '${houseNumber ? houseNumber+" " : ""}${escapedStreetName}%' AND SiteCity='${city}'`,
      outFields:
        "ParcelId,Folio,SiteStreetAddress,SiteCity,SiteZipCode",
      fetchImpl,
    });
    const matches = candidates.filter((candidate) =>
      isStrictParcelAddressMatch(
        address,
        collierCandidateStreet(candidate),
        String(candidate.SiteCity ?? ""),
      ),
    );
    const attributes=matches.length===1?matches[0]:undefined;
    return attributes
      ? foundFromAttributes({
          county,
          attributes,
          parcelIdField: "Folio",
          folioField: "Folio",
          streetField: "SiteStreetAddress",
          cityField: "SiteCity",
          source,
          taxDistrictField: "MillageArea",
          justValueField: "TotalJustValue",
          assessedValueField: "CountyAssessedValue",
          countyMillageField: "CountyMillage",
          schoolMillageField: "SchoolMillage",
          municipalMillageField: "MunicipalMillage",
          otherMillageField: "OtherMillage",
          millageAreaField: "MillageArea",
          taxYearField: "TaxYear",
        }) ?? missing(county, source)
      : missing(county, source);
  } catch (error: any) {
    console.error("[parcel] Collier lookup failed:", error?.message);
    return missing(county, source);
  }
}

async function readIdentityCache(
  county: CountySlug,
  address: string,
  now: Date,
): Promise<ParcelIdentity | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("parcel_identity_cache")
      .select("*")
      .eq("county", county)
      .eq("address_normalized", normalizeParcelAddress(address))
      .maybeSingle();
    if (error || !data) return null;
    const expiresAt = new Date(String(data.expires_at ?? ""));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) return null;
    const parcelId = String(data.parcel_id ?? "").trim();
    if (!parcelId) return null;
    return {
      status: "found",
      county,
      parcelId,
      folio: data.folio ? String(data.folio) : null,
      taxDistrict: data.tax_district ? String(data.tax_district) : null,
      situsAddress: data.situs_address ? String(data.situs_address) : null,
      situsCity: data.situs_city ? String(data.situs_city) : null,
      source: String(data.source ?? "parcel-identity-cache"),
      justValue: asPositiveNumber(data.just_value),
      assessedValue: asPositiveNumber(data.assessed_value),
      fromCache: true,
    };
  } catch {
    return null;
  }
}

export async function writeIdentityCache(
  address: string,
  identity: ParcelIdentity,
  now: Date,
): Promise<void> {
  if (!supabaseAdmin || identity.status !== "found" || !identity.parcelId) {
    return;
  }
  const expiresAt = new Date(now);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + IDENTITY_CACHE_YEARS);
  const { error } = await supabaseAdmin.from("parcel_identity_cache").upsert(
    {
      county: identity.county,
      address_normalized: normalizeParcelAddress(address),
      address_display: address.trim(),
      parcel_id: identity.parcelId,
      folio: identity.folio,
      tax_district: identity.taxDistrict,
      situs_address: identity.situsAddress,
      situs_city: identity.situsCity,
      just_value: identity.justValue ?? null,
      assessed_value: identity.assessedValue ?? null,
      source: identity.source,
      queried_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    },
    { onConflict: "county,address_normalized" },
  );
  if (error) console.error("[parcel] identity cache write failed:", error.message);
}

export interface ParcelResolverOptions {
  fetchImpl?: FetchImplementation;
  now?: Date;
  skipCache?: boolean;
  adapters?: Partial<
    Record<CountySlug, (address: string) => Promise<ParcelIdentity>>
  >;
}

export async function resolveParcel(
  county: CountySlug,
  address: string,
  options?: ParcelResolverOptions,
): Promise<ParcelIdentity>;
/** Backward-compatible address-only form for callers with an unambiguous ZIP. */
export async function resolveParcel(
  address: string,
  options?: ParcelResolverOptions,
): Promise<ParcelIdentity | null>;
export async function resolveParcel(
  countyOrAddress: CountySlug | string,
  addressOrOptions?: string | ParcelResolverOptions,
  maybeOptions: ParcelResolverOptions = {},
): Promise<ParcelIdentity | null> {
  const explicitCounty = SUPPORTED_COUNTY_SLUGS.includes(
    countyOrAddress as CountySlug,
  )
    ? (countyOrAddress as CountySlug)
    : null;
  const address = explicitCounty
    ? String(addressOrOptions ?? "")
    : countyOrAddress;
  const options = explicitCounty
    ? maybeOptions
    : ((addressOrOptions as ParcelResolverOptions | undefined) ?? {});
  const county = explicitCounty ?? identifyCountyFromAddress(address);
  if (!county) return null;

  const now = options.now ?? new Date();
  // Browser-verified Collier identity is reusable; rates live separately in
  // the annual official cache, never in a generic identity-derived fallback.
  if (!options.skipCache) {
    const cached = await readIdentityCache(county, address, now);
    if (cached && (county!=="collier" || ["collier-official-estimator-page","collier-pa-arcgis-parcel"].includes(cached.source))) return cached;
  }

  let identity: ParcelIdentity;
  if (options.adapters?.[county]) {
    identity = await options.adapters[county]!(address);
  } else if (county === "hillsborough") {
    const found = await lookupPIN(address, options.fetchImpl ?? fetch);
    identity = found
      ? {
          status: "found",
          county,
          parcelId: found.pin,
          folio: found.folio,
          taxDistrict: null,
          situsAddress: requestedStreet(address),
          situsCity: requestedCity(address),
          source: "hcpa-api",
        }
      : missing(county, "hcpa-api");
  } else if (county === "pinellas") {
    const found = await lookupPinellasParcel(address);
    identity = found
      ? {
          status: "found",
          county,
          parcelId: found.account,
          folio: found.account,
          taxDistrict: found.taxDistrict??null,
          situsAddress: found.situsAddress,
          situsCity: normalizeCity(found.situsCity),
          source: "pinellas-pa-arcgis",
          ...(found.justValue ? { justValue: found.justValue } : {}),
        }
      : missing(county, "pinellas-pa-arcgis");
  } else if (county === "manatee") {
    const found = await lookupManateeParcel(address);
    identity = found
      ? {
          status: "found",
          county,
          parcelId: found.parid,
          folio: found.parid,
          taxDistrict: null,
          situsAddress: found.situsAddress,
          situsCity: normalizeCity(found.situsCity),
          source: "manatee-pa-arcgis",
          ...(found.justValue > 0 ? { justValue: found.justValue } : {}),
        }
      : await lookupSwfwmd(county, address, options.fetchImpl ?? fetch);
  } else if (county === "lee") {
    identity = await lookupLee(address, options.fetchImpl ?? fetch);
  } else if (county === "collier") {
    identity = await lookupCollier(address, options.fetchImpl ?? fetch);
  } else {
    identity = await lookupSwfwmd(county, address, options.fetchImpl ?? fetch);
  }

  if (!options.skipCache) {
    await writeIdentityCache(address, identity, now);
  }
  return identity;
}

/**
 * Only used by address-only refinance requests. Ambiguous boundary ZIPs return
 * null; their county candidates are tried by the current-bill service.
 */
export function identifyCountyFromAddress(address: string): CountySlug | null {
  const candidates = identifyCountyCandidatesFromAddress(address);
  return candidates.length === 1 ? candidates[0] : null;
}

const COUNTY_ZIP_PATTERNS: Array<[CountySlug, RegExp]> = [
  ["hillsborough", /^(?:336\d{2}|335\d{2})$/],
  ["pinellas", /^(?:337\d{2}|346(?:77|81|83|84|85|88|89|90|95|98))$/],
  ["manatee", /^342(?:0[1-9]|1\d|2[128]|40|43|51|66)$/],
  ["pasco", /^(?:335(?:23|25|40|41|42|43|44|45|48|49|56|58|59|76|97)|33849|346(?:04|10|37|38|39|52|53|54|55|67|68|69|90|91))$/],
  ["hernando", /^(?:33523|33597|346(?:01|02|04|06|07|08|09|13|14|61))$/],
  ["sarasota", /^(?:339(?:53|66)|342(?:23|24|28|29|3\d|40|41|42|43|51|66|75|84|85|86|87|88|89|91|92|93))$/],
  ["lee", /^(?:339\d{2}|341(?:10|19|34|35))$/],
  ["collier", /^341(?:02|03|04|05|08|09|10|12|13|14|16|17|19|20|34|37|38|39|40|41|42|45)$/],
  ["polk", /^(?:338\d{2}|335(?:25|47|97)|347(?:11|14|39|58|59))$/],
];

export function identifyCountyCandidatesFromAddress(
  address: string,
): CountySlug[] {
  const zipMatches = Array.from(
    address.matchAll(/\b(\d{5})(?:-\d{4})?\b/g),
  );
  const zip = zipMatches.at(-1)?.[1];
  if (!zip) return [];
  return COUNTY_ZIP_PATTERNS
    .filter(([, pattern]) => pattern.test(zip))
    .map(([county]) => county);
}