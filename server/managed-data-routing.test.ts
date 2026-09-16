import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecoveryReceipt } from "./managed-data-recovery-proof";
import {
  MANAGED_DATA_WRITE_FENCE_KEY,
  mirrorSourceResultOrWriteTarget,
  resolveManagedDataRouting,
  routedRead,
  routedWrite,
  withSourceWriteFence,
} from "./managed-data-routing";

test("defaults to source-only", () => {
  assert.deepEqual(resolveManagedDataRouting({}), {
    mode: "source-only", readFrom: "source",
    writeSource: true, writeSupabase: false, rollback: false,
  });
});

test("dual-write keeps source reads and writes both", async () => {
  const routing = resolveManagedDataRouting({ MANAGED_DATA_MODE: "dual-write" });
  const writes: string[] = [];
  const result = await routedWrite(
    async () => { writes.push("source"); return 7; },
    async value => { writes.push(`supabase:${value}`); return 8; },
    routing,
  );
  assert.equal(result, 7);
  assert.deepEqual(writes, ["source", "supabase:7"]);
});

test("supabase-read cuts reads and writes over", async () => {
  const routing = resolveManagedDataRouting({ MANAGED_DATA_MODE: "supabase-read" });
  assert.equal(await routedRead(async () => "source", async () => "target", routing), "target");
  assert.equal(await routedWrite(async () => "source", async () => "target", routing), "target");
});

test("Supabase canary reads target while keeping rollback source current", async () => {
  const routing = resolveManagedDataRouting({
    MANAGED_DATA_MODE: "supabase-canary",
  });
  const writes: string[] = [];
  assert.equal(
    await routedRead(async () => "source", async () => "target", routing),
    "target",
  );
  assert.equal(await routedWrite(
    async () => { writes.push("source"); return "source-result"; },
    async () => { writes.push("target"); return "target-result"; },
    routing,
  ), "source-result");
  assert.deepEqual(writes, ["source", "target"]);
});

test("rollback flag restores source reads and source-only writes", async () => {
  const routing = resolveManagedDataRouting({
    MANAGED_DATA_MODE: "supabase-canary", MANAGED_DATA_ROLLBACK: "true",
  });
  const calls: string[] = [];
  assert.equal(await routedRead(async () => "source", async () => "target", routing), "source");
  await routedWrite(
    async () => { calls.push("source"); return "ok"; },
    async () => { calls.push("target"); return "ok"; },
    routing,
  );
  assert.deepEqual(calls, ["source"]);
});

test("post-retirement rollback fails closed without a recovery receipt", () => {
  assert.throws(
    () => resolveManagedDataRouting({
      MANAGED_DATA_MODE: "supabase-read",
      MANAGED_DATA_ROLLBACK: "true",
    }),
    /configuration is invalid/,
  );
});

test("post-retirement rollback accepts a protected valid recovery receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "managed-recovery-"));
  const receiptPath = join(directory, "receipt.json");
  const checksum = "c".repeat(64);
  try {
    writeFileSync(
      receiptPath,
      JSON.stringify(createRecoveryReceipt(checksum, "production")),
      { mode: 0o600, flag: "wx" },
    );
    assert.deepEqual(resolveManagedDataRouting({
      NODE_ENV: "production",
      MANAGED_DATA_MODE: "supabase-read",
      MANAGED_DATA_ROLLBACK: "true",
      MANAGED_DATA_RECOVERY_RECEIPT: receiptPath,
      MANAGED_DATA_RECOVERY_CHECKSUM: checksum,
      MANAGED_DATA_RECOVERY_ENVIRONMENT: "production",
    }), {
      mode: "supabase-read", readFrom: "source",
      writeSource: true, writeSupabase: false, rollback: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production post-retirement rollback rejects a development receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "managed-recovery-"));
  const receiptPath = join(directory, "receipt.json");
  const checksum = "d".repeat(64);
  try {
    writeFileSync(
      receiptPath,
      JSON.stringify(createRecoveryReceipt(checksum, "development")),
      { mode: 0o600, flag: "wx" },
    );
    assert.throws(() => resolveManagedDataRouting({
      NODE_ENV: "production",
      MANAGED_DATA_MODE: "supabase-read",
      MANAGED_DATA_ROLLBACK: "true",
      MANAGED_DATA_RECOVERY_RECEIPT: receiptPath,
      MANAGED_DATA_RECOVERY_CHECKSUM: checksum,
      MANAGED_DATA_RECOVERY_ENVIRONMENT: "development",
    }), /production requires a production recovery receipt/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canary rollback remains receipt-free", () => {
  assert.deepEqual(resolveManagedDataRouting({
    NODE_ENV: "production",
    MANAGED_DATA_MODE: "supabase-canary",
    MANAGED_DATA_ROLLBACK: "true",
  }), {
    mode: "supabase-canary", readFrom: "source",
    writeSource: true, writeSupabase: false, rollback: true,
  });
});

test("dual-write secondary failure does not interrupt source authority", async () => {
  const result = await routedWrite(
    async () => "source-result",
    async () => { throw new Error("target outage"); },
    resolveManagedDataRouting({ MANAGED_DATA_MODE: "dual-write" }),
  );
  assert.equal(result, "source-result");
});

test("missing source updates never create target-only state before cutover", async () => {
  for (const mode of ["dual-write", "supabase-canary"] as const) {
    const calls: string[] = [];
    const result = await routedWrite<{ id: number } | undefined>(
      async () => {
        calls.push("source");
        return undefined;
      },
      (sourceResult, context) => mirrorSourceResultOrWriteTarget(
        sourceResult,
        context,
        async () => { calls.push("mirror"); },
        async () => {
          calls.push("target-update");
          return { id: 1 };
        },
      ),
      resolveManagedDataRouting({ MANAGED_DATA_MODE: mode }),
    );
    assert.equal(result, undefined);
    assert.deepEqual(calls, ["source"]);
  }
});

test("the same missing-row update uses the target after final cutover", async () => {
  const calls: string[] = [];
  const result = await routedWrite<{ id: number } | undefined>(
    async () => {
      calls.push("source");
      return undefined;
    },
    (sourceResult, context) => mirrorSourceResultOrWriteTarget(
      sourceResult,
      context,
      async () => { calls.push("mirror"); },
      async () => {
        calls.push("target-update");
        return { id: 1 };
      },
    ),
    resolveManagedDataRouting({ MANAGED_DATA_MODE: "supabase-read" }),
  );
  assert.deepEqual(result, { id: 1 });
  assert.deepEqual(calls, ["target-update"]);
});

test("source fence holds the shared advisory lock around work", async () => {
  const calls: string[] = [];
  const fakePool = {
    async connect() {
      return {
        async query(sql: string, values: unknown[]) {
          if (sql === "begin" || sql === "commit" || sql === "rollback") {
            calls.push(sql);
          } else {
            calls.push(`shared-lock:${values[0]}`);
            assert.match(sql, /pg_advisory_xact_lock_shared/);
          }
        },
        release() { calls.push("release"); },
      };
    },
  };
  await withSourceWriteFence(async () => { calls.push("work"); }, fakePool as any);
  assert.deepEqual(calls, [
    "begin",
    `shared-lock:${MANAGED_DATA_WRITE_FENCE_KEY}`,
    "work",
    "commit",
    "release",
  ]);
});

test("source fence rolls back and releases when work fails", async () => {
  const calls: string[] = [];
  const fakePool = {
    async connect() {
      return {
        async query(sql: string) { calls.push(sql.split(" ")[0]); },
        release() { calls.push("release"); },
      };
    },
  };
  await assert.rejects(
    withSourceWriteFence(
      async () => { throw new Error("source failed"); },
      fakePool as any,
    ),
    /source failed/,
  );
  assert.deepEqual(calls, ["begin", "select", "rollback", "release"]);
});