import assert from "node:assert/strict";
import test from "node:test";
import {
  createIfwActivityClaimHandler,
  deleteExpiredIfwActivityClaims,
  type IfwActivityClaimResult,
  type IfwActivityClaimStore,
  RoutedIfwActivityClaimStore,
} from "./ifw-activity-claims";
import { resolveManagedDataRouting } from "../managed-data-routing";

class SharedMemoryClaimStore implements IfwActivityClaimStore {
  private readonly claims = new Map<string, { userId: string; createdAt: number; expiresAt: number }>();

  async claim(input: {
    userId: string;
    dedupeKey: string;
    now: Date;
    windowMs: number;
    maxPerWindow: number;
  }): Promise<IfwActivityClaimResult> {
    const now = input.now.getTime();
    for (const [key, claim] of this.claims) {
      if (claim.userId === input.userId && claim.expiresAt <= now) this.claims.delete(key);
    }
    if ((this.claims.get(input.dedupeKey)?.expiresAt ?? 0) > now) return "duplicate";
    const recent = [...this.claims.values()].filter(
      claim => claim.userId === input.userId && claim.createdAt > now - input.windowMs,
    );
    if (recent.length >= input.maxPerWindow) return "rate_limited";
    this.claims.set(input.dedupeKey, {
      userId: input.userId,
      createdAt: now,
      expiresAt: now + input.windowMs,
    });
    return "claimed";
  }
}

const options = { windowMs: 60_000, maxPerWindow: 2 };

test("deduplicates activity across separate request-handler instances", async () => {
  const sharedStore = new SharedMemoryClaimStore();
  const firstServerHandler = createIfwActivityClaimHandler(sharedStore, options);
  const restartedServerHandler = createIfwActivityClaimHandler(sharedStore, options);
  const now = new Date("2026-08-27T12:00:00Z");

  assert.equal(
    await firstServerHandler({ userId: "user-1", dedupeKey: "user-1:save:123-main", now }),
    "claimed",
  );
  assert.equal(
    await restartedServerHandler({ userId: "user-1", dedupeKey: "user-1:save:123-main", now }),
    "duplicate",
  );
});

test("shares per-user rate limits across request-handler instances", async () => {
  const sharedStore = new SharedMemoryClaimStore();
  const serverA = createIfwActivityClaimHandler(sharedStore, options);
  const serverB = createIfwActivityClaimHandler(sharedStore, options);
  const now = new Date("2026-08-27T12:00:00Z");

  assert.equal(await serverA({ userId: "user-1", dedupeKey: "first", now }), "claimed");
  assert.equal(await serverB({ userId: "user-1", dedupeKey: "second", now }), "claimed");
  assert.equal(await serverA({ userId: "user-1", dedupeKey: "third", now }), "rate_limited");
  assert.equal(await serverB({ userId: "user-2", dedupeKey: "other-user", now }), "claimed");
});

test("continues when persistent claim storage is unavailable", async () => {
  const errors: unknown[] = [];
  const unavailableStore: IfwActivityClaimStore = {
    async claim() {
      throw new Error("database temporarily unavailable");
    },
  };
  const handler = createIfwActivityClaimHandler(unavailableStore, {
    ...options,
    onUnavailable: error => errors.push(error),
  });

  assert.equal(
    await handler({ userId: "user-1", dedupeKey: "worksheet-action" }),
    "unavailable",
  );
  assert.equal(errors.length, 1);
});

test("deletes only a bounded batch of expired claims and retains active claims", async () => {
  const now = new Date("2026-08-27T12:00:00Z");
  const claims = [
    { key: "oldest-expired", expiresAt: new Date("2026-08-27T10:00:00Z") },
    { key: "newer-expired", expiresAt: new Date("2026-08-27T11:00:00Z") },
    { key: "active", expiresAt: new Date("2026-08-27T13:00:00Z") },
  ];
  const fakePool = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /where expires_at <= \$1[\s\S]*order by expires_at[\s\S]*skip locked[\s\S]*limit \$2/i);
      const [cutoff, limit] = params as [Date, number];
      const expired = claims
        .filter(claim => claim.expiresAt <= cutoff)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, limit);
      for (const claim of expired) {
        claims.splice(claims.findIndex(candidate => candidate.key === claim.key), 1);
      }
      return { rowCount: expired.length };
    },
  };

  assert.equal(
    await deleteExpiredIfwActivityClaims(fakePool as any, { now, batchSize: 1 }),
    1,
  );
  assert.deepEqual(
    claims.map(claim => claim.key),
    ["newer-expired", "active"],
  );
});

test("Supabase read cutover makes IFW claims in the target authority", async () => {
  const calls: string[] = [];
  const source: IfwActivityClaimStore = {
    async claim() { calls.push("source"); return "claimed"; },
  };
  const target: IfwActivityClaimStore = {
    async claim() { calls.push("target"); return "duplicate"; },
  };
  const store = new RoutedIfwActivityClaimStore(
    source,
    target,
    resolveManagedDataRouting({ MANAGED_DATA_MODE: "supabase-read" }),
  );

  assert.equal(await store.claim({
    userId: "user-1",
    dedupeKey: "worksheet-action",
    now: new Date("2026-09-06T12:00:00Z"),
    windowMs: 60_000,
    maxPerWindow: 2,
  }), "duplicate");
  assert.deepEqual(calls, ["target"]);
});

test("rollback restores IFW claims to the source authority", async () => {
  const calls: string[] = [];
  const source: IfwActivityClaimStore = {
    async claim() { calls.push("source"); return "rate_limited"; },
  };
  const target: IfwActivityClaimStore = {
    async claim() { calls.push("target"); return "claimed"; },
  };
  const store = new RoutedIfwActivityClaimStore(
    source,
    target,
    resolveManagedDataRouting({
      MANAGED_DATA_MODE: "supabase-canary",
      MANAGED_DATA_ROLLBACK: "true",
    }),
  );

  assert.equal(await store.claim({
    userId: "user-1",
    dedupeKey: "worksheet-action",
    now: new Date("2026-09-06T12:00:00Z"),
    windowMs: 60_000,
    maxPerWindow: 2,
  }), "rate_limited");
  assert.deepEqual(calls, ["source"]);
});
