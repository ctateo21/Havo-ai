import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const routes = readFileSync("server/routes.ts", "utf8");
const sourceFile = ts.createSourceFile("routes.ts", routes, ts.ScriptTarget.Latest, true);
let helper: ts.FunctionDeclaration | undefined;
const overrides: Array<{ source: string; position: number }> = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "createFollowUpBossContact") {
    helper = node;
  }
  if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "createFollowUpBossContact") {
    const argument = node.arguments[0];
    if (argument && ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === "source") {
          assert.ok(ts.isStringLiteral(property.initializer));
          overrides.push({ source: property.initializer.text, position: node.getStart(sourceFile) });
        }
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(sourceFile);
assert.ok(helper);
const helperJs = ts.transpileModule(helper.getText(sourceFile), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test("FUB event source override leaves defaults and event type unchanged", async () => {
  const events: Array<Record<string, unknown>> = [];
  // Exercise the real helper without loading routes, starting jobs, accessing
  // credentials, or making any network requests.
  const send = new Function(
    "process", "console", "fetch", "FUB_AGENT_IDS", "normalizePhoneDigits",
    "formatReferralBlock", "findFubPersonByEmail", "fubHeaders", "formatPhoneDisplay",
    `${helperJs}; return createFollowUpBossContact;`,
  )(
    { env: { FOLLOWUPBOSS_API_KEY: "mock-only" } },
    { log() {}, warn() {}, error() {} },
    async (url: string, options: RequestInit) => {
      if (url.endsWith("/events")) events.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ id: 101 }), { status: 200 });
    },
    {}, (phone: string) => phone, () => "", async () => null,
    () => ({}), (phone: string) => phone,
  );
  const input = {
    firstName: "Test", lastName: "Only", email: "test@example.com", phone: "",
  };
  await send(input);
  await send({ ...input, source: "havofl.com - INSURANCE LIVE QUOTE" });
  assert.equal(events[0].source, "Tateo & Co Website");
  assert.equal(events[1].source, "havofl.com - INSURANCE LIVE QUOTE");
  assert.equal(events[0].type, "Property Inquiry");
  assert.equal(events[1].type, "Property Inquiry");
});

test("only qr-start overrides the FUB lead source", () => {
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].source, "havofl.com - INSURANCE LIVE QUOTE");
  assert.ok(overrides[0].position > routes.indexOf('"/api/insurance/qr-start"'));
  assert.ok(overrides[0].position < routes.indexOf('"/api/insurance/qr-quotes"'));
});