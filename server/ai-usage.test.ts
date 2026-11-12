import test from "node:test";
import assert from "node:assert/strict";
import { aiUsageStore, AiLimitError, parseUsage, withAiUser } from "./ai-usage";
import { completeWithOpenRouter } from "./openrouter";

const input = { purpose: "document" as const, system: "synthetic", content: "synthetic", maxTokens: 10 };

function setup(t: any) {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "synthetic";
  t.after(() => {
    if (original === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = original;
  });
}

test("unauthenticated calls cannot reach accounting or provider", async t => {
  setup(t);
  const reserve = t.mock.method(aiUsageStore, "reserve", async () => { throw new Error("unexpected"); });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected"); });
  await assert.rejects(completeWithOpenRouter(input), { code: "AI_AUTH_REQUIRED", status: 401 });
  assert.equal(reserve.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("daily and concurrent denials reach caller without provider calls or retries", async t => {
  setup(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected"); });
  for (const code of ["AI_DAILY_LIMIT", "AI_BUSY"]) {
    const mock = t.mock.method(aiUsageStore, "reserve", async () => { throw new AiLimitError(code, "Wait", 180); });
    await assert.rejects(withAiUser("user-a", () => completeWithOpenRouter(input)), { code, retryAfter: 180 });
    mock.mock.restore();
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("accounting outage fails closed without exposing database details", async t => {
  setup(t);
  t.mock.method(aiUsageStore, "reserve", async () => { throw new Error("secret database URI"); });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected"); });
  await assert.rejects(withAiUser("user-a", () => completeWithOpenRouter(input)), error => {
    assert.equal((error as AiLimitError).status, 503);
    assert.doesNotMatch((error as Error).message, /secret|URI/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("user context stays isolated and only aggregate usage is finalized", async t => {
  setup(t);
  t.mock.method(aiUsageStore, "reserve", async userId => ({ id: userId, userId, day: "2026-10-13" }));
  const finish = t.mock.method(aiUsageStore, "finish", async () => {});
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.03, private: "NEVER STORE" },
    choices: [{ finish_reason: "stop", message: { content: "PRIVATE DOCUMENT OUTPUT" } }],
  }));
  await Promise.all(["user-a", "user-b"].map(user => withAiUser(user, () => completeWithOpenRouter(input))));
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(finish.mock.calls.map(c => c.arguments[0].userId).sort(), ["user-a", "user-b"]);
  for (const call of finish.mock.calls) {
    assert.deepEqual(call.arguments[2], { promptTokens: 100, completionTokens: 20, cost: 0.03 });
    assert.equal(call.arguments[3], true);
    assert.doesNotMatch(JSON.stringify(call.arguments), /PRIVATE|NEVER/);
  }
});

test("charged incomplete responses record usage and failures without retries", async t => {
  setup(t);
  t.mock.method(aiUsageStore, "reserve", async userId => ({ id: "test", userId, day: "2026-10-13" }));
  const finish = t.mock.method(aiUsageStore, "finish", async () => {});
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.1 },
    choices: [{ finish_reason: "length", message: { content: "partial" } }],
  }));
  await assert.rejects(withAiUser("user", () => completeWithOpenRouter(input)), /complete analysis/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(finish.mock.calls[0].arguments[2]?.cost, 0.1);
  assert.equal(finish.mock.calls[0].arguments[3], false);
});

test("unknown costs remain unknown; invalid counters cannot contaminate aggregates", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: -1, completion_tokens: Infinity, cost: -1 }),
    { promptTokens: 0, completionTokens: 0, cost: null });
  assert.equal(parseUsage({ cost: 0 }).cost, 0);
  assert.equal(parseUsage(undefined).cost, null);
});

test("oversized inputs and output limits are rejected before admission", async t => {
  setup(t);
  const reserve = t.mock.method(aiUsageStore, "reserve", async () => { throw new Error("unexpected"); });
  for (const request of [
    { ...input, maxTokens: 8193 },
    { ...input, maxTokens: -1 },
    { ...input, maxTokens: 1.5 },
    { ...input, content: "x".repeat(15 * 1024 * 1024) },
  ]) {
    await assert.rejects(withAiUser("user", () => completeWithOpenRouter(request)), /supported size/);
  }
  assert.equal(reserve.mock.callCount(), 0);
});

test("provider failure consumes one attempt and finalizes unknown cost without a retry", async t => {
  setup(t);
  const reserve = t.mock.method(aiUsageStore, "reserve", async userId => ({ id: "test", userId, day: "2026-10-13" }));
  const finish = t.mock.method(aiUsageStore, "finish", async () => {});
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("PRIVATE", { status: 429 }));
  await assert.rejects(withAiUser("user", () => completeWithOpenRouter(input)), /busy/);
  assert.equal(reserve.mock.callCount(), 1);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(finish.mock.calls[0].arguments[2], null);
  assert.equal(finish.mock.calls[0].arguments[3], false);
});
