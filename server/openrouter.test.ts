import nodeTest from "node:test";
import assert from "node:assert/strict";
import { completeWithOpenRouter } from "./openrouter";
import { analyzeClosingDisclosure, analyzeMortgageStatement } from "./anthropic-analyze";
import { aiUsageStore, withAiUser } from "./ai-usage";

const request = { system: "Return JSON", content: "Synthetic test", maxTokens: 64, purpose: "document" as const };
const cd = {
  propertyAddress: "123 Synthetic Test St, Tampa, FL 33602",
  lender: "Test Lender", closingDate: "2025-01-15", loanAmount: 300000,
  purchasePrice: 320000, interestRate: 6.5, loanTermMonths: 360,
  principalAndInterest: 1896.20, escrowAmount: 400, loanType: "VA",
  loanNumber: "0000123", confidence: "high", rawExtractedData: {},
};

function setup(t: any, respond: (body: any) => Response) {
  t.mock.method(aiUsageStore, "reserve", async () => ({ id: "test", userId: "synthetic-user", day: "2026-10-13" }));
  t.mock.method(aiUsageStore, "finish", async () => {});
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldDocument = process.env.OPENROUTER_DOCUMENT_MODEL;
  const oldMarket = process.env.OPENROUTER_MARKET_MODEL;
  process.env.OPENROUTER_API_KEY = "synthetic-test-key";
  delete process.env.OPENROUTER_DOCUMENT_MODEL;
  delete process.env.OPENROUTER_MARKET_MODEL;
  t.after(() => {
    for (const [name, value] of [
      ["OPENROUTER_API_KEY", oldKey], ["OPENROUTER_DOCUMENT_MODEL", oldDocument],
      ["OPENROUTER_MARKET_MODEL", oldMarket],
    ]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
  });
  return t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal((init.headers as any).Authorization, "Bearer synthetic-test-key");
    return respond(JSON.parse(String(init.body)));
  });
}

function ok(content: string, annotations: any[] = []) {
  return Response.json({ choices: [{ finish_reason: "stop", message: { content, annotations } }] });
}

test("statement uses OpenRouter without Anthropic credentials and keeps normalization", async t => {
  setup(t, body => {
    assert.equal(body.model, "anthropic/claude-haiku-4.5");
    assert.deepEqual(body.provider, { only: ["anthropic"], allow_fallbacks: false, data_collection: "deny" });
    assert.equal(body.plugins, undefined);
    return ok(JSON.stringify({ loanNumber: " 0000123 ", currentEscrowBalance: "1500" }));
  });
  const result = await analyzeMortgageStatement("Synthetic statement");
  assert.equal(result.loanNumber, "0000123");
  assert.equal(result.currentEscrowBalance, 1500);
});

test("closing disclosure preserves native PDF input and checked loan type", async t => {
  setup(t, body => {
    assert.deepEqual(body.plugins, [{ id: "file-parser", pdf: { engine: "native" } }]);
    const file = body.messages[1].content[0];
    assert.equal(file.type, "file");
    assert.equal(file.file.file_data, "data:application/pdf;base64,cGRm");
    return ok(JSON.stringify(cd));
  });
  const result = await analyzeClosingDisclosure({ pdfBuffer: Buffer.from("pdf") });
  assert.equal(result.loanType, "va");
  assert.equal(result.loanNumber, "0000123");
});

test("closing disclosure text path retains strict financial validation", async t => {
  setup(t, body => {
    assert.equal(body.plugins, undefined);
    return ok(JSON.stringify({ ...cd, loanAmount: 0 }));
  });
  await assert.rejects(analyzeClosingDisclosure({ documentText: "test" }), /valid loan amount/);
});

test("closing disclosure validation rejects invalid critical fields independently of model", async t => {
  let invalid: Record<string, unknown> = {};
  setup(t, () => ok(JSON.stringify({ ...cd, ...invalid })));
  for (const [field, value, message] of [
    ["propertyAddress", "", /property address/],
    ["loanAmount", 10000, /valid loan amount/],
    ["loanAmount", 20000000, /valid loan amount/],
    ["interestRate", 0, /valid interest rate/],
    ["interestRate", 16, /valid interest rate/],
    ["loanTermMonths", 0, /valid loan term/],
    ["loanTermMonths", 481, /valid loan term/],
    ["closingDate", null, /closing date/],
    ["closingDate", "not a date", /closing date/],
  ] as const) {
    invalid = { [field]: value };
    await assert.rejects(analyzeClosingDisclosure({ documentText: "synthetic invalid CD" }), message);
  }
});

test("market web search preserves only safe unique citations", async t => {
  setup(t, body => {
    assert.equal(body.model, "anthropic/claude-opus-4.5");
    assert.deepEqual(body.plugins, [{ id: "web", engine: "native", max_results: 5 }]);
    return ok("{}", [
      { type: "url_citation", url_citation: { url: "https://example.com/report", title: "Report" } },
      { type: "url_citation", url_citation: { url: "https://example.com/report", title: "Report" } },
      { type: "url_citation", url_citation: { url: "javascript:alert(1)" } },
    ]);
  });
  const result = await completeWithOpenRouter({ ...request, purpose: "market", webSearch: true });
  assert.deepEqual(result.citations, [{ url: "https://example.com/report", title: "Report" }]);
});

test("explicit approved document model override remains available for rollback", async t => {
  setup(t, body => {
    assert.equal(body.model, "anthropic/claude-opus-4.5");
    assert.deepEqual(body.provider, { only: ["anthropic"], allow_fallbacks: false, data_collection: "deny" });
    return ok("{}");
  });
  process.env.OPENROUTER_DOCUMENT_MODEL = "anthropic/claude-opus-4.5";
  await completeWithOpenRouter(request);
});

test("provider errors never expose upstream response bodies", async t => {
  setup(t, () => new Response("private document text and secret", { status: 402 }));
  await assert.rejects(completeWithOpenRouter(request), error => {
    assert.match((error as Error).message, /credits/);
    assert.doesNotMatch((error as Error).message, /private|secret/);
    return true;
  });
});

test("truncated and empty completions fail rather than returning partial financial data", async t => {
  let n = 0;
  setup(t, () => ++n === 1
    ? Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] })
    : ok(""));
  await assert.rejects(completeWithOpenRouter(request), /complete analysis/);
  await assert.rejects(completeWithOpenRouter(request), /empty analysis/);
});

test("missing credentials and unapproved model families fail before network", async t => {
  const fetchMock = setup(t, () => ok("{}"));
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(completeWithOpenRouter(request), /key is not configured/);
  process.env.OPENROUTER_API_KEY = "synthetic-test-key";
  process.env.OPENROUTER_DOCUMENT_MODEL = "openrouter/auto";
  await assert.rejects(completeWithOpenRouter(request), /approved Anthropic/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("malformed document JSON never leaks extraction text into errors", async t => {
  setup(t, () => ok("PRIVATE-BORROWER-DATA not json"));
  await assert.rejects(analyzeMortgageStatement("Synthetic statement"), error => {
    assert.match((error as Error).message, /invalid document data/);
    assert.doesNotMatch((error as Error).message, /PRIVATE/);
    return true;
  });
});

function test(name: string, fn: Parameters<typeof nodeTest>[1]) {
  return nodeTest(name, t => withAiUser("synthetic-user", () => fn!(t)));
}
