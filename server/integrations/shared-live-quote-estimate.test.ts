import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  SHARED_ESTIMATE_MAX_AGE_MS,
  normalizeOccupancy,
  registerSharedLiveQuoteEstimateRoute,
  runMatchesScenario,
  selectSharedEstimate,
  sharedEstimateRequest,
  type SharedQuoteCandidate,
} from "./shared-live-quote-estimate";
import { normalizeQuoteAddress } from "@shared/quote-address";

const NOW = new Date("2026-11-25T12:00:00Z");
const DAY = 86_400_000;
const c = (annual: number, daysAgo: number, policyType: string, occupancy: SharedQuoteCandidate["occupancy"]): SharedQuoteCandidate =>
  ({ annual, completedAt: new Date(NOW.getTime() - daysAgo * DAY), policyType, occupancy });

test("normalizes occupancy from snapshots and capitalized cache usageType", () => {
  assert.equal(normalizeOccupancy("Primary"), "primary");
  assert.equal(normalizeOccupancy(" investment "), "investment");
  assert.equal(normalizeOccupancy("rental"), null);
  assert.equal(normalizeOccupancy(undefined), null);
});

test("occupancy and policy matching", () => {
  // Primary HO3/HO6 serve primary scenarios only.
  assert.equal(runMatchesScenario({ policyType: "HO3", occupancy: "primary" }, { policyType: "HO3", occupancy: "primary" }), true);
  assert.equal(runMatchesScenario({ policyType: "HO3", occupancy: "primary" }, { policyType: "HO3", occupancy: "investment" }), false);
  assert.equal(runMatchesScenario({ policyType: "HO6", occupancy: "primary" }, { policyType: "HO6", occupancy: "investment" }), false);
  assert.equal(runMatchesScenario({ policyType: "HO6", occupancy: "primary" }, { policyType: "HO6", occupancy: "secondary" }), false);
  // Rental HO6 serves an investment HO6 scenario.
  assert.equal(runMatchesScenario({ policyType: "HO6", occupancy: "investment" }, { policyType: "HO6", occupancy: "investment" }), true);
  assert.equal(runMatchesScenario({ policyType: "HO6", occupancy: "investment" }, { policyType: "HO6", occupancy: "primary" }), false);
  // Unknown occupancy is never reused for HO forms.
  assert.equal(runMatchesScenario({ policyType: "HO3", occupancy: null }, { policyType: "HO3", occupancy: "primary" }), false);
  // DP3 serves investment, never primary.
  assert.equal(runMatchesScenario({ policyType: "DP3", occupancy: "investment" }, { policyType: "DP3", occupancy: "investment" }), true);
  assert.equal(runMatchesScenario({ policyType: "DP3", occupancy: null }, { policyType: "DP3", occupancy: "investment" }), true);
  assert.equal(runMatchesScenario({ policyType: "DP3", occupancy: "investment" }, { policyType: "DP3", occupancy: "primary" }), false);
  // Policy form must match.
  assert.equal(runMatchesScenario({ policyType: "HO6", occupancy: "primary" }, { policyType: "HO3", occupancy: "primary" }), false);
  // Investment HO3 requests are served from DP3 quotes.
  assert.deepEqual(sharedEstimateRequest("HO3", "investment"), { policyType: "DP3", occupancy: "investment" });
  assert.deepEqual(sharedEstimateRequest("HO3", "primary"), { policyType: "HO3", occupancy: "primary" });
});

test("lowest matching premium within 90 days; number and date only; else null", () => {
  const estimate = selectSharedEstimate([
    c(2400, 5, "HO3", "primary"),
    c(1900, 40, "HO3", "primary"),
    c(1500, 91, "HO3", "primary"),      // too old
    c(1200, 2, "HO3", "investment"),    // wrong occupancy
  ], { policyType: "HO3", occupancy: "primary" }, NOW);
  assert.deepEqual(estimate, {
    annual: 1900, monthly: 158.33,
    quotedDate: new Date(NOW.getTime() - 40 * DAY).toISOString(),
    source: "recent_live_quote",
  });
  assert.equal(selectSharedEstimate([c(1500, 91, "HO3", "primary")], { policyType: "HO3", occupancy: "primary" }, NOW), null);
  assert.equal(selectSharedEstimate([], { policyType: "HO3", occupancy: "primary" }, NOW), null);
  assert.equal(SHARED_ESTIMATE_MAX_AGE_MS, 90 * DAY);
});

test("route: guests allowed, returns only the estimate fields, falls back to null, rate-limited", async () => {
  const reads: Array<[string, string, string]> = [];
  const app = express();
  registerSharedLiveQuoteEstimateRoute(app, {
    normalizeAddress: normalizeQuoteAddress,
    now: () => NOW,
    clientKey: () => "test-client",
    readCandidates: async (address, policyType, since) => {
      reads.push([address, policyType, since.toISOString()]);
      return [c(2100, 3, "HO3", "primary"), c(3000, 3, "DP3", "investment")];
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (q: string) => fetch(`${base}/api/insurance/shared-estimate?${q}`);
  try {
    const address = encodeURIComponent("100 Example St, Tampa, FL 33602");
    const primary = await (await get(`address=${address}&policyType=HO3&occupancy=primary`)).json();
    assert.deepEqual(Object.keys(primary.estimate).sort(), ["annual", "monthly", "quotedDate", "source"]);
    assert.equal(primary.estimate.annual, 2100);
    assert.equal(reads[0][0], normalizeQuoteAddress("100 Example St, Tampa, FL 33602"));
    assert.equal(reads[0][2], new Date(NOW.getTime() - 90 * DAY).toISOString());
    const investment = await (await get(`address=${address}&policyType=HO3&occupancy=investment`)).json();
    assert.equal(investment.estimate.annual, 3000, "investment never receives the primary HO3 quote");
    assert.equal(reads[1][1], "DP3");
    const unknown = await (await get(`address=${address}&policyType=HO6&occupancy=primary`)).json();
    assert.equal(unknown.estimate, null);
    assert.equal((await get(`address=x&policyType=HO3`)).status, 400);
    let limited = false;
    for (let i = 0; i < 65 && !limited; i++) {
      limited = (await get(`address=${address}&policyType=HO3&occupancy=primary`)).status === 429;
    }
    assert.equal(limited, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
