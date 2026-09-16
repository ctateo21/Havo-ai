import { open, readFile } from "node:fs/promises";
import {
  TABLES, canonicalRows, createMigrationSourcePool, primaryKeys,
  type ExportFile, type MigrationSqlClient,
} from "./managed-data-migration-common";
import {
  parseRecoveryJson, recoveryChecksum as contentChecksum, stringifyRecoveryJson,
} from "./managed-data-recovery-json";
import {
  createRecoveryTargetReader, fetchAllRecoveryTargetRows, type RecoveryTargetReader,
} from "./managed-data-recovery-target";
import { MANAGED_DATA_WRITE_FENCE_KEY } from "../server/managed-data-fence";
import { createRecoveryReceipt } from "../server/managed-data-recovery-proof";
import {
  normalizeRecoveryRows, recoveryJsonColumns, recoveryTimestampColumns,
} from "./managed-data-recovery-columns";

type Environment = ExportFile["environment"];
type TargetClient = RecoveryTargetReader;
export type RecoveryManifest = Omit<ExportFile, "format"> & {
  format: "havo-managed-recovery-v2";
};
export interface RecoveryApproval {
  environment: Environment;
  writersStopped: boolean;
  approveRestore: boolean;
  allowProductionRestore: boolean;
  expectedChecksum: string;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const tableName = (schema: string, table: string) => `${quote(schema)}.${quote(table)}`;

function assertEnvironment(environment: unknown): asserts environment is Environment {
  if (environment !== "development" && environment !== "production") {
    throw new Error("An explicit development or production environment is required");
  }
  if (process.env.NODE_ENV === "production" && environment !== "production") {
    throw new Error("Production runtime requires production acknowledgement");
  }
}

/** Strict allowlist: no manifest-controlled SQL identifiers or missing tables. */
export function validateRecoveryManifest(value: unknown): asserts value is RecoveryManifest {
  const file = value as RecoveryManifest;
  if (!file || file.format !== "havo-managed-recovery-v2" || !file.tables ||
      !Number.isFinite(Date.parse(file.exportedAt))) throw new Error("Invalid recovery manifest");
  assertEnvironment(file.environment);
  const targets = TABLES.map(([, target]) => target);
  if (Object.keys(file.tables).length !== targets.length ||
      Object.keys(file.tables).some(target => !targets.includes(target as typeof targets[number]))) {
    throw new Error("Recovery requires exactly all managed tables");
  }
  for (const [source, target, pk] of TABLES) {
    const table = file.tables[target];
    if (!table || table.sourceTable !== source || !Array.isArray(table.rows) ||
        table.rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`Invalid recovery table: ${target}`);
    }
    try {
      for (const row of table.rows as Record<string, unknown>[]) {
        for (const column of recoveryJsonColumns(target)) {
          if (!Object.prototype.hasOwnProperty.call(row, column) || row[column] === null) continue;
          if (typeof row[column] !== "string" ||
              stringifyRecoveryJson(parseRecoveryJson(row[column]), true) !== row[column]) {
            throw new Error("Invalid recovery JSON column");
          }
        }
      }
    } catch {
      throw new Error(`Recovery integrity failure: ${target}`);
    }
    const rows = canonicalRows(table.rows, pk);
    const keys = primaryKeys(rows, pk);
    if (keys.some(key => key.some(value => value == null)) ||
        new Set(keys.map(key => stringifyRecoveryJson(key, true))).size !== rows.length ||
        table.count !== rows.length || contentChecksum(rows) !== table.checksum ||
        contentChecksum(keys) !== table.primaryKeyChecksum) {
      throw new Error(`Recovery integrity failure: ${target}`);
    }
  }
  if (contentChecksum(file.tables) !== file.checksum) throw new Error("Recovery manifest checksum mismatch");
}

/** Reads only Supabase; the old database is never connected during dry-run. */
export async function exportRecoveryManifest(
  client: TargetClient, environment: Environment,
): Promise<RecoveryManifest> {
  assertEnvironment(environment);
  const tables: RecoveryManifest["tables"] = {};
  for (const [sourceTable, target, pk] of TABLES) {
    let rows: any[];
    try {
      rows = canonicalRows(normalizeRecoveryRows(
        target, await fetchAllRecoveryTargetRows(client, target, pk.split(",")),
      ), pk);
    }
    catch { throw new Error(`Recovery target read failed: ${target}`); }
    tables[target] = {
      sourceTable, rows, count: rows.length,
      primaryKeyChecksum: contentChecksum(primaryKeys(rows, pk)),
      checksum: contentChecksum(rows),
    };
  }
  const manifest: RecoveryManifest = {
    format: "havo-managed-recovery-v2", environment,
    exportedAt: new Date().toISOString(), tables, checksum: contentChecksum(tables),
  };
  validateRecoveryManifest(manifest);
  return manifest;
}

/** A second full scan detects drift; it does NOT replace stopping all writers. */
export async function verifyRecoveryTarget(file: RecoveryManifest, client: TargetClient): Promise<void> {
  validateRecoveryManifest(file);
  const current = await exportRecoveryManifest(client, file.environment);
  for (const [, target] of TABLES) {
    compareTable(target, file.tables[target], current.tables[target].rows);
  }
}

function compareTable(target: string, expected: RecoveryManifest["tables"][string], rows: unknown[]) {
  const pk = TABLES.find(([, name]) => name === target)![2];
  const canonical = canonicalRows(normalizeRecoveryRows(target, rows), pk);
  const countOk = canonical.length === expected.count;
  const keysOk = contentChecksum(primaryKeys(canonical, pk)) === expected.primaryKeyChecksum;
  const contentOk = contentChecksum(canonical) === expected.checksum;
  console.log(`${target}: count=${canonical.length}/${expected.count} primary-keys=${keysOk ? "match" : "MISMATCH"} content=${contentOk ? "match" : "MISMATCH"}`);
  if (!countOk || !keysOk || !contentOk) throw new Error(`Recovery reconciliation failed: ${target}`);
}

/** Refuses overwrite/symlinks, and never writes private data to a public file. */
export async function writePrivateRecoveryFile(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${stringifyRecoveryJson(value)}\n`);
    await file.sync();
  } finally { await file.close(); }
}

export function validateRecoveryApproval(file: RecoveryManifest, approval: RecoveryApproval): void {
  validateRecoveryManifest(file);
  assertEnvironment(approval.environment);
  if (approval.environment !== file.environment || !approval.writersStopped ||
      !approval.approveRestore || approval.expectedChecksum !== file.checksum ||
      (approval.environment === "production" && !approval.allowProductionRestore)) {
    throw new Error("Recovery requires matching environment/checksum, stopped writers, approved restore, and production acknowledgement");
  }
}

/**
 * Exact replacement, not an upsert-only merge: deleted target rows must not be
 * resurrected on rollback. No CASCADE, grants, role changes, or session-wide
 * read/write override. Any failure rolls back rows AND sequence restarts.
 * Call only on a dedicated recovery-role connection, with every writer stopped.
 */
export async function restoreRecoveryManifest(
  source: MigrationSqlClient, client: TargetClient,
  file: RecoveryManifest, approval: RecoveryApproval,
  schema = "public", fenceKey = MANAGED_DATA_WRITE_FENCE_KEY,
) {
  validateRecoveryApproval(file, approval);
  // Stale/tampered exports fail before a source write transaction is opened.
  await verifyRecoveryTarget(file, client);
  let locked = false;
  let transaction = false;
  try {
    await source.query("set default_transaction_read_only = on");
    await source.query("select pg_advisory_lock(hashtextextended($1, 0))", [fenceKey]);
    locked = true;
    await source.query("begin transaction isolation level serializable read write");
    transaction = true;
    await source.query("set local time zone 'UTC'");
    await source.query("set local lock_timeout = '15s'");
    await source.query("set local statement_timeout = '120s'");
    const names = TABLES.map(([name]) => tableName(schema, name)).join(", ");
    await source.query(`lock table ${names} in access exclusive mode`);
    const sourceColumns = new Map<string, Array<{ column_name: string; data_type: string }>>();
    // Reject schema drift before touching rows. Postgres otherwise silently
    // ignores unknown JSON keys and could erase data from newly added columns.
    for (const [name, target] of TABLES) {
      const { rows: columns } = await source.query(
        "select column_name, data_type from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position",
        [schema, name],
      );
      if (!columns.length) throw new Error("Recovery source table missing");
      sourceColumns.set(name, columns);
      const expected = columns.map((column: any) => column.column_name).sort();
      const timestamps = recoveryTimestampColumns(target);
      const jsonColumns = recoveryJsonColumns(target);
      if (columns.some((column: any) => timestamps.includes(column.column_name) &&
          column.data_type !== "timestamp without time zone" &&
          column.data_type !== "timestamp with time zone")) {
        throw new Error(`Recovery timestamp schema mismatch: ${target}`);
      }
      if (columns.some((column: any) => jsonColumns.includes(column.column_name) &&
          column.data_type !== "json" && column.data_type !== "jsonb")) {
        throw new Error(`Recovery JSON schema mismatch: ${target}`);
      }
      if (columns.some((column: any) =>
        (column.data_type === "json" || column.data_type === "jsonb") &&
        !jsonColumns.includes(column.column_name))) {
        // Unknown JSON fields were not projected as text at the target and
        // would otherwise lose the SQL NULL versus JSON null distinction.
        throw new Error(`Recovery JSON schema mismatch: ${target}`);
      }
      if (file.tables[target].rows.some(row => jsonColumns.some(column =>
        Object.prototype.hasOwnProperty.call(row, column) &&
        !columns.some((sourceColumn: any) => sourceColumn.column_name === column &&
          (sourceColumn.data_type === "json" || sourceColumn.data_type === "jsonb"))))) {
        throw new Error(`Recovery JSON schema mismatch: ${target}`);
      }
      if (file.tables[target].rows.some(row =>
        JSON.stringify(Object.keys(row as object).sort()) !== JSON.stringify(expected))) {
        throw new Error(`Recovery schema mismatch: ${target}`);
      }
    }
    // A single explicit list permits internal FKs, but refuses external FKs.
    await source.query(`truncate table ${names} restart identity`);
    for (const [name, target] of TABLES) {
      const rows = file.tables[target].rows;
      const qualified = tableName(schema, name);
      const columns = sourceColumns.get(name)!;
      const jsonColumns = recoveryJsonColumns(target);
      const columnList = columns.map(column => quote(column.column_name)).join(", ");
      const selections = columns.map(column => {
        if (!jsonColumns.includes(column.column_name)) return `native.${quote(column.column_name)}`;
        return `(item.value ->> ${quoteLiteral(column.column_name)})::${column.data_type}`;
      }).join(", ");
      for (let offset = 0; offset < rows.length; offset += 250) {
        await source.query(
          `insert into ${qualified} (${columnList})
           select ${selections}
           from json_array_elements($1::json) as item(value)
           cross join lateral json_populate_record(null::${qualified}, item.value) as native`,
          [stringifyRecoveryJson(rows.slice(offset, offset + 250))],
        );
      }
      // ALTER SEQUENCE RESTART is transactional, unlike setval().
      const sequences = await source.query(`
        select a.attname as column_name, ns.nspname as sequence_schema,
               seq.relname as sequence_name, p.seqmin::text, p.seqmax::text, p.seqincrement::text
        from pg_attribute a
        join pg_class t on t.oid = a.attrelid
        join pg_namespace tn on tn.oid = t.relnamespace
        join pg_class seq on seq.oid = pg_get_serial_sequence($1, a.attname)::regclass
        join pg_namespace ns on ns.oid = seq.relnamespace
        join pg_sequence p on p.seqrelid = seq.oid
        where tn.nspname = $2 and t.relname = $3 and a.attnum > 0 and not a.attisdropped
      `, [qualified, schema, name]);
      for (const sequence of sequences.rows) {
        const increment = BigInt(sequence.seqincrement);
        if (increment !== BigInt(1)) throw new Error("Recovery requires standard increasing sequences");
        const maximum = await source.query(`select max(${quote(sequence.column_name)})::text as maximum from ${qualified}`);
        const max = maximum.rows[0].maximum;
        const next = max == null ? BigInt(sequence.seqmin) : BigInt(max) + increment;
        if (next < BigInt(sequence.seqmin) || next > BigInt(sequence.seqmax)) throw new Error("Recovery sequence exhausted");
        await source.query(`alter sequence ${tableName(sequence.sequence_schema, sequence.sequence_name)} restart with ${next}`);
      }
    }
    for (const [name, target] of TABLES) {
      // JSON preserves sub-millisecond timestamps and dates without driver loss.
      // JSON/JSONB is projected as SQL text first so JSON null remains distinct
      // from SQL NULL in the same v2 representation used by the target reader.
      const jsonColumns = recoveryJsonColumns(target);
      const projection = sourceColumns.get(name)!.map(column => {
        const identifier = quote(column.column_name);
        return jsonColumns.includes(column.column_name)
          ? `${identifier}::text as ${identifier}` : identifier;
      }).join(", ");
      const result = await source.query(
        `select row_to_json(projected)::text as row from (select ${projection} from ${tableName(schema, name)}) projected`,
      );
      compareTable(target, file.tables[target], result.rows.map((item: any) => parseRecoveryJson(item.row)));
    }
    // A target change during restore invalidates the entire transaction.
    await verifyRecoveryTarget(file, client);
    await source.query("commit");
    transaction = false;
  } catch {
    if (transaction) {
      try { await source.query("rollback"); } catch { /* Connection must be discarded by caller. */ }
    }
    // Never propagate driver DETAIL fields (which often include private rows).
    throw new Error("Recovery restore failed; no rollback receipt issued");
  } finally {
    if (locked) {
      await source.query("select pg_advisory_unlock(hashtextextended($1, 0))", [fenceKey])
        .catch(() => { throw new Error("Recovery fence cleanup failed; no receipt issued"); });
    }
  }
  // Only reachable after all checks and successful COMMIT.
  return createRecoveryReceipt(file.checksum, file.environment);
}

export async function runRecoveryCommand(command: "reverse-dry-run" | "reverse-restore"): Promise<void> {
  const args = process.argv.slice(3);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => {
    const index = args.indexOf(`--${name}`);
    const result = index < 0 ? undefined : args[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`--${name} is required`);
    return result;
  };
  const environment = value("environment");
  assertEnvironment(environment);
  if (!flag("acknowledge-writers-stopped")) throw new Error("--acknowledge-writers-stopped is required");
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase recovery configuration is required");
  const client = createRecoveryTargetReader(url, key);
  if (command === "reverse-dry-run") {
    const output = value("output");
    const manifest = await exportRecoveryManifest(client, environment);
    await verifyRecoveryTarget(manifest, client);
    await writePrivateRecoveryFile(output, manifest);
    console.log(`Recovery dry-run verified ${TABLES.length} tables. SHA-256: ${manifest.checksum}. Source unchanged; rollback NOT enabled.`);
    return;
  }
  const input: unknown = parseRecoveryJson(await readFile(value("input"), "utf8"));
  validateRecoveryManifest(input);
  const approval: RecoveryApproval = {
    environment, writersStopped: flag("acknowledge-writers-stopped"),
    approveRestore: flag("approve-restore"), allowProductionRestore: flag("allow-production-restore"),
    expectedChecksum: value("expected-checksum"),
  };
  validateRecoveryApproval(input, approval);
  const receiptPath = value("receipt");
  // Reserve a fresh private file before mutation. Existing approvals cannot be
  // accidentally reused or overwritten. Empty reservations fail runtime checks.
  const receiptFile = await open(receiptPath, "wx", 0o600);
  try {
    if (!process.env.DATABASE_URL) throw new Error("Managed source configuration is required");
    const pool = createMigrationSourcePool(process.env.DATABASE_URL);
    try {
      const source = await pool.connect();
      try {
        const receipt = await restoreRecoveryManifest(source, client, input, approval);
        await receiptFile.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
        await receiptFile.sync();
        console.log(`Recovery committed and reconciled ${TABLES.length} tables. Receipt issued for SHA-256: ${input.checksum}. Keep writers stopped until approved rollback deployment.`);
      } finally {
        // Never return a potentially failed transaction/session to a pool.
        source.release(true);
      }
    } finally { await pool.end(); }
  } finally { await receiptFile.close(); }
}