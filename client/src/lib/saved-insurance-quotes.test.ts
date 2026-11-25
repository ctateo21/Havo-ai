import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  EXPLAINERS_OPEN_BY_DEFAULT,
  GUEST_LIVE_QUOTE_PROMPT,
  findSavedQuoteForAddress,
  insuranceCardSummary,
  quoteEstimatePayload,
  type SavedQuoteResult,
} from "./saved-insurance-quotes";

function result(overrides: Partial<SavedQuoteResult> = {}): SavedQuoteResult {
  return {
    addressNormalized: "100 example st tampa fl 33602",
    policyType: "HO3",
    leadId: 1,
    completedAt: "2026-11-20T12:00:00.000Z",
    stale: false,
    bestCarrier: "Carrier A",
    bestAnnual: 2000,
    quotes: [{ siteName: "Carrier A", annualPremium: 2000, monthlyPremium: 166.67, coverageA: 400000, hurricaneDeductible: "2%", aop: "$2,500", quoteUrl: null, quoteDate: "", rank: 1 }],
    ...overrides,
  };
}

test("dashboard card shows the live quote when one is saved, else the estimate", () => {
  const quoted = insuranceCardSummary(2600, true, result());
  assert.equal(quoted.status, "Quoted");
  assert.equal(quoted.annual, 2000);
  assert.equal(quoted.monthly, 166.67);
  assert.equal(quoted.carrier, "Carrier A");
  assert.equal(quoted.quotedDate, "Nov 20, 2026");
  const estimate = insuranceCardSummary(2400, true, null);
  assert.deepEqual([estimate.status, estimate.annual, estimate.monthly, estimate.carrier], ["Estimate", 2400, 200, null]);
  assert.equal(insuranceCardSummary(undefined, false, null).status, "Not started");
  assert.equal(insuranceCardSummary(2400, true, result({ quotes: [] })).status, "Estimate");
});

test("saved results match addresses with the server's normalization and prefer the policy type", () => {
  const list = [
    result({ policyType: "HO6", completedAt: "2026-11-22T00:00:00.000Z" }),
    result({ policyType: "HO3" }),
    result({ addressNormalized: "200 other st" }),
  ];
  assert.equal(findSavedQuoteForAddress(list, "100 Example St., Tampa, FL 33602", "HO3")?.policyType, "HO3");
  assert.equal(findSavedQuoteForAddress(list, "100  EXAMPLE ST, TAMPA, FL 33602")?.policyType, "HO6");
  assert.equal(findSavedQuoteForAddress(list, "300 Missing Rd"), null);
  assert.equal(findSavedQuoteForAddress(undefined, "100 Example St"), null);
});

test("qr-start estimate uses the manual premium, else the rounded midpoint", () => {
  assert.deepEqual(quoteEstimatePayload(null, 2399.6, "Hillsborough"), { annual: 2400, monthly: 200, county: "Hillsborough", modelVersion: "havo-insurance-estimate-v1" });
  assert.equal(quoteEstimatePayload(3000, 2399.6, null)?.annual, 3000);
  assert.equal(quoteEstimatePayload(null, 0, null), null);
});

test("guest prompt and collapsed explainers are wired into the insurance page", () => {
  assert.equal(GUEST_LIVE_QUOTE_PROMPT, "Create an account to get live carrier quotes and save them");
  assert.deepEqual(EXPLAINERS_OPEN_BY_DEFAULT, { rebuild: false, coverageDetails: false });
  const page = readFileSync(new URL("../pages/insurance.tsx", import.meta.url), "utf8");
  const form = readFileSync(new URL("../components/insurance/sourced-insurance-form.tsx", import.meta.url), "utf8");
  assert.match(page, /onClick=\{\(\) => void requireAccount\(\)\}[\s\S]{0,120}\{GUEST_LIVE_QUOTE_PROMPT\}/);
  assert.match(page, /<details[\s\S]{0,200}open=\{EXPLAINERS_OPEN_BY_DEFAULT\.coverageDetails\}/);
  assert.match(form, /<details[^>]*open=\{EXPLAINERS_OPEN_BY_DEFAULT\.rebuild\}/);
  assert.match(page, /Real-time carrier rates via Tateo &amp; Co/);
  assert.match(page, /estimate: quoteEstimate/);
});
