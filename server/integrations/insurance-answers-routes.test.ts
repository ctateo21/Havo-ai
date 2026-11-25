import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  createSupabaseScenarioAnswerStore,
  mergeAnswerSources,
  registerInsuranceAnswerRoutes,
  type InsuranceScenarioAnswerStore,
  type OwnScenarioRow,
} from "./insurance-answers-routes";

type Row = OwnScenarioRow & { user_id: string } & Record<string, unknown>;

function memoryStore(rows: Row[]) {
  const calls: string[] = [];
  const store: InsuranceScenarioAnswerStore = {
    async listOwn(userId) { calls.push(`list:${userId}`); return rows.filter(r => r.user_id === userId); },
    async updateOwn(userId, id, values) {
      calls.push(`update:${userId}:${id}`);
      const row = rows.find(r => r.id === id && r.user_id === userId);
      if (row) Object.assign(row, values);
    },
    async insertOwn(userId, values) {
      calls.push(`insert:${userId}`);
      rows.push({ ...(values as any), user_id: userId });
    },
  };
  return { store, calls };
}

async function withServer(store: InsuranceScenarioAnswerStore, userId: string | null, run: (post: (body: unknown) => Promise<Response>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerInsuranceAnswerRoutes(app, { optionalUser: async () => (userId ? { id: userId } : null), store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/insurance/scenario-answers`;
  try {
    await run(body => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("mergeAnswerSources keeps unrelated and server-owned live_quote_* keys", () => {
  const merged = mergeAnswerSources(
    { roof_year: 2010, live_quote_best_annual: 1800, other_field: "keep" },
    { roof_year: 2018, live_quote_best_annual: 1, quote_home_mortgage: "yes" },
  );
  assert.deepEqual(merged, { roof_year: 2018, live_quote_best_annual: 1800, other_field: "keep", quote_home_mortgage: "yes" });
});

test("merge endpoint updates only the user's own row for this property and never deletes", async () => {
  const rows: Row[] = [
    { id: "a", user_id: "user-1", address: "100 Example St, Tampa, FL 33602", normalized_property_key: null,
      user_answer_sources: { live_quote_completed_at: "2026-11-20", factor_hurrIdx: 1, roof_year: 2005 } },
    { id: "b", user_id: "user-1", address: "200 Sample Ave, Tampa, FL 33602", normalized_property_key: null,
      user_answer_sources: { roof_year: 1999 } },
    { id: "c", user_id: "user-2", address: "100 Example St, Tampa, FL 33602", normalized_property_key: null,
      user_answer_sources: { roof_year: 1980 } },
  ];
  const { store, calls } = memoryStore(rows);
  await withServer(store, null, async post => {
    assert.equal((await post({ id: "x", address: "100 Example St", answers: {} })).status, 401);
  });
  await withServer(store, "user-1", async post => {
    const response = await post({
      id: "client-generated", address: "100 example st, tampa, fl 33602",
      columns: { annual_premium: 2100, policy_type: "HO3" },
      answers: { roof_year: 2019, live_quote_completed_at: "forged", quote_wind_answers: { shape: "Hip" } },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, "a");
    assert.equal(body.created, false);
  });
  assert.deepEqual(rows.map(r => r.id), ["a", "b", "c"], "no row deleted or added");
  assert.deepEqual(rows[0].user_answer_sources, {
    live_quote_completed_at: "2026-11-20", factor_hurrIdx: 1, roof_year: 2019, quote_wind_answers: { shape: "Hip" },
  });
  assert.equal(rows[0].annual_premium, 2100);
  assert.deepEqual(rows[1].user_answer_sources, { roof_year: 1999 });
  assert.deepEqual(rows[2].user_answer_sources, { roof_year: 1980 }, "another user's row is untouched");
  assert.ok(calls.every(call => !call.includes("user-2")));
});

test("merge endpoint inserts a new own row and rejects invalid input", async () => {
  const rows: Row[] = [];
  const { store } = memoryStore(rows);
  await withServer(store, "user-1", async post => {
    const created = await post({ id: "new-1", address: "300 Demo Rd, Tampa, FL 33602", answers: { roof_year: 2020, live_quote_x: 1 } });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).created, true);
    assert.equal((await post({ id: "new-2", address: "300 Demo Rd", columns: { user_id: "user-2" }, answers: {} })).status, 400);
    assert.equal((await post({ id: "new-3", address: "300 Demo Rd", answers: { "bad key": 1 } })).status, 400);
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, "user-1");
  assert.deepEqual(rows[0].user_answer_sources, { roof_year: 2020 });
});

test("Supabase store scopes every query by user_id", async () => {
  const filters: Array<[string, string, unknown]> = [];
  const builder = (op: string) => {
    const chain: any = {
      eq(column: string, value: unknown) { filters.push([op, column, value]); return chain; },
      then(resolve: (v: unknown) => void) { resolve({ data: [], error: null }); },
    };
    return chain;
  };
  const client = {
    from: () => ({
      select: () => builder("select"),
      update: () => builder("update"),
      insert: (values: any) => { filters.push(["insert", "user_id", values.user_id]); return Promise.resolve({ error: null }); },
    }),
  };
  const store = createSupabaseScenarioAnswerStore(client);
  await store.listOwn("user-1");
  await store.updateOwn("user-1", "row-1", { roof_year: 1 });
  await store.insertOwn("user-1", { id: "row-2", user_id: "user-2" });
  assert.deepEqual(filters, [
    ["select", "user_id", "user-1"],
    ["update", "id", "row-1"],
    ["update", "user_id", "user-1"],
    ["insert", "user_id", "user-1"],
  ]);
});
