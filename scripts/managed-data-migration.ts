import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseRecoveryJson, stringifyRecoveryJson, recoveryChecksum } from "./managed-data-recovery-json";
import { normalizeMigrationTimestamps, normalizeRecoveryRows, recoveryJsonColumns } from "./managed-data-recovery-columns";
import { createMigrationTargetClient as createExactMigrationTargetClient, type MigrationTargetClient } from "./managed-data-migration-target";
import { fetchAllRecoveryTargetRows } from "./managed-data-recovery-target";
import { MANAGED_DATA_WRITE_FENCE_KEY } from "../server/managed-data-fence";
import {
  TABLES,
  canonicalRows,
  contentChecksum,
  createMigrationSourcePool,
  fetchAllTargetRows,
  primaryKeys,
  type ExportFile,
  type MigrationSqlClient,
} from "./managed-data-migration-common";

// Preserve the original migration module API for existing callers.
export {
  TABLES,
  canonicalRows,
  contentChecksum,
  createMigrationSourcePool,
  fetchAllTargetRows,
  primaryKeys,
  stable,
  type ExportFile,
  type MigrationSqlClient,
} from "./managed-data-migration-common";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createMigrationTargetClient(): MigrationTargetClient {
  const url = required("VITE_SUPABASE_URL", process.env.VITE_SUPABASE_URL);
  const key = required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
  return createExactMigrationTargetClient(url, key);
}
function buildManifest(environment: ExportFile["environment"], tables: ExportFile["tables"]): ExportFile {
  return {
    format: "havo-managed-data-v1", environment, exportedAt: new Date().toISOString(),
    checksumEncoding: "exact-json-v2",
    tables, checksum: recoveryChecksum(tables),
  };
}

/** PostgreSQL row_to_json::text preserves dates natively before driver decoding. */
export async function collectSourceManifest(
  source: MigrationSqlClient, environment: ExportFile["environment"],
): Promise<ExportFile> {
  const tables: ExportFile["tables"] = {};
  for (const [sourceTable, target, pk] of TABLES) {
    const jsonColumns = recoveryJsonColumns(target);
    const projections = jsonColumns.map(column => `source_row."${column}"::text as "${column}"`);
    const result = await source.query(`select row_to_json(source_row)::text as exact_row${projections.length ? `, ${projections.join(", ")}` : ""} from "${sourceTable}" source_row`);
    const rows = canonicalRows(normalizeRecoveryRows(
      target, result.rows.map((row: any) => {
        const parsed = parseRecoveryJson(row.exact_row) as Record<string, unknown>;
        for (const column of jsonColumns) parsed[column] = row[column];
        return parsed;
      }),
    ), pk);
    tables[target] = {
      sourceTable, rows, count: rows.length,
      primaryKeyChecksum: recoveryChecksum(primaryKeys(rows, pk)),
      checksum: recoveryChecksum(rows),
    };
  }
  return buildManifest(environment, tables);
}
/**
 * Wait for every in-flight shared application fence before opening the source
 * snapshot. A session-level lock is required here: taking a transaction-level
 * lock after BEGIN could establish a stale REPEATABLE READ snapshot while the
 * lock query waits.
 */
export async function withExclusiveMigrationSnapshot<T>(
  source: MigrationSqlClient,
  work: () => Promise<T>,
  fenceKey = MANAGED_DATA_WRITE_FENCE_KEY,
): Promise<T> {
  let lockAcquired = false;
  let transactionOpen = false;
  let result: T | undefined;
  let failure: unknown;
  try {
    await source.query(
      "select pg_advisory_lock(hashtextextended($1, 0))",
      [fenceKey],
    );
    lockAcquired = true;
    await source.query(
      "begin transaction isolation level repeatable read read only",
    );
    transactionOpen = true;
    result = await work();
    await source.query("commit");
    transactionOpen = false;
  } catch (error) {
    failure = error;
    if (transactionOpen) {
      try {
        await source.query("rollback");
        transactionOpen = false;
      } catch {
        // Preserve the original failure. Closing the pool connection after this
        // helper returns releases both transaction and session advisory locks.
      }
    }
  } finally {
    if (lockAcquired) {
      try {
        const unlocked = await source.query(
          "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
          [fenceKey],
        );
        if (unlocked.rows?.[0]?.unlocked === false) {
          throw new Error("Managed-data migration fence was not held");
        }
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
  return result as T;
}

async function exportSource(): Promise<void> {
  const environment = required("--environment", arg("environment"));
  if (environment !== "development" && environment !== "production") {
    throw new Error("--environment must be development or production");
  }
  // Replit injects the selected deployment's managed database as DATABASE_URL.
  // NEON_DATABASE_URL is deliberately neither read nor accepted.
  const connectionString = required("DATABASE_URL", process.env.DATABASE_URL);
  const output = resolve(required("--output", arg("output")));
  const pool = createMigrationSourcePool(connectionString);
  const source = await pool.connect();
  try {
    const manifest = await exportManagedData(source, environment);
    await writeManifest(output, manifest);
    console.log(`Exported ${Object.values(manifest.tables).reduce((n, t) => n + t.count, 0)} rows to ${output}`);
    console.log(`Manifest SHA-256: ${manifest.checksum}`);
  } finally {
    source.release();
    await pool.end();
  }
}

export async function loadManifest(
  input = resolve(required("--input", arg("input"))),
): Promise<ExportFile> {
  return parseMigrationManifest(await readFile(input, "utf8"));
}

export function parseMigrationManifest(text: string): ExportFile {
  const file = parseRecoveryJson(text) as ExportFile;
  if (file.checksumEncoding !== undefined && file.checksumEncoding !== "exact-json-v1" && file.checksumEncoding !== "exact-json-v2") {
    throw new Error("Unsupported export checksum encoding");
  }
  const checksum = file.checksumEncoding ? recoveryChecksum : contentChecksum;
  if (file.format !== "havo-managed-data-v1" || checksum(file.tables) !== file.checksum) {
    throw new Error("Export manifest checksum validation failed");
  }
  for (const [target, table] of Object.entries(file.tables)) {
    const descriptor = TABLES.find(([, candidate]) => candidate === target);
    if (
      table.count !== table.rows.length ||
      checksum(table.rows) !== table.checksum ||
      (descriptor && checksum(primaryKeys(table.rows as any[], descriptor[2])) !== table.primaryKeyChecksum)
    ) {
      throw new Error(`Table checksum validation failed for ${table.sourceTable}`);
    }
  }
  return file;
}
export async function importManifest(
  file: ExportFile,
  client: MigrationTargetClient = createMigrationTargetClient(),
): Promise<void> {
  if (file.environment === "production" && !process.argv.includes("--allow-production-import")) {
    throw new Error("Production imports require the explicit --allow-production-import acknowledgement");
  }
  for (const [, target, pk] of TABLES) {
    const rows = file.tables[target]?.rows ?? [];
    for (let offset = 0; offset < rows.length; offset += 250) {
      await client.upsert(target, pk, rows.slice(offset, offset + 250), file.checksumEncoding);
    }
    console.log(`Imported ${rows.length} idempotent rows into ${target}`);
  }
  await client.reseed();
}
async function importTarget(): Promise<void> { await importManifest(await loadManifest()); }

export async function reconcileManifest(
  file: ExportFile,
  client: MigrationTargetClient | SupabaseClient = createMigrationTargetClient(),
): Promise<void> {
  const hash = file.checksumEncoding ? recoveryChecksum : contentChecksum;
  for (const [, target, pk] of TABLES) {
    const expected = file.tables[target];
    if (file.checksumEncoding === "exact-json-v2" && !("readPage" in client)) {
      throw new Error("Exact JSON v2 reconciliation requires the projection-aware migration client");
    }
    const fetched = "readPage" in client
      ? await fetchAllRecoveryTargetRows({
        readPage: (table, keys, from, to) => client.readPage(table, keys, from, to, file.checksumEncoding),
      }, target, pk.split(","))
      : await fetchAllTargetRows(client, target, pk.split(","));
    const rows = canonicalRows(
      file.checksumEncoding === "exact-json-v2" ? normalizeRecoveryRows(target, fetched)
        : file.checksumEncoding ? normalizeMigrationTimestamps(target, fetched) : fetched,
      pk,
    );
    const checksum = hash(rows);
    const pkOk = hash(primaryKeys(rows, pk)) === expected.primaryKeyChecksum;
    const contentOk = checksum === expected.checksum;
    const ok = rows.length === expected.count && pkOk && contentOk;
    console.log(
      `${target}: count=${rows.length}/${expected.count} ` +
      `primary-keys=${pkOk ? "match" : "MISMATCH"} ` +
      `content=${contentOk ? "match" : "MISMATCH"}`,
    );
    if (!ok) throw new Error(`Reconciliation mismatch for ${target}`);
  }
}
async function reconcile(): Promise<void> {
  try { await reconcileManifest(await loadManifest()); }
  catch (error) { process.exitCode = 2; throw error; }
}

/** Shared by the CLI and disposable rehearsal: keep the fence through reconciliation. */
export async function finalSyncManagedData(
  source: MigrationSqlClient,
  environment: ExportFile["environment"],
  output: string,
  target = createMigrationTargetClient(),
): Promise<ExportFile> {
  return withExclusiveMigrationSnapshot(source, async () => {
    const manifest = await collectSourceManifest(source, environment);
    await writeManifest(output, manifest);
    await importManifest(manifest, target);
    await reconcileManifest(manifest, target);
    console.log(`Final sync reconciled ${Object.keys(manifest.tables).length} tables; manifest SHA-256: ${manifest.checksum}`);
    return manifest;
  });
}
async function finalSync(): Promise<void> {
  const environment = required("--environment", arg("environment"));
  if (environment !== "development" && environment !== "production") throw new Error("--environment must be development or production");
  if (environment === "production" && !process.argv.includes("--allow-production-import")) {
    throw new Error("Production final-sync requires --allow-production-import");
  }
  const output = resolve(required("--output", arg("output")));
  const pool = createMigrationSourcePool(
    required("DATABASE_URL", process.env.DATABASE_URL),
  );
  const source = await pool.connect();
  try {
    // The session-level exclusive fence is acquired before BEGIN so the
    // repeatable-read snapshot necessarily includes every earlier shared write.
    // Later app writes queue until import and reconciliation finish.
    await finalSyncManagedData(source, environment, output);
  } finally {
    source.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  try {
    if (command === "export") await exportSource();
    else if (command === "import") await importTarget();
    else if (command === "reconcile") await reconcile();
    else if (command === "final-sync") await finalSync();
    else if (command === "reverse-dry-run" || command === "reverse-restore") {
      const { runRecoveryCommand } = await import("./managed-data-recovery");
      await runRecoveryCommand(command);
    } else {
      console.error("Usage: managed-data-migration.ts export|import|reconcile|final-sync|reverse-dry-run|reverse-restore [options]");
      process.exitCode = 1;
    }
  } catch {
    // Driver/API errors can include SQL values, private rows or credentials.
    // Never let the CLI's top-level exception handler print the raw exception.
    console.error("Managed-data command failed; no rollback approval issued. Check prerequisites and reconciliation status; do not log private records.");
    process.exitCode ||= 1;
  }
}

export async function exportManagedData(
  source: MigrationSqlClient,
  environment: ExportFile["environment"],
): Promise<ExportFile> {
  return withExclusiveMigrationSnapshot(source, () => collectSourceManifest(source, environment));
}

async function writeManifest(output: string, manifest: ExportFile): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${stringifyRecoveryJson(manifest)}\n`, { mode: 0o600 });
}
