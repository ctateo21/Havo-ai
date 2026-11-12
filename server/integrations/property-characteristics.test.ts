import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lookupFemaNfhl,
  lookupMilesToCoast,
  constructionIndexFromCharacteristics,
  mergeConfirmedCharacteristics,
  resolveQuoteRushCharacteristicValues,
  resolvePropertyCharacteristics,
  toPublicPropertyCharacteristics,
  type PropertyCharacteristics,
  type PropertyCharacteristicsCache,
} from "./property-characteristics";
import type { ParcelIdentity } from "./parcel-resolver";

function identity(county: ParcelIdentity["county"], parcelId = "P-1"): ParcelIdentity {
  return {
    status: "found",
    county,
    parcelId,
    folio: parcelId,
    taxDistrict: null,
    situsAddress: "100 MAIN ST",
    situsCity: "BRADENTON",
    source: "test",
  };
}

test("FEMA lookup uses validated NFHL layer 28 fields and parses attributes", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname.endsWith("/NFHL/MapServer/28/query"), true);
    assert.equal(
      url.searchParams.get("outFields"),
      "FLD_ZONE,ZONE_SUBTY,STATIC_BFE,SFHA_TF,DFIRM_ID",
    );
    assert.equal(url.searchParams.get("geometry"), "-81.73,25.94");
    return new Response(JSON.stringify({
      features: [{
        attributes: {
          FLD_ZONE: " ae ",
          ZONE_SUBTY: "COASTAL FLOODPLAIN",
          STATIC_BFE: 9,
          SFHA_TF: "T",
        },
      }],
    }));
  };
  assert.deepEqual(await lookupFemaNfhl(25.94, -81.73, fetchImpl), {
    floodZone: "AE",
    floodZoneSubtype: "COASTAL FLOODPLAIN",
    staticBfe: 9,
    sfha: true,
    source: "fema-nfhl-layer-28",
    dfirmId:null,
  });
});

test("miles to coast is calculated once from the nearest shoreline segment", async () => {
  const result = await lookupMilesToCoast(
    28,
    -82,
    async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("where"), "level_ = 1");
      assert.equal(url.searchParams.get("outFields"), "OBJECTID,level_");
      return new Response(JSON.stringify({
        features: [{
          attributes: { OBJECTID: 1, level_: 1 },
          geometry: { rings: [[[-81.99, 27], [-81.99, 29]]] },
        }],
      }));
    },
  );
  assert.ok(result.milesToCoast != null);
  assert.ok(result.milesToCoast > 0.60 && result.milesToCoast < 0.62);
  assert.equal(result.source, "noaa-gshhs-level-1-ocean-shoreline-proxy");
});

test("Manatee enriches building fields and only uses verified domain labels", async () => {
  const writes: PropertyCharacteristics[] = [];
  const cache: PropertyCharacteristicsCache = {
    read: async () => null,
    write: async (profile) => { writes.push(profile); },
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "hazards.fema.gov") {
      return new Response(JSON.stringify({
        features: [{ attributes: { FLD_ZONE: "X", SFHA_TF: "F" } }],
      }));
    }
    if (!url.pathname.endsWith("/query")) {
      return new Response(JSON.stringify({
        fields: [
          {
            name: "BLDG_R1_EXTWALL",
            domain: { codedValues: [{ code: "ST", name: "Stucco" }] },
          },
        ],
      }));
    }
    assert.match(url.searchParams.get("where") ?? "", /PARID='P-1'/);
    return new Response(JSON.stringify({
      features: [{
        attributes: {
          BLDG_R1_YRBUILT: 2001,
          BLDG_R1_EFFYR: 2009,
          BLDG_R1_SQFTLIVNG: 3377,
          BLDG_R1_STORIES: 2,
          BLDG_R1_EXTWALL: "ST",
          BLDG_R1_CONST: "C",
          PAR_SWIMPOOL_FLAG: "Y",
          BLDGS_LIVINGUNITS: 1,
        },
      }],
    }));
  };
  const result = await resolvePropertyCharacteristics(
    "manatee",
    "100 Main St, Bradenton, FL 34201",
    {
      fetchImpl,
      coordinates: { latitude: 27.4, longitude: -82.5 },
      cache,
      resolveParcelImpl: async () => identity("manatee"),
    },
  );
  assert.equal(result.yearBuilt, 2001);
  assert.equal(result.squareFeetLiving, 3377);
  assert.equal(result.exteriorWallLabel, "Stucco");
  assert.equal(result.constructionCode, "C");
  assert.equal(result.constructionLabel, null);
  assert.equal(result.hasPool, true);
  assert.equal(writes.length, 1);
});

test("Hillsborough persists intentional no-county-source nulls", async () => {
  const writes: PropertyCharacteristics[] = [];
  const cache: PropertyCharacteristicsCache = {
    read: async () => null,
    write: async (profile) => { writes.push(profile); },
  };
  const result = await resolvePropertyCharacteristics(
    "hillsborough",
    "100 Main St, Tampa, FL 33602",
    {
      coordinates: { latitude: 27.95, longitude: -82.46 },
      cache,
      resolveParcelImpl: async () => identity("hillsborough"),
      fetchImpl: async () => new Response(JSON.stringify({
        features: [{ attributes: { FLD_ZONE: "X", SFHA_TF: "F" } }],
      })),
    },
  );
  assert.equal(result.buildingDataSource, "no-county-source");
  assert.equal(result.yearBuilt, null);
  assert.equal(writes.length, 1);
});

test("confirmed manual categories win an automated refresh", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const base: PropertyCharacteristics = {
    addressNormalized: "100 MAIN ST TAMPA FL 33602",
    addressDisplay: "100 Main St, Tampa, FL 33602",
    county: "hillsborough",
    parcelId: "1",
    latitude: 1,
    longitude: 2,
    floodZone: "AE",
    floodZoneSubtype: null,
    staticBfe: 9,
    sfha: true,
    yearBuilt: 2000,
    yearBuiltEffective: null,
    squareFeetLiving: 2000,
    squareFeetTotal: null,
    stories: 1,
    livingUnits: 1,
    buildingCount: 1,
    hasPool: false,
    exteriorWallCode: null,
    exteriorWallLabel: null,
    constructionCode: null,
    constructionLabel: null,
    buildingDataSource: "county-auto",
    floodDataSource: "fema-nfhl-layer-28",
    milesToCoast: 2,
    coastDataSource: "noaa-gshhs-level-1-ocean-shoreline-proxy",
    queriedAt: now,
    expiresAt: now,
  };
  const merged = mergeConfirmedCharacteristics(base, {
    ...base,
    yearBuilt: 1995,
    floodZone: "X",
    buildingDataSource: "manual-confirmed",
    floodDataSource: "agent-confirmed",
  });
  assert.equal(merged.yearBuilt, 1995);
  assert.equal(merged.floodZone, "X");
  assert.equal(merged.buildingDataSource, "manual-confirmed");
  assert.equal(merged.floodDataSource, "agent-confirmed");
});

test("public profile mapping excludes cache identity and only maps known construction labels", () => {
  const profile = {
    addressNormalized: "PRIVATE",
    parcelId: "PRIVATE",
    latitude: 27,
    longitude: -82,
    ...({
      county: "manatee", floodZone: "X", floodZoneSubtype: null, staticBfe: null,
      sfha: false, yearBuilt: 2001, yearBuiltEffective: null,
      squareFeetLiving: 2000, squareFeetTotal: null, stories: null,
      livingUnits: null, buildingCount: null, hasPool: null,
      exteriorWallCode: null, exteriorWallLabel: null, constructionCode: "C",
      constructionLabel: "Concrete Block", buildingDataSource: "county",
      floodDataSource: "fema", fromCache: true,
    }),
  } as PropertyCharacteristics;
  profile.queriedAt=new Date("2026-11-12T00:00:00Z");
  const publicProfile = toPublicPropertyCharacteristics(profile);
  assert.equal("latitude" in publicProfile, false);
  assert.equal("parcelId" in publicProfile, false);
  assert.equal(constructionIndexFromCharacteristics("Concrete Block"), 0);
  assert.equal(constructionIndexFromCharacteristics("unverified provider text"), null);
});

test("QuoteRUSH characteristics fill only unlocked missing values", () => {
  const profile = {
    floodZone: "AE",
    squareFeetLiving: 2200,
    yearBuilt: 2001,
    constructionLabel: "Concrete Block",
  };
  assert.deepEqual(
    resolveQuoteRushCharacteristicValues({
      floodZone: "",
      sqFt: 0,
      constIdx: 1,
      propertyCharacteristicLocks: {},
    }, profile),
    { floodZone: "AE", sqFt: 2200, yearBuilt: 2001, constIdx: 0 },
  );
  assert.deepEqual(
    resolveQuoteRushCharacteristicValues({
      floodZone: "X",
      sqFt: 1800,
      yearBuilt: 1995,
      constIdx: 2,
      propertyCharacteristicLocks: {
        floodZone: true, squareFeet: true, yearBuilt: true, construction: true,
      },
    }, profile),
    { floodZone: "X", sqFt: 1800, yearBuilt: 1995, constIdx: 2 },
  );
  assert.deepEqual(
    resolveQuoteRushCharacteristicValues({
      floodZone: "",
      sqFt: 0,
      constIdx: 0,
      propertyCharacteristicLocks: {},
    }, null),
    { floodZone: "", sqFt: 0, yearBuilt: undefined, constIdx: 0 },
  );
});

test("a valid cache row prevents every outbound lookup", async () => {
  const now = new Date("2026-02-01T00:00:00Z");
  const cached: PropertyCharacteristics = {
    fieldSources:{floodZone:{value:"X",source:"FEMA NFHL",sourceUrl:"https://hazards.fema.gov",fetchedAt:"2026-01-01T00:00:00Z"}},
    addressNormalized: "100 MAIN ST TAMPA FL 33602",
    addressDisplay: "100 Main St, Tampa, FL 33602",
    county: "hillsborough",
    parcelId: "1",
    latitude: 27.95,
    longitude: -82.46,
    floodZone: "X",
    floodZoneSubtype: "AREA OF MINIMAL FLOOD HAZARD",
    staticBfe: null,
    sfha: false,
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
    buildingDataSource: "no-county-source",
    floodDataSource: "fema-nfhl-layer-28",
    milesToCoast: 2,
    coastDataSource: "noaa-gshhs-level-1-ocean-shoreline-proxy",
    queriedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: new Date("2027-01-01T00:00:00Z"),
  };
  let writes = 0;
  const cache: PropertyCharacteristicsCache = {
    read: async (_key, _now, includeExpired) =>
      includeExpired ? null : cached,
    write: async () => { writes += 1; },
  };
  const result = await resolvePropertyCharacteristics(
    "hillsborough",
    "100 Main St, Tampa, FL 33602",
    {
      now,
      cache,
      fetchImpl: async () => { throw new Error("unexpected fetch"); },
      resolveParcelImpl: async () => {
        throw new Error("unexpected parcel lookup");
      },
    },
  );
  assert.equal(result.fromCache, true);
  assert.equal(result.floodZone, "X");
  assert.equal(writes, 0);
});

test("new cache rows expire after one year", async () => {
  const now = new Date("2024-02-29T12:00:00Z");
  let written: PropertyCharacteristics | null = null;
  const cache: PropertyCharacteristicsCache = {
    read: async () => null,
    write: async (profile) => { written = profile; },
  };
  await resolvePropertyCharacteristics(
    "collier",
    "458 Capri Ct, Marco Island, FL 34145",
    {
      now,
      coordinates: { latitude: 25.94, longitude: -81.73 },
      cache,
      resolveParcelImpl: async () => identity("collier"),
      fetchImpl: async () => new Response(JSON.stringify({
        features: [{ attributes: { FLD_ZONE: "AE", SFHA_TF: "T" } }],
      })),
    },
  );
  assert.equal(
    (written as PropertyCharacteristics | null)?.expiresAt.toISOString(),
    "2025-02-28T12:00:00.000Z",
  );
});