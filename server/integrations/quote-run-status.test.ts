import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  RUN_RUNNING_MAX_AGE_MS,
  deriveQuoteRunStatus,
  latestOwnedRuns,
  runKey,
  type OwnedCacheRun,
} from "./quote-run-status";
import { registerSavedQuoteResultRoutes } from "./saved-quote-results-routes";
import type { SavedQuoteStore } from "./saved-quote-results";
import { normalizeQuoteAddress } from "@shared/quote-address";

const NOW = new Date("2026-11-25T12:00:00Z");
const MIN = 60_000;
const KEY = normalizeQuoteAddress("100 Example St, Tampa, FL 33602");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const quotes = (...annuals: number[]) => annuals.map((annualPremium, i) => ({
  siteName: `Carrier ${i + 1}`, annualPremium, monthlyPremium: annualPremium / 12, coverageA: 300_000,
  hurricaneDeductible: "2%", aop: "$2,500", quoteUrl: "https://carrier.example/q", quoteMessage: "",
  quoteDate: "2026-11-25", rank: i + 1,
}));

function cacheRun(overrides: Partial<OwnedCacheRun> = {}): OwnedCacheRun {
  return {
    id: 1, addressNormalized: KEY, policyType: "HO3", status: "pending", quotes: [], leadId: 5,
    triggeredAt: ago(2 * MIN), completedAt: null, ownerUserId: "user-1", emailUserId: "user-1",
    ...overrides,
  };
}

test("running while the pending marker is newer than the last result and inside the window", () => {
  const saved = { quotes: quotes(2000), completedAt: ago(10 * 24 * 60 * MIN), pendingStartedAt: ago(3 * MIN) };
  const result = deriveQuoteRunStatus({ saved, cache: null, now: NOW });
  assert.equal(result.status, "running");
  assert.equal(result.startedAt, ago(3 * MIN).toISOString());
  // Same marker, past the 12 min window + grace → agent follow-up.
  const expired = deriveQuoteRunStatus({
    saved: { ...saved, pendingStartedAt: ago(RUN_RUNNING_MAX_AGE_MS + 1) }, cache: null, now: NOW,
  });
  assert.equal(expired.status, "agent_follow_up");
  // Just inside the grace still running.
  assert.equal(deriveQuoteRunStatus({
    saved: { ...saved, pendingStartedAt: ago(RUN_RUNNING_MAX_AGE_MS - 1000) }, cache: null, now: NOW,
  }).status, "running");
});

test("completed once a result is newer than the marker; 0-quote success means agent follow-up", () => {
  const done = deriveQuoteRunStatus({
    saved: { quotes: quotes(1800, 2200), completedAt: ago(MIN), pendingStartedAt: ago(5 * MIN) }, cache: null, now: NOW,
  });
  assert.equal(done.status, "completed");
  const zero = deriveQuoteRunStatus({
    saved: { quotes: [], completedAt: null, pendingStartedAt: ago(5 * MIN) },
    cache: cacheRun({ status: "success", quotes: [], triggeredAt: ago(5 * MIN), completedAt: ago(MIN) }),
    now: NOW,
  });
  assert.equal(zero.status, "agent_follow_up");
  const failed = deriveQuoteRunStatus({
    saved: null,
    cache: cacheRun({ status: "failed", triggeredAt: ago(20 * MIN), completedAt: ago(8 * MIN) }),
    now: NOW,
  });
  assert.equal(failed.status, "failed");
  // Marker cleared by the worker: the newer failed cache row decides.
  const cleared = deriveQuoteRunStatus({
    saved: { quotes: quotes(2000), completedAt: ago(9 * 24 * 60 * MIN), pendingStartedAt: null },
    cache: cacheRun({ status: "success", quotes: [], triggeredAt: ago(9 * MIN), completedAt: ago(MIN) }),
    now: NOW,
  });
  assert.equal(cleared.status, "agent_follow_up");
});

test("a successful owned cache run without a saved row is backfilled", () => {
  const cache = cacheRun({ status: "success", quotes: quotes(1500), completedAt: ago(MIN) });
  const result = deriveQuoteRunStatus({ saved: null, cache, now: NOW });
  assert.equal(result.status, "completed");
  assert.equal(result.backfill, cache);
  const already = deriveQuoteRunStatus({
    saved: { quotes: quotes(1500), completedAt: ago(30 * 1000), pendingStartedAt: null }, cache, now: NOW,
  });
  assert.equal(already.backfill, null);
});

test("an older cache row never resolves a newer pending marker", () => {
  const result = deriveQuoteRunStatus({
    saved: { quotes: [], completedAt: null, pendingStartedAt: ago(2 * MIN) },
    cache: cacheRun({ status: "failed", triggeredAt: ago(60 * MIN), completedAt: ago(50 * MIN) }),
    now: NOW,
  });
  assert.equal(result.status, "running");
});

test("latestOwnedRuns keeps only this user's rows, newest per property", () => {
  const map = latestOwnedRuns("user-1", [
    cacheRun({ id: 1, triggeredAt: ago(10 * MIN) }),
    cacheRun({ id: 2, triggeredAt: ago(MIN) }),
    cacheRun({ id: 3, triggeredAt: ago(0), ownerUserId: "user-2", emailUserId: "user-2" }),
    cacheRun({ id: 4, triggeredAt: ago(5 * MIN), ownerUserId: null, emailUserId: "user-1", policyType: "HO6" }),
  ]);
  assert.equal(map.get(runKey(KEY, "HO3"))?.id, 2);
  assert.equal(map.get(runKey(KEY, "HO6"))?.id, 4);
  assert.equal(map.size, 2);
});

test("my-quotes returns own run status, backfills own success, never another user's rows", async () => {
  const savedCalls: any[] = [];
  let rows: any[] = [];
  const store: SavedQuoteStore = {
    recordPending: async () => {},
    saveCompleted: async (args: any) => {
      savedCalls.push(args);
      rows = [{
        id: 1, userId: args.userId, addressNormalized: args.addressNormalized, policyType: args.policyType,
        leadId: args.leadId ?? null, quotes: args.quotes, completedAt: args.completedAt ?? NOW,
        pendingStartedAt: null, estimateSnapshot: null, pendingEstimateSnapshot: null,
        bestCarrier: null, bestAnnualPremium: null,
      }];
    },
    listForUser: async () => rows,
  };
  const readerCalls: string[] = [];
  const app = express();
  registerSavedQuoteResultRoutes(app, {
    optionalUser: async () => ({ id: "user-1" }),
    normalizeAddress: normalizeQuoteAddress,
    store,
    now: () => NOW,
    mirror: null,
    readCacheRuns: async userId => {
      readerCalls.push(userId);
      return [
        cacheRun({ id: 7, status: "success", quotes: quotes(1700, 1600), completedAt: ago(MIN) }),
        cacheRun({ id: 8, policyType: "HO6", ownerUserId: "user-2", emailUserId: "user-2", triggeredAt: ago(MIN) }),
      ];
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/insurance/my-quotes`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(readerCalls, ["user-1"]);
    assert.equal(savedCalls.length, 1, "backfilled once from the owned success row");
    assert.equal(savedCalls[0].userId, "user-1");
    assert.deepEqual(body.runs.map((r: any) => [r.policyType, r.status]), [["HO3", "completed"]]);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].quotes[0].annualPremium, 1600);
    assert.doesNotMatch(JSON.stringify(body), /user-2|ownerUserId|emailUserId|snapshot/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
