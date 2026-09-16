import assert from "node:assert/strict";
import { test } from "node:test";
import { runCountyEstimator } from "./county-estimator-runner";

test("unverified county drivers fail closed instead of returning formula tax", async () => {
  const result = await runCountyEstimator({
    county: "collier",
    address: "112 Palmetto Dunes Cir, Naples, FL 34113",
    parcelId: "55252840005",
    purchasePrice: 525_000,
    homestead: false,
  });

  assert.equal(result.status, "unavailable");
  assert.match(result.error ?? "", /not available|not verified/i);
  assert.equal("adValoremCents" in result, false);
  assert.equal("source" in result, false);
});

test("forced unavailability is explicit and never a numeric zero", async () => {
  const result = await runCountyEstimator({
    county: "hillsborough",
    address: "3440 Laurel Dale Dr, Tampa, FL 33618",
    purchasePrice: 350_000,
    homestead: true,
    __forceUnavailable: true,
  });

  assert.deepEqual(result, {
    status: "unavailable",
    error: "Official county purchase estimator was forced unavailable.",
  });
});
