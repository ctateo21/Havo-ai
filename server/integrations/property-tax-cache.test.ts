/**
 * Unit tests for the general property-tax purchase-estimate cache.
 * Tests: validity rules, expiry boundary, cache recomputation.
 * No DB calls — all pure functions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCacheRowValid,
  computeFromCache,
  nextTaxRefreshBoundary,
  type PropertyTaxCacheRow,
} from "./property-tax-cache";
import { PURCHASE_TAX_LOW_ASSESSMENT_RATIO } from "@shared/property-tax-policy";

// ── nextTaxRefreshBoundary ────────────────────────────────────────

test("nextTaxRefreshBoundary: before Nov 1 → same-year Nov 1", () => {
  const now = new Date(Date.UTC(2026, 7, 20)); // Aug 20 2026
  assert.equal(nextTaxRefreshBoundary(now).toISOString(), "2026-11-01T00:00:00.000Z");
});

test("nextTaxRefreshBoundary: on Nov 1 exactly → next-year Nov 1", () => {
  const now = new Date(Date.UTC(2026, 10, 1)); // Nov 1 00:00 UTC
  assert.equal(nextTaxRefreshBoundary(now).toISOString(), "2027-11-01T00:00:00.000Z");
});

test("nextTaxRefreshBoundary: Dec 15 → next-year Nov 1", () => {
  const now = new Date(Date.UTC(2026, 11, 15));
  assert.equal(nextTaxRefreshBoundary(now).toISOString(), "2027-11-01T00:00:00.000Z");
});

test("nextTaxRefreshBoundary: Jan 1 → same-year Nov 1", () => {
  const now = new Date(Date.UTC(2027, 0, 1));
  assert.equal(nextTaxRefreshBoundary(now).toISOString(), "2027-11-01T00:00:00.000Z");
});

// ── isCacheRowValid ───────────────────────────────────────────────

type ValidInput = Pick<
  PropertyTaxCacheRow,
  | "parcelId"
  | "folio"
  | "homesteadAdValoremPct"
  | "nonHomesteadAdValoremPct"
  | "samplePrice"
  | "schoolMillage"
  | "nonSchoolMillage"
  | "assessmentRatio"
  | "homesteadSchoolExemption"
  | "homesteadNonSchoolExemption"
  | "rateYear"
  | "nonAdValoremAmtCents"
  | "source"
  | "expiresAt"
>;

function baseRow(): ValidInput {
  return {
    parcelId: "12345",
    folio: "12345",
    homesteadAdValoremPct: 0.01197,
    nonHomesteadAdValoremPct: 0.0146,
    samplePrice: 400_000,
    schoolMillage: null,
    nonSchoolMillage: null,
    assessmentRatio: null,
    homesteadSchoolExemption: null,
    homesteadNonSchoolExemption: null,
    rateYear: null,
    nonAdValoremAmtCents: 0,
    source: "manatee-formula-plus-arcgis-nav",
    expiresAt: new Date(Date.UTC(2027, 10, 1)), // far future
  };
}

const NOW = new Date(Date.UTC(2026, 7, 20));

test("valid row with price exactly at sample is accepted", () => {
  assert.equal(isCacheRowValid(baseRow(), 400_000, NOW), true);
});

test("valid row with price 19% below sample is accepted", () => {
  assert.equal(isCacheRowValid(baseRow(), 400_000 * 0.81, NOW), true);
});

test("valid row with price 19% above sample is accepted", () => {
  assert.equal(isCacheRowValid(baseRow(), 400_000 * 1.19, NOW), true);
});

test("price at 80% of sample (ratio=0.8) is valid, below is not", () => {
  assert.equal(isCacheRowValid(baseRow(), 320_000, NOW), true);   // exactly 0.8
  assert.equal(isCacheRowValid(baseRow(), 319_999, NOW), false);  // < 0.8
});

test("price at 120% of sample (ratio=1.2) is valid, above is not", () => {
  assert.equal(isCacheRowValid(baseRow(), 480_000, NOW), true);   // exactly 1.2
  assert.equal(isCacheRowValid(baseRow(), 480_001, NOW), false);  // > 1.2
});

test("expired row is rejected", () => {
  const row = { ...baseRow(), expiresAt: new Date(Date.UTC(2026, 7, 19)) };
  assert.equal(isCacheRowValid(row, 400_000, NOW), false);
});

test("invalid expiry date is rejected", () => {
  const row = { ...baseRow(), expiresAt: new Date("not-a-date") };
  assert.equal(isCacheRowValid(row, 400_000, NOW), false);
});

test("missing both parcelId and folio is rejected", () => {
  const row = { ...baseRow(), parcelId: null, folio: null };
  assert.equal(isCacheRowValid(row, 400_000, NOW), false);
});

test("parcelId null but non-empty folio is accepted", () => {
  const row = { ...baseRow(), parcelId: null, folio: "ABC123" };
  assert.equal(isCacheRowValid(row, 400_000, NOW), true);
});

test("folio null but non-empty parcelId is accepted", () => {
  const row = { ...baseRow(), parcelId: "ABC123", folio: null };
  assert.equal(isCacheRowValid(row, 400_000, NOW), true);
});

test("zero homestead percentage is rejected", () => {
  assert.equal(isCacheRowValid({ ...baseRow(), homesteadAdValoremPct: 0 }, 400_000, NOW), false);
});

test("zero non-homestead percentage is rejected", () => {
  assert.equal(isCacheRowValid({ ...baseRow(), nonHomesteadAdValoremPct: 0 }, 400_000, NOW), false);
});

test("non-finite percentages are rejected", () => {
  assert.equal(isCacheRowValid({ ...baseRow(), homesteadAdValoremPct: NaN }, 400_000, NOW), false);
  assert.equal(isCacheRowValid({ ...baseRow(), nonHomesteadAdValoremPct: Infinity }, 400_000, NOW), false);
});

test("invalid fixed NAV cents are rejected", () => {
  assert.equal(isCacheRowValid({ ...baseRow(), nonAdValoremAmtCents: -1 }, 400_000, NOW), false);
  assert.equal(isCacheRowValid({ ...baseRow(), nonAdValoremAmtCents: 12.5 }, 400_000, NOW), false);
});

test("empty source is rejected", () => {
  assert.equal(isCacheRowValid({ ...baseRow(), source: "" }, 400_000, NOW), false);
});

test("zero sample price is rejected (backfill seed row must always miss)", () => {
  assert.equal(isCacheRowValid({ ...baseRow(), samplePrice: 0 }, 400_000, NOW), false);
});

test("hillsborough backfill seed (sample_price=0, pcts=0) is always a miss", () => {
  // Simulates what the SQL backfill writes — both pcts=0 and sample_price=0
  const seedRow: ValidInput = {
    parcelId: "pin-xyz",
    folio: "folio-xyz",
    homesteadAdValoremPct: 0,
    nonHomesteadAdValoremPct: 0,
    samplePrice: 0,
    schoolMillage: null,
    nonSchoolMillage: null,
    assessmentRatio: null,
    homesteadSchoolExemption: null,
    homesteadNonSchoolExemption: null,
    rateYear: null,
    nonAdValoremAmtCents: 0,
    source: "hillsborough-hcpa-cache-seed",
    expiresAt: new Date(Date.UTC(2027, 10, 1)),
  };
  assert.equal(isCacheRowValid(seedRow, 400_000, NOW), false);
});

test("complete millage row is valid at every positive purchase price", () => {
  const row = {
    ...baseRow(),
    homesteadAdValoremPct: 0,
    nonHomesteadAdValoremPct: 0,
    samplePrice: 0,
    schoolMillage: 5.5,
    nonSchoolMillage: 12,
    assessmentRatio: PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
    homesteadSchoolExemption: 25_000,
    homesteadNonSchoolExemption: 51_411,
    rateYear: 2026,
  };
  assert.equal(isCacheRowValid(row, 1, NOW), true);
  assert.equal(isCacheRowValid(row, 10_000_000, NOW), true);
});

test("complete millage row with a stale non-low-end ratio is rejected", () => {
  const row = {
    ...baseRow(),
    homesteadAdValoremPct: 0,
    nonHomesteadAdValoremPct: 0,
    schoolMillage: 5.5,
    nonSchoolMillage: 12,
    assessmentRatio: 1,
    homesteadSchoolExemption: 25_000,
    homesteadNonSchoolExemption: 51_411,
    rateYear: 2026,
  };
  assert.equal(isCacheRowValid(row, 400_000, NOW), false);
});

test("stale Collier 85%-basis millage rows are rejected", () => {
  const row = {
    ...baseRow(),
    homesteadAdValoremPct: 0,
    nonHomesteadAdValoremPct: 0,
    schoolMillage: 4.147,
    nonSchoolMillage: 6.3575,
    assessmentRatio: PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
    homesteadSchoolExemption: 25_000,
    homesteadNonSchoolExemption: 51_411,
    rateYear: 2026,
    source: "collier-bill-live-low-end-purchase-value-situs-v2",
  };
  assert.equal(isCacheRowValid(row, 525_000, NOW), false);
});

test("incomplete millage does not bypass legacy sample-price guard", () => {
  const row = { ...baseRow(), schoolMillage: 5.5, nonSchoolMillage: 12 };
  assert.equal(isCacheRowValid(row, 800_000, NOW), false);
});

// ── computeFromCache ──────────────────────────────────────────────

test("computeFromCache uses homestead pct when homestead=true", () => {
  const row = {
    homesteadAdValoremPct: 0.01197,
    nonHomesteadAdValoremPct: 0.0146,
    nonAdValoremAmtCents: 50_000, // $500
  };
  const result = computeFromCache(row, 400_000, true);
  assert.equal(result.adValoremTax, Math.round(400_000 * 0.01197));
  assert.equal(result.nonAdValoremTax, 500);
  assert.equal(result.annualTax, result.adValoremTax + 500);
});

test("computeFromCache uses non-homestead pct when homestead=false", () => {
  const row = {
    homesteadAdValoremPct: 0.01197,
    nonHomesteadAdValoremPct: 0.0146,
    nonAdValoremAmtCents: 0,
  };
  const result = computeFromCache(row, 400_000, false);
  assert.equal(result.adValoremTax, Math.round(400_000 * 0.0146));
  assert.equal(result.annualTax, result.adValoremTax);
});

test("computeFromCache: non-homestead tax is higher than homestead for same price", () => {
  const row = {
    homesteadAdValoremPct: 0.01197,
    nonHomesteadAdValoremPct: 0.0146,
    nonAdValoremAmtCents: 0,
  };
  const h  = computeFromCache(row, 500_000, true);
  const nh = computeFromCache(row, 500_000, false);
  assert.ok(nh.annualTax > h.annualTax);
});

test("computeFromCache: fixed NAV does not scale with purchase price", () => {
  const row = {
    homesteadAdValoremPct: 0.01197,
    nonHomesteadAdValoremPct: 0.0146,
    nonAdValoremAmtCents: 250_000, // $2500 fixed
  };
  const low  = computeFromCache(row, 300_000, true);
  const high = computeFromCache(row, 450_000, true);
  // NAV must be the same dollar amount regardless of price
  assert.equal(low.nonAdValoremTax, 2500);
  assert.equal(high.nonAdValoremTax, 2500);
  // But ad valorem scales
  assert.ok(high.adValoremTax > low.adValoremTax);
});

test("computeFromCache: rounds ad valorem to whole dollars", () => {
  const row = {
    homesteadAdValoremPct: 0.01197,
    nonHomesteadAdValoremPct: 0.0146,
    nonAdValoremAmtCents: 0,
  };
  const result = computeFromCache(row, 333_333, true);
  assert.equal(result.adValoremTax, Math.round(333_333 * 0.01197));
});

test("computeFromCache: exact millage applies Florida homestead exemptions separately", () => {
  const row = {
    homesteadAdValoremPct: 0,
    nonHomesteadAdValoremPct: 0,
    nonAdValoremAmtCents: 0,
    schoolMillage: 5,
    nonSchoolMillage: 10,
    assessmentRatio: PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
    homesteadSchoolExemption: 25_000,
    homesteadNonSchoolExemption: 51_411,
    rateYear: 2026,
  };
  const homestead = computeFromCache(row, 400_000, true);
  const nonHomestead = computeFromCache(row, 400_000, false);
  // $400k price → $340k low-end assessment.
  assert.equal(homestead.adValoremTax, 4_461);
  assert.equal(nonHomestead.adValoremTax, 5_100);
});

test("computeFromCache: Collier official parcel millage preserves full-price basis", () => {
  const row = {
    homesteadAdValoremPct: 0,
    nonHomesteadAdValoremPct: 0,
    nonAdValoremAmtCents: 0,
    schoolMillage: 4.147,
    nonSchoolMillage: 6.3575,
    assessmentRatio: 1,
    homesteadSchoolExemption: 25_000,
    homesteadNonSchoolExemption: 51_411,
    rateYear: 2026,
    source: "collier-pa-millage-situs-v2",
  };
  assert.equal(computeFromCache(row, 525_000, false).adValoremTax, 5_514);
  assert.equal(computeFromCache(row, 525_000, true).adValoremTax, 5_084);
});

test("computeFromCache: exact millage enforces the low end at arbitrary price", () => {
  const row = {
    homesteadAdValoremPct: 0,
    nonHomesteadAdValoremPct: 0,
    nonAdValoremAmtCents: 0,
    schoolMillage: 4,
    nonSchoolMillage: 8,
    assessmentRatio: 0.9,
    homesteadSchoolExemption: 25_000,
    homesteadNonSchoolExemption: 51_411,
    rateYear: 2026,
  };
  // $600k price → $510k low-end assessed; a stale 0.9 row cannot raise it.
  assert.equal(computeFromCache(row, 600_000, false).adValoremTax, 6_120);
});

test("computeFromCache phases in the additional exemption above $50k", () => {
  const row = {
    homesteadAdValoremPct: 0,
    nonHomesteadAdValoremPct: 0,
    nonAdValoremAmtCents: 0,
    schoolMillage: 0,
    nonSchoolMillage: 10,
    assessmentRatio: PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
    homesteadSchoolExemption: 25_000,
    homesteadNonSchoolExemption: 51_411,
    rateYear: 2026,
  };
  // At $51k low-end assessed value, $1k of the indexed additional exemption
  // has phased in, leaving $25k taxable after the first exemption.
  assert.equal(computeFromCache(row, 60_000, true).adValoremTax, 250);
});

// ── Source label requirements ─────────────────────────────────────

test("source labels: pinellas-formula-pending is NOT valid for cache (sample_price=0 seed)", () => {
  // A formula-pending row should never be cached as live; if stored, sample_price=0 ensures miss.
  const row: ValidInput = {
    parcelId: "1234",
    folio: "1234",
    homesteadAdValoremPct: 0.01517,
    nonHomesteadAdValoremPct: 0.0185,
    samplePrice: 0,                            // not cached as live
    nonAdValoremAmtCents: 0,
    source: "pinellas-formula-pending",
    expiresAt: new Date(Date.UTC(2027, 10, 1)),
  };
  assert.equal(isCacheRowValid(row, 400_000, NOW), false);
});

test("source labels: pinellas-bill-live is valid for cache when sample_price set", () => {
  const row: ValidInput = {
    parcelId: "1234",
    folio: "1234",
    homesteadAdValoremPct: 0.01517,
    nonHomesteadAdValoremPct: 0.0185,
    samplePrice: 400_000,
    nonAdValoremAmtCents: 0,
    source: "pinellas-bill-live",
    expiresAt: new Date(Date.UTC(2027, 10, 1)),
  };
  assert.equal(isCacheRowValid(row, 400_000, NOW), true);
});

test("source labels: manatee-formula-plus-arcgis-nav is valid for cache", () => {
  const row: ValidInput = {
    parcelId: "M123",
    folio: "M123",
    homesteadAdValoremPct: 0.01197,
    nonHomesteadAdValoremPct: 0.0146,
    samplePrice: 350_000,
    nonAdValoremAmtCents: 250_000,
    source: "manatee-formula-plus-arcgis-nav",
    expiresAt: new Date(Date.UTC(2027, 10, 1)),
  };
  assert.equal(isCacheRowValid(row, 350_000, NOW), true);
});
