import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cashBuyTaxBadge,
  cashBuyTaxHint,
  canApplyCashBuyTaxResult,
  isParcelVerifiedTaxSource,
  lookupCashBuyPropertyTax,
  sameCashBuyTaxRequest,
  type CashBuyTaxFetch,
} from "./cash-buy-property-tax";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const collierRequest = {
  address: "100 Main St, Naples, FL 34102",
  purchasePrice: 500_000,
  occupancy: "primary" as const,
};

test("Cash Buy uses an official Collier purchase-estimator result", async () => {
  const calls: string[] = [];
  const fetcher: CashBuyTaxFetch = async (input) => {
    calls.push(String(input));
    return jsonResponse({
      annualTax: 4_321,
      monthlyTax: 360.08,
      source: "county-estimator",
      parcelId: "COL-123",
      taxDistrict: "Naples",
    });
  };

  const result = await lookupCashBuyPropertyTax(collierRequest, fetcher);

  assert.equal(result.status, "verified");
  assert.equal(result.annualTax, 4_321);
  assert.equal(result.parcelId, "COL-123");
  assert.deepEqual(calls, ["/api/property-tax/county"]);
  assert.equal(isParcelVerifiedTaxSource(result.source), true);
  assert.equal(cashBuyTaxBadge(result.status), "Official estimate");
});

test("formula response is unavailable rather than shown as a purchase estimate", async () => {
  const fetcher: CashBuyTaxFetch = async () => jsonResponse({
    annualTax: null,
    source: "county-estimator-unavailable",
  });

  const result = await lookupCashBuyPropertyTax(collierRequest, fetcher);

  assert.equal(result.status, "fallback");
  assert.equal(result.annualTax, undefined);
  assert.equal(cashBuyTaxBadge(result.status), "Official unavailable");
  assert.match(cashBuyTaxHint(result.status, 0), /No formula estimate is shown/);
  assert.equal(isParcelVerifiedTaxSource(result.source), false);
});

test("pending parcel millage does not become an automatic purchase tax", async () => {
  const fetcher: CashBuyTaxFetch = async () => jsonResponse({
    annualTax: null,
    source: "collier-formula-bill-pending",
    parcelId: "COL-123",
    millageRate: 16.123,
    nonAdValoremPending: true,
  });

  const result = await lookupCashBuyPropertyTax(collierRequest, fetcher);

  assert.equal(result.status, "fallback");
  assert.equal(result.annualTax, undefined);
});

test("unavailable routes leave the tax field for manual entry", async () => {
  const fetcher: CashBuyTaxFetch = async () => jsonResponse({ useFallback: true });
  const result = await lookupCashBuyPropertyTax(collierRequest, fetcher);

  assert.equal(result.status, "fallback");
  assert.equal(result.annualTax, undefined);
  assert.match(cashBuyTaxHint(result.status, 0), /enter the annual bill manually/);
});

test("manual edits and changed inputs cannot accept an old lookup", () => {
  const request = collierRequest;
  assert.equal(sameCashBuyTaxRequest(request, request), true);
  assert.equal(
    sameCashBuyTaxRequest(request, { ...request, purchasePrice: 525_000 }),
    false,
  );
  assert.equal(
    sameCashBuyTaxRequest(request, { ...request, occupancy: "investment" }),
    false,
  );
  assert.equal(
    sameCashBuyTaxRequest(request, {
      ...request,
      address: "101 Main St, Naples, FL 34102",
    }),
    false,
  );
  assert.equal(canApplyCashBuyTaxResult(request, request, undefined), true);
  assert.equal(canApplyCashBuyTaxResult(request, request, "manual"), false);
  assert.equal(
    canApplyCashBuyTaxResult(
      { ...request, purchasePrice: 525_000 },
      request,
      undefined,
    ),
    false,
  );
  assert.equal(cashBuyTaxHint("manual", 250), "Manually entered. Editing price or property use won't overwrite this. · ≈ $250/mo");
});

test("a failed first route can fall through to a strict county route", async () => {
  const responses = [
    jsonResponse({ useFallback: true }),
    jsonResponse({
      annualTax: 2_000,
      source: "county-estimator",
      parcelId: "H-123",
    }),
  ];
  const calls: string[] = [];
  const fetcher: CashBuyTaxFetch = async (input) => {
    calls.push(String(input));
    return responses.shift()!;
  };

  const result = await lookupCashBuyPropertyTax({
    address: "100 Main St, Zephyrhills, FL 33540",
    purchasePrice: 400_000,
    occupancy: "primary",
  }, fetcher);

  assert.equal(result.status, "verified");
  assert.equal(result.annualTax, 2_000);
  assert.deepEqual(calls, ["/api/property-tax/hillsborough", "/api/property-tax/county"]);
});