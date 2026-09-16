import assert from "node:assert/strict";
import { test } from "node:test";
import {
  identifyCountyCandidatesFromAddress,
  identifyCountyFromAddress,
  isStrictParcelAddressMatch,
  resolveParcel,
} from "./parcel-resolver";

test("strict parcel matching requires both exact street/unit and city", () => {
  assert.equal(
    isStrictParcelAddressMatch(
      "7762 Ashton Rd, Naples, FL 34113",
      "7762 Ashton RD, Naples",
      "Naples",
    ),
    true,
  );
  assert.equal(
    isStrictParcelAddressMatch(
      "7762 Ashton Rd, Naples, FL 34113",
      "7764 Ashton RD, Naples",
      "Naples",
    ),
    false,
  );
  assert.equal(
    isStrictParcelAddressMatch(
      "7762 Ashton Rd, Naples, FL 34113",
      "7762 Ashton RD, Naples",
      "Marco Island",
    ),
    false,
  );
});

test("county identification remains conservative for shared ZIPs", () => {
  assert.equal(
    identifyCountyFromAddress("100 Main St, Fort Myers, FL 33901"),
    "lee",
  );
  assert.equal(
    identifyCountyFromAddress("100 Main St, Dade City, FL 33523"),
    null,
  );
  assert.deepEqual(
    identifyCountyCandidatesFromAddress("100 Main St, Dade City, FL 33523"),
    ["hillsborough", "pasco", "hernando"],
  );
  assert.deepEqual(
    identifyCountyCandidatesFromAddress(
      "16807 McGregor Blvd, Fort Myers, FL 33908",
    ),
    ["lee"],
  );
});

test("Lee queries by house number and strictly selects the matching parcel", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.match(url.pathname, /Lee_County_Parcels\/FeatureServer\/0\/query/);
    assert.equal(
      url.searchParams.get("where"),
      "SITEADDR LIKE '16807%' AND SITECITY='FORT MYERS'",
    );
    return new Response(
      JSON.stringify({
        features: [
          {
            attributes: {
              STRAP: "29442307000000190",
              FOLIOID: 10602786,
              SITEADDR: "16807 PRINCE PHILLIP CT",
              SITECITY: "CAPE CORAL",
            },
          },
          {
            attributes: {
              STRAP: "024623010000E0060",
              FOLIOID: 10636991,
              SITEADDR: "16807 MCGREGOR BLVD",
              SITECITY: "FORT MYERS",
              JUST: 390344,
              ASSESSED: 248634,
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await resolveParcel(
    "lee",
    "16807 McGregor Blvd, Fort Myers, FL 33908",
    { fetchImpl, skipCache: true },
  );
  assert.equal(result.status, "found");
  assert.equal(result.parcelId, "024623010000E0060");
  assert.equal(result.justValue, 390344);
});

test("Collier uses the official ParcelJoin row and preserves millage area rates", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.match(url.pathname, /ParcelJoin\/FeatureServer\/0\/query/);
    assert.equal(
      url.searchParams.get("where"),
      "SiteStreetNumber=112 AND SiteStreetName LIKE 'PALMETTO DUNES%' AND SiteCity='NAPLES'",
    );
    return new Response(
      JSON.stringify({
        features: [{
          attributes: {
            ParcelId: 55252840005,
            Folio: "55252840005",
            SiteStreetAddress: "112 PALMETTO DUNES CIRCLE",
            SiteCity: "NAPLES",
            TaxYear: 2026,
            TotalJustValue: 488479,
            CountyAssessedValue: 488479,
            MillageArea: 32,
            CountyMillage: 4.0318,
            SchoolMillage: 4.147,
            MunicipalMillage: 0,
            OtherMillage: 2.3257,
          },
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await resolveParcel(
    "collier",
    "112 Palmetto Dunes Cir, Naples, FL 34113",
    { fetchImpl, skipCache: true },
  );
  assert.equal(result.status, "found");
  assert.equal(result.parcelId, "55252840005");
  assert.equal(result.millageArea, "32");
  assert.equal(result.countyMillage, 4.0318);
  assert.equal(result.schoolMillage, 4.147);
  assert.equal(result.otherMillage, 2.3257);
});

test("Collier query keeps suffix variants bounded and matches SiteUnit strictly", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(
      url.searchParams.get("where"),
      "SiteStreetNumber=112 AND SiteStreetName LIKE 'PALMETTO DUNES%' AND SiteCity='NAPLES'",
    );
    return new Response(
      JSON.stringify({
        features: [
          {
            attributes: {
              Folio: "wrong-unit",
              SiteStreetAddress: "112 PALMETTO DUNES CIRCLE",
              SiteUnit: "2",
              SiteCity: "NAPLES",
            },
          },
          {
            attributes: {
              Folio: "right-unit",
              SiteStreetAddress: "112 PALMETTO DUNES CIRCLE",
              SiteUnit: "3",
              SiteCity: "NAPLES",
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await resolveParcel(
    "collier",
    "112 Palmetto Dunes Cir Unit 3, Naples, FL 34113",
    { fetchImpl, skipCache: true },
  );
  assert.equal(result.status, "found");
  assert.equal(result.parcelId, "right-unit");
});

test("SWFWMD Hernando uses ALTKEY as the TaxSys parcel key", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.match(String(input), /MapServer\/5\/query/);
    const where = new URL(String(input)).searchParams.get("where");
    assert.equal(
      where,
      "SITEADD LIKE '3301 %' AND SCITY='BROOKSVILLE'",
    );
    return new Response(
      JSON.stringify({
        features: [{
          attributes: {
            PARNO: "R-Z APN 19 0000 0310 0030",
            ALTKEY: "1738622",
            SITEADD: "3301  NORTHEAST PKWY",
            SCITY: "BROOKSVILLE",
            PARVAL: 300000,
            ASSD_TOT: 250000,
          },
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await resolveParcel(
    "hernando",
    "3301 Northeast Pkwy, Brooksville, FL 34604",
    { fetchImpl, skipCache: true },
  );
  assert.equal(result.status, "found");
  assert.equal(result.parcelId, "1738622");
  assert.equal(result.folio, "R-Z APN 19 0000 0310 0030");
});

test("Polk parcel identity is resolved through SWFWMD layer 14", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.match(String(input), /MapServer\/14\/query/);
    return new Response(
      JSON.stringify({
        features: [{
          attributes: {
            PARNO: "222602000000011010",
            SITEADD: "100 MAIN ST",
            SCITY: "LAKELAND",
          },
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await resolveParcel(
    "polk",
    "100 Main St, Lakeland, FL 33809",
    { fetchImpl, skipCache: true },
  );
  assert.equal(result.status, "found");
  assert.equal(result.parcelId, "222602000000011010");
});

test("candidate with wrong city is never accepted", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        features: [{
          attributes: {
            PARNO: "0000007033",
            SITEADD: "1630 MAIN ST",
            SCITY: "VENICE",
          },
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const result = await resolveParcel(
    "sarasota",
    "1630 Main St, Sarasota, FL 34236",
    { fetchImpl, skipCache: true },
  );
  assert.equal(result.status, "not-found");
});