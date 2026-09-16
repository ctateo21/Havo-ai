import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEstimatorPage, rescaleAdValorem, runCountyEstimator } from "./county-estimator";

test("Collier labeled PDF transcription reproduces the human-captured ad valorem within $1", () => {
  const page = readFileSync("test/fixtures/estimators/collier-55252840005-525000-nohs.txt", "utf8");
  const parsed = parseEstimatorPage("collier", page);
  assert.notEqual(parsed.adValoremCents, null);
  assert.ok(Math.abs(parsed.adValoremCents! - 551_400) <= 100);
});

test("parser refuses missing, ambiguous and non-ad-valorem-only amounts", () => {
  for (const page of [
    "", "Total Tax ($) 5,514", "Approximate Non-Ad Valorem Taxes ($) 300",
    "Approximate Ad Valorem Taxes ($) 500 Approximate Ad Valorem Taxes ($) 600",
  ]) assert.equal(parseEstimatorPage("collier", page).adValoremCents, null);
  assert.equal(parseEstimatorPage("hillsborough", "Ad Valorem Taxes ($) 4,676").adValoremCents, null);
});

test("non-homestead verified seed rescales within the 20% boundary", () => {
  const result = rescaleAdValorem({
    seedPrice: 525_000, seedAdValoremCents: 551_400, seedHomestead: false,
    newPrice: 550_000, newHomestead: false,
  });
  assert.equal(result.status, "rescaled");
  if (result.status === "rescaled") assert.ok(Math.abs(result.adValoremCents - 577_657) <= 100);
});

test("scaling rejects occupancy changes, large moves, homestead price edits and invalid seeds", () => {
  const base = {
    seedPrice: 525_000, seedAdValoremCents: 551_400, seedHomestead: false,
    newPrice: 525_000, newHomestead: false,
  };
  for (const change of [
    { newHomestead: true }, { newPrice: 700_000 }, { seedPrice: 0 },
    { newPrice: NaN }, { seedAdValoremCents: -1 },
    { seedHomestead: true, newHomestead: true, newPrice: 550_000 },
  ]) assert.equal(rescaleAdValorem({ ...base, ...change }).status, "recall-required");
});

test("unavailable estimator never substitutes a formula estimate", async () => {
  const result = await runCountyEstimator({
    county: "collier", address: "1 Nonexistent Way, Naples, FL",
    purchasePrice: 400_000, homestead: false, __forceUnavailable: true,
  });
  assert.equal(result.status, "unavailable");
  assert.notEqual((result as { source?: string }).source, "formula");
});