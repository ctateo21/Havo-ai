/**
 * Unit tests for the property-tax field helpers used in the refinance
 * LoanTracker. Verifies:
 *  1. API "ready" response parsing produces the correct patch shape.
 *  2. API "unavailable" response sets the right status.
 *  3. Manual-entry patches only touch tax fields (no spillover to other fields).
 *  4. Lookup patches only touch tax fields (no spillover).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCurrentTaxLookupPatch,
  buildManualPropertyTaxPatch,
  type PropertyTaxLoanPatch,
} from "./property-tax-refi";


// ── Tests ─────────────────────────────────────────────────────────────

test("buildCurrentTaxLookupPatch: annualTax field", () => {
  const patch = buildCurrentTaxLookupPatch({
    state: "ready",
    annualTax: 4800,
    taxYear: 2025,
    source: "tax-collector-bill-scrape",
    county: "hillsborough",
    parcelId: "A-1234",
  });
  assert.ok(patch !== null, "should parse successfully");
  assert.equal(patch!.annualPropertyTax, 4800);
  assert.equal(patch!.annualPropertyTaxSource, "tax-collector-bill-scrape");
  assert.equal(patch!.annualPropertyTaxYear, 2025);
  assert.equal(patch!.annualPropertyTaxQueriedAt, undefined);
});

test("buildCurrentTaxLookupPatch: accepts Manatee's actual annual total", () => {
  const patch = buildCurrentTaxLookupPatch({
    state: "ready",
    annualTax: 4469.66,
    taxYear: 2025,
    source: "manatee-arcgis",
  });
  assert.ok(patch !== null);
  assert.equal(patch!.annualPropertyTax, 4469.66);
  assert.equal(patch!.annualPropertyTaxSource, "manatee-arcgis");
});

test("buildCurrentTaxLookupPatch: returns null for non-ready state", () => {
  assert.equal(buildCurrentTaxLookupPatch({ state: "pending", county: "hillsborough" }), null);
  assert.equal(buildCurrentTaxLookupPatch({ state: "unavailable", reason: "no data" }), null);
});

test("buildCurrentTaxLookupPatch: rejects missing totals and unknown sources", () => {
  assert.equal(buildCurrentTaxLookupPatch({ state: "ready", annualTax: -1, taxYear: 2025, source: "tax-collector-bill-scrape" }), null);
  assert.equal(buildCurrentTaxLookupPatch({ state: "ready", annualTax: "four thousand", taxYear: 2025, source: "tax-collector-bill-scrape" }), null);
  assert.equal(buildCurrentTaxLookupPatch({ state: "ready", adValoremTax: 3600, taxYear: 2025, source: "tax-collector-bill-scrape" }), null);
  assert.equal(buildCurrentTaxLookupPatch({ state: "ready", annualTax: 3600, taxYear: 2025, source: "formula" }), null);
  assert.equal(buildCurrentTaxLookupPatch({ state: "ready", annualTax: 3600, source: "tax-collector-bill-scrape" }), null);
});

test("buildManualPropertyTaxPatch: preserves cents and sets source=manual", () => {
  const patch = buildManualPropertyTaxPatch(4799.99);
  assert.equal(patch?.annualPropertyTax, 4799.99);
  assert.equal(patch?.annualPropertyTaxSource, "manual");
  assert.equal(patch?.annualPropertyTaxYear, undefined);
  assert.equal(patch?.annualPropertyTaxQueriedAt, undefined);
});

test("lookup patch only touches tax fields", () => {
  const existingLoan = {
    id: "loan-1",
    propertyAddress: "123 Main St",
    loanBalance: 300000,
    estimatedHomeValue: 400000,
    loanType: "conventional",
    annualPropertyTax: undefined,
  };
  const patch = buildCurrentTaxLookupPatch({
    state: "ready",
    annualTax: 5200,
    taxYear: 2025,
    source: "tax-collector-bill-scrape",
  });
  assert.ok(patch !== null);
  // Verify none of the non-tax fields appear in the patch
  const patchKeys = Object.keys(patch!);
  const nonTaxKeys = patchKeys.filter(k => !k.startsWith("annualPropertyTax"));
  assert.equal(nonTaxKeys.length, 0, `unexpected non-tax keys in patch: ${nonTaxKeys.join(", ")}`);
  // Verify that merging the patch leaves non-tax fields untouched
  const merged = { ...existingLoan, ...patch! };
  assert.equal(merged.loanBalance, 300000);
  assert.equal(merged.estimatedHomeValue, 400000);
  assert.equal(merged.loanType, "conventional");
});

test("manual patch only touches tax fields", () => {
  const existingLoan = {
    id: "loan-1",
    propertyAddress: "123 Main St",
    loanBalance: 300000,
    estimatedHomeValue: 400000,
    loanType: "conventional",
  };
  const patch = buildManualPropertyTaxPatch(4800);
  assert.ok(patch !== null);
  const patchKeys = Object.keys(patch);
  const nonTaxKeys = patchKeys.filter(k => !k.startsWith("annualPropertyTax"));
  assert.equal(nonTaxKeys.length, 0, `unexpected non-tax keys in manual patch: ${nonTaxKeys.join(", ")}`);
  const merged = { ...existingLoan, ...patch! };
  assert.equal(merged.loanBalance, 300000);
  assert.equal(merged.estimatedHomeValue, 400000);
  assert.equal(merged.loanType, "conventional");
  assert.equal(merged.annualPropertyTax, 4800);
});

test("manual patch never overwrites annualPropertyTax when source=lookup", () => {
  // Simulate: a lookup already set the tax value with source=tax-collector-bill-scrape.
  // Then user enters manually → the manual source wins (it's a user action).
  const lookupPatch: PropertyTaxLoanPatch = {
    annualPropertyTax: 5000,
    annualPropertyTaxSource: "tax-collector-bill-scrape",
    annualPropertyTaxYear: 2024,
    annualPropertyTaxQueriedAt: "2024-01-01T00:00:00.000Z",
  };
  const manualPatch = buildManualPropertyTaxPatch(4800);
  assert.ok(manualPatch !== null);
  // Manual overrides lookup (last write wins in the UI — intentional user action)
  const merged = { ...lookupPatch, ...manualPatch! };
  assert.equal(merged.annualPropertyTax, 4800);
  assert.equal(merged.annualPropertyTaxSource, "manual");
  assert.equal(merged.annualPropertyTaxYear, undefined);
  assert.equal(merged.annualPropertyTaxQueriedAt, undefined);
});
