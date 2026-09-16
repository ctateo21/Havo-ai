import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bustLeaderboardCache,
  getLeaderboardData,
} from "./fub-leaderboard";

function emptyFubResponse(url: string): Response {
  const path = new URL(url).pathname.split("/").pop() ?? "items";
  return Response.json({ [path]: [], _metadata: { total: 0 } });
}

test("leaderboard refreshes are single-flight and stale data stays available", async () => {
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  let callsRetryAfter: string | null = null;

  globalThis.fetch = (async (input) => {
    requestCount++;
    if (callsRetryAfter && new URL(String(input)).pathname.endsWith("/calls")) {
      return new Response("", {
        status: 429,
        headers: { "retry-after": callsRetryAfter },
      });
    }
    return emptyFubResponse(String(input));
  }) as typeof fetch;

  try {
    const [first, duplicate] = await Promise.all([
      getLeaderboardData("test-key", "today"),
      getLeaderboardData("test-key", "today"),
    ]);

    assert.equal(first.refreshState, "fresh");
    assert.equal(duplicate.refreshState, "fresh");
    assert.equal(requestCount, 4, "duplicate callers must share one FUB collection");

    bustLeaderboardCache("today");
    const [cached, cachedDuplicate] = await Promise.all([
      getLeaderboardData("test-key", "today"),
      getLeaderboardData("test-key", "today"),
    ]);

    assert.equal(cached.refreshState, "cached");
    assert.equal(cachedDuplicate.refreshState, "cached");
    assert.deepEqual(cached.data, first.data);

    // The paced background refresh makes four endpoint requests at 300ms
    // intervals. Waiting here also ensures fetch is restored only after it ends.
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    const refreshed = await getLeaderboardData("test-key", "today");
    assert.equal(refreshed.refreshState, "fresh");
    assert.equal(requestCount, 8, "cached callers must not fan out refresh traffic");

    const beforeOtherPeriods = requestCount;
    const [week, month] = await Promise.all([
      getLeaderboardData("test-key", "week"),
      getLeaderboardData("test-key", "month"),
    ]);
    assert.equal(week.refreshState, "fresh");
    assert.equal(month.refreshState, "fresh");
    assert.equal(
      requestCount - beforeOtherPeriods,
      4,
      "different periods may fetch their two date-ranged sources but must reuse identical FUB reads",
    );

    const completeSnapshot = refreshed.data;
    callsRetryAfter = "0.01";
    bustLeaderboardCache("today");
    const cachedDuringRateLimit = await getLeaderboardData("test-key", "today");
    assert.equal(cachedDuringRateLimit.refreshState, "cached");
    assert.deepEqual(cachedDuringRateLimit.data, completeSnapshot);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const preserved = await getLeaderboardData("test-key", "today");
    assert.equal(preserved.refreshState, "cached");
    assert.ok(preserved.retryAfterSeconds && preserved.retryAfterSeconds > 0);
    assert.deepEqual(preserved.data, completeSnapshot);
    assert.equal(
      preserved.data.collectionWarnings,
      undefined,
      "a rate-limited refresh must not overwrite a complete snapshot with zeros",
    );
    assert.equal(requestCount, 15, "rate-limited calls must stop after the bounded retry count");

    callsRetryAfter = new Date(Date.now() + 30_000).toUTCString();
    const coldPartial = await getLeaderboardData("test-key", "yesterday");
    assert.equal(coldPartial.refreshState, "partial");
    assert.ok(coldPartial.retryAfterSeconds && coldPartial.retryAfterSeconds > 0);
    assert.ok(coldPartial.data.collectionWarnings?.includes("calls"));
    assert.equal(
      requestCount,
      16,
      "an HTTP-date shared cooldown must fail remaining metric requests fast",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});