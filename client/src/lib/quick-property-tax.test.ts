import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeQuickPropertyTax, parseQuickPropertyTax, safeTaxUrl } from "./quick-property-tax";
import { resolvePurchasePropertyTaxSource } from "./official-property-tax";

export const quickFixture = {
  key: "fixture-property-a", status: "estimate", annualTax: 4723.81, monthlyTax: 393.6508,
  adValorem: 4723.81, nav: null, navPending: true, taxYear: 2026, ratesYear: 2026,
  district: "fixture-district", sourceName: "Fixture county published millage",
  sourceUrl: "https://county.example/rates", label: "Estimated from published district millage",
  officialState: "pending",
};
const source = { name: "Fixture county estimator", url: "https://county.example/estimator",
  fetchedAt: "2026-06-03T15:24:17Z", taxYear: 2026, parcelId: "fixture-parcel" };
export const officialFixture = {
  ...quickFixture, status: "official", annualTax: 5014.17, adValorem: 4723.81, nav: 290.36, navPending: false,
  officialState: "complete", breakdown: {
    adValorem: { cents: 472381, source },
    nonAdValorem: { cents: 29036, source: { ...source, name: "Fixture county collector", url: "https://county.example/bill" } },
    total: { cents: 501417 }, warnings: ["Verify the applicable exemptions with the county."],
  },
};
test("quick estimates are usable but never official, including complete official job failures", () => {
  for (const status of ["estimate", "area_estimate", "rough_estimate"]) {
    const result = parseQuickPropertyTax({ ...quickFixture, status });
    assert.equal(result.status, status);
    assert.equal(result.annualTax, 4723.81);
    assert.equal(result.nav, null);
    assert.equal(resolvePurchasePropertyTaxSource(result.annualTax!, status, "tuple", { ...result, key: "tuple" }), status);
    assert.equal(resolvePurchasePropertyTaxSource(result.annualTax!, status, "changed-tuple", { ...result, key: "tuple" }), "unavailable");
  }
});
test("pending unavailable responses show no zero and can later become an official auditable amount", () => {
  const pending = parseQuickPropertyTax({ key: quickFixture.key, status: "unavailable", annualTax: null, officialState: "pending" });
  assert.equal(pending.annualTax, null);
  assert.equal(pending.monthlyTax, null);
  const official = parseQuickPropertyTax(officialFixture);
  assert.equal(official.status, "official");
  assert.equal(mergeQuickPropertyTax(pending, official).annualTax, 5014.17);
});
test("a failed official lookup retains quick amount and provenance, and rejects another job", () => {
  const previous = parseQuickPropertyTax(quickFixture);
  const failure = parseQuickPropertyTax({ key: previous.key, status: "unavailable", annualTax: null, officialState: "failed", reason: "County timed out" });
  const merged = mergeQuickPropertyTax(previous, failure);
  assert.equal(merged.annualTax, previous.annualTax);
  assert.equal(merged.sourceUrl, previous.sourceUrl);
  assert.equal(merged.status, "estimate");
  assert.equal(merged.officialState, "failed");
  assert.equal(mergeQuickPropertyTax(previous, { ...failure, key: "another-job" }), previous);
});
test("official requires matching complete cents and both component sources", () => {
  assert.equal(parseQuickPropertyTax(officialFixture).status, "official");
  assert.equal(parseQuickPropertyTax({ ...officialFixture, breakdown: undefined }).status, "estimate");
  assert.equal(parseQuickPropertyTax({ ...officialFixture, annualTax: 5014 }).status, "estimate");
  assert.equal(parseQuickPropertyTax({ ...officialFixture, breakdown: { ...officialFixture.breakdown, nonAdValorem: { cents: 29036 } } }).status, "estimate");
});
test("manual explicit zero wins, unsafe source links and malformed amounts fail closed", () => {
  const result = parseQuickPropertyTax(quickFixture);
  assert.equal(resolvePurchasePropertyTaxSource(0, "manual", "changed", { ...result, key: "old" }), "manual");
  assert.equal(parseQuickPropertyTax({ ...quickFixture, annualTax: "4723.81" }).annualTax, null);
  assert.equal(safeTaxUrl("javascript:alert(1)"), null);
  assert.equal(safeTaxUrl("https://county.example/rates"), "https://county.example/rates");
  assert.throws(() => parseQuickPropertyTax({ annualTax: 4821.11 }));
});
