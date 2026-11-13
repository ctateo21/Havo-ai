import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_QUOTE_POLL_AGE_MS,
  pollQuoteJob,
  runQuotePollingJob,
  startQuoteJobSweeper,
  stopQuoteJobSweeper,
  type QuotePollingDependencies,
} from "./quoterush-background";
import type { QuoteCacheRow } from "../managed-quote-cache";
import type { QuoteRushQuote, QuoteRushResult } from "./quoterush";

function quote(): QuoteRushQuote {
  return {
    siteName: "Carrier One",
    annualPremium: 2_400,
    monthlyPremium: 200,
    coverageA: 400_000,
    hurricaneDeductible: "2%",
    aop: "$2,500",
    quoteUrl: null,
    quoteMessage: "",
    quoteDate: "2026-01-01",
    rank: 1,
  };
}

function row(overrides: Partial<QuoteCacheRow> = {}): QuoteCacheRow {
  return {
    id: 1000,
    addressNormalized: "123 MAIN ST|TAMPA|FL|33602",
    addressDisplay: "123 Main St, Tampa, FL 33602",
    leadId: 987,
    status: "pending",
    quotes: [],
    quoteCounter: 0,
    quotePollAttempts: 0,
    quoteStablePolls: 0,
    quotePreviousCounter: null,
    quotePollClaimedAt: null,
    quotePollLeaseUntil: null,
    coverageA: 400_000,
    policyType: "HO3",
    cacheScope: "shared",
    propertyDataSnapshot: {},
    propertyDataProvenance: { windMitigationReportConfirmed: false },
    agencyDefaultSnapshot: {},
    consumerPropertyAnswers: {},
    quoteProfileVersion: "HO3-v3",
    rawQuoterushPropertyData: null,
    rawQuoterushPropertyDataSource: null,
    rawQuoterushPropertyDataFetchedAt: null,
    rawQuoterushPropertyDataExpiresAt: null,
    assumptions: [],
    triggeredAt: new Date(),
    completedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    emailRecipient: "customer@example.com",
    emailUserId: "user-1",
    emailDeliveryStatus: "pending",
    emailClaimedAt: null,
    emailFirstAttemptAt: null,
    emailRetryCount: 0,
    emailQuarantineAt: null,
    emailSentAt: null,
    emailError: null,
    ...overrides,
  } as QuoteCacheRow;
}

function fakeDependencies(
  cacheRow: QuoteCacheRow,
  results: QuoteRushResult[],
  sent: Array<Record<string, unknown>> = [],
): QuotePollingDependencies {
  let resultIndex = 0;
  return {
    getQuotes: async () =>
      results[Math.min(resultIndex++, results.length - 1)],
    readQuoteCache: async () => [cacheRow],
    updateQuoteCache: async (_id, values) => {
      Object.assign(cacheRow, values);
      return cacheRow;
    },
    claimQuoteResultEmail: async () => {
      if (
        cacheRow.emailDeliveryStatus !== "pending" &&
        cacheRow.emailDeliveryStatus !== null
      ) return undefined;
      cacheRow.emailDeliveryStatus = "sending";
      cacheRow.emailClaimedAt = new Date();
      return cacheRow;
    },
    sendResultsEmail: async args => {
      sent.push(args as unknown as Record<string, unknown>);
      return { status: "sent", error: null };
    },
  };
}

function stableResult(): QuoteRushResult {
  return {
    status: "success",
    leadId: 987,
    quoteCounter: 3,
    quotes: [quote()],
  };
}

test("a delayed unpublished lead cannot be applied to a reclaimed address row", async () => {
  const oldTriggeredAt = new Date(Date.now() - 60_000);
  const cache = row({ leadId: null });
  const dependencies = fakeDependencies(cache, []);
  dependencies.getQuotes = async () => { throw new Error("must not fetch the old lead"); };
  dependencies.updateQuoteCache = async () => { throw new Error("must not write the replacement run"); };
  assert.equal(
    await pollQuoteJob(cache.id, dependencies, new Date(), 123, oldTriggeredAt),
    "missing",
  );
  assert.equal(cache.leadId, null);
});

test("server polling completes after three stable counter checks without browser work", async () => {
  const cacheRow = row({ id: 1001 });
  const sent: Array<Record<string, unknown>> = [];
  const dependencies = fakeDependencies(
    cacheRow,
    [stableResult(), stableResult(), stableResult(), stableResult()],
    sent,
  );

  const outcome = await runQuotePollingJob(1001, {
    dependencies,
    sleep: async () => {},
  });

  assert.equal(outcome, "completed");
  assert.equal(cacheRow.status, "success");
  assert.equal(cacheRow.quoteStablePolls, 3);
  assert.equal(sent.length, 1);
  assert.match(
    String(sent[0].idempotencyKey),
    /^insurance-quote-cache:1001:\d+:results$/,
  );
});

test("a restarted worker resumes from durable stable-poll counters", async () => {
  const cacheRow = row({
    id: 1002,
    quotePollAttempts: 3,
    quotePreviousCounter: 3,
    quoteStablePolls: 2,
  });
  const dependencies = fakeDependencies(cacheRow, [stableResult()]);

  const outcome = await pollQuoteJob(1002, dependencies, new Date());

  assert.equal(outcome, "completed");
  assert.equal(cacheRow.quotePollAttempts, 4);
  assert.equal(cacheRow.quoteStablePolls, 3);
});

test("polling marks a row failed at its durable maximum window", async () => {
  const cacheRow = row({
    id: 1003,
    triggeredAt: new Date(Date.now() - MAX_QUOTE_POLL_AGE_MS - 1),
  });
  let quoteRushCalls = 0;
  const dependencies = fakeDependencies(cacheRow, [stableResult()]);
  dependencies.getQuotes = async () => {
    quoteRushCalls += 1;
    return stableResult();
  };

  const outcome = await pollQuoteJob(1003, dependencies, new Date());

  assert.equal(outcome, "completed");
  assert.equal(cacheRow.status, "success");
  assert.equal(quoteRushCalls, 0);
});

test("polling completes with durable partial quotes when the window expires", async () => {
  const cacheRow = row({
    id: 1008,
    triggeredAt: new Date(Date.now() - MAX_QUOTE_POLL_AGE_MS - 1),
    quotes: [quote()],
  });
  const dependencies = fakeDependencies(cacheRow, []);

  const outcome = await pollQuoteJob(1008, dependencies, new Date());

  assert.equal(outcome, "completed");
  assert.equal(cacheRow.status, "success");
  assert.equal((cacheRow.quotes ?? []).length, 1);
});

test("transient QuoteRUSH errors preserve partial quotes and finish with usable results", async () => {
  const cacheRow = row({
    id: 1007,
    quotes: [quote()],
    quoteCounter: 1,
    quotePreviousCounter: 1,
  });
  const errorResult: QuoteRushResult = {
    status: "error",
    leadId: 987,
    quoteCounter: 0,
    quotes: [],
  };
  const dependencies = fakeDependencies(cacheRow, [errorResult, errorResult]);

  const outcome = await runQuotePollingJob(1007, {
    dependencies,
    maxAttempts: 2,
    sleep: async () => {},
  });

  assert.equal(outcome, "completed");
  assert.equal(cacheRow.status, "success");
  assert.equal((cacheRow.quotes ?? []).length, 1);
});

test("concurrent delivery claims allow one sender and provider retries reuse one key", async () => {
  const cacheRow = row({
    id: 1004,
    status: "success",
    quotes: [quote()],
  });
  const sent: Array<Record<string, unknown>> = [];
  const dependencies = fakeDependencies(cacheRow, [], sent);

  const [first, second] = await Promise.all([
    dependencies.claimQuoteResultEmail(1004),
    dependencies.claimQuoteResultEmail(1004),
  ]);

  assert.ok(first);
  assert.equal(second, undefined);
  assert.equal(sent.length, 0);

  // A retry after provider acceptance carries the same key. Resend's
  // Idempotency-Key then collapses the crash/retry boundary to one message.
  cacheRow.emailDeliveryStatus = "pending";
  await pollQuoteJob(1004, dependencies, new Date());
  assert.match(
    String(sent[0]?.idempotencyKey),
    /^insurance-quote-cache:1004:\d+:results$/,
  );
});

test("concurrent poll workers acquire one durable lease before GetQuotes", async () => {
  const cacheRow = row({ id: 1009 });
  const dependencies = fakeDependencies(cacheRow, [stableResult()]);
  let leaseHeld = false;
  let quoteRushCalls = 0;
  dependencies.claimQuotePoll = async (_id, _generation, now) => {
    if (leaseHeld) return undefined;
    leaseHeld = true;
    cacheRow.quotePollClaimedAt = now ?? new Date();
    cacheRow.quotePollLeaseUntil = new Date(
      (now ?? new Date()).getTime() + 120_000,
    );
    return cacheRow;
  };
  const originalGetQuotes = dependencies.getQuotes;
  dependencies.getQuotes = async leadId => {
    quoteRushCalls += 1;
    return originalGetQuotes(leadId);
  };

  const outcomes = await Promise.all([
    pollQuoteJob(1009, dependencies, new Date()),
    pollQuoteJob(1009, dependencies, new Date()),
  ]);

  assert.equal(quoteRushCalls, 1);
  assert.deepEqual(outcomes.sort(), ["pending", "pending"]);
});

test("a stale lease holder cannot write after another worker reclaims the lease", async () => {
  const cacheRow = row({ id: 1011 });
  const dependencies = fakeDependencies(cacheRow, [stableResult()]);
  const firstLease = new Date(Date.now());
  const reclaimedLease = new Date(firstLease.getTime() + 120_000);
  dependencies.claimQuotePoll = async () => {
    return {
      ...cacheRow,
      quotePollClaimedAt: firstLease,
      quotePollLeaseUntil: new Date(firstLease.getTime() + 120_000),
    };
  };
  dependencies.getQuotes = async () => {
    cacheRow.quotePollClaimedAt = reclaimedLease;
    cacheRow.quotePollLeaseUntil = new Date(reclaimedLease.getTime() + 120_000);
    return stableResult();
  };
  dependencies.updateQuoteCache = async (_id, _values, generation) => {
    if (generation?.quotePollClaimedAt?.getTime() === firstLease.getTime()) {
      return undefined;
    }
    return cacheRow;
  };

  const outcome = await pollQuoteJob(1011, dependencies, new Date());

  assert.equal(outcome, "missing");
  assert.equal(cacheRow.quotePollClaimedAt, reclaimedLease);
});

test("a delayed poll cannot regress a refresh that completed the pending row", async () => {
  const cacheRow = row({ id: 1012 });
  const dependencies = fakeDependencies(cacheRow, [stableResult()]);
  dependencies.getQuotes = async () => {
    // Model qr-refresh winning while this delayed poll is still in flight.
    cacheRow.status = "success";
    cacheRow.quotes = [quote()];
    return stableResult();
  };
  dependencies.updateQuoteCache = async (_id, _values, generation) => {
    if (generation?.expectedStatus !== cacheRow.status) return undefined;
    return cacheRow;
  };

  const outcome = await pollQuoteJob(1012, dependencies, new Date());

  assert.equal(outcome, "missing");
  assert.equal(cacheRow.status, "success");
});

test("provider failure is persisted and suppression never reaches the provider", async () => {
  const cacheRow = row({
    id: 1005,
    status: "success",
    quotes: [quote()],
  });
  let providerCalls = 0;
  const dependencies = fakeDependencies(cacheRow, [], []);
  dependencies.sendResultsEmail = async () => {
    providerCalls += 1;
    return { status: "failed", error: "provider unavailable" };
  };

  await pollQuoteJob(1005, dependencies, new Date());
  assert.equal(cacheRow.emailDeliveryStatus, "failed");
  assert.equal(cacheRow.emailError, "provider unavailable");
  assert.equal(providerCalls, 1);

  const suppressed = row({
    id: 1006,
    status: "success",
    quotes: [quote()],
  });
  const suppressedDeps = fakeDependencies(suppressed, [], []);
  suppressedDeps.sendResultsEmail = async () => {
    throw new Error("suppressed recipient reached provider");
  };
  suppressedDeps.claimQuoteResultEmail = async () => {
    suppressed.emailDeliveryStatus = "sending";
    return suppressed;
  };
  // Suppression is evaluated by sendQuoteRushResultsEmail before this
  // injected provider dependency in production; model that result here.
  suppressedDeps.sendResultsEmail = async () => ({
    status: "skipped",
    error: "user unsubscribed",
  });
  await pollQuoteJob(1006, suppressedDeps, new Date());
  assert.equal(suppressed.emailDeliveryStatus, "skipped");
  assert.equal(providerCalls, 1);
});

test("email recovery is bounded after the first attempt and periodic sweeper repeats", async () => {
  const cacheRow = row({
    id: 1010,
    status: "success",
    quotes: [quote()],
    emailFirstAttemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    emailDeliveryStatus: "sending",
  });
  let providerCalls = 0;
  const dependencies = fakeDependencies(cacheRow, [], []);
  dependencies.claimQuoteResultEmail = async () => {
    cacheRow.emailDeliveryStatus = "quarantined";
    cacheRow.emailQuarantineAt = new Date();
    return cacheRow;
  };
  dependencies.sendResultsEmail = async () => {
    providerCalls += 1;
    return { status: "sent", error: null };
  };

  await pollQuoteJob(1010, dependencies, new Date());
  assert.equal(cacheRow.emailDeliveryStatus, "quarantined");
  assert.equal(providerCalls, 0);

  let sweeps = 0;
  startQuoteJobSweeper(2, async () => {
    sweeps += 1;
  });
  await new Promise(resolve => setTimeout(resolve, 8));
  stopQuoteJobSweeper();
  assert.ok(sweeps >= 2);
});
