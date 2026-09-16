import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEstimatorPage, runCountyEstimator, type CountySlug } from "../server/integrations/county-estimator";

// Acceptance gate, deliberately separate from ordinary unit tests. Missing
// evidence FAILS this command; it is never filled with calculated expectations.
const COUNTIES: CountySlug[] = [
  "hillsborough", "pinellas", "manatee", "pasco", "hernando",
  "sarasota", "lee", "collier", "polk",
];
const KNOWN = [{
  county: "collier" as CountySlug,
  parcelId: "55252840005",
  address: "112 Palmetto Dunes Cir, Naples, FL 34113",
  purchasePrice: 525_000,
  homestead: false,
  expectedAdValoremCents: 551_400,
  fixture: "collier-55252840005-525000-nohs.txt",
  capturedOn: "2026-09-16",
  source: "User-supplied official county estimator PDF (see fixture README)",
}];
const TOLERANCE_CENTS = 100;

test("every supported county has a confirmed human-captured known answer", () => {
  const covered = new Set(KNOWN.map(k => k.county));
  assert.deepEqual(COUNTIES.filter(c => !covered.has(c)), [],
    "Missing confirmed captures: counties are NOT complete. Hillsborough's proposed value is approximate, not verified.");
});

for (const k of KNOWN) {
  test(`[fixture] ${k.county}: official captured ad valorem`, () => {
    const page = readFileSync(`test/fixtures/estimators/${k.fixture}`, "utf8");
    const parsed = parseEstimatorPage(k.county, page);
    assert.notEqual(parsed.adValoremCents, null);
    assert.ok(Math.abs(parsed.adValoremCents! - k.expectedAdValoremCents) <= TOLERANCE_CENTS);
  });
  test(`[live] ${k.county}: actual county estimator matches capture`, {
    skip: process.env.RUN_LIVE_ESTIMATOR_TESTS !== "1",
  }, async () => {
    const result = await runCountyEstimator(k);
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status !== "ok") return;
    assert.ok(result.pageText?.trim(), "Missing page output for audit");
    assert.ok(Math.abs(result.adValoremCents - k.expectedAdValoremCents) <= TOLERANCE_CENTS);
  });
}