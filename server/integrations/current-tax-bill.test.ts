import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveCurrentTaxBill,
  type CurrentTaxBillOptions,
} from "./current-tax-bill";
import type {
  CountySlug,
  ParcelIdentity,
} from "./parcel-resolver";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function found(
  county: CountySlug,
  parcelId = "123456789",
): ParcelIdentity {
  return {
    status: "found",
    county,
    parcelId,
    situsAddress: "100 MAIN ST",
    situsCity: county === "pasco" ? "WESLEY CHAPEL" : county.toUpperCase(),
    source: "test-fixture",
  };
}

test("current bill uses actual ad-valorem plus NAV dollars only", async () => {
  let billCalls = 0;
  const result = await resolveCurrentTaxBill(
    "100 Main St, Sarasota, FL 34236",
    NOW,
    {
      skipCache: true,
      resolveParcelFn: async (county) => found(county),
      getBillFn: async () => {
        billCalls += 1;
        return {
          state: "ready",
          data: {
            total: 725.5,
            lines: [{ authority: "CDD", amount: 725.5 }],
            noAssessments: false,
            billYear: 2025,
            totalAdValorem: 4_100.25,
            totalMillage: 17.5,
            adValoremMills: [],
          },
        };
      },
    },
  );
  assert.equal(billCalls, 1);
  assert.deepEqual(result, {
    state: "ready",
    annualTax: 4_825.75,
    monthlyTax: 402.15,
    taxYear: 2025,
    adValoremTax: 4_100.25,
    nonAdValoremTax: 725.5,
    source: "tax-collector-bill-scrape",
    sourceLabel: "sarasota Tax Collector annual bill, tax year 2025 (ad valorem $4100.25 + non-ad valorem $725.50, including CDD). Tyler counties require APIFY_TOKEN in production.",
    county: "sarasota",
    parcelId: "123456789",
  });
});

test("Polk uses the verified Phenix bill result", async () => {
  let billCalled = false;
  const result = await resolveCurrentTaxBill(
    "100 Main St, Lakeland, FL 33801",
    NOW,
    {
      skipCache: true,
      resolveParcelFn: async () => found("polk"),
      getBillFn: async () => {
        billCalled = true;
        return {
          state: "ready",
          data: {
            folio: "v2:polk:123456789",
            billYear: 2025,
            lines: [{ authority: "FIRE", amount: 100 }],
            total: 100,
            fromCache: false,
            totalMillage: 15,
            adValoremMills: [{ authority: "SCHOOL", mills: 6 }],
            totalAdValorem: 2900,
          },
        };
      },
    },
  );
  assert.equal(billCalled, true);
  assert.deepEqual(result, {
    state: "ready",
    annualTax: 3000,
    monthlyTax: 250,
    taxYear: 2025,
    adValoremTax: 2900,
    nonAdValoremTax: 100,
    source: "tax-collector-bill-scrape",
    sourceLabel: "polk Tax Collector annual bill, tax year 2025 (ad valorem $2900.00 + non-ad valorem $100.00, including CDD).",
    county: "polk",
    parcelId: "123456789",
  });
});

test("missing APIFY token is an explicit operational error", async () => {
  const result = await resolveCurrentTaxBill(
    "100 Main St, Naples, FL 34102",
    NOW,
    {
      skipCache: true,
      resolveParcelFn: async (county) => found(county),
      getBillFn: async () => ({
        state: "unavailable",
        reason: "apify_token_missing",
      }),
    },
  );
  assert.equal(result.state, "unavailable");
  if (result.state !== "unavailable") return;
  assert.equal(result.reason, "live-bill-service-not-configured");
  assert.match(result.operationalError ?? "", /APIFY_TOKEN/);
});

test("ambiguous ZIP tries strict county candidates until one resolves", async () => {
  const calls: CountySlug[] = [];
  const options: CurrentTaxBillOptions = {
    skipCache: true,
    resolveParcelFn: async (county) => {
      calls.push(county);
      return county === "pasco"
        ? found("pasco")
        : { status: "not_found", county };
    },
    getBillFn: async () => ({
      state: "ready",
      data: {
        total: 0,
        lines: [],
        noAssessments: true,
        billYear: 2025,
        totalAdValorem: 3_000,
        totalMillage: 15,
        adValoremMills: [],
      },
    }),
  };
  const result = await resolveCurrentTaxBill(
    "100 Main St, Wesley Chapel, FL 33544",
    NOW,
    options,
  );
  assert.ok(calls.length >= 2);
  assert.equal(calls.at(-1), "pasco");
  assert.equal(result.state, "ready");
  if (result.state === "ready") assert.equal(result.county, "pasco");
});