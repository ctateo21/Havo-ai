import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TABLES,
  collectSourceManifest,
  contentChecksum,
  createMigrationSourcePool,
  exportManagedData,
  fetchAllTargetRows,
  finalSyncManagedData,
  importManifest,
  parseMigrationManifest,
  reconcileManifest,
  withExclusiveMigrationSnapshot,
  type ExportFile,
} from "../scripts/managed-data-migration";
import { createMigrationTargetClient } from "../scripts/managed-data-migration-target";
import { parseRecoveryJson, recoveryChecksum, stringifyRecoveryJson } from "../scripts/managed-data-recovery-json";
import { recoveryJsonAlias } from "../scripts/managed-data-recovery-target";
import { recoveryJsonColumns } from "../scripts/managed-data-recovery-columns";
import { withSourceWriteFence } from "./managed-data-routing";

const quoteIdentifier = (value: string) => `"${value.replaceAll(`"`, `""`)}"`;

const jsonbSourceTargets = new Set([
  "insurance_quote_cache",
  "non_ad_valorem_cache",
]);

/**
 * Keep the disposable source fixtures schema-aware.  In particular, a source
 * table that omits a newly added JSON column would make the production
 * collector's projection fail before it can exercise the transport.
 */
async function createSourceFixtures(
  db: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  integrationJsonType?: "json" | "jsonb",
) {
  for (const [sourceTable, target, primaryKey] of TABLES) {
    const columns = new Map<string, string>();
    for (const column of primaryKey.split(",")) {
      columns.set(column, column === "id" ? "integer" : "text");
    }
    for (const column of recoveryJsonColumns(target)) {
      let type = jsonbSourceTargets.has(target) ? "jsonb" : "json";
      if (target === "managed_integration_requests" && integrationJsonType) {
        type = column === "request_data"
          ? integrationJsonType
          : integrationJsonType === "json" ? "jsonb" : "json";
      }
      columns.set(column, type);
    }
    columns.set("created_at", "timestamp(6)");
    if (sourceTable === "integration_requests") {
      columns.set("submission_id", "integer");
      columns.set("provider", "text");
      columns.set("status", "text");
    }
    if (sourceTable === "submissions") {
      columns.set("user_id", "integer");
      columns.set("status", "text");
    }
    await db.query(
      `create temporary table ${quoteIdentifier(sourceTable)} (${
        [...columns].map(([column, type]) => `${quoteIdentifier(column)} ${type}`).join(", ")
      })`,
    );
  }
}

/**
 * The RPC migration intentionally names public tables.  A random schema lets
 * this test install the exact migration function (with only its schema
 * qualification rewritten) without touching any application data.
 */
async function createIsolatedRpcSchema(
  db: { query: (text: string, values?: unknown[]) => Promise<any> },
  schema: string,
  installGrants = false,
) {
  const qualified = (table: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  await db.query(`create schema ${quoteIdentifier(schema)}`);
  await db.query(`create table ${qualified("managed_users")} (
    id bigint primary key, username text, password text, email text,
    first_name text, last_name text, phone text, contact_preference text,
    created_at timestamptz
  )`);
  await db.query(`create table ${qualified("managed_services")} (
    id bigint primary key, name text, display_name text, description text,
    options jsonb
  )`);
  await db.query(`create table ${qualified("managed_submissions")} (
    id bigint primary key, user_id bigint, selected_services jsonb not null,
    form_data jsonb not null, status text, created_at timestamptz
  )`);
  await db.query(`create table ${qualified("managed_integration_requests")} (
    id bigint primary key, submission_id bigint, provider text,
    request_data jsonb not null, response_data jsonb, status text,
    created_at timestamptz
  )`);
  await db.query(`create table ${qualified("managed_questionnaire_responses")} (
    id bigint primary key, session_id text, service_type text, step_name text,
    response_data jsonb not null, is_completed boolean, created_at timestamptz,
    updated_at timestamptz
  )`);
  await db.query(`create table ${qualified("user_subscriptions")} (
    id bigint primary key, user_id text unique, email text,
    stripe_customer_id text, stripe_subscription_id text, status text,
    current_period_end timestamptz, updated_at timestamptz
  )`);
  await db.query(`create table ${qualified("private_user_profiles")} (
    user_id text primary key, date_of_birth date,
    credit_score_consent_at timestamptz, created_at timestamptz,
    updated_at timestamptz
  )`);
  await db.query(`create table ${qualified("private_insurance_properties")} (
    user_id text, address_normalized text, current_policy_expiration_date date,
    quote_cache_scope text, created_at timestamptz, updated_at timestamptz,
    primary key (user_id, address_normalized)
  )`);
  await db.query(`create table ${qualified("insurance_quote_cache")} (
    id bigint primary key, address_normalized text, address_display text,
    lead_id bigint, status text, quotes jsonb, quote_counter integer,
    coverage_a integer, policy_type text, cache_scope text,
    property_data_snapshot jsonb, property_data_provenance jsonb,
    agency_default_snapshot jsonb, consumer_property_answers jsonb,
    quote_profile_version text, raw_quoterush_property_data jsonb,
    raw_quoterush_property_data_source text,
    raw_quoterush_property_data_fetched_at timestamptz,
    raw_quoterush_property_data_expires_at timestamptz, assumptions jsonb,
    triggered_at timestamptz, completed_at timestamptz, expires_at timestamptz,
    unique (address_normalized, policy_type)
  )`);
  await db.query(`create table ${qualified("non_ad_valorem_cache")} (
    id bigint primary key, folio text unique, account_number text,
    bill_year integer, status text, lines jsonb, total_non_ad_valorem integer,
    total_ad_valorem_cents integer, total_millage integer,
    ad_valorem_mills jsonb, fetched_at timestamptz, expires_at timestamptz
  )`);
  await db.query(`create table ${qualified("ifw_activity_claims")} (
    dedupe_key text primary key, user_id text, created_at timestamptz,
    expires_at timestamptz
  )`);

  const migration = await readFile(
    join(process.cwd(), "supabase/migrations/2026_09_07_managed_database_exact_json_v2.sql"),
    "utf8",
  );
  const functionStart = migration.indexOf(
    "create or replace function public.upsert_managed_migration_rows",
  );
  assert.ok(functionStart >= 0, "exact-json-v2 RPC migration is present");
  const functionEnd = migration.indexOf("$$;", functionStart);
  assert.ok(functionEnd >= 0, "exact-json-v2 RPC body is present");
  const functionSql = migration.slice(functionStart, functionEnd + 3)
    .replaceAll("public.", `${quoteIdentifier(schema)}.`)
    .replace("set search_path = pg_catalog, public",
      `set search_path = pg_catalog, ${quoteIdentifier(schema)}`);
  await db.query(functionSql);
  let grantRoles: { service: string; anon: string; authenticated: string } | undefined;
  if (installGrants) {
    const roleCapability = await db.query(
      `select rolcreaterole from pg_roles where rolname = current_user`,
    );
    if (roleCapability.rows[0]?.rolcreaterole) {
      const roleSuffix = randomUUID().replaceAll("-", "_");
      grantRoles = {
        service: `migration_rpc_service_${roleSuffix}`,
        anon: `migration_rpc_anon_${roleSuffix}`,
        authenticated: `migration_rpc_auth_${roleSuffix}`,
      };
      for (const role of Object.values(grantRoles)) {
        await db.query(`create role ${quoteIdentifier(role)} nologin`);
      }
      const grantStart = migration.indexOf("revoke all on function", functionEnd);
      const grantEnd = migration.indexOf("notify pgrst", grantStart);
      assert.ok(grantStart >= 0 && grantEnd >= 0, "RPC grants are present");
      const grantSql = migration.slice(grantStart, grantEnd)
        .replaceAll("public.", `${quoteIdentifier(schema)}.`)
        .replaceAll("service_role", quoteIdentifier(grantRoles.service))
        .replaceAll("anon", quoteIdentifier(grantRoles.anon))
        .replaceAll("authenticated", quoteIdentifier(grantRoles.authenticated));
      await db.query(grantSql);
    }
  }
  return { qualified, grantRoles };
}

/**
 * Emulate only the HTTP boundary around PostgREST.  The upsert itself is the
 * SQL RPC from the migration above, not a duplicate json_populate implementation
 * in this test.
 */
function isolatedRpcRequest(
  db: { query: (text: string, values?: unknown[]) => Promise<any> },
  schema: string,
): typeof fetch {
  const qualified = (table: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  return (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/rpc/reseed_managed_migration_sequences")) {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/rpc/upsert_managed_migration_rows")) {
      const body = parseRecoveryJson(String(init?.body ?? "")) as Record<string, unknown>;
      const rows = body.p_rows;
      await db.query(
        `select ${qualified("upsert_managed_migration_rows")}($1::text, $2::text, $3::json)`,
        [
          body.p_target,
          body.p_primary_key,
          stringifyRecoveryJson(rows),
        ],
      );
      return new Response(null, { status: 204 });
    }

    const table = url.pathname.split("/").at(-1)!;
    const descriptor = TABLES.find(([, target]) => target === table);
    if (!descriptor) return new Response("[]", { status: 404 });
    const primaryKey = descriptor[2].split(",");
    const jsonColumns = recoveryJsonColumns(table);
    const from = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "1000");
    const order = primaryKey.map(column => `${quoteIdentifier(column)} asc`).join(", ");
    const projections = jsonColumns.map(column =>
      `${quoteIdentifier(column)}::text as ${quoteIdentifier(recoveryJsonAlias(column))}`,
    );
    const result = await db.query(
      `select row_to_json(source_row)::text as exact_row${
        projections.length ? `, ${projections.join(", ")}` : ""
      } from ${qualified(table)} source_row
       order by ${order} offset $1 limit $2`,
      [from, limit],
    );
    const countResult = await db.query(
      `select count(*)::integer as count from ${qualified(table)}`,
    );
    const rows = result.rows.map((candidate: Record<string, unknown>) => {
      const row = parseRecoveryJson(String(candidate.exact_row)) as Record<string, unknown>;
      for (const column of jsonColumns) {
        row[recoveryJsonAlias(column)] = candidate[recoveryJsonAlias(column)];
      }
      return row;
    });
    const count = Number(countResult.rows[0].count);
    const range = rows.length ? `${from}-${from + rows.length - 1}/${count}` : `*/${count}`;
    return new Response(stringifyRecoveryJson(rows), {
      status: 200,
      headers: { "content-range": range },
    });
  }) as typeof fetch;
}

test("migration checksums ignore object key order but detect content changes", () => {
  assert.equal(
    contentChecksum([{ id: 1, value: { b: 2, a: 1 } }]),
    contentChecksum([{ value: { a: 1, b: 2 }, id: 1 }]),
  );
  assert.notEqual(
    contentChecksum([{ id: 1, value: "a" }]),
    contentChecksum([{ id: 1, value: "b" }]),
  );
});

test("target reconciliation fully paginates rather than accepting first page", async () => {
  const calls: number[] = [];
  const client = {
    from() {
      return {
        select() { return this; },
        order() { return this; },
        async range(from: number) {
          calls.push(from);
          return {
            data: from === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
            count: 3,
            error: null,
          };
        },
      };
    },
  };
  assert.deepEqual(await fetchAllTargetRows(client as any, "managed_users", ["id"], 2), [
    { id: 1 }, { id: 2 }, { id: 3 },
  ]);
  assert.deepEqual(calls, [0, 2]);
});

test("migration checksums normalize equivalent timestamp encodings", () => {
  assert.equal(
    contentChecksum({ updated_at: "2026-09-07T12:00:00.000Z" }),
    contentChecksum({ updated_at: "2026-09-07T12:00:00+00:00" }),
  );
});

test("legacy v1 manifests retain their checksums and remain importable", async () => {
  const tables: ExportFile["tables"] = {};
  for (const [sourceTable, target] of TABLES) {
    const rows = target === "managed_users" ? [{
      id: 1, created_at: "2026-09-07T12:00:00.000Z", policy_data: { large: 1e21 },
    }] : [];
    tables[target] = {
      sourceTable, rows, count: rows.length,
      primaryKeyChecksum: contentChecksum(rows.map(row => [row.id])),
      checksum: contentChecksum(rows),
    };
  }
  const legacy: ExportFile = {
    format: "havo-managed-data-v1", environment: "development",
    exportedAt: "2026-09-07T12:00:00.000Z", tables, checksum: contentChecksum(tables),
  };
  const loaded = parseMigrationManifest(JSON.stringify(legacy));
  assert.deepEqual(loaded, legacy);
  let imported = 0;
  let reseeded = false;
  const target = {
    async upsert(_table: string, _pk: string, rows: unknown[]) { imported += rows.length; },
    async reseed() { reseeded = true; },
    async readPage(table: string) {
      return {
        // jsonb expands scientific notation; this must keep matching the
        // historical native-number checksum, not its new raw lexical form.
        rows: table === "managed_users" ? parseRecoveryJson(
          '[{"id":1,"created_at":"2026-09-07T12:00:00+00:00","policy_data":{"large":1000000000000000000000}}]',
        ) as unknown[] : [],
        count: tables[table].count,
      };
    },
  };
  await importManifest(loaded, target);
  await reconcileManifest(loaded, target);
  assert.equal(imported, 1);
  assert.equal(reseeded, true);

  // exact-json-v1 manifests remain readable while v2 rolls forward.  The
  // fixture deliberately uses the same large value that exposed the old
  // native-number checksum behavior.
  const exactV1Tables = Object.fromEntries(
    Object.entries(loaded.tables).map(([targetName, table]) => [
      targetName,
      {
        ...table,
        primaryKeyChecksum: recoveryChecksum(
          table.rows.map((row: any) => [row.id]),
        ),
        checksum: recoveryChecksum(table.rows),
      },
    ]),
  ) as ExportFile["tables"];
  const exactV1: ExportFile = {
    ...loaded,
    checksumEncoding: "exact-json-v1",
    tables: exactV1Tables,
    checksum: recoveryChecksum(exactV1Tables),
  };
  const loadedExactV1 = parseMigrationManifest(stringifyRecoveryJson(exactV1));
  await importManifest(loadedExactV1, target);
  await reconcileManifest(loadedExactV1, target);
  assert.equal(imported, 2);
  assert.equal(reseeded, true);
  assert.throws(() => parseMigrationManifest(JSON.stringify({ ...legacy, checksumEncoding: "unknown" })));
});

test("forward exact-json-v2 export, disk manifest, RPC import and reconciliation preserve exact PostgreSQL values", async () => {
  const connectionString = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
  assert.ok(connectionString, "An isolated managed test database is required");
  const pool = createMigrationSourcePool(connectionString);
  const db = await pool.connect();
  const directory = await mkdtemp(join(tmpdir(), "migration-precision-"));
  const schema = `migration_exact_json_${randomUUID().replaceAll("-", "_")}`;
  const payload = '{"unsafe":9007199254740993,"decimal":0.12345678901234567890123456789,"__proto__":{"kept":true},"isLosslessNumber":true,"value":"not a number","date":"2026-09-07T12:00:00.123456Z"}';
  try {
    // Session-local source fixtures shadow real tables and disappear on
    // disconnect.  The target function and tables live only in this random
    // schema, which is dropped below; no application data is read or changed.
    await createSourceFixtures(db);
    await createIsolatedRpcSchema(db, schema);
    await db.query(
      `insert into submissions (id, selected_services, form_data, created_at)
       values (1, $1::json, $1::json, '2026-09-07 12:00:00.123456')`,
      [payload],
    );
    // The exact production source collector is shared by export and final-sync.
    const manifest = await withExclusiveMigrationSnapshot(
      db, () => collectSourceManifest(db, "development"), `precision-${randomUUID()}`,
    );
    assert.equal(manifest.checksumEncoding, "exact-json-v2");
    const text = stringifyRecoveryJson(manifest);
    assert.ok(text.includes("9007199254740993e0"));
    assert.ok(text.includes("12345678901234567890123456789e-29"));
    assert.ok(text.includes("2026-09-07T12:00:00.123456Z"));
    const path = join(directory, "export.json");
    await writeFile(path, text);
    const loaded = parseMigrationManifest(await readFile(path, "utf8"));

    // The request adapter only supplies HTTP framing; the upsert itself is
    // the migration's schema-owned SQL RPC.
    const request = isolatedRpcRequest(db, schema);
    const target = createMigrationTargetClient("https://test.invalid", "synthetic-test-key", request);
    await importManifest(loaded, target);
    await importManifest(loaded, target);
    await reconcileManifest(loaded, target);
    const stored = await db.query(`select
      selected_services->>'unsafe' as selected_unsafe,
      selected_services->>'decimal' as selected_decimal,
      form_data->>'unsafe' as unsafe, form_data->>'decimal' as decimal,
      to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.US') as timestamp,
      form_data->'__proto__'->>'kept' as own_key
      from ${quoteIdentifier(schema)}.managed_submissions`);
    assert.deepEqual(stored.rows, [{
      selected_unsafe: "9007199254740993",
      selected_decimal: "0.12345678901234567890123456789",
      unsafe: "9007199254740993", decimal: "0.12345678901234567890123456789",
      timestamp: "2026-09-07 12:00:00.123456", own_key: "true",
    }]);

    for (const mutation of [
      `form_data = jsonb_set(form_data, '{unsafe}', '9007199254740992')`,
      `selected_services = jsonb_set(selected_services, '{decimal}', '0.12345678901234568')`,
      `created_at = '2026-09-07 12:00:00.123'`,
      // Date-looking JSON strings are data, not SQL timestamp columns.
      `form_data = jsonb_set(form_data, '{date}', '"2026-09-07T12:00:00.123456+00:00"')`,
    ]) {
      await db.query(
        `update ${quoteIdentifier(schema)}.managed_submissions set ${mutation}`,
      );
      await assert.rejects(reconcileManifest(loaded, target), /Reconciliation mismatch/);
      await importManifest(loaded, target);
    }
    for (const [original, rounded] of [
      ["9007199254740993e0", "9007199254740992e0"],
      ["12345678901234567890123456789e-29", "12345678901234568e-29"],
      [".123456Z", ".123Z"],
    ]) {
      assert.throws(() => parseMigrationManifest(text.replaceAll(original, rounded)), /checksum validation failed/);
    }
    assert.equal(recoveryChecksum(parseRecoveryJson('{"n":9007199254740993.000}')),
      recoveryChecksum(parseRecoveryJson('{"n":9.007199254740993e15}')));
  } finally {
    await db.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`)
      .catch(() => undefined);
    db.release();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const jsonType of ["json", "jsonb"] as const) {
  test(`forward exact-json-v2 preserves SQL NULL versus JSON null for ${jsonType}`, async () => {
    const connectionString = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
    assert.ok(connectionString, "An isolated managed test database is required");
    const pool = createMigrationSourcePool(connectionString);
    const db = await pool.connect();
    const targetDb = await pool.connect();
    const directory = await mkdtemp(join(tmpdir(), `migration-null-${jsonType}-`));
    const schema = `migration_nulls_${jsonType}_${randomUUID().replaceAll("-", "_")}`;
    try {
      await createSourceFixtures(db, jsonType);
      await createIsolatedRpcSchema(db, schema);
      await db.query(
        `insert into integration_requests
          (id, submission_id, provider, request_data, response_data, status, created_at)
         values
          (1, 10, 'test', 'null'::${jsonType}, null, 'pending',
            '2026-09-07 12:00:00.000000'),
          (2, 10, 'test', 'null'::${jsonType},
            'null'::${jsonType === "json" ? "jsonb" : "json"}, 'pending',
            '2026-09-07 12:00:00.000000')`,
      );

      // Export to disk, parse the disk bytes, import them through the actual
      // v2 RPC, then run the complete final-sync path as a second round trip.
      const exported = await exportManagedData(db, "development");
      const exportPath = join(directory, "export.json");
      await writeFile(exportPath, `${stringifyRecoveryJson(exported)}\n`);
      const loaded = parseMigrationManifest(await readFile(exportPath, "utf8"));
      const target = createMigrationTargetClient(
        "https://test.invalid",
        "synthetic-test-key",
        isolatedRpcRequest(targetDb, schema),
      );
      await importManifest(loaded, target);
      const finalPath = join(directory, "final-sync.json");
      const finalManifest = await finalSyncManagedData(
        db, "development", finalPath, target,
      );
      const finalDiskManifest = parseMigrationManifest(
        await readFile(finalPath, "utf8"),
      );
      assert.equal(finalManifest.checksum, finalDiskManifest.checksum);
      await reconcileManifest(finalDiskManifest, target);

      const stored = await db.query(`
        select id, request_data::text, response_data::text,
          response_data is null as sql_null
        from ${quoteIdentifier(schema)}.managed_integration_requests
        order by id
      `);
      assert.deepEqual(stored.rows, [
        { id: "1", request_data: "null", response_data: null, sql_null: true },
        { id: "2", request_data: "null", response_data: "null", sql_null: false },
      ]);

      // Either direction of nullness corruption must be visible to the final
      // reconciliation: SQL NULL is not interchangeable with JSON null.
      await db.query(
        `update ${quoteIdentifier(schema)}.managed_integration_requests
         set response_data = 'null'::jsonb where id = 1`,
      );
      await assert.rejects(
        reconcileManifest(finalDiskManifest, target),
        /Reconciliation mismatch/,
      );
      await importManifest(finalDiskManifest, target);

      await db.query(
        `update ${quoteIdentifier(schema)}.managed_integration_requests
         set response_data = null where id = 2`,
      );
      await assert.rejects(
        reconcileManifest(finalDiskManifest, target),
        /Reconciliation mismatch/,
      );
      await importManifest(finalDiskManifest, target);
      await reconcileManifest(finalDiskManifest, target);
    } finally {
      await db.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`)
        .catch(() => undefined);
      db.release();
      targetDb.release();
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("exact-json-v2 SQL RPC exercises every managed branch and isolated grants", async () => {
  const connectionString = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
  assert.ok(connectionString, "An isolated managed test database is required");
  const pool = createMigrationSourcePool(connectionString);
  const db = await pool.connect();
  const schema = `migration_rpc_branches_${randomUUID().replaceAll("-", "_")}`;
  let grantRoles: { service: string; anon: string; authenticated: string } | undefined;
  try {
    const installed = await createIsolatedRpcSchema(db, schema, true);
    grantRoles = installed.grantRoles;
    const target = createMigrationTargetClient(
      "https://test.invalid",
      "synthetic-test-key",
      isolatedRpcRequest(db, schema),
    );
    const timestamp = "2026-09-07T12:00:00.000Z";
    const rows: Record<string, unknown[]> = {
      managed_users: [{
        id: 1, username: "rpc-user", password: "password", email: "rpc@example.test",
        first_name: "RPC", last_name: "User", phone: null,
        contact_preference: "email", created_at: timestamp,
      }],
      managed_services: [{
        id: 2, name: "rpc-service", display_name: "RPC Service",
        description: "isolated", options: "[]",
      }],
      managed_submissions: [{
        id: 3, user_id: 1, selected_services: "[]", form_data: "{}",
        status: "pending", created_at: timestamp,
      }],
      managed_integration_requests: [{
        id: 4, submission_id: 3, provider: "rpc", request_data: "{}",
        response_data: null, status: "pending", created_at: timestamp,
      }],
      managed_questionnaire_responses: [{
        id: 5, session_id: "rpc-session", service_type: "rpc",
        step_name: "initial", response_data: "{}", is_completed: true,
        created_at: timestamp, updated_at: timestamp,
      }],
      user_subscriptions: [{
        id: 6, user_id: "rpc-user", email: "rpc@example.test",
        stripe_customer_id: "customer", stripe_subscription_id: "subscription",
        status: "active", current_period_end: timestamp, updated_at: timestamp,
      }],
      private_user_profiles: [{
        user_id: "rpc-user", date_of_birth: "1990-01-01",
        credit_score_consent_at: timestamp, created_at: timestamp, updated_at: timestamp,
      }],
      private_insurance_properties: [{
        user_id: "rpc-user", address_normalized: "rpc-address",
        current_policy_expiration_date: "2030-01-01", quote_cache_scope: "unused",
        created_at: timestamp, updated_at: timestamp,
      }],
      insurance_quote_cache: [{
        id: 9, address_normalized: "rpc-address", address_display: "RPC Address",
        lead_id: 1, status: "completed", quotes: "[]", quote_counter: 1,
        coverage_a: 100, policy_type: "HO3", cache_scope: "shared",
        property_data_snapshot: "{}", property_data_provenance: "{}",
        agency_default_snapshot: "{}", consumer_property_answers: "{}",
        quote_profile_version: "rpc-v1", raw_quoterush_property_data: null,
        raw_quoterush_property_data_source: null,
        raw_quoterush_property_data_fetched_at: null,
        raw_quoterush_property_data_expires_at: null, assumptions: "[]",
        triggered_at: timestamp, completed_at: null, expires_at: timestamp,
      }],
      non_ad_valorem_cache: [{
        id: 10, folio: "rpc-folio", account_number: "account", bill_year: 2026,
        status: "complete", lines: "[]", total_non_ad_valorem: 0,
        total_ad_valorem_cents: null, total_millage: null,
        ad_valorem_mills: null, fetched_at: timestamp, expires_at: timestamp,
      }],
      ifw_activity_claims: [{
        dedupe_key: "rpc-claim", user_id: "rpc-user",
        created_at: timestamp, expires_at: timestamp,
      }],
    };

    for (const [, targetName, primaryKey] of TABLES) {
      await target.upsert(
        targetName,
        primaryKey,
        rows[targetName],
        "exact-json-v2",
      );
      const page = await target.readPage(
        targetName,
        primaryKey.split(","),
        0,
        0,
        "exact-json-v2",
      );
      assert.equal(page.count, 1, `${targetName} branch inserted a row`);
      assert.equal(page.rows.length, 1, `${targetName} branch is readable`);
    }

    if (grantRoles) {
      const functionName =
        `${schema}.upsert_managed_migration_rows(text,text,json)`;
      const privileges = await db.query(
        `select
           has_function_privilege($1, $4::regprocedure, 'execute') as service_execute,
           has_function_privilege($2, $4::regprocedure, 'execute') as anon_execute,
           has_function_privilege($3, $4::regprocedure, 'execute') as authenticated_execute`,
        [grantRoles.service, grantRoles.anon, grantRoles.authenticated, functionName],
      );
      assert.deepEqual(privileges.rows, [{
        service_execute: true,
        anon_execute: false,
        authenticated_execute: false,
      }]);
    }
  } finally {
    await db.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`)
      .catch(() => undefined);
    if (grantRoles) {
      for (const role of Object.values(grantRoles)) {
        await db.query(`drop role if exists ${quoteIdentifier(role)}`)
          .catch(() => undefined);
      }
    }
    db.release();
    await pool.end();
  }
});

test("final-sync snapshot includes a write already inside the shared fence", async () => {
  const connectionString =
    process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
  assert.ok(connectionString, "An isolated managed test database is required");
  const pool = createMigrationSourcePool(connectionString);
  const writer = await pool.connect();
  const snapshot = await pool.connect();
  const suffix = randomUUID().replaceAll("-", "_");
  const schema = `migration_fence_${suffix}`;
  const fenceKey = `migration-fence-test-${suffix}`;
  let releaseWrite!: () => void;
  const mayWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  let sharedFenceEntered!: () => void;
  const sharedFenceIsHeld = new Promise<void>(
    resolve => { sharedFenceEntered = resolve; },
  );
  let exclusiveLockRequested!: () => void;
  const exclusiveLockIsWaiting = new Promise<void>(
    resolve => { exclusiveLockRequested = resolve; },
  );
  let appWrite: Promise<void> | undefined;
  let snapshotRead: Promise<string> | undefined;

  try {
    await writer.query(`create schema "${schema}"`);
    await writer.query(`
      create table "${schema}".records (
        id integer primary key,
        value text not null
      )
    `);
    await writer.query(
      `insert into "${schema}".records (id, value) values (1, 'old')`,
    );

    appWrite = withSourceWriteFence(
      async () => {
        sharedFenceEntered();
        await mayWrite;
        await writer.query(
          `update "${schema}".records set value = 'new' where id = 1`,
        );
      },
      pool,
      fenceKey,
    );
    await sharedFenceIsHeld;

    const observedSnapshotClient = {
      query(text: string, values?: unknown[]) {
        if (text.includes("pg_advisory_lock(")) {
          exclusiveLockRequested();
        }
        return snapshot.query(text, values as any[]);
      },
    };
    let snapshotWorkStarted = false;
    snapshotRead = withExclusiveMigrationSnapshot(
      observedSnapshotClient,
      async () => {
        snapshotWorkStarted = true;
        const result = await snapshot.query(
          `select value from "${schema}".records where id = 1`,
        );
        return String(result.rows[0]?.value);
      },
      fenceKey,
    );
    await exclusiveLockIsWaiting;
    assert.equal(
      snapshotWorkStarted,
      false,
      "exclusive final-sync fence must wait for the shared application fence",
    );

    releaseWrite();
    await appWrite;
    assert.equal(await snapshotRead, "new");
  } finally {
    releaseWrite();
    await Promise.allSettled(
      [appWrite, snapshotRead].filter(
        (promise): promise is Promise<void> | Promise<string> => promise !== undefined,
      ),
    );
    await writer.query(`drop schema if exists "${schema}" cascade`)
      .catch(() => undefined);
    writer.release();
    snapshot.release();
    await pool.end();
  }
});