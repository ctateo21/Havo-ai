import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasMatchingOfficialAnnualTax,
  parseOfficialPropertyTaxResponse,
} from "./official-property-tax";

test("official tuple guard rejects a changed annual amount until inputs sync", () => {
  assert.equal(hasMatchingOfficialAnnualTax(5514, 5514), true);
  assert.equal(hasMatchingOfficialAnnualTax(5514, 5513), false);
  assert.equal(hasMatchingOfficialAnnualTax(5514, 0), false);
  assert.equal(hasMatchingOfficialAnnualTax(5514, null), false);
});

test("accepts the approved county-estimator response", () => {
  assert.deepEqual(
    parseOfficialPropertyTaxResponse({
      annualTax: 5514,
      source: "collier-county-estimator",
      taxDistrict: "Naples",
      nonAdValoremTax: 312,
    }),
    {
      status: "available",
      annualTax: 5514,
      source: "collier-county-estimator",
      municipality: "Naples",
      millageRate: undefined,
      nonAdValoremTax: 312,
      nonAdValoremPending: false,
      operationalError: undefined,
    },
  );
  assert.equal(
    parseOfficialPropertyTaxResponse({
      annualTax: 1,
      source: "county-estimator",
    }).status,
    "available",
  );
});

test("accepts only an explicitly gated formula fallback for a supported county", () => {
  const estimated = parseOfficialPropertyTaxResponse({
    annualTax: 5000,
    source: "collier-formula-fallback",
    estimatorVerified: false,
  });
  assert.deepEqual(estimated, {
    status: "available",
    annualTax: 5000,
    source: "collier-formula-fallback",
    provenance: "estimated",
    municipality: undefined,
    millageRate: undefined,
    nonAdValoremTax: 0,
    nonAdValoremPending: false,
    operationalError: undefined,
  });
  assert.equal(
    parseOfficialPropertyTaxResponse({
      annualTax: 5000,
      source: "formula-fallback",
      county: "Collier County",
      estimatorVerified: false,
      official: false,
      useFallback: true,
    }).status,
    "available",
  );

  for (const source of [
    "collier-formula-strict-parcel-unavailable",
    "manatee-formula-plus-arcgis-nav",
    "county-fallback",
    "collier-county-estimator-unavailable",
    "collier-bill-live-2026-situs-v2",
    "orange-county-estimator",
  ]) {
    const result = parseOfficialPropertyTaxResponse({
      annualTax: 5000,
      source,
      estimatorVerified: false,
    });
    assert.equal(result.status, "unavailable", source);
  }
  assert.equal(
    parseOfficialPropertyTaxResponse({
      annualTax: 5000,
      source: "collier-formula-fallback",
    }).status,
    "unavailable",
  );
  assert.equal(
    parseOfficialPropertyTaxResponse({
      annualTax: 5000,
      source: "orange-formula-fallback",
      estimatorVerified: false,
    }).status,
    "unavailable",
  );
});

test("explicit unavailable and legacy useFallback never become zero tax", () => {
  assert.deepEqual(
    parseOfficialPropertyTaxResponse({ status: "unavailable", annualTax: 0 }),
    { status: "unavailable" },
  );
  assert.deepEqual(
    parseOfficialPropertyTaxResponse({ useFallback: true, annualTax: 4800 }),
    { status: "unavailable" },
  );
  assert.deepEqual(
    parseOfficialPropertyTaxResponse({
      adValoremTax: null,
      annualTax: null,
      monthlyTax: null,
      nonAdValoremTax: 0,
      source: "collier-county-estimator-unavailable",
      operationalError: "No official county estimator adapter is enabled",
    }),
    {
      status: "unavailable",
      reason: "No official county estimator adapter is enabled",
    },
  );
});

test("accepts an explicit official zero amount", () => {
  const result = parseOfficialPropertyTaxResponse({
    annualTax: 0,
    source: "hillsborough-county-estimator",
  });
  assert.deepEqual(result, {
    status: "available",
    annualTax: 0,
    source: "hillsborough-county-estimator",
    municipality: undefined,
    millageRate: undefined,
    nonAdValoremTax: 0,
    nonAdValoremPending: false,
    operationalError: undefined,
  });
});

test("a numeric response without an official source is unavailable", () => {
  assert.equal(
    parseOfficialPropertyTaxResponse({ annualTax: 4800 }).status,
    "unavailable",
  );
});
