import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { interestEventSchema, interestSignupSchema, signupRecord } from "./b2b-interest-schema";
import { confirmationEmail, MAILING_ADDRESS, type InterestRow } from "./integrations/b2b-interest-delivery";
import { requireInterestAdmin } from "./b2b-interest-routes";
import { supabaseAdmin } from "./supabase";

const signup = {
  id: randomUUID(), sessionId: randomUUID(), name: "Test Agent", email: "AGENT@example.com",
  company: "Test Company", role: "realtor", buyersPerYear: "11_25", tier: "agent",
  consent: true, website: "", utmSource: "campaign", utmMedium: "email", utmCampaign: "launch",
};
test("all tiers and roles validate; attribution and lowercase email persist", () => {
  for (const tier of ["agent", "loan_officer", "brokerage"]) {
    for (const role of ["realtor", "loan_officer", "broker_owner", "insurance_agent"]) {
      const row = signupRecord(interestSignupSchema.parse({ ...signup, tier, role }));
      assert.equal(row.email, "agent@example.com");
      assert.equal(row.utm_campaign, "launch");
      assert.equal(row.tier, tier);
      assert.equal(row.role, role);
    }
  }
});
test("invalid inputs, honeypots, unconsented requests and test flags are rejected", () => {
  for (const change of [
    { email: "invalid" }, { consent: false }, { website: "https://spam.test" },
    { name: " " }, { company: "" }, { role: "admin" }, { tier: "free" },
    { buyersPerYear: "100" }, { utmSource: "a".repeat(201) }, { is_test: true }, { card: "1234" },
  ]) assert.equal(interestSignupSchema.safeParse({ ...signup, ...change }).success, false);
});
test("only page views and tier clicks are publicly writable", () => {
  const base = { id: randomUUID(), sessionId: randomUUID() };
  assert.equal(interestEventSchema.safeParse({ ...base, eventType: "page_view", tier: null }).success, true);
  assert.equal(interestEventSchema.safeParse({ ...base, eventType: "tier_click", tier: "brokerage" }).success, true);
  assert.equal(interestEventSchema.safeParse({ ...base, eventType: "tier_click", tier: null }).success, false);
  assert.equal(interestEventSchema.safeParse({ ...base, eventType: "popup_submission", tier: "agent" }).success, false);
});
test("confirmation is escaped, compliant, and never implies a paid trial", () => {
  const row = { ...signupRecord(interestSignupSchema.parse(signup)), name: "<script>attack</script>",
    unsubscribe_token: randomUUID() } as InterestRow;
  const mail = confirmationEmail(row);
  assert.ok(mail.text.includes(MAILING_ADDRESS));
  assert.match(mail.text, /Christian will reach out personally/);
  assert.match(mail.text, /no payment was collected/);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.doesNotMatch(mail.html, /<script>/);
  assert.match(mail.headers["List-Unsubscribe"], /https:\/\/havofl.com\/api\/agents\/unsubscribe\?token=/);
  assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});
test("admin results reject anonymous callers without trusting client claims", async () => {
  let status = 0;
  const res = { setHeader() {}, status(v: number) { status = v; return this; }, json() {} };
  assert.equal(await requireInterestAdmin({ headers: {} } as any, res as any), false);
  assert.ok([401, 503].includes(status));
});

test("admin authorization checks the server-verified identity, not client role claims", async t => {
  if (!supabaseAdmin) { t.skip("Supabase client unavailable"); return; }
  let email = "ordinary-user@example.com";
  t.mock.method(supabaseAdmin.auth, "getUser", async () => ({
    data: { user: { id: randomUUID(), email } }, error: null,
  }));
  let status = 0;
  const res = { setHeader() {}, status(v: number) { status = v; return this; }, json() {} };
  const req = { headers: { authorization: "Bearer synthetic-test-token" }, body: { role: "admin" } };
  assert.equal(await requireInterestAdmin(req as any, res as any), false);
  assert.equal(status, 403);
  email = "christian@tateoco.com";
  assert.equal(await requireInterestAdmin(req as any, res as any), true);
});
