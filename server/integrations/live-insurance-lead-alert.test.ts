import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  liveInsuranceLeadContent, sendLiveInsuranceLeadAlert,
} from "./live-insurance-lead-alert";

const lead = {
  address: "123 Example St, Tampa, FL",
  name: "Test User",
  phone: "202-555-0100",
  email: "test@example.com",
  requestId: "mock-lead",
};

test("live insurance lead email has the exact subject and four requested fields", () => {
  const content = liveInsuranceLeadContent({ ...lead, dob: "private" } as typeof lead);
  assert.equal(content.subject, "LIVE INSURANCE LEAD: 123 Example St, Tampa, FL");
  assert.equal(content.text, "Property: 123 Example St, Tampa, FL\nName: Test User\nPhone: 202-555-0100\nEmail: test@example.com");
  assert.doesNotMatch(content.html + content.text, /private|dob/i);
});

test("lead contact fields are escaped and the subject is a single line", () => {
  const content = liveInsuranceLeadContent({ ...lead, name: "<img src=x>", address: "123 St\r\nBcc: unwanted" });
  assert.doesNotMatch(content.subject, /[\r\n]/);
  assert.match(content.html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(content.html, /<img/);
});

test("direct delivery uses the internal inbox and a stable idempotency key", async () => {
  const oldTo = process.env.INTERNAL_ALERT_EMAIL;
  const oldFrom = process.env.ALERT_FROM_EMAIL;
  process.env.INTERNAL_ALERT_EMAIL = "team@example.com";
  process.env.ALERT_FROM_EMAIL = "alerts@example.com";
  try {
    const result = await sendLiveInsuranceLeadAlert(lead, async (payload, key) => {
      assert.equal(payload.to, "team@example.com");
      assert.equal(payload.subject, "LIVE INSURANCE LEAD: 123 Example St, Tampa, FL");
      assert.equal(key, "live-insurance-lead:mock-lead");
    });
    assert.equal(result.status, "sent");
    assert.equal((await sendLiveInsuranceLeadAlert(lead, async () => { throw new Error("mock"); })).status, "failed");
  } finally {
    if (oldTo === undefined) delete process.env.INTERNAL_ALERT_EMAIL;
    else process.env.INTERNAL_ALERT_EMAIL = oldTo;
    if (oldFrom === undefined) delete process.env.ALERT_FROM_EMAIL;
    else process.env.ALERT_FROM_EMAIL = oldFrom;
  }
});

test("only a newly started live quote sends the new direct alert", () => {
  const routes = readFileSync("server/routes.ts", "utf8");
  assert.equal((routes.match(/void sendLiveInsuranceLeadAlert\(/g) ?? []).length, 1);
  const call = routes.indexOf("void sendLiveInsuranceLeadAlert(");
  assert.ok(call > routes.indexOf('"/api/insurance/qr-start"'));
  assert.ok(call < routes.indexOf('"/api/insurance/qr-quotes"'));
});