import assert from "node:assert/strict";
import test from "node:test";
import {
  createMigrationTargetClient,
} from "../scripts/managed-data-migration-target";
import {
  parseRecoveryJson,
  stringifyRecoveryJson,
} from "../scripts/managed-data-recovery-json";

type FetchCall = { url: URL; init: RequestInit };

test("v2 transport preserves text JSON null separately from SQL NULL", async () => {
  const rows = [{ id: 1, options: "null" }, { id: 2, options: null }];
  const fake = fakeFetch(call => call.init.method === "POST"
    ? new Response(null, { status: 204 })
    : new Response(JSON.stringify([
      { id: 1, options: null, __recovery_json_options: "null" },
      { id: 2, options: null, __recovery_json_options: null },
    ]), { headers: { "content-range": "0-1/2" } }));
  const client = createMigrationTargetClient("https://target.example", "test-key", fake.request);
  await client.upsert("managed_services", "id", rows, "exact-json-v2");
  assert.equal(fake.calls[0].url.pathname, "/rest/v1/rpc/upsert_managed_migration_rows");
  assert.deepEqual(JSON.parse(String(fake.calls[0].init.body)), {
    p_target: "managed_services", p_primary_key: "id", p_rows: rows,
  });
  assert.deepEqual(
    await client.readPage("managed_services", ["id"], 0, 1, "exact-json-v2"),
    { rows, count: 2 },
  );
  assert.equal(fake.calls[1].url.searchParams.get("select"), "*,__recovery_json_options:options::text");

  const missingProjection = createMigrationTargetClient("https://target.example", "test-key",
    fakeFetch(new Response('[{"id":1,"options":null}]', {
      headers: { "content-range": "0-0/1" },
    })).request);
  await assert.rejects(
    missingProjection.readPage("managed_services", ["id"], 0, 0, "exact-json-v2"),
    /target read failed/,
  );
});

function fakeFetch(
  response: Response | ((call: FetchCall) => Response | Promise<Response>),
) {
  const calls: FetchCall[] = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init: init ?? {} };
    calls.push(call);
    return typeof response === "function" ? response(call) : response;
  }) as typeof fetch;
  return { calls, request };
}

test("migration target reads raw lossless JSON and sends exact upsert bodies", async () => {
  const pageText = '[{"id":9007199254740993,"ratio":0.123456789012345678901}]';
  const upsertRows = parseRecoveryJson(pageText) as unknown[];
  const fake = fakeFetch(call => {
    if (call.init.method === "POST") return new Response(null, { status: 204 });
    return new Response(pageText, {
      status: 200,
      headers: { "content-range": "0-0/1" },
    });
  });
  const client = createMigrationTargetClient(
    "https://target.example",
    "service-secret",
    fake.request,
  );

  const page = await client.readPage("managed_users", ["id"], 0, 0);
  assert.equal(stringifyRecoveryJson(page.rows), pageText);
  assert.equal(page.count, 1);

  await client.upsert("managed_users", "id", upsertRows);
  const upsert = fake.calls[1];
  assert.equal(upsert.url.searchParams.get("on_conflict"), "id");
  assert.equal(upsert.init.body, pageText);
  assert.equal(upsert.init.headers && (upsert.init.headers as Record<string, string>).Prefer,
    "resolution=merge-duplicates");

  await client.reseed();
  const reseed = fake.calls[2];
  assert.equal(reseed.url.pathname, "/rest/v1/rpc/reseed_managed_migration_sequences");
  assert.equal(reseed.init.method, "POST");
  assert.equal(reseed.init.body, "{}");
});

test("migration target includes exact pagination and ordering parameters", async () => {
  const fake = fakeFetch(new Response("[]", {
    status: 200,
    headers: { "content-range": "12-34/35" },
  }));
  const client = createMigrationTargetClient(
    "https://target.example",
    "service-secret",
    fake.request,
  );

  await client.readPage(
    "private_insurance_properties",
    ["user_id", "address_normalized"],
    12,
    34,
  );
  const url = fake.calls[0].url;
  assert.equal(url.pathname, "/rest/v1/private_insurance_properties");
  assert.equal(url.searchParams.get("select"), "*");
  assert.equal(url.searchParams.get("order"), "user_id.asc,address_normalized.asc");
  assert.equal(url.searchParams.get("offset"), "12");
  assert.equal(url.searchParams.get("limit"), "23");
  assert.equal(fake.calls[0].init.headers &&
    (fake.calls[0].init.headers as Record<string, string>).Prefer, "count=exact");
});

test("migration target rejects non-allowlisted tables and sanitizes HTTP errors", async () => {
  let requests = 0;
  const request = (async () => {
    requests++;
    return new Response('{"private":"row data","credential":"service-secret"}', {
      status: 500,
    });
  }) as typeof fetch;
  const client = createMigrationTargetClient(
    "https://target.example",
    "service-secret",
    request,
  );

  await assert.rejects(
    client.readPage("not_allowlisted", ["id"], 0, 0),
    error => error instanceof Error && error.message === "Unknown migration target",
  );
  assert.equal(requests, 0);

  await assert.rejects(
    client.upsert("managed_users", "id", [{ private: "row data" }]),
    error => error instanceof Error &&
      error.message === "Migration target upsert failed: managed_users" &&
      !error.message.includes("service-secret") &&
      !error.message.includes("row data"),
  );
});