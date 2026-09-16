import { managedDataFencePool } from "./db";
import {
  type ManagedDataRecoveryEnvironment,
  validateRecoveryReceipt,
} from "./managed-data-recovery-proof";
import { MANAGED_DATA_WRITE_FENCE_KEY } from "./managed-data-fence";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

type FencePool = Pick<typeof managedDataFencePool, "connect">;

/** A shared transaction advisory lock spans source work and its mirror. */
export async function withSourceWriteFence<T>(
  work: () => Promise<T>,
  databasePool: FencePool = managedDataFencePool,
  fenceKey = MANAGED_DATA_WRITE_FENCE_KEY,
): Promise<T> {
  const client = await databasePool.connect();
  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;
    await client.query(
      "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
      [fenceKey],
    );
    const result = await work();
    await client.query("commit");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the source/mirror failure. Releasing a broken client causes
        // the pool to discard it, and transaction advisory locks auto-release.
      }
    }
    throw error;
  } finally {
    try {
      client.release();
    } catch {
      // The pool owns connection cleanup; never replace the original result.
    }
  }
}

export { MANAGED_DATA_WRITE_FENCE_KEY };
export const MANAGED_DATA_MODES = [
  "source-only",
  "dual-write",
  "supabase-canary",
  "supabase-read",
] as const;
export type ManagedDataMode = typeof MANAGED_DATA_MODES[number];

export interface ManagedDataRouting {
  mode: ManagedDataMode;
  readFrom: "source" | "supabase";
  writeSource: boolean;
  writeSupabase: boolean;
  rollback: boolean;
}

export interface RoutedWriteContext {
  sourceWasWritten: boolean;
  routing: ManagedDataRouting;
}

const MAX_RECOVERY_RECEIPT_BYTES = 16 * 1024;

function requireRecoveryReceipt(
  env: { [key: string]: string | undefined },
): void {
  const receiptPath = env.MANAGED_DATA_RECOVERY_RECEIPT;
  const expectedChecksum = env.MANAGED_DATA_RECOVERY_CHECKSUM;
  const environment = env.MANAGED_DATA_RECOVERY_ENVIRONMENT;
  if (
    !receiptPath
    || !isAbsolute(receiptPath)
    || !expectedChecksum
    || (environment !== "development" && environment !== "production")
  ) {
    throw new Error("[managed-data] recovery receipt configuration is invalid");
  }
  if (env.NODE_ENV === "production" && environment !== "production") {
    throw new Error("[managed-data] production requires a production recovery receipt");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      receiptPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile()
      || metadata.size > MAX_RECOVERY_RECEIPT_BYTES
      || (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("untrusted receipt file");
    }
    const buffer = Buffer.alloc(MAX_RECOVERY_RECEIPT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_RECOVERY_RECEIPT_BYTES) {
      throw new Error("oversized receipt file");
    }
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    validateRecoveryReceipt(
      value,
      expectedChecksum,
      environment as ManagedDataRecoveryEnvironment,
    );
  } catch {
    // Never expose a trusted path, receipt contents, or parser details.
    throw new Error("[managed-data] recovery receipt validation failed");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A close failure must not reveal filesystem details.
      }
    }
  }
}

/** Parse migration controls without ever inspecting or logging credentials. */
export function resolveManagedDataRouting(
  env: { [key: string]: string | undefined } = process.env,
): ManagedDataRouting {
  const rollback = env.MANAGED_DATA_ROLLBACK === "true";
  const configured = env.MANAGED_DATA_MODE?.trim() || "source-only";
  if (!MANAGED_DATA_MODES.includes(configured as ManagedDataMode)) {
    throw new Error(
      `MANAGED_DATA_MODE must be one of ${MANAGED_DATA_MODES.join(", ")}`,
    );
  }
  const mode = configured as ManagedDataMode;
  if (rollback) {
    if (mode === "supabase-read") {
      // Operators must keep every writer stopped from restore through startup.
      // This trusted-file proof is not an auth credential and does not replace
      // deployment maintenance/fencing procedures.
      requireRecoveryReceipt(env);
    }
    return {
      mode,
      readFrom: "source",
      writeSource: true,
      writeSupabase: false,
      rollback: true,
    };
  }
  const readsSupabase =
    mode === "supabase-canary" || mode === "supabase-read";
  return {
    mode,
    readFrom: readsSupabase ? "supabase" : "source",
    writeSource: mode !== "supabase-read",
    writeSupabase: mode !== "source-only",
    rollback: false,
  };
}

export const managedDataRouting = resolveManagedDataRouting();

export async function routedRead<T>(
  source: () => Promise<T>,
  supabase: () => Promise<T>,
  routing = managedDataRouting,
): Promise<T> {
  return routing.readFrom === "supabase" ? supabase() : source();
}

/**
 * The source remains authoritative during dual-write. A target failure is
 * mirrored under one source advisory fence. Mirror failures are logged without
 * interrupting the user; reconciliation/final-sync is the repair authority.
 */
export async function routedWrite<T>(
  source: () => Promise<T>,
  supabase: (
    sourceResult: T | undefined,
    context: RoutedWriteContext,
  ) => Promise<T>,
  routing = managedDataRouting,
): Promise<T> {
  if (routing.writeSource) {
    return withSourceWriteFence(async () => {
      const result = await source();
      if (routing.writeSupabase) {
        try {
          await supabase(result, { sourceWasWritten: true, routing });
        } catch {
          // Do not include data or error text: managed records can contain PII.
          console.error("[managed-data] Supabase mirror failed; final sync/reconciliation required");
        }
      }
      return result;
    });
  }
  return supabase(undefined, { sourceWasWritten: false, routing });
}

/**
 * During dual-write/canary, mirror only a row the source actually changed.
 * A missing source row must stay a no-op so rollback authority cannot drift.
 * In Supabase-only mode, execute the target-native update instead.
 */
export async function mirrorSourceResultOrWriteTarget<T>(
  sourceResult: T | undefined,
  context: RoutedWriteContext,
  mirror: (row: T) => Promise<void>,
  writeTarget: () => Promise<T | undefined>,
): Promise<T | undefined> {
  if (context.sourceWasWritten) {
    if (sourceResult !== undefined) await mirror(sourceResult);
    return sourceResult;
  }
  return writeTarget();
}