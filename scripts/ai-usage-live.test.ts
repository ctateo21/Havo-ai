// Run explicitly against the development database, never production:
// npx tsx --test scripts/ai-usage-live.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { aiUsageStore, AI_LIMITS } from "../server/ai-usage";
import { pool } from "../server/db";

test("real database atomically bounds concurrent/daily usage and retains failed attempts", async () => {
  const user = `ai-test-${randomUUID()}`;
  try {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => aiUsageStore.reserve(user, "document")));
    const accepted = results.filter(r => r.status === "fulfilled").map(r => (r as PromiseFulfilledResult<any>).value);
    assert.equal(accepted.length, AI_LIMITS.userConcurrent);
    for (const rejected of results.filter(r => r.status === "rejected")) {
      assert.equal((rejected as PromiseRejectedResult).reason.code, "AI_BUSY");
    }
    await aiUsageStore.finish(accepted[0], "document", { promptTokens: 123, completionTokens: 45, cost: .02 }, true);
    await aiUsageStore.finish(accepted[1], "document", null, false);
    for (let i = 2; i < AI_LIMITS.userDaily; i++) {
      const r = await aiUsageStore.reserve(user, i % 2 ? "market" : "document");
      await aiUsageStore.finish(r, i % 2 ? "market" : "document", null, false);
    }
    await assert.rejects(aiUsageStore.reserve(user, "market"), { code: "AI_DAILY_LIMIT" });
    const { rows: [row] } = await pool.query(`SELECT sum(attempts)::int AS attempts,
      sum(prompt_tokens)::int AS tokens, sum(reported_cost_usd)::text AS cost,
      sum(unknown_cost_attempts)::int AS unknown FROM ai_usage_daily WHERE user_id=$1`, [user]);
    assert.deepEqual(row, { attempts: 20, tokens: 123, cost: "0.02", unknown: 19 });
  } finally {
    await pool.query("DELETE FROM ai_usage_leases WHERE user_id=$1", [user]);
    await pool.query("DELETE FROM ai_usage_daily WHERE user_id=$1", [user]);
    await pool.end();
  }
});
