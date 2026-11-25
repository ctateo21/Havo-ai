import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { getTableConfig } from "drizzle-orm/pg-core";
import { userInsuranceQuoteResults, type UserInsuranceQuoteResult } from "@shared/schema";
import { normalizeQuoteAddress } from "@shared/quote-address";
import {
  buildEstimateSnapshot,
  computeQuoteDelta,
  resolveCompletedSnapshot,
  parseEstimateInput,
  publicSavedQuoteResult,
  saveCompletedQuoteRun,
  topThreeSavedQuotes,
  type SavedQuoteStore,
} from "./saved-quote-results";
import { registerSavedQuoteResultRoutes } from "./saved-quote-results-routes";
import { runQuotePollingJob, type QuotePollingDependencies } from "./quoterush-background";
import type { QuoteCacheRow } from "../managed-quote-cache";
import type { QuoteRushQuote } from "./quoterush";

const ADDRESS = "100 Example St, Tampa, FL 33602";
const KEY = normalizeQuoteAddress(ADDRESS);
const DAY = 86_400_000;

function carrier(siteName: string, annualPremium: number, extra: Partial<QuoteRushQuote> = {}): QuoteRushQuote {
  return {
    siteName, annualPremium, monthlyPremium: annualPremium / 12, coverageA: 400_000,
    hurricaneDeductible: "2%", aop: "$2,500", quoteUrl: "https://carrier.example/q",
    quoteMessage: "", quoteDate: "2026-11-01", rank: 1, ...extra,
  };
}

function savedRow(overrides: Partial<UserInsuranceQuoteResult> = {}): UserInsuranceQuoteResult {
  return {
    userId: "user-1", addressNormalized: KEY, policyType: "HO3", leadId: 5,
    quotes: topThreeSavedQuotes([carrier("Carrier A", 2000)], true),
    bestCarrier: "Carrier A", bestAnnual: "2000",
    completedAt: new Date("2026-11-20T12:00:00Z"),
    estimateSnapshot: { annual: 2500 }, pendingEstimateSnapshot: null, pendingStartedAt: null,
    estimateAnnual: "2500", lowestAnnual: "2000", quoteDelta: "-500", quoteDeltaPct: "-0.2",
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

test("schema: per-user saved results table with a composite owner key", () => {
  const config = getTableConfig(userInsuranceQuoteResults);
  assert.equal(config.name, "user_insurance_quote_results");
  const columns = config.columns.map(c => c.name).sort();
  for (const name of [
    "user_id", "address_normalized", "policy_type", "lead_id", "quotes", "best_carrier",
    "best_annual", "completed_at", "estimate_snapshot", "pending_estimate_snapshot",
    "pending_started_at", "estimate_annual", "lowest_annual", "quote_delta", "quote_delta_pct",
    "created_at", "updated_at",
  ]) assert.ok(columns.includes(name), `missing ${name}`);
  assert.deepEqual(config.primaryKeys[0].columns.map(c => c.name), ["user_id", "address_normalized", "policy_type"]);
  const sql = readFileSync(new URL("../../migrations/20261125_user_insurance_quote_results.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists user_insurance_quote_results/);
  assert.match(sql, /primary key \(user_id, address_normalized, policy_type\)/);
  assert.doesNotMatch(sql, /\b(drop|delete|truncate)\b/i);
  for (const column of ["estimate_annual", "lowest_annual", "quote_delta", "quote_delta_pct"])
    assert.match(sql, new RegExp(`add column if not exists ${column} numeric`));
  const supabaseSql = readFileSync(new URL("../../supabase/migrations/2026_11_25_user_insurance_quote_results.sql", import.meta.url), "utf8");
  assert.match(supabaseSql, /enable row level security/i);
  assert.match(supabaseSql, /revoke all .* from anon, authenticated/i);
});

test("estimate snapshot keeps property facts and drops identity, contact, and report identifiers", () => {
  const request = {
    address: ADDRESS, name: "Pat Example", firstName: "Pat", lastName: "Example",
    email: "pat@example.com", phone: "202-555-0100", dateOfBirth: "1980-01-01", dob: "1980-01-01",
    previousAddress: "1 Old St", currentCarrier: "Prior Carrier", claimRecords: [{ type: "wind" }],
    policyType: "HO3", coverageA: 400_000, yearBuilt: 2004, roofYear: 2019, sqFt: 1800, constIdx: 0,
    hurrIdx: 1, aopDeductible: 2500, floodZone: "X", newPurchase: true,
    windAnswers: {
      shape: "hip",
      report: { roofToWall: "clips", inspectorName: "Inspector Example", inspectorLicense: "X1", uploadId: "upl-1", inspectionDate: "2026-01-01" },
      uploadId: "upl-2",
    },
  };
  const snapshot = buildEstimateSnapshot(request, parseEstimateInput({ annual: 2600, county: "Hillsborough", modelVersion: "m1" }));
  const json = JSON.stringify(snapshot);
  for (const forbidden of ["Pat", "pat@example.com", "202-555-0100", "1980-01-01", "Inspector Example", "upl-1", "upl-2", "1 Old St", "Prior Carrier", "claim", ADDRESS])
    assert.ok(!json.includes(forbidden), `snapshot leaked ${forbidden}`);
  assert.equal(snapshot.annual, 2600);
  assert.equal(snapshot.monthly, 216.67);
  assert.equal(snapshot.hurricaneDeductible, "5%");
  assert.equal(snapshot.construction, "Masonry");
  assert.equal(snapshot.windMitigationReport, false, "report values are ignored unless a report is declared");
  assert.equal(snapshot.county, "Hillsborough");
  assert.equal(snapshot.modelVersion, "m1");
  for (const key of ["policyType", "coverageA", "yearBuilt", "roofYear", "construction", "floodZone", "aopDeductible", "hurricaneDeductible"])
    assert.ok(snapshot[key] != null, `missing ${key}`);
  assert.doesNotMatch(json, /address|email|phone|dob|dateOfBirth|inspector|uploadId|reference|inspectionDate/i);
  assert.equal(parseEstimateInput({ annual: -5 }), null);
  assert.equal(parseEstimateInput("nope"), null);
});

test("snapshot records each wind-mitigation input as user-provided, report-confirmed, or assumed", () => {
  const base = {
    policyType: "HO3", coverageA: 350_000, yearBuilt: 2010, roofYear: 2020, constIdx: 0, hurrIdx: 0,
    aopDeductible: 2500, floodZone: "AE", roofCovering: "Meets FBC 2001", roofShape: "Gable",
    secondaryWaterResistance: "No", openingProtection: false,
  };
  const assumed = buildEstimateSnapshot({ ...base, windAnswers: { shape: "Not sure", allOpenings: "unsure", peelAndStick: "unsure" } }, null, { county: "Pinellas" });
  const wind = assumed.windMitigation as any;
  for (const key of ["roofCovering", "roofDeck", "roofToWall", "roofShape", "secondaryWaterResistance", "openingProtection"]) {
    assert.equal(wind[key].userProvided, false, key);
    assert.equal(wind[key].source, "assumed", key);
  }
  assert.equal(wind.roofDeck.value, "C");
  assert.equal(wind.roofToWall.value, "Clips");
  assert.equal(assumed.annual, null);

  const user = buildEstimateSnapshot({
    ...base, roofShape: "Hip", roofShapeUserSet: true, openingProtection: true, secondaryWaterResistance: "Yes",
    windMitigationLocks: { openingProtection: true, secondaryWaterResistance: true },
    windAnswers: { shape: "Hip", roofDeck: "B", roofToWall: "Single Wraps", roofCovering: "Meets FBC 1994" },
  }, null, { county: "Pinellas" }).windMitigation as any;
  assert.deepEqual(user.roofShape, { value: "Hip", userProvided: true, source: "user" });
  assert.deepEqual(user.roofDeck, { value: "B", userProvided: true, source: "user" });
  assert.deepEqual(user.roofToWall, { value: "Single Wraps", userProvided: true, source: "user" });
  assert.deepEqual(user.roofCovering, { value: "Meets FBC 1994", userProvided: true, source: "user" });
  assert.deepEqual(user.openingProtection, { value: true, userProvided: true, source: "user" });
  assert.deepEqual(user.secondaryWaterResistance, { value: "Yes", userProvided: true, source: "user" });

  const reported = buildEstimateSnapshot({ ...base, windAnswers: { reportAvailable: true, report: {
    reference: "REF-123", uploadId: "upl-9", inspector: "Inspector Example", inspectionDate: "2025-01-01",
    roofToWall: "Clips", roofDeck: "C", swr: "Yes", opening: "A", shape: "Hip", productApproval: "Meets FBC 2001",
    assumedFields: ["swr"],
  } } }, null);
  const r = reported.windMitigation as any;
  assert.equal(reported.windMitigationReport, true);
  assert.deepEqual(r.roofToWall, { value: "Clips", userProvided: true, source: "report" });
  assert.deepEqual(r.secondaryWaterResistance, { value: "Yes", userProvided: false, source: "assumed" });
  assert.doesNotMatch(JSON.stringify(reported), /REF-123|upl-9|Inspector Example|2025-01-01/);
});

test("estimate vs lowest quote delta math, including missing and zero estimates", () => {
  assert.deepEqual(computeQuoteDelta(2500, 2000), { estimateAnnual: 2500, lowestAnnual: 2000, quoteDelta: -500, quoteDeltaPct: -0.2 });
  assert.deepEqual(computeQuoteDelta(2000, 2600), { estimateAnnual: 2000, lowestAnnual: 2600, quoteDelta: 600, quoteDeltaPct: 0.3 });
  assert.deepEqual(computeQuoteDelta("3000", "2000.5"), { estimateAnnual: 3000, lowestAnnual: 2000.5, quoteDelta: -999.5, quoteDeltaPct: -0.3332 });
  assert.deepEqual(computeQuoteDelta(null, 2000), { estimateAnnual: null, lowestAnnual: 2000, quoteDelta: null, quoteDeltaPct: null });
  assert.deepEqual(computeQuoteDelta(undefined, 2000), { estimateAnnual: null, lowestAnnual: 2000, quoteDelta: null, quoteDeltaPct: null });
  assert.deepEqual(computeQuoteDelta(0, 2000), { estimateAnnual: 0, lowestAnnual: 2000, quoteDelta: null, quoteDeltaPct: null });
  assert.deepEqual(computeQuoteDelta(Number.NaN, 2000).quoteDelta, null);
});

test("a completed run keeps its own estimate snapshot and never adopts a newer run's pending one", () => {
  const started = new Date("2026-11-20T10:00:00Z");
  const own = { annual: 1 }, pending = { annual: 2 }, old = { annual: 3 };
  assert.deepEqual(resolveCompletedSnapshot(null, own, started), { snapshot: own, consumedPending: false });
  assert.deepEqual(resolveCompletedSnapshot({ estimateSnapshot: old, pendingEstimateSnapshot: pending, pendingStartedAt: started }, null, started),
    { snapshot: pending, consumedPending: true });
  assert.deepEqual(resolveCompletedSnapshot({ estimateSnapshot: old, pendingEstimateSnapshot: pending, pendingStartedAt: new Date(started.getTime() + 1000) }, null, started),
    { snapshot: old, consumedPending: false });
  assert.deepEqual(resolveCompletedSnapshot(null, null, started), { snapshot: null, consumedPending: false });
});

test("worker saves a successful run for the requesting user before the results email", async () => {
  const saved: QuoteCacheRow[] = [];
  const order: string[] = [];
  const cache = {
    id: 3001, addressNormalized: KEY, addressDisplay: ADDRESS, leadId: 77, status: "pending",
    quotes: [], quoteCounter: 0, quotePollAttempts: 0, quoteStablePolls: 0, quotePreviousCounter: null,
    quotePollClaimedAt: null, quotePollLeaseUntil: null, coverageA: 400_000, policyType: "HO3",
    cacheScope: "shared", propertyDataSnapshot: {}, propertyDataProvenance: {}, agencyDefaultSnapshot: {},
    consumerPropertyAnswers: {}, quoteProfileVersion: "HO3-v3", assumptions: ["Agency default — confirm"],
    triggeredAt: new Date(), completedAt: null, expiresAt: new Date(Date.now() + DAY),
    emailRecipient: "user@example.com", emailUserId: "user-1", ownerUserId: "user-1",
    emailDeliveryStatus: "pending", emailClaimedAt: null, emailFirstAttemptAt: null, emailRetryCount: 0,
    emailQuarantineAt: null, emailSentAt: null, emailError: null,
  } as unknown as QuoteCacheRow;
  const result = { status: "success" as const, leadId: 77, quoteCounter: 2, quotes: [carrier("B", 3000), carrier("A", 2000)] };
  const dependencies: QuotePollingDependencies = {
    getQuotes: async () => result,
    readQuoteCache: async () => [cache],
    updateQuoteCache: async (_id, values) => { Object.assign(cache, values); return cache; },
    claimQuoteResultEmail: async () => {
      if (cache.emailDeliveryStatus !== "pending") return undefined;
      cache.emailDeliveryStatus = "sending"; return cache;
    },
    sendResultsEmail: async () => { order.push("email"); return { status: "sent", error: null }; },
    saveOwnerResult: async row => { order.push("save"); saved.push({ ...row }); },
  };
  assert.equal(await runQuotePollingJob(3001, { dependencies, sleep: async () => {} }), "completed");
  assert.deepEqual(order, ["save", "email"]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].emailUserId, "user-1");
  assert.equal(saved[0].status, "success");

  // The real saver upserts the top 3 for that user; failures never throw.
  const calls: any[] = [];
  const store: SavedQuoteStore = {
    recordPending: async () => {},
    saveCompleted: async args => { calls.push(args); },
    listForUser: async () => [],
  };
  await saveCompletedQuoteRun(saved[0] as any, { store, mirror: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, "user-1");
  assert.equal(calls[0].addressNormalized, KEY);
  assert.deepEqual(calls[0].quotes.map((q: any) => q.siteName), ["A", "B"]);
  assert.equal(calls[0].quotes[0].quoteUrl, "https://carrier.example/q");
  await saveCompletedQuoteRun({ ...(saved[0] as any), quotes: [] }, { store, mirror: null });
  assert.equal(calls.length, 1, "no row for a run without positive quotes");
  const failing: SavedQuoteStore = { ...store, saveCompleted: async () => { throw new Error("db down"); } };
  await saveCompletedQuoteRun(saved[0] as any, { store: failing, mirror: null });
  // Another user's shared result never exposes the owner's carrier links.
  await saveCompletedQuoteRun(saved[0] as any, { store, mirror: null, userId: "user-2" });
  assert.equal(calls.at(-1).userId, "user-2");
  assert.equal(calls.at(-1).quotes[0].quoteUrl, null);
});

async function withServer(store: SavedQuoteStore, userId: string | null, run: (base: string) => Promise<void>) {
  const app = express();
  registerSavedQuoteResultRoutes(app, {
    optionalUser: async () => (userId ? { id: userId } : null),
    normalizeAddress: normalizeQuoteAddress,
    store,
    now: () => new Date("2026-11-25T12:00:00Z"),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("my-quotes: 401 for guests; own completed rows only, newest first, stale flag, no snapshots", async () => {
  const requested: string[] = [];
  const store: SavedQuoteStore = {
    recordPending: async () => {},
    saveCompleted: async () => {},
    listForUser: async userId => {
      requested.push(userId);
      return [
        savedRow({ completedAt: new Date("2026-10-01T00:00:00Z"), policyType: "HO6" }),
        savedRow({ userId: "someone-else", completedAt: new Date("2026-11-24T00:00:00Z") }),
        savedRow({ completedAt: new Date("2026-11-20T00:00:00Z") }),
        savedRow({ completedAt: null, policyType: "DP3", pendingEstimateSnapshot: { annual: 1 } }),
      ];
    },
  };
  await withServer(store, null, async base => {
    const response = await fetch(`${base}/api/insurance/my-quotes`);
    assert.equal(response.status, 401);
  });
  assert.equal(requested.length, 0);
  await withServer(store, "user-1", async base => {
    const response = await fetch(`${base}/api/insurance/my-quotes`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(requested, ["user-1"]);
    assert.equal(body.results.length, 2);
    assert.deepEqual(body.results.map((r: any) => r.policyType), ["HO3", "HO6"]);
    assert.equal(body.results[0].stale, false);
    assert.equal(body.results[1].stale, true);
    const json = JSON.stringify(body);
    assert.doesNotMatch(json, /estimateSnapshot|estimate_snapshot|pending|userId|someone-else|quoteDelta|estimateAnnual/);
    const bad = await fetch(`${base}/api/insurance/my-quotes?policyType=XX`);
    assert.equal(bad.status, 400);
  });
});

test("public saved result is stale only after 30 days", () => {
  const now = new Date("2026-11-25T00:00:00Z");
  assert.equal(publicSavedQuoteResult(savedRow({ completedAt: new Date(now.getTime() - 29 * DAY) }), now).stale, false);
  assert.equal(publicSavedQuoteResult(savedRow({ completedAt: new Date(now.getTime() - 31 * DAY) }), now).stale, true);
});
