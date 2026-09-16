import assert from "node:assert/strict";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { stringifyRecoveryJson } from "./managed-data-recovery-json";
import {
  createMigrationTargetClient,
  exportManagedData,
  finalSyncManagedData,
  importManifest,
  loadManifest,
  reconcileManifest,
  type ExportFile,
} from "./managed-data-migration";
import { ROWS_PER_TABLE, seedRehearsalSource } from "./managed-data-rehearsal-fixtures";
import { testClaimRaces } from "./managed-data-rehearsal-rpcs";

/** No default project URL, external socket, or production manifest is accepted. */
async function rehearsalConfig() {
  const root = process.env.REHEARSAL_ROOT;
  assert.ok(root, "Run npm run test:managed-data-rehearsal, not this file directly");
  assert.equal(await realpath(root), root);
  assert.ok(root.startsWith(join(await realpath(tmpdir()), "managed-data-rehearsal-")));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  const socket = await realpath(join(root, "socket"));
  const urls = [process.env.REHEARSAL_SOURCE_URL, process.env.REHEARSAL_TARGET_URL];
  for (const [index, value] of urls.entries()) {
    assert.ok(value, "Runner-created database URLs are required");
    const url = new URL(value);
    assert.equal(url.protocol, "postgresql:");
    assert.equal(url.hostname, "localhost");
    assert.equal(url.username, "rehearsal");
    assert.equal(url.password, "");
    assert.equal(url.pathname, index === 0 ? "/rehearsal_source" : "/rehearsal_target");
    assert.equal(url.searchParams.get("host"), socket);
    assert.deepEqual([...url.searchParams.keys()].sort(), ["host", "port"]);
  }
  const apiUrl = process.env.REHEARSAL_API_URL;
  assert.ok(apiUrl);
  const api = new URL(apiUrl);
  assert.equal(api.protocol, "http:");
  assert.equal(api.hostname, "127.0.0.1");
  assert.ok(api.port);
  assert.equal(process.env.DATABASE_URL, urls[0]);
  assert.equal(process.env.VITE_SUPABASE_URL, apiUrl);
  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, "synthetic-rehearsal-key");
  assert.equal(process.env.MANAGED_DATA_MODE, "supabase-read");
  return { root, sourceUrl: urls[0]!, targetUrl: urls[1]!, apiUrl };
}

async function until(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("disposable managed-data handoff rehearsal", { timeout: 180_000 }, async t => {
  const config = await rehearsalConfig();
  const source = new Pool({ connectionString: config.sourceUrl, max: 5, statement_timeout: 20_000 });
  const target = new Pool({ connectionString: config.targetUrl, max: 8, statement_timeout: 20_000 });
  t.after(async () => { await Promise.all([source.end(), target.end()]); });
  const api = createMigrationTargetClient();
  // Application mirror writes still use the SDK; the migration itself must
  // use the exact REST transport instead of its ordinary JSON decoder.
  const mirrorApi = createClient(config.apiUrl, "synthetic-rehearsal-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as any },
  });
  let manifest!: ExportFile;
  let setupComplete = false;

  await t.test("standalone target migration applies twice to an empty database", async () => {
    const sql = await readFile(
      new URL("../supabase/migrations/2026_09_06_managed_database_staged_migration.sql", import.meta.url),
      "utf8",
    );
    await target.query(sql);
    await target.query(sql);
    const quoteRushPollingSql = await readFile(
      new URL("../supabase/migrations/2026_09_11_quoterush_server_polling.sql", import.meta.url),
      "utf8",
    );
    await target.query(quoteRushPollingSql);
    await target.query(quoteRushPollingSql);
    const exactJsonSql = await readFile(
      new URL("../supabase/migrations/2026_09_07_managed_database_exact_json_v2.sql", import.meta.url),
      "utf8",
    );
    await target.query(exactJsonSql);
    await target.query(exactJsonSql);
    const quoteRushExactJsonSql = await readFile(
      new URL("../supabase/migrations/2026_09_12_managed_database_exact_json_quoterush_polling.sql", import.meta.url),
      "utf8",
    );
    await target.query(quoteRushExactJsonSql);
    await target.query(quoteRushExactJsonSql);
    await until(async () => {
      try {
        await api.readPage("managed_users", ["id"], 0, 0);
        return true;
      } catch {
        return false;
      }
    }, "PostgREST schema reload");
    const { rows } = await target.query(`
      select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r'
    `);
    assert.equal(rows.length, 11);
    assert.ok(rows.every(row => row.relrowsecurity), "all migrated tables enable RLS");
    const privileges = await target.query(`
      select bool_and(not has_function_privilege('anon', p.oid, 'execute')
        and not has_function_privilege('authenticated', p.oid, 'execute')
        and has_function_privilege('service_role', p.oid, 'execute')) as restricted
      from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('claim_ifw_activity', 'cleanup_ifw_activity_claims',
          'claim_insurance_quote_cache', 'reseed_managed_migration_sequences')
    `);
    assert.equal(privileges.rows[0].restricted, true);
  });

  await t.test("exports synthetic source data and imports it twice with exact reconciliation", async () => {
    await seedRehearsalSource(source);
    const connection = await source.connect();
    try {
      manifest = await exportManagedData(connection, "development");
    } finally {
      connection.release();
    }
    assert.equal(Object.keys(manifest.tables).length, 11);
    for (const table of Object.values(manifest.tables)) {
      assert.equal(table.count, ROWS_PER_TABLE);
      assert.ok(table.count > 1_000);
    }
    for (const [table, firstKey, secondKey] of [
      ["private_insurance_properties", "user_id", "address_normalized"],
      ["insurance_quote_cache", "address_normalized", "policy_type"],
    ]) {
      const rows = manifest.tables[table].rows as Record<string, unknown>[];
      assert.ok(new Set(rows.map(row => row[firstKey])).size < rows.length);
      assert.equal(new Set(rows.map(row => JSON.stringify([row[firstKey], row[secondKey]]))).size, rows.length);
    }
    const path = join(config.root, "synthetic-export.json");
    await writeFile(path, stringifyRecoveryJson(manifest), { mode: 0o600 });
    manifest = await loadManifest(path);
    for (let pass = 0; pass < 2; pass++) {
      await importManifest(manifest, api);
      await reconcileManifest(manifest, api);
    }
    // Prove there really is an API cap, rather than a test that never paginates.
    const firstPage = await api.readPage("private_insurance_properties",
      ["user_id", "address_normalized"], 0, 9_999);
    assert.equal(firstPage.rows.length, 1_000);
    assert.equal(firstPage.count, ROWS_PER_TABLE);
    const transferredQuoteState = await target.query<{
      quote_poll_attempts: number;
      quote_stable_polls: number;
      quote_previous_counter: number | null;
      quote_poll_claimed_at: string | null;
      quote_poll_lease_until: string | null;
      email_recipient: string | null;
      email_delivery_status: string;
      email_retry_count: number;
      email_quarantine_at: string | null;
      email_error: string | null;
    }>(`
      select quote_poll_attempts, quote_stable_polls, quote_previous_counter,
             to_char(quote_poll_claimed_at at time zone 'UTC',
               'YYYY-MM-DD HH24:MI:SS') as quote_poll_claimed_at,
             to_char(quote_poll_lease_until at time zone 'UTC',
               'YYYY-MM-DD HH24:MI:SS') as quote_poll_lease_until,
             email_recipient, email_delivery_status, email_retry_count,
             email_quarantine_at, email_error
        from insurance_quote_cache
       where id = 1
    `);
    assert.deepEqual(transferredQuoteState.rows[0], {
      quote_poll_attempts: 1,
      quote_stable_polls: 1,
      quote_previous_counter: 1,
      quote_poll_claimed_at: "2026-02-02 13:01:00",
      quote_poll_lease_until: "2026-02-02 14:01:00",
      email_recipient: "quote-recipient-1@example.invalid",
      email_delivery_status: "sending",
      email_retry_count: 1,
      email_quarantine_at: null,
      email_error: null,
    });
    t.diagnostic(`Reconciled ${11 * ROWS_PER_TABLE} synthetic rows across 11 tables after each import.`);
    setupComplete = true;
  });
  assert.ok(setupComplete, "Stop the rehearsal after a failed initial handoff");

  await t.test("reconciliation detects changed content, changed keys, and missing rows beyond page one", async () => {
    const rows = manifest.tables.private_insurance_properties.rows as Record<string, unknown>[];
    const tail = rows.at(-1)!;
    const identity = [tail.user_id, tail.address_normalized];
    await target.query(`update private_insurance_properties set quote_cache_scope = 'tampered'
      where user_id = $1 and address_normalized = $2`, identity);
    await assert.rejects(reconcileManifest(manifest, api), /mismatch for private_insurance_properties/);
    await target.query(`update private_insurance_properties
      set quote_cache_scope = $3, address_normalized = 'changed-key.invalid'
      where user_id = $1 and address_normalized = $2`, [...identity, tail.quote_cache_scope]);
    await assert.rejects(reconcileManifest(manifest, api), /mismatch for private_insurance_properties/);
    await target.query(`delete from private_insurance_properties
      where user_id = $1 and address_normalized = 'changed-key.invalid'`, [tail.user_id]);
    await assert.rejects(reconcileManifest(manifest, api), /mismatch for private_insurance_properties/);
    await importManifest(manifest, api);
    await reconcileManifest(manifest, api);
  });

  await t.test("reseed RPC advances every imported serial sequence", async () => {
    for (const [table, data] of Object.entries(manifest.tables)) {
      const sequence = await target.query("select pg_get_serial_sequence($1, 'id') as name", [table])
        .catch(error => {
          // Tables with natural/composite primary keys deliberately have no id.
          if (error.code === "42703") return { rows: [{ name: null }] };
          throw error;
        });
      if (!sequence.rows[0].name) continue;
      const { rows } = await target.query("select nextval($1)::int as id", [sequence.rows[0].name]);
      assert.equal(rows[0].id, Math.max(...(data.rows as { id: number }[]).map(row => row.id)) + 1, table);
    }
  });

  await t.test("managed write queues through the real final-sync import and resumes with its mirror", async () => {
    const { withSourceWriteFence } = await import("../server/managed-data-routing");
    const snapshot = await source.connect();
    const blocker = await target.connect();
    const writerPool = new Pool({ connectionString: config.sourceUrl, max: 1, statement_timeout: 20_000 });
    const writerPid = Number((await writerPool.query("select pg_backend_pid() as pid")).rows[0].pid);
    let sync: Promise<ExportFile> | undefined;
    let write: Promise<void> | undefined;
    let enteredWrite = false;
    const value = { rehearsal: "queued-managed-write", nested: { complete: true } };
    try {
      await blocker.query("begin");
      await blocker.query("lock table managed_users in access exclusive mode");
      sync = finalSyncManagedData(snapshot, "development", join(config.root, "synthetic-final-sync.json"), api);
      // Attach rejection handlers immediately while observing locks.
      void sync.catch(() => undefined);
      await until(async () => Number((await target.query(`
        select count(*) from pg_locks
        where relation = 'managed_users'::regclass and not granted
      `)).rows[0].count) > 0, "final sync to block inside its real target import");
      write = withSourceWriteFence(async () => {
        enteredWrite = true;
        await source.query("update questionnaire_responses set response_data = $1 where id = 1", [value]);
        const result = await mirrorApi.from("managed_questionnaire_responses")
          .update({ response_data: value }).eq("id", 1);
        assert.ifError(result.error);
      }, writerPool as unknown as Parameters<typeof withSourceWriteFence>[1]);
      void write.catch(() => undefined);
      await until(async () => (await source.query(`
        select 1 from pg_locks where pid = $1 and locktype = 'advisory' and not granted
      `, [writerPid])).rows.length > 0, "concurrent managed writer to queue on the final-sync fence");
      assert.equal(enteredWrite, false);
      assert.equal((await source.query("select response_data from questionnaire_responses where id = 1"))
        .rows[0].response_data.rehearsal, undefined);
      await blocker.query("commit");
      const synced = await sync;
      const persisted = await loadManifest(join(config.root, "synthetic-final-sync.json"));
      assert.equal(synced.checksum, persisted.checksum);
      assert.equal((await stat(join(config.root, "synthetic-final-sync.json"))).mode & 0o777, 0o600);
      await write;
      assert.equal(enteredWrite, true);
      for (const [pool, table] of [[source, "questionnaire_responses"], [target, "managed_questionnaire_responses"]] as const) {
        assert.deepEqual((await pool.query(`select response_data from ${table} where id = 1`)).rows[0].response_data, value);
      }
      // A new complete snapshot verifies that the resumed mirror did not lose data.
      await reconcileManifest(await exportManagedData(snapshot, "development"), api);
    } finally {
      await blocker.query("rollback");
      await Promise.allSettled([sync, write].filter(Boolean));
      blocker.release();
      snapshot.release();
      await writerPool.end();
    }
  });

  await t.test("failed final sync releases its exclusive fence and permits a later managed write", async () => {
    const { withSourceWriteFence } = await import("../server/managed-data-routing");
    const snapshot = await source.connect();
    let writer: PoolClient | undefined;
    try {
      await target.query("alter table managed_users add constraint rehearsal_reject_import check (id <> 1) not valid");
      await assert.rejects(
        finalSyncManagedData(snapshot, "development", join(config.root, "synthetic-failed-sync.json"), api),
        /Migration target upsert failed: managed_users/,
      );
      writer = await source.connect();
      const lock = await writer.query("select pg_try_advisory_lock(hashtextextended('managed-data-write-fence', 0)) as ok");
      assert.equal(lock.rows[0].ok, true);
      await writer.query("select pg_advisory_unlock(hashtextextended('managed-data-write-fence', 0))");
      await withSourceWriteFence(async () => {
        assert.equal((await source.query("select 1 as ok")).rows[0].ok, 1);
      }, source as unknown as Parameters<typeof withSourceWriteFence>[1]);
    } finally {
      writer?.release();
      snapshot.release();
      await target.query("alter table managed_users drop constraint if exists rehearsal_reject_import");
    }
  });

  await t.test("claim RPC races", rpc => testClaimRaces(rpc, target));
});