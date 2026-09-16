import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCacheRowValid,
  isOfficialEstimatorCacheSource,
} from "./property-tax-cache";

const expiresAt = new Date("2027-11-01T00:00:00.000Z");

test("only official county-estimator cache labels are eligible", () => {
  assert.equal(isOfficialEstimatorCacheSource("county-estimator"), true);
  assert.equal(isOfficialEstimatorCacheSource("collier-county-estimator"), true);
  assert.equal(isOfficialEstimatorCacheSource("collier-pa-millage-situs-v2"), false);
  assert.equal(isOfficialEstimatorCacheSource("manatee-formula-plus-arcgis-nav"), false);
  assert.equal(isOfficialEstimatorCacheSource("pinellas-bill-live"), false);
});

test("formula and parcel-millage rows are rejected as purchase successes", () => {
  const base = {
    parcelId: "parcel-1",
    folio: "parcel-1",
    homesteadAdValoremPct: 0.01,
    nonHomesteadAdValoremPct: 0.014,
    samplePrice: 400_000,
    nonAdValoremAmtCents: 0,
    expiresAt,
  };

  assert.equal(
    isCacheRowValid({ ...base, source: "pinellas-formula-fallback" }, 400_000),
    false,
  );
  assert.equal(
    isCacheRowValid(
      { ...base, source: "collier-pa-millage-situs-v2" },
      400_000,
    ),
    false,
  );
  assert.equal(
    isCacheRowValid({ ...base, source: "county-estimator" }, 400_000),
    true,
  );
});
