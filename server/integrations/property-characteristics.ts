import { supabaseAdmin } from "../supabase";
import { geocodeAddress } from "./geocode";
import {lookupDorBuilding,lookupHcpaBuilding,type FieldEvidence,type RoofPermit} from "./insurance-building-sources";
import {
  normalizeParcelAddress,
  resolveParcel,
  type CountySlug,
  type ParcelIdentity,
} from "./parcel-resolver";

type FetchImplementation = typeof fetch;
type Attributes = Record<string, unknown>;

const TIMEOUT_MS = 8_000;
const FEMA_LAYER =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";
const GSHHS_COASTLINE_LAYER =
  "https://services7.arcgis.com/WSiUmUhlFx4CtMBB/arcgis/rest/services/GSHHS_GlobalCoastlines_HighResolution/FeatureServer/0";
const MANATEE_LAYER =
  "https://gis.manateepao.com/arcgis/rest/services/Website/WebLayers/MapServer/0";
const LEE_LAYER =
  "https://services2.arcgis.com/LvWGAAhHwbCJ2GMP/ArcGIS/rest/services/Lee_County_Parcels/FeatureServer/0";
const SWFWMD_BASE =
  "https://www25.swfwmd.state.fl.us/arcgis12/rest/services/BaseVector/parcel_search/MapServer";
const SWFWMD_LAYERS: Partial<Record<CountySlug, number>> = {
  hernando: 5,
  pasco: 12,
  polk: 14,
  sarasota: 15,
};

export interface PropertyCharacteristics {
  fieldSources?: Record<string,FieldEvidence>;
  roofPermits?: RoofPermit[];
  addressNormalized: string;
  addressDisplay: string;
  county: CountySlug;
  parcelId: string | null;
  latitude: number | null;
  longitude: number | null;
  floodZone: string | null;
  floodZoneSubtype: string | null;
  staticBfe: number | null;
  sfha: boolean | null;
  yearBuilt: number | null;
  yearBuiltEffective: number | null;
  squareFeetLiving: number | null;
  squareFeetTotal: number | null;
  stories: number | null;
  livingUnits: number | null;
  buildingCount: number | null;
  hasPool: boolean | null;
  exteriorWallCode: string | null;
  exteriorWallLabel: string | null;
  constructionCode: string | null;
  constructionLabel: string | null;
  buildingDataSource: string;
  floodDataSource: string | null;
  designWindSpeed?: number | null;
  windborneDebrisRegion?: boolean | null;
  milesToCoast?: number | null;
  windDataSource?: string | null;
  coastDataSource?: string | null;
  queriedAt: Date;
  expiresAt: Date;
  fromCache?: boolean;
  errors?: string[];
}

type BuildingValues = Pick<
  PropertyCharacteristics,
  | "yearBuilt"
  | "yearBuiltEffective"
  | "squareFeetLiving"
  | "squareFeetTotal"
  | "stories"
  | "livingUnits"
  | "buildingCount"
  | "hasPool"
  | "exteriorWallCode"
  | "exteriorWallLabel"
  | "constructionCode"
  | "constructionLabel"
>;

export interface PropertyCharacteristicsCache {
  read(
    addressNormalized: string,
    now: Date,
    includeExpired?: boolean,
  ): Promise<PropertyCharacteristics | null>;
  write(profile: PropertyCharacteristics): Promise<void>;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed != null && parsed > 0 ? Math.round(parsed) : null;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result ? result : null;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

async function arcGisQuery(
  url: string,
  where: string,
  outFields: string,
  fetchImpl: FetchImplementation,
): Promise<Attributes[]> {
  const query = new URLSearchParams({
    where,
    outFields,
    returnGeometry: "false",
    f: "json",
  });
  const response = await fetchImpl(`${url}/query?${query}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`ArcGIS request failed (${response.status})`);
  }
  const json = (await response.json()) as {
    error?: { message?: string };
    features?: Array<{ attributes?: Attributes }>;
  };
  if (json.error) {
    throw new Error(json.error.message ?? "ArcGIS returned an error");
  }
  return (json.features ?? [])
    .map((feature) => feature.attributes)
    .filter((value): value is Attributes => Boolean(value));
}

function emptyBuilding(): BuildingValues {
  return {
    yearBuilt: null,
    yearBuiltEffective: null,
    squareFeetLiving: null,
    squareFeetTotal: null,
    stories: null,
    livingUnits: null,
    buildingCount: null,
    hasPool: null,
    exteriorWallCode: null,
    exteriorWallLabel: null,
    constructionCode: null,
    constructionLabel: null,
  };
}

async function manateeDomains(
  fetchImpl: FetchImplementation,
): Promise<Map<string, Map<string, string>>> {
  const response = await fetchImpl(`${MANATEE_LAYER}?f=json`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return new Map();
  const json = (await response.json()) as {
    fields?: Array<{
      name?: string;
      domain?: { codedValues?: Array<{ code?: unknown; name?: unknown }> };
    }>;
  };
  const result = new Map<string, Map<string, string>>();
  for (const field of json.fields ?? []) {
    if (!field.name || !field.domain?.codedValues) continue;
    result.set(
      field.name,
      new Map(
        field.domain.codedValues
          .filter((item) => item.code != null && text(item.name))
          .map((item) => [String(item.code), String(item.name).trim()]),
      ),
    );
  }
  return result;
}

async function lookupBuilding(
  county: CountySlug,
  identity: ParcelIdentity,
  fetchImpl: FetchImplementation,
): Promise<{ values: BuildingValues; source: string }> {
  if (county === "hillsborough" || county === "collier") {
    return { values: emptyBuilding(), source: "no-county-source" };
  }
  if (identity.status !== "found" || !identity.parcelId) {
    return { values: emptyBuilding(), source: `${county}-parcel-not-found` };
  }

  if (county === "manatee") {
    const fields = [
      "BLDG_R1_YRBUILT", "BLDG_R1_EFFYR", "BLDG_R1_SQFTLIVNG",
      "BLDG_R1_STORIES", "BLDG_R1_EXTWALL", "BLDG_R1_CONST",
      "PAR_SWIMPOOL_FLAG", "BLDGS_LIVINGUNITS",
    ].join(",");
    const [attributes, domains] = await Promise.all([
      arcGisQuery(
        MANATEE_LAYER,
        `PARID='${escapeSql(identity.parcelId)}'`,
        fields,
        fetchImpl,
      ).then((rows) => rows[0]),
      manateeDomains(fetchImpl),
    ]);
    if (!attributes) {
      return { values: emptyBuilding(), source: "manatee-pa-arcgis" };
    }
    const wallCode = text(attributes.BLDG_R1_EXTWALL);
    const constructionCode = text(attributes.BLDG_R1_CONST);
    const poolCode = text(attributes.PAR_SWIMPOOL_FLAG)?.toUpperCase();
    return {
      values: {
        ...emptyBuilding(),
        yearBuilt: positiveInteger(attributes.BLDG_R1_YRBUILT),
        yearBuiltEffective: positiveInteger(attributes.BLDG_R1_EFFYR),
        squareFeetLiving: positiveInteger(attributes.BLDG_R1_SQFTLIVNG),
        stories: finiteNumber(attributes.BLDG_R1_STORIES),
        livingUnits: positiveInteger(attributes.BLDGS_LIVINGUNITS),
        hasPool: poolCode === "Y" ? true : poolCode === "N" ? false : null,
        exteriorWallCode: wallCode,
        exteriorWallLabel: wallCode
          ? domains.get("BLDG_R1_EXTWALL")?.get(wallCode) ?? null
          : null,
        constructionCode,
        constructionLabel: constructionCode
          ? domains.get("BLDG_R1_CONST")?.get(constructionCode) ?? null
          : null,
      },
      source: "manatee-pa-arcgis",
    };
  }

  if (county === "pinellas") return {values:emptyBuilding(),source:"Unavailable"};

  if (county === "lee") {
    const attributes = (
      await arcGisQuery(
        LEE_LAYER,
        `STRAP='${escapeSql(identity.parcelId)}'`,
        "MINBUILTY,MAXBUILTY,HEATEDAREA,TOTALAREA,MAXSTORIES,POOL,SEAWALL,BLDGCOUNT",
        fetchImpl,
      )
    )[0];
    const pool = text(attributes?.POOL);
    return {
      values: {
        ...emptyBuilding(),
        yearBuilt: positiveInteger(attributes?.MINBUILTY),
        squareFeetLiving: positiveInteger(attributes?.HEATEDAREA),
        squareFeetTotal: positiveInteger(attributes?.TOTALAREA),
        stories: finiteNumber(attributes?.MAXSTORIES),
        buildingCount: positiveInteger(attributes?.BLDGCOUNT),
        hasPool: pool == null ? false : !/^(?:N|NO|NONE|0)$/i.test(pool),
      },
      source: "lee-county-parcels",
    };
  }

  const layer = SWFWMD_LAYERS[county];
  if (layer == null) {
    return { values: emptyBuilding(), source: "no-county-source" };
  }
  const keyField = county === "hernando" ? "ALTKEY" : "PARNO";
  const key = county === "hernando"
    ? identity.parcelId
    : identity.folio || identity.parcelId;
  const attributes = (
    await arcGisQuery(
      `${SWFWMD_BASE}/${layer}`,
      `${keyField}='${escapeSql(key)}'`,
      "YRBLT_ACT,YRBLT_EFF,TOT_LVG_AREA,NO_BULDNG",
      fetchImpl,
    )
  )[0];
  return {
    values: {
      ...emptyBuilding(),
      yearBuilt: positiveInteger(attributes?.YRBLT_ACT),
      yearBuiltEffective: positiveInteger(attributes?.YRBLT_EFF),
      squareFeetLiving: positiveInteger(attributes?.TOT_LVG_AREA),
      buildingCount: positiveInteger(attributes?.NO_BULDNG),
    },
    source: `swfwmd-layer-${layer}`,
  };
}

export async function lookupFemaNfhl(
  latitude: number,
  longitude: number,
  fetchImpl: FetchImplementation = fetch,
): Promise<{
  floodZone: string | null;
  floodZoneSubtype: string | null;
  staticBfe: number | null;
  sfha: boolean | null;
  source: "fema-nfhl-layer-28";
  dfirmId: string | null;
}> {
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180
  ) {
    throw new Error("Invalid coordinates for FEMA NFHL lookup");
  }
  const query = new URLSearchParams({
    geometry: `${longitude},${latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "FLD_ZONE,ZONE_SUBTY,STATIC_BFE,SFHA_TF,DFIRM_ID",
    returnGeometry: "false",
    f: "json",
  });
  const response = await fetchImpl(`${FEMA_LAYER}/query?${query}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; TateoApp/1.0)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`FEMA NFHL request failed (${response.status})`);
  }
  const json = (await response.json()) as {
    error?: { message?: string };
    features?: Array<{ attributes?: Attributes }>;
  };
  if (json.error) throw new Error(json.error.message ?? "FEMA NFHL error");
  const attributes = json.features?.[0]?.attributes;
  const rawZone = text(attributes?.FLD_ZONE)?.toUpperCase() ?? null;
  const floodZone =
    rawZone && /^[A-Z0-9][A-Z0-9 .-]{0,31}$/.test(rawZone) ? rawZone : null;
  const sfhaCode = text(attributes?.SFHA_TF)?.toUpperCase();
  return {
    floodZone,
    floodZoneSubtype: text(attributes?.ZONE_SUBTY)?.toUpperCase() ?? null,
    staticBfe: finiteNumber(attributes?.STATIC_BFE) != null && Number(attributes?.STATIC_BFE) > -9000 ? Number(attributes?.STATIC_BFE) : null,
    dfirmId: text(attributes?.DFIRM_ID),
    sfha: sfhaCode === "T" ? true : sfhaCode === "F" ? false : null,
    source: "fema-nfhl-layer-28",
  };
}

type ArcGisGeometry = { paths?: number[][][]; rings?: number[][][] };

function pointToSegmentMiles(
  latitude: number,
  longitude: number,
  start: number[],
  end: number[],
): number {
  const milesPerLonDegree = 69.172 * Math.cos(latitude * Math.PI / 180);
  const ax = (start[0] - longitude) * milesPerLonDegree;
  const ay = (start[1] - latitude) * 69.0;
  const bx = (end[0] - longitude) * milesPerLonDegree;
  const by = (end[1] - latitude) * 69.0;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function closestPointOnGeometry(
  latitude: number,
  longitude: number,
  geometry: ArcGisGeometry,
): { latitude: number; longitude: number; distanceMiles: number } | null {
  const milesPerLonDegree = 69.172 * Math.cos(latitude * Math.PI / 180);
  let closest: { latitude: number; longitude: number; distanceMiles: number } | null = null;
  for (const path of geometry.paths ?? geometry.rings ?? []) {
    for (let index = 1; index < path.length; index += 1) {
      const start = path[index - 1];
      const end = path[index];
      const ax = (start[0] - longitude) * milesPerLonDegree;
      const ay = (start[1] - latitude) * 69.0;
      const bx = (end[0] - longitude) * milesPerLonDegree;
      const by = (end[1] - latitude) * 69.0;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
      const distanceMiles = Math.hypot(ax + t * dx, ay + t * dy);
      if (!closest || distanceMiles < closest.distanceMiles) {
        closest = {
          longitude: start[0] + (end[0] - start[0]) * t,
          latitude: start[1] + (end[1] - start[1]) * t,
          distanceMiles,
        };
      }
    }
  }
  return closest;
}

async function queryNearbyGeometry(
  layer: string,
  latitude: number,
  longitude: number,
  fetchImpl: FetchImplementation,
  params: Record<string, string>,
): Promise<Array<{ attributes: Attributes; geometry: ArcGisGeometry }>> {
  const query = new URLSearchParams({
    where: "1=1",
    geometry: `${longitude},${latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    ...params,
  });
  const response = await fetchImpl(`${layer}/query?${query}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ArcGIS geography request failed (${response.status})`);
  const json = await response.json() as {
    error?: { message?: string };
    features?: Array<{ attributes?: Attributes; geometry?: ArcGisGeometry }>;
  };
  if (json.error) throw new Error(json.error.message ?? "ArcGIS geography error");
  return (json.features ?? [])
    .filter((feature) => feature.attributes && feature.geometry)
    .map((feature) => ({
      attributes: feature.attributes!,
      geometry: feature.geometry!,
    }));
}

/**
 * Straight-line distance to the nearest GSHHS level-1 ocean/land shoreline.
 * This is an approximate ocean-shoreline proxy, not a surveyed legal mean
 * high-water line. Inland lakes and non-ocean water boundaries are excluded.
 */
export async function lookupMilesToCoast(
  latitude: number,
  longitude: number,
  fetchImpl: FetchImplementation = fetch,
): Promise<{
  milesToCoast: number | null;
  source: "noaa-gshhs-level-1-ocean-shoreline-proxy";
}> {
  const features = await queryNearbyGeometry(
    GSHHS_COASTLINE_LAYER,
    latitude,
    longitude,
    fetchImpl,
    {
      where: "level_ = 1",
      outFields: "OBJECTID,level_",
      maxAllowableOffset: "0.001",
      geometryPrecision: "5",
    },
  );
  const nearest = features
    .map((feature) => closestPointOnGeometry(latitude, longitude, feature.geometry))
    .filter((point): point is NonNullable<typeof point> => point != null)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)[0];
  return {
    milesToCoast: nearest?.distanceMiles ?? null,
    ...(nearest
      ? { coastLatitude: nearest.latitude, coastLongitude: nearest.longitude }
      : {}),
    source: "noaa-gshhs-level-1-ocean-shoreline-proxy",
  } as {
    milesToCoast: number | null;
    coastLatitude?: number;
    coastLongitude?: number;
    source: "noaa-gshhs-level-1-ocean-shoreline-proxy";
  };
}

async function geocode(
  address: string,
  fetchImpl: FetchImplementation,
): Promise<{ latitude: number; longitude: number }> {
  const result=await geocodeAddress(address,{fetchImpl});
  if(!result)throw new Error("Unavailable — address could not be verified");
  return {latitude:result.lat,longitude:result.lng};
}

function rowFromSupabase(row: Record<string, unknown>): PropertyCharacteristics {
  return {
    fieldSources: (row.field_sources??{}) as Record<string,FieldEvidence>,
    roofPermits: (row.roof_permits??[]) as RoofPermit[],
    addressNormalized: String(row.address_normalized ?? ""),
    addressDisplay: String(row.address_display ?? ""),
    county: String(row.county ?? "") as CountySlug,
    parcelId: text(row.parcel_id),
    latitude: finiteNumber(row.latitude),
    longitude: finiteNumber(row.longitude),
    floodZone: text(row.flood_zone),
    floodZoneSubtype: text(row.flood_zone_subtype),
    staticBfe: finiteNumber(row.static_bfe),
    sfha: typeof row.sfha === "boolean" ? row.sfha : null,
    yearBuilt: positiveInteger(row.year_built),
    yearBuiltEffective: positiveInteger(row.year_built_effective),
    squareFeetLiving: positiveInteger(row.square_feet_living),
    squareFeetTotal: positiveInteger(row.square_feet_total),
    stories: finiteNumber(row.stories),
    livingUnits: positiveInteger(row.living_units),
    buildingCount: positiveInteger(row.building_count),
    hasPool: typeof row.has_pool === "boolean" ? row.has_pool : null,
    exteriorWallCode: text(row.exterior_wall_code),
    exteriorWallLabel: text(row.exterior_wall_label),
    constructionCode: text(row.construction_code),
    constructionLabel: text(row.construction_label),
    buildingDataSource: String(row.building_data_source ?? ""),
    floodDataSource: text(row.flood_data_source),
    designWindSpeed: positiveInteger(row.design_wind_speed),
    windborneDebrisRegion:
      typeof row.windborne_debris_region === "boolean"
        ? row.windborne_debris_region
        : null,
    milesToCoast: finiteNumber(row.miles_to_coast),
    windDataSource: text(row.wind_data_source),
    coastDataSource: text(row.coast_data_source),
    queriedAt: new Date(String(row.queried_at ?? "")),
    expiresAt: new Date(String(row.expires_at ?? "")),
  };
}

export const propertyCharacteristicsCache: PropertyCharacteristicsCache = {
  async read(addressNormalized, now, includeExpired = false) {
    if (!supabaseAdmin) return null;
    try {
      const { data, error } = await supabaseAdmin
        .from("property_characteristics_cache")
        .select("*")
        .eq("address_normalized", addressNormalized)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const profile = rowFromSupabase(data as Record<string, unknown>);
      if (
        !includeExpired &&
        (!Number.isFinite(profile.expiresAt.getTime()) || profile.expiresAt <= now)
      ) return null;
      return profile;
    } catch (error: any) {
      console.error("[property-characteristics] cache read failed:", error?.message);
      return null;
    }
  },
  async write(profile) {
    if (!supabaseAdmin) return;
    const row = {
      field_sources: profile.fieldSources??{},
      roof_permits: profile.roofPermits??[],
      address_normalized: profile.addressNormalized,
      address_display: profile.addressDisplay,
      county: profile.county,
      parcel_id: profile.parcelId,
      latitude: profile.latitude,
      longitude: profile.longitude,
      flood_zone: profile.floodZone,
      flood_zone_subtype: profile.floodZoneSubtype,
      static_bfe: profile.staticBfe,
      sfha: profile.sfha,
      year_built: profile.yearBuilt,
      year_built_effective: profile.yearBuiltEffective,
      square_feet_living: profile.squareFeetLiving,
      square_feet_total: profile.squareFeetTotal,
      stories: profile.stories,
      living_units: profile.livingUnits,
      building_count: profile.buildingCount,
      has_pool: profile.hasPool,
      exterior_wall_code: profile.exteriorWallCode,
      exterior_wall_label: profile.exteriorWallLabel,
      construction_code: profile.constructionCode,
      construction_label: profile.constructionLabel,
      building_data_source: profile.buildingDataSource,
      flood_data_source: profile.floodDataSource,
      design_wind_speed: profile.designWindSpeed ?? null,
      windborne_debris_region: profile.windborneDebrisRegion ?? null,
      miles_to_coast: profile.milesToCoast ?? null,
      wind_data_source: profile.windDataSource ?? null,
      coast_data_source: profile.coastDataSource ?? null,
      queried_at: profile.queriedAt.toISOString(),
      expires_at: profile.expiresAt.toISOString(),
    };
    try {
      const { error } = await supabaseAdmin
        .from("property_characteristics_cache")
        .upsert(row, { onConflict: "address_normalized" });
      if (error) throw error;
    } catch (error: any) {
      console.error("[property-characteristics] cache write failed:", error?.message);
    }
  },
};

function isConfirmedSource(source: string | null | undefined): boolean {
  return Boolean(source && /(?:manual|confirmed)/i.test(source));
}

/** Preserve confirmed/manual categories when automated data is refreshed. */
export function mergeConfirmedCharacteristics(
  automated: PropertyCharacteristics,
  existing: PropertyCharacteristics | null,
): PropertyCharacteristics {
  if (!existing) return automated;
  let result = automated;
  if (isConfirmedSource(existing.buildingDataSource)) {
    result = {
      ...result,
      ...Object.fromEntries(
        Object.keys(emptyBuilding()).map((key) => [
          key,
          existing[key as keyof BuildingValues],
        ]),
      ) as BuildingValues,
      buildingDataSource: existing.buildingDataSource,
    };
  }
  if (isConfirmedSource(existing.floodDataSource)) {
    result = {
      ...result,
      floodZone: existing.floodZone,
      floodZoneSubtype: existing.floodZoneSubtype,
      staticBfe: existing.staticBfe,
      sfha: existing.sfha,
      floodDataSource: existing.floodDataSource,
    };
  }
  if (isConfirmedSource(existing.windDataSource)) {
    result = {
      ...result,
      designWindSpeed: existing.designWindSpeed ?? null,
      windborneDebrisRegion: existing.windborneDebrisRegion ?? null,
      windDataSource: existing.windDataSource ?? null,
    };
  }
  for(const [field,proof] of Object.entries(existing.fieldSources??{})){
    if(isConfirmedSource(proof.source)&&field in result){
      (result as any)[field]=proof.value;
      result.fieldSources={...result.fieldSources,[field]:proof};
    }
  }
  return result;
}

export interface ResolvePropertyCharacteristicsOptions {
  now?: Date;
  fetchImpl?: FetchImplementation;
  skipCache?: boolean;
  coordinates?: { latitude: number; longitude: number };
  cache?: PropertyCharacteristicsCache;
  resolveParcelImpl?: (
    county: CountySlug,
    address: string,
  ) => Promise<ParcelIdentity>;
}

/** Deliberately excludes coordinates, parcel identifiers, and cache timings. */
export function toPublicPropertyCharacteristics(profile: PropertyCharacteristics) {
  return {
    fieldSources:profile.fieldSources??{},
    roofPermits:profile.roofPermits??[],
    queriedAt:profile.queriedAt.toISOString(),
    county: profile.county,
    floodZone: profile.floodZone,
    floodZoneSubtype: profile.floodZoneSubtype,
    staticBfe: profile.staticBfe,
    sfha: profile.sfha,
    yearBuilt: profile.yearBuilt,
    yearBuiltEffective: profile.yearBuiltEffective,
    squareFeetLiving: profile.squareFeetLiving,
    squareFeetTotal: profile.squareFeetTotal,
    stories: profile.stories,
    livingUnits: profile.livingUnits,
    buildingCount: profile.buildingCount,
    hasPool: profile.hasPool,
    exteriorWallLabel: profile.exteriorWallLabel,
    constructionLabel: profile.constructionLabel,
    buildingDataSource: profile.buildingDataSource,
    floodDataSource: profile.floodDataSource,
    designWindSpeed: profile.designWindSpeed ?? null,
    windborneDebrisRegion: profile.windborneDebrisRegion ?? null,
    milesToCoast: profile.milesToCoast ?? null,
    windDataSource: profile.windDataSource ?? null,
    coastDataSource: profile.coastDataSource ?? null,
    fromCache: Boolean(profile.fromCache),
  };
}

/** Only explicit, provider-domain labels are mapped to existing form choices. */
export function constructionIndexFromCharacteristics(
  constructionLabel: string | null,
): 0 | 1 | 2 | null {
  const label = constructionLabel?.trim().toUpperCase() ?? "";
  if (["CONCRETE BLOCK", "CONCRETE", "MASONRY"].includes(label)) return 0;
  if (["FRAME", "WOOD FRAME", "WOOD"].includes(label)) return 2;
  if (["MIXED", "MIXED MASONRY / FRAME"].includes(label)) return 1;
  return null;
}

export function resolveQuoteRushCharacteristicValues(
  request: {
    floodZone: string;
    sqFt: number;
    yearBuilt?: number;
    constIdx: number;
    propertyCharacteristicLocks?: {
      floodZone?: boolean;
      yearBuilt?: boolean;
      squareFeet?: boolean;
      construction?: boolean;
    };
  },
  profile: Pick<
    PropertyCharacteristics,
    "floodZone" | "squareFeetLiving" | "yearBuilt" | "constructionLabel"
  > | null,
) {
  const locks = request.propertyCharacteristicLocks;
  const legacyExplicit = !locks;
  const requestFloodIsKnown =
    Boolean(request.floodZone && request.floodZone !== "UNKNOWN");
  return {
    floodZone:
      locks?.floodZone || (legacyExplicit && requestFloodIsKnown)
        ? request.floodZone
        : profile?.floodZone || request.floodZone || "",
    sqFt:
      locks?.squareFeet || (legacyExplicit && request.sqFt > 0)
        ? request.sqFt
        : profile?.squareFeetLiving ?? request.sqFt,
    yearBuilt:
      locks?.yearBuilt || (legacyExplicit && request.yearBuilt != null)
        ? request.yearBuilt
        : profile?.yearBuilt ?? request.yearBuilt,
    constIdx:
      locks?.construction || legacyExplicit
        ? request.constIdx
        : constructionIndexFromCharacteristics(profile?.constructionLabel ?? null) ??
          request.constIdx,
  };
}

export async function resolvePropertyCharacteristics(
  county: CountySlug,
  address: string,
  options: ResolvePropertyCharacteristicsOptions = {},
): Promise<PropertyCharacteristics> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = options.cache ?? propertyCharacteristicsCache;
  const addressNormalized = normalizeParcelAddress(address);
  if (!addressNormalized) throw new Error("A property address is required");

  if (!options.skipCache) {
    const cached = await cache.read(addressNormalized, now);
    if (
      cached &&
      cached.fieldSources && Object.keys(cached.fieldSources).length
    ) return { ...cached, fromCache: true };
  }

  const existing = await cache.read(addressNormalized, now, true);
  const identity = options.resolveParcelImpl
    ? await options.resolveParcelImpl(county, address)
    : ["pinellas","collier","hillsborough"].includes(county)
      ? {status:"not-found",parcelId:null} as unknown as ParcelIdentity
      : await resolveParcel(county, address, { fetchImpl });
  const errors: string[] = [];
  let coordinates = options.coordinates;
  if (!coordinates) {
    try {
      coordinates = await geocode(address, fetchImpl);
    } catch (error: any) {
      errors.push(error?.message ?? "Geocoding failed");
    }
  }

  let flood: Awaited<ReturnType<typeof lookupFemaNfhl>> | null = null;
  let coast: Awaited<ReturnType<typeof lookupMilesToCoast>> | null = null;
  if (coordinates) {
    const [floodResult, coastResult] = await Promise.allSettled([
      lookupFemaNfhl(coordinates.latitude, coordinates.longitude, fetchImpl),
      lookupMilesToCoast(coordinates.latitude, coordinates.longitude, fetchImpl),
    ]);
    if (floodResult.status === "fulfilled") flood = floodResult.value;
    else errors.push(floodResult.reason?.message ?? "FEMA NFHL lookup failed");
    if (coastResult.status === "fulfilled") coast = coastResult.value;
  }

  let building = {
    values: emptyBuilding(),
    source: county === "hillsborough" || county === "collier"
      ? "no-county-source"
      : `${county}-county-source-unavailable`,
  };
  try {
    building = await lookupBuilding(county, identity, fetchImpl);
  } catch (error: any) {
    errors.push(error?.message ?? `${county} building lookup failed`);
  }
  let fieldSources:Record<string,FieldEvidence>={};
  let roofPermits:RoofPermit[]=[];
  // Existing county fields retain their own provenance; DOR fills holes only.
  for(const [key,value] of Object.entries(building.values))if(value!=null)fieldSources[key]={
    value,source:building.source,sourceUrl:county==="manatee"?MANATEE_LAYER:county==="lee"?LEE_LAYER:`${SWFWMD_BASE}/${SWFWMD_LAYERS[county]}`,
    fetchedAt:now.toISOString(),
  };
  if(county==="hillsborough"){
    try{const hcpa=await lookupHcpaBuilding(address,fetchImpl);if(hcpa){
      building={values:{...emptyBuilding(),...hcpa.values},source:hcpa.source};
      fieldSources=hcpa.fieldSources;roofPermits=hcpa.roofPermits??[];
    }}catch{errors.push("Hillsborough County Property Appraiser unavailable");}
  }
  if(coordinates && (!building.values.yearBuilt||!building.values.squareFeetLiving)){
    try{
      const dor=await lookupDorBuilding(address,address.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]?.slice(0,5)??"",coordinates.latitude,coordinates.longitude,identity.parcelId??undefined,fetchImpl);
      if(dor){
        for(const [key,value] of Object.entries(dor.values)){
          if(value!=null && (building.values as any)[key]==null){
            (building.values as any)[key]=value;fieldSources[key]=dor.fieldSources[key];
          }
        }
        if(building.source==="no-county-source"||building.source==="Unavailable"||Object.keys(fieldSources).every(k=>fieldSources[k].source.includes("Dept. of Revenue")))building.source=dor.source;
      }
    }catch{errors.push("Florida Dept. of Revenue tax roll unavailable");}
  }
  if(flood?.floodZone)fieldSources.floodZone={value:flood.floodZone,source:"FEMA NFHL",sourceUrl:FEMA_LAYER,fetchedAt:now.toISOString()};

  const expiresAt = new Date(now);
  const expiryDay = expiresAt.getUTCDate();
  expiresAt.setUTCDate(1);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
  const lastDayOfExpiryMonth = new Date(Date.UTC(
    expiresAt.getUTCFullYear(),
    expiresAt.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  expiresAt.setUTCDate(Math.min(expiryDay, lastDayOfExpiryMonth));
  let profile: PropertyCharacteristics = {
    fieldSources,roofPermits,
    addressNormalized,
    addressDisplay: address.trim(),
    county,
    parcelId: identity.status === "found" ? identity.parcelId : null,
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    floodZone: flood?.floodZone ?? null,
    floodZoneSubtype: flood?.floodZoneSubtype ?? null,
    staticBfe: flood?.staticBfe ?? null,
    sfha: flood?.sfha ?? null,
    ...building.values,
    buildingDataSource: building.source,
    floodDataSource: flood?.source ?? null,
    designWindSpeed: null,
    milesToCoast: coast?.milesToCoast ?? null,
    windborneDebrisRegion: null,
    windDataSource: null,
    coastDataSource: coast?.source ?? null,
    queriedAt: now,
    expiresAt,
    ...(errors.length ? { errors } : {}),
  };
  profile = mergeConfirmedCharacteristics(profile, existing);

  // A transient geocoder/FEMA failure must not poison the one-year cache.
  // County "no source" is intentional and is persisted once FEMA succeeds.
  if (
    errors.length === 0 &&
    (flood || isConfirmedSource(profile.floodDataSource))
  ) {
    await cache.write(profile);
  }
  return profile;
}