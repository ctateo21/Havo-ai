import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  exportRecoveryManifest, restoreRecoveryManifest, validateRecoveryApproval,
  validateRecoveryManifest, verifyRecoveryTarget, writePrivateRecoveryFile,
  type RecoveryManifest,
} from "../scripts/managed-data-recovery";
import {
  TABLES, createMigrationSourcePool, primaryKeys,
  type MigrationSqlClient,
} from "../scripts/managed-data-migration";
import {
  parseRecoveryJson, recoveryChecksum as contentChecksum, stringifyRecoveryJson,
} from "../scripts/managed-data-recovery-json";
import {
  normalizeRecoveryRows, recoveryJsonColumns, recoveryTimestampColumns,
} from "../scripts/managed-data-recovery-columns";

type Row = Record<string, unknown>;
const rowsFor = (target: string, primaryKey: string): Row[] => {
  const keys = primaryKey.split(",");
  return [1, 2, 3].map(n => Object.fromEntries(keys.map((key, index) => [
    key, key === "address_normalized" ? `address-${n}` :
      key === "policy_type" ? `policy-${n}` : key === "dedupe_key" ? `claim-${n}` : n + index,
  ])));
};

function targetClient(data: Record<string, Row[]>, pageSize = 2) {
  const calls: Array<{ table: string; from: number; orders: string[] }> = [];
  return {
    calls,
    async readPage(table: string, primaryKey: string[], from: number, to: number) {
      calls.push({ table, from, orders: [...primaryKey] });
      const rows = (data[table] ?? [])
        .slice(from, Math.min(to + 1, from + pageSize))
        .map(row => {
          const encoded = { ...row };
          for (const column of recoveryJsonColumns(table)) {
            if (Object.prototype.hasOwnProperty.call(encoded, column) &&
                encoded[column] !== null) {
              // Fixtures model actual target JSON values. The reader contract
              // models the explicit ::text projection, including JSON strings.
              encoded[column] = stringifyRecoveryJson(encoded[column]);
            }
          }
          return encoded;
        });
      // A deliberately short page verifies callers continue from the number
      // of rows received rather than trusting a requested range size.
      return { rows, count: data[table]?.length ?? 0 };
    },
  };
}

async function manifest(data = fixture()): Promise<RecoveryManifest> {
  return exportRecoveryManifest(targetClient(data) as any, "development");
}

function fixture() {
  return Object.fromEntries(TABLES.map(([, target, pk]) => [target, rowsFor(target, pk)])) as Record<string, Row[]>;
}

function approval(file: RecoveryManifest) {
  return { environment: "development" as const, writersStopped: true, approveRestore: true,
    allowProductionRestore: false, expectedChecksum: file.checksum };
}

test("recovery export includes every managed table, composite keys, and every target page", async () => {
  const data = fixture();
  const client = targetClient(data);
  const file = await exportRecoveryManifest(client as any, "development");
  assert.equal(file.format, "havo-managed-recovery-v2");
  assert.deepEqual(Object.keys(file.tables).sort(), TABLES.map(([, target]) => target).sort());
  for (const [, target, pk] of TABLES) {
    assert.equal(file.tables[target].count, 3);
    assert.equal(file.tables[target].primaryKeyChecksum,
      contentChecksum(primaryKeys(data[target], pk)));
    assert.deepEqual(client.calls.filter(call => call.table === target).map(call => call.from), [0, 2]);
  }
  assert.deepEqual(client.calls.find(call => call.table === "private_insurance_properties")?.orders,
    ["user_id", "address_normalized"]);
});

test("only typed timestamp columns normalize offsets while preserving microseconds", () => {
  const normalized = (created_at: string) =>
    normalizeRecoveryRows("managed_users", [{ id: 1, created_at }]);
  assert.notEqual(
    contentChecksum(normalized("2026-09-07T12:00:00.123456Z")),
    contentChecksum(normalized("2026-09-07T12:00:00.123457Z")),
  );
  assert.equal(
    contentChecksum(normalized("2026-09-07T12:00:00.123400Z")),
    contentChecksum(normalized("2026-09-07T08:00:00.1234-04:00")),
  );
  assert.equal(
    contentChecksum(normalized("2026-09-07T12:00:00.123400")),
    contentChecksum(normalized("2026-09-07T12:00:00.1234Z")),
  );
  assert.notEqual(
    contentChecksum({ text: "2026-09-07T12:00:00.1234Z" }),
    contentChecksum({ text: "2026-09-07T08:00:00.1234-04:00" }),
  );
});

test("nested JSON and text timestamp-looking changes cannot reuse manifest checksums", async () => {
  const data = fixture();
  data.managed_services[0].description = "2026-09-07T12:00:00.1234Z";
  data.managed_questionnaire_responses[0].response_data = {
    answer: "2026-09-07T12:00:00.1234Z",
  };
  const file = await manifest(data);
  assert.equal(
    (file.tables.managed_services.rows[0] as Row).description,
    "2026-09-07T12:00:00.1234Z",
  );

  const equivalentSpelling = parseRecoveryJson(
    stringifyRecoveryJson(file),
  ) as RecoveryManifest;
  (equivalentSpelling.tables.managed_services.rows[0] as Row).description =
    "2026-09-07T08:00:00.1234-04:00";
  assert.throws(() => validateRecoveryManifest(equivalentSpelling), /integrity/i);
  await assert.rejects(
    verifyRecoveryTarget(equivalentSpelling, targetClient(data) as any),
    /integrity/i,
  );

  const invalidCalendarDate = parseRecoveryJson(
    stringifyRecoveryJson(file),
  ) as RecoveryManifest;
  const invalidResponseRow =
    invalidCalendarDate.tables.managed_questionnaire_responses.rows[0] as Row;
  const invalidResponse = parseRecoveryJson(
    String(invalidResponseRow.response_data),
  ) as Row;
  invalidResponse.answer = "2026-02-30T12:00:00Z";
  invalidResponseRow.response_data = stringifyRecoveryJson(invalidResponse);
  assert.throws(() => validateRecoveryManifest(invalidCalendarDate), /integrity/i);
  await assert.rejects(
    verifyRecoveryTarget(invalidCalendarDate, targetClient(data) as any),
    /integrity/i,
  );

  // A fully self-consistent changed export is valid in isolation, but must not
  // verify against the unchanged target.
  const changedTable = equivalentSpelling.tables.managed_services;
  changedTable.checksum = contentChecksum(changedTable.rows);
  equivalentSpelling.checksum = contentChecksum(equivalentSpelling.tables);
  validateRecoveryManifest(equivalentSpelling);
  await assert.rejects(
    verifyRecoveryTarget(equivalentSpelling, targetClient(data) as any),
    /Recovery reconciliation failed: managed_services/,
  );
});

test("recovery JSON round-trips unsafe integers and decimals without rounded equivalence", () => {
  const exactText = '{"integer":9007199254740993,"decimal":0.123456789012345678901}';
  const roundedText = '{"integer":9007199254740992,"decimal":0.12345678901234568}';
  const exact = parseRecoveryJson(exactText);
  const rounded = parseRecoveryJson(roundedText);
  assert.equal(stringifyRecoveryJson(exact), exactText);
  assert.equal(stringifyRecoveryJson(parseRecoveryJson(stringifyRecoveryJson(exact))), exactText);
  assert.notEqual(contentChecksum(exact), contentChecksum(rounded));
  assert.notEqual(
    contentChecksum(parseRecoveryJson('9007199254740993')),
    contentChecksum(parseRecoveryJson('9007199254740992')),
  );
  assert.notEqual(
    contentChecksum(parseRecoveryJson('0.123456789012345678901')),
    contentChecksum(parseRecoveryJson('0.12345678901234568')),
  );
});

test("recovery JSON preserves own __proto__ and marker-like keys at every nesting level", () => {
  const text = String.raw`{
    "__proto__":{"kind":"object"},
    "values":[
      {"__proto__":"string"},
      {"\u005f\u005fproto\u005f\u005f":null},
      {"__proto__":[1,{"deep":true}]}
    ],
    "constructor":{"private":"constructor"},
    "prototype":"prototype",
    "isLosslessNumber":{"value":"ordinary user object"}
  }`;
  const parsed = parseRecoveryJson(text) as Row;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), true);
  assert.deepEqual(parsed.__proto__, { kind: "object" });
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "constructor"), true);
  assert.deepEqual(parsed.constructor, { private: "constructor" });
  assert.equal(parsed.prototype, "prototype");
  assert.deepEqual(parsed.isLosslessNumber, { value: "ordinary user object" });
  const values = parsed.values as Row[];
  assert.equal(Object.prototype.hasOwnProperty.call(values[0], "__proto__"), true);
  assert.equal(values[0].__proto__, "string");
  assert.equal(Object.prototype.hasOwnProperty.call(values[1], "__proto__"), true);
  assert.equal(values[1].__proto__, null);
  assert.deepEqual(values[2].__proto__, [1, { deep: true }]);

  const roundTrip = parseRecoveryJson(stringifyRecoveryJson(parsed)) as Row;
  assert.equal(Object.prototype.hasOwnProperty.call(roundTrip, "__proto__"), true);
  assert.equal(Object.prototype.hasOwnProperty.call((roundTrip.values as Row[])[1], "__proto__"), true);
  assert.equal(contentChecksum(roundTrip), contentChecksum(parsed));
  const omitted = parseRecoveryJson(
    '{"values":[{}, {}, {}],"constructor":{"private":"constructor"},"prototype":"prototype","isLosslessNumber":{"value":"ordinary user object"}}',
  );
  assert.notEqual(contentChecksum(parsed), contentChecksum(omitted));
});

test("recovery JSON rejects malformed and duplicate input without exposing payloads", () => {
  const secret = "private-sample-must-not-appear";
  for (const input of [
    `{"value":"${secret}",}`,
    `{"value":"${secret}","value":null}`,
    `{"nested":{"key":"${secret}","key":false}}`,
    `{"__proto__":"${secret}","\\u005f\\u005fproto\\u005f\\u005f":null}`,
    `["${secret}",]`,
    `{"unterminated":"${secret}`,
  ]) {
    assert.throws(
      () => parseRecoveryJson(input),
      (error: Error) => error.message === "Invalid recovery JSON" &&
        !error.message.includes(secret) && !error.message.includes(input),
    );
  }
});

test("recovery manifest rejects missing, duplicate, and tampered primary keys/checksums", async () => {
  const file = await manifest();
  const target = "private_insurance_properties";
  const missing = structuredClone(file);
  delete (missing.tables[target].rows[0] as Row).address_normalized;
  assert.throws(() => validateRecoveryManifest(missing), /integrity/i);
  const duplicate = structuredClone(file);
  duplicate.tables[target].rows[1] = { ...duplicate.tables[target].rows[0] };
  duplicate.tables[target].checksum = contentChecksum(duplicate.tables[target].rows);
  duplicate.tables[target].primaryKeyChecksum = contentChecksum(primaryKeys(duplicate.tables[target].rows, "user_id,address_normalized"));
  duplicate.checksum = contentChecksum(duplicate.tables);
  assert.throws(() => validateRecoveryManifest(duplicate), /integrity/i);
  const changed = structuredClone(file);
  (changed.tables.managed_users.rows[0] as Row).id = 999;
  assert.throws(() => validateRecoveryManifest(changed), /integrity/i);
  const absent = structuredClone(file);
  delete absent.tables.managed_users;
  absent.checksum = contentChecksum(absent.tables);
  assert.throws(() => validateRecoveryManifest(absent), /exactly all/i);
});

test("approval is strict about environment, writer stop, production acknowledgement, and checksum", async () => {
  const file = await manifest();
  for (const invalid of [
    { ...approval(file), writersStopped: false },
    { ...approval(file), approveRestore: false },
    { ...approval(file), environment: "production" as const },
    { ...approval(file), expectedChecksum: "0".repeat(64) },
  ]) assert.throws(() => validateRecoveryApproval(file, invalid), /Recovery requires/);
  const production = { ...file, environment: "production" as const };
  production.checksum = contentChecksum(production.tables);
  assert.throws(() => validateRecoveryApproval(production, {
    ...approval(production), environment: "production", allowProductionRestore: false,
  }), /Recovery requires/);
});

test("private recovery output is exclusive, mode 0600, and refuses symlinks", async () => {
  const directory = join(tmpdir(), `recovery-test-${randomUUID()}`);
  const path = join(directory, "manifest.json");
  try {
    await mkdir(directory);
    await writePrivateRecoveryFile(path, { okay: true });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateRecoveryFile(path, {}), /exist/i);
    const link = join(directory, "link.json");
    await symlink(path, link);
    await assert.rejects(writePrivateRecoveryFile(link, {}), /exist/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dry-run export needs only its target client, never a source connection", async () => {
  const file = await manifest();
  await verifyRecoveryTarget(file, targetClient(fixture()) as any);
});

function sourceFor(file: RecoveryManifest, options: { fail?: string; drift?: boolean } = {}) {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const source: MigrationSqlClient = {
    async query(text, params = []) {
      queries.push(text); values.push(params);
      if (options.fail && text.includes(options.fail)) throw new Error("private@example.test raw SQL detail");
      if (text.includes("information_schema.columns")) {
        const name = String(params[1]);
        const descriptor = TABLES.find(([source]) => source === name)!;
        const row = file.tables[descriptor[1]].rows[0] as Row;
        const timestamps = recoveryTimestampColumns(descriptor[1]);
        const jsonColumns = recoveryJsonColumns(descriptor[1]);
        return { rows: Object.keys(row).sort().map(column_name => ({
          column_name,
          data_type: timestamps.includes(column_name)
            ? "timestamp without time zone"
            : jsonColumns.includes(column_name) ? "jsonb" : "text",
        })) };
      }
      if (text.includes("from pg_attribute")) return { rows: [] };
      if (text.startsWith("select row_to_json")) {
        const descriptor = TABLES.find(([source]) => text.includes(`"${source}"`))!;
        return { rows: file.tables[descriptor[1]].rows.map(row => ({ row: stringifyRecoveryJson(row) })) };
      }
      return { rows: [] };
    },
  };
  const client = targetClient(fixture());
  if (options.drift) {
    let pages = 0;
    const readPage = client.readPage.bind(client);
    client.readPage = async (table: string, primaryKey: string[], from: number, to: number) => {
      const result = await readPage(table, primaryKey, from, to);
      if (++pages > TABLES.length * 2) result.rows = [];
      return result;
    };
  }
  return { source, client, queries, values };
}

test("restore uses read-only-by-default, locks, exact replacement, reseed path and commits only after reconciliation", async () => {
  const file = await manifest();
  const { source, client, queries } = sourceFor(file);
  await restoreRecoveryManifest(source, client as any, file, approval(file), "isolated_recovery", "fence-test");
  assert.equal(queries[0], "set default_transaction_read_only = on");
  assert.ok(queries.some(query => query.startsWith("lock table \"isolated_recovery\".")));
  assert.ok(queries.some(query => query.startsWith("truncate table ") && query.includes("restart identity")));
  assert.equal(queries.filter(query => query.startsWith("insert into ")).length, TABLES.length);
  assert.ok(queries.includes("commit"));
  assert.ok(queries.some(query => query.includes("pg_advisory_unlock")));
});

test("restore rolls back on database failure or target drift and never logs raw SQL or PII", async () => {
  const file = await manifest();
  for (const options of [{ fail: "truncate table" }, { drift: true }]) {
    const { source, client, queries } = sourceFor(file, options);
    const logged: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args); };
    try {
      await assert.rejects(
        restoreRecoveryManifest(source, client as any, file, approval(file), "safe_schema", "safe-fence"),
        /Recovery restore failed; no rollback receipt issued/,
      );
    } finally { console.log = original; }
    assert.ok(queries.includes("rollback"));
    assert.equal(JSON.stringify(logged).includes("private@example.test"), false);
    assert.equal(JSON.stringify(logged).includes("insert into"), false);
  }
});

const liveDatabase = process.env.NODE_ENV === "production" ? undefined : process.env.DATABASE_URL;
test("live isolated source restore replaces deleted rows and reseeds identities", { skip: !liveDatabase }, async () => {
  // This deliberately uses DATABASE_URL only.  It creates a random schema, never
  // reads public tables, and drops that schema even if the assertion fails.
  const pool = createMigrationSourcePool(liveDatabase!);
  const source = await pool.connect();
  // restore intentionally leaves its dedicated connection read-only by default;
  // inspect with a separate connection rather than weakening that invariant.
  const inspector = await pool.connect();
  const schema = `recovery_test_${randomUUID().replaceAll("-", "_")}`;
  const liveData = fixture();
  const privateNumbers = parseRecoveryJson(
    '{"unsafe_integer":9007199254740993,"precise_decimal":0.123456789012345678901,"__proto__":{"private_nested":"retained"}}',
  ) as Row;
  liveData.managed_users = liveData.managed_users.map((row, index) => ({
    ...row,
    optional_note: index === 1 ? null : `note-${index}`,
    service_date: `2026-09-0${index + 1}`,
    created_at: `2026-09-07T12:00:00.12345${index}Z`,
  }));
  liveData.managed_integration_requests =
    liveData.managed_integration_requests.map((row, index) => ({
      ...row,
      request_data: {
      enabled: index % 2 === 0, labels: [`label-${index}`, null],
      private_numbers: privateNumbers,
      timestamp_text: "2026-09-07T08:00:00.1234-04:00",
      invalid_timestamp_text: "2026-02-30T12:00:00Z",
      },
      response_data: { result: `response-${index}` },
    }));
  const file = await manifest(liveData);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const snapshot = async () => Object.fromEntries(await Promise.all(TABLES.map(async ([name, target, pk]) => {
    const row = file.tables[target].rows[0] as Row;
    const jsonColumns = recoveryJsonColumns(target);
    const projection = Object.keys(row).map(column => jsonColumns.includes(column)
      ? `${quote(column)}::text as ${quote(column)}` : quote(column)).join(", ");
    const result = await inspector.query(
      `select row_to_json(projected)::text as row from (select ${projection} from ${quote(schema)}.${quote(name)} order by ${pk.split(",").map(quote).join(", ")}) projected`,
    );
    return [target, result.rows.map(item => parseRecoveryJson(item.row))];
  })));
  const sequenceState = async () => {
    const result = await inspector.query(
      `select last_value::text, is_called from ${quote(schema)}.users_id_seq`,
    );
    return result.rows[0];
  };
  try {
    await source.query(`create schema ${quote(schema)}`);
    for (const [name, target, pk] of TABLES) {
      const columns = pk.split(",").map(column => {
        if (column === "id" || column === "user_id" || column === "folio") {
          return `${quote(column)} integer generated by default as identity`;
        }
        return `${quote(column)} text`;
      });
      if (name === "users") {
        columns.push(
          `"optional_note" text`,
          `"service_date" date not null`,
          `"created_at" timestamp(6) without time zone not null`,
        );
      }
      if (name === "integration_requests") {
        columns.push(`"request_data" jsonb not null`, `"response_data" jsonb`);
      }
      await source.query(`create table ${quote(schema)}.${quote(name)} (${columns.join(", ")}, primary key (${pk.split(",").map(quote).join(", ")}))`);
      const stale = Object.fromEntries(Object.keys(file.tables[target].rows[0] as Row).map(key => {
        if (key === "request_data" || key === "response_data") return [key, '{"stale":true}'];
        if (key === "optional_note") return [key, "stale"];
        if (key === "service_date") return [key, "2000-01-01"];
        if (key === "created_at") return [key, "2000-01-01T00:00:00.000001Z"];
        if (key === "address_normalized") return [key, "stale-address"];
        if (key === "policy_type") return [key, "stale-policy"];
        if (key === "dedupe_key") return [key, "stale-claim"];
        return [key, 99];
      }));
      await source.query(
        `insert into ${quote(schema)}.${quote(name)} (${Object.keys(stale).map(quote).join(", ")}) values (${Object.keys(stale).map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(stale),
      );
    }
    await restoreRecoveryManifest(source, targetClient(liveData) as any, file, approval(file), schema, `test-${schema}`);
    const firstState = await snapshot();
    const firstSequence = await sequenceState();
    for (const [name, target] of TABLES) {
      assert.equal((firstState[target] as Row[]).length, file.tables[target].count, `${name} must delete its source-only row`);
      assert.equal(
        contentChecksum(normalizeRecoveryRows(target, firstState[target] as Row[])),
        file.tables[target].checksum,
      );
    }
    const restoredRequestData = parseRecoveryJson(String(
      (firstState.managed_integration_requests as Row[])[0].request_data,
    )) as Row;
    const restoredPrivateNumbers =
      restoredRequestData.private_numbers as Row;
    assert.equal(
      Object.prototype.hasOwnProperty.call(restoredPrivateNumbers, "__proto__"),
      true,
    );
    assert.deepEqual(restoredPrivateNumbers.__proto__, { private_nested: "retained" });
    assert.equal(restoredRequestData.timestamp_text, "2026-09-07T08:00:00.1234-04:00");
    assert.equal(restoredRequestData.invalid_timestamp_text, "2026-02-30T12:00:00Z");
    assert.deepEqual(firstSequence, { last_value: "4", is_called: false });

    const readOnly = await source.query("show default_transaction_read_only");
    assert.equal(readOnly.rows[0].default_transaction_read_only, "on");
    await assert.rejects(
      source.query(`insert into ${quote(schema)}.users (service_date, created_at) values (current_date, now())`),
      (error: any) => error?.code === "25006",
    );

    // A second approved restore is exactly idempotent, including sequence state.
    await restoreRecoveryManifest(source, targetClient(liveData) as any, file, approval(file), schema, `test-${schema}`);
    assert.deepEqual(await snapshot(), firstState);
    assert.deepEqual(await sequenceState(), firstSequence);

    // Attempt a materially different replacement. Drift only when the final
    // target is read for the second time, after these rows have been inserted,
    // reconciled, and their identity sequence has been restarted at 31.
    const replacementData = parseRecoveryJson(
      stringifyRecoveryJson(liveData),
    ) as Record<string, Row[]>;
    replacementData.managed_users.forEach((row, index) => {
      row.id = (index + 1) * 10;
    });
    replacementData.managed_integration_requests.forEach((row, index) => {
      (row.request_data as Row).rollback_marker = `attempted-${index}`;
    });
    const replacementFile = await manifest(replacementData);
    const lateDrift = targetClient(replacementData);
    const lastTarget = TABLES.at(-1)![1];
    let lastTargetPages = 0;
    const readPage = lateDrift.readPage.bind(lateDrift);
    lateDrift.readPage = async (table, primaryKey, from, to) => {
      const page = await readPage(table, primaryKey, from, to);
      if (table === lastTarget && ++lastTargetPages > 2) page.rows = [];
      return page;
    };
    await assert.rejects(
      restoreRecoveryManifest(
        source, lateDrift as any, replacementFile, approval(replacementFile),
        schema, `test-${schema}`,
      ),
      /Recovery restore failed; no rollback receipt issued/,
    );
    // The failed transaction must restore ids 1/2/3, their original JSON, and
    // next identity 4 rather than leaving attempted ids 10/20/30 and next 31.
    assert.deepEqual(await snapshot(), firstState);
    assert.deepEqual(await sequenceState(), firstSequence);

    // Force a real insert failure after TRUNCATE. Transaction rollback must
    // preserve both all prior rows and the transactional sequence restart.
    const invalidData = parseRecoveryJson(
      stringifyRecoveryJson(liveData),
    ) as Record<string, Row[]>;
    invalidData.managed_users[0].id = 2_147_483_648;
    const invalidFile = await manifest(invalidData);
    await assert.rejects(
      restoreRecoveryManifest(
        source, targetClient(invalidData) as any, invalidFile, approval(invalidFile),
        schema, `test-${schema}`,
      ),
      /Recovery restore failed; no rollback receipt issued/,
    );
    assert.deepEqual(await snapshot(), firstState);
    assert.deepEqual(await sequenceState(), firstSequence);
    assert.equal((await source.query("show default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
  } finally {
    await inspector.query(`drop schema if exists ${quote(schema)} cascade`).catch(() => undefined);
    source.release(true);
    inspector.release(true);
    await pool.end();
  }
});