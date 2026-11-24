import assert from "node:assert/strict";
import test from "node:test";
import undici, { ProxyAgent } from "undici";
import { quoteRushFetch } from "./quoterush-pause";

// Node's test runner isolates this file in its own process. Use only fixtures.
const endpoint = "https://carrier.example.invalid/test";
const fakeProxy = "http://user:fixture-only@proxy.example:80";
const init = { method: "POST", body: "{}", signal: AbortSignal.timeout(10_000) };
delete process.env.QUOTERUSH_PAUSED;
delete process.env.QUOTERUSH_PROXY_URL;

test("only QuoteRush uses the cached dispatcher; rotation and removal drain old agents", async (t) => {
  const info = t.mock.method(console, "info", () => {});
  const direct = t.mock.method(globalThis, "fetch", async () => new Response("direct"));
  const viaProxy = t.mock.method(undici, "fetch", async () => new undici.Response("proxied"));
  // No sockets are opened in this test. Observe the wrapper's drain requests,
  // not undici's internal promise-to-callback implementation of close().
  const close = t.mock.method(ProxyAgent.prototype, "close", async () => {});

  process.env.QUOTERUSH_PROXY_URL = fakeProxy;
  assert.equal(await (await quoteRushFetch(endpoint, init)).text(), "proxied");
  const first = viaProxy.mock.calls[0].arguments[1]?.dispatcher;
  assert.ok(first instanceof ProxyAgent);
  assert.equal(viaProxy.mock.calls[0].arguments[0], endpoint);
  assert.deepEqual(viaProxy.mock.calls[0].arguments[1], { ...init, dispatcher: first });
  await quoteRushFetch(endpoint);
  assert.equal(viaProxy.mock.calls[1].arguments[1]?.dispatcher, first);
  assert.equal(direct.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 0);

  process.env.QUOTERUSH_PROXY_URL = "http://replacement.example:8080";
  await quoteRushFetch(endpoint);
  assert.notEqual(viaProxy.mock.calls[2].arguments[1]?.dispatcher, first);
  assert.equal(close.mock.callCount(), 1);
  for (const absent of [undefined, "", "  "]) {
    if (absent === undefined) delete process.env.QUOTERUSH_PROXY_URL;
    else process.env.QUOTERUSH_PROXY_URL = absent;
    assert.equal(await (await quoteRushFetch(endpoint, init)).text(), "direct");
    assert.deepEqual(direct.mock.calls.at(-1)?.arguments, [endpoint, init]);
  }
  assert.equal(close.mock.callCount(), 2);
  assert.equal(viaProxy.mock.callCount(), 3);
  assert.deepEqual(info.mock.calls.map(({ arguments: args }) => args), [["quoterush proxy: enabled"]]);
});

test("proxy failures disclose no URL or password, never retry directly, and respect pause", async (t) => {
  const logs = (["info", "log", "warn", "error", "debug"] as const)
    .map(level => t.mock.method(console, level, () => {}));
  const direct = t.mock.method(globalThis, "fetch", async () => new Response());
  const viaProxy = t.mock.method(undici, "fetch", async () => { throw Error(fakeProxy); });
  process.env.QUOTERUSH_PROXY_URL = `invalid ${fakeProxy}`;
  process.env.QUOTERUSH_PAUSED = "true";
  assert.throws(() => quoteRushFetch(endpoint), { message: "QuoteRush calls are paused." });
  delete process.env.QUOTERUSH_PAUSED;
  assert.throws(() => quoteRushFetch(endpoint), { message: "Invalid QuoteRush proxy configuration." });
  assert.equal(viaProxy.mock.callCount(), 0);
  process.env.QUOTERUSH_PROXY_URL = fakeProxy;
  await assert.rejects(quoteRushFetch(endpoint), (err: Error) =>
    err.message === "QuoteRush proxy request failed." && err.cause === undefined);
  assert.equal(viaProxy.mock.callCount(), 1);
  assert.equal(direct.mock.callCount(), 0);
  // Check the boolean only, so a failing assertion cannot print a credential.
  const output = JSON.stringify(logs.flatMap(log => log.mock.calls.map(call => call.arguments)));
  assert.ok(!output.includes("proxy.example") && !output.includes("fixture-only"));
  delete process.env.QUOTERUSH_PROXY_URL;
});
