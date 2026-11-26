import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  createLiveQuoteClickAlerter,
  registerLiveQuoteClickRoute,
  type CrmResult,
  type LiveQuoteClickContact,
} from "./live-quote-click-alert";
import { checkCrmConsent, type ConsentStore } from "./crm-consent-gate";

const contact: LiveQuoteClickContact = {
  userId: "user-1", address: "100 Example St, Tampa, FL 33602", normalizedAddress: "100 example st tampa fl 33602",
  firstName: "Test", lastName: "Buyer", name: "Test Buyer", email: "buyer@example.test", phone: "8135550100",
};

function harness(crm: Array<CrmResult | Error>, emailStatus: "sent" | "failed" | "skipped" = "sent") {
  const calls = { crm: 0, email: 0, logs: [] as string[] };
  let t = 0;
  const alert = createLiveQuoteClickAlerter({
    sendCrm: async () => {
      const next = crm[Math.min(calls.crm++, crm.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    sendTeamEmail: async () => { calls.email++; return { status: emailStatus }; },
    log: m => calls.logs.push(m),
    now: () => t,
  });
  return { alert, calls, advance: (ms: number) => { t += ms; } };
}

test("consent skip: no retry, team email fallback is sent", async () => {
  const h = harness([{ ok: true, skipped: true }]);
  const out = await h.alert(contact);
  assert.equal(h.calls.crm, 1);
  assert.equal(h.calls.email, 1);
  assert.deepEqual(out, { teamNotified: true, channel: "email", deduped: false });
});

test("missing CRM key: retried once, then team email", async () => {
  const h = harness([{ ok: false, skipped: true, error: "FOLLOWUPBOSS_API_KEY not set" }]);
  const out = await h.alert(contact);
  assert.equal(h.calls.crm, 2);
  assert.equal(h.calls.email, 1);
  assert.equal(out.channel, "email");
});

test("CRM HTTP failure (throw): retried once, then team email", async () => {
  const h = harness([new Error("HTTP 500"), new Error("HTTP 500")]);
  const out = await h.alert(contact);
  assert.equal(h.calls.crm, 2);
  assert.equal(h.calls.email, 1);
  assert.equal(out.teamNotified, true);
});

test("a retry that succeeds does not send the email", async () => {
  const h = harness([{ ok: false, error: "HTTP 502" }, { ok: true }]);
  const out = await h.alert(contact);
  assert.equal(h.calls.crm, 2);
  assert.equal(h.calls.email, 0);
  assert.equal(out.channel, "crm");
});

test("dedupes per user + property; a failed delivery is not cached", async () => {
  const h = harness([{ ok: true }]);
  await h.alert(contact);
  const again = await h.alert(contact);
  assert.equal(again.deduped, true);
  assert.equal(h.calls.crm, 1);
  await h.alert({ ...contact, normalizedAddress: "200 sample ave tampa fl 33602" });
  assert.equal(h.calls.crm, 2, "another property is alerted");
  await h.alert({ ...contact, userId: "user-2" });
  assert.equal(h.calls.crm, 3, "another user is alerted");
  h.advance(61_000);
  await h.alert(contact);
  assert.equal(h.calls.crm, 4, "window expired");

  const failing = harness([{ ok: false }], "failed");
  const first = await failing.alert(contact);
  assert.equal(first.teamNotified, false);
  await failing.alert(contact);
  assert.equal(failing.calls.crm, 4, "failed outcome retried on the next tap");
});

test("logs carry no personal data", async () => {
  const h = harness([{ ok: true, skipped: true }]);
  await h.alert(contact);
  const text = h.calls.logs.join("\n");
  for (const pii of [contact.email, contact.phone, contact.name, contact.address, contact.userId]) {
    assert.ok(!text.includes(pii), `log leaks ${pii}`);
  }
  assert.ok(!/fub|follow ?up boss/i.test(text));
});

async function withRoute(
  alert: Parameters<typeof registerLiveQuoteClickRoute>[1]["alert"],
  run: (post: (body: unknown) => Promise<Response>) => Promise<void>,
  user: { id: string } | null = { id: "user-1" },
) {
  const app = express();
  app.use(express.json());
  registerLiveQuoteClickRoute(app, {
    optionalUser: async () => user,
    loadContact: async (_u, address) => ({ ...contact, address }),
    alert,
    log: () => {},
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/insurance/live-quote-click`;
  try {
    await run(body => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("route returns 200 ok for consent skip, missing key and HTTP failure, with email fallback", async () => {
  for (const crm of [[{ ok: true, skipped: true }], [{ ok: false, skipped: true, error: "missing key" }], [new Error("HTTP 503")]] as Array<Array<CrmResult | Error>>) {
    const h = harness(crm);
    await withRoute(h.alert, async post => {
      const res = await post({ address: contact.address });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.error, undefined);
    });
    assert.equal(h.calls.email, 1);
  }
});

test("route stays 200 even when every alert channel fails or throws", async () => {
  const h = harness([{ ok: false }], "failed");
  await withRoute(h.alert, async post => {
    const res = await post({ address: contact.address });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, teamNotified: false, deduped: false });
  });
  await withRoute(async () => { throw new Error("boom"); }, async post => {
    const res = await post({ address: contact.address });
    assert.equal(res.status, 200);
  });
});

test("route still requires sign-in and a valid address", async () => {
  const h = harness([{ ok: true }]);
  await withRoute(h.alert, async post => assert.equal((await post({ address: "x" })).status, 401), null);
  await withRoute(h.alert, async post => assert.equal((await post({})).status, 400));
  assert.equal(h.calls.crm, 0);
});

function consentStore(lead: Array<{ marketing_consent: boolean | null; consent_at: string }>, account: Array<{ consent: boolean | null; recorded_at: string }>, error = false): ConsentStore {
  return {
    latestLeadConsent: async () => ({ data: lead, error: error ? new Error("x") : null }),
    latestAccountConsent: async () => ({ data: account, error: null }),
  };
}

test("consent gate blocks CRM enrollment without consent", async () => {
  assert.equal(await checkCrmConsent(consentStore([], []), "8135550100"), "no_consent");
  assert.equal(await checkCrmConsent(consentStore([{ marketing_consent: false, consent_at: "2026-11-01T00:00:00Z" }], []), "8135550100"), "no_consent");
  assert.equal(await checkCrmConsent(
    consentStore([{ marketing_consent: true, consent_at: "2026-10-01T00:00:00Z" }], [{ consent: false, recorded_at: "2026-11-01T00:00:00Z" }]),
    "8135550100"), "no_consent", "most recent withdrawal wins");
  assert.equal(await checkCrmConsent(consentStore([{ marketing_consent: true, consent_at: "2026-11-01T00:00:00Z" }], []), "8135550100"), "allowed");
  assert.equal(await checkCrmConsent(consentStore([], [], true), "8135550100"), "unavailable");
  assert.equal(await checkCrmConsent(null, "8135550100"), "unavailable");
});

test("CRM contact creation still runs the consent gate before enrolling", async () => {
  const { readFileSync } = await import("node:fs");
  const routes = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");
  const fn = routes.slice(routes.indexOf("async function createFollowUpBossContact"));
  const gate = fn.indexOf("checkCrmConsent(");
  const enroll = fn.indexOf("FOLLOWUPBOSS_API_KEY");
  assert.ok(gate > 0 && gate < enroll, "consent is checked before any CRM call");
  assert.match(fn, /if\(consent!=="allowed"\)return \{ok:true,noteAdded:false,personId:null,skipped:true/);
});
