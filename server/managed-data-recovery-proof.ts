import { createHash, timingSafeEqual } from "node:crypto";

export const MANAGED_DATA_RECOVERY_RECEIPT_FORMAT =
  "havo-managed-data-recovery-v1" as const;
export const MANAGED_DATA_RECOVERY_TABLE_COUNT = 11 as const;
export const MANAGED_DATA_RECOVERY_RECEIPT_TTL_MS = 60 * 60 * 1000;

export type ManagedDataRecoveryEnvironment = "development" | "production";

export interface ManagedDataRecoveryReceipt {
  format: typeof MANAGED_DATA_RECOVERY_RECEIPT_FORMAT;
  manifestChecksum: string;
  environment: ManagedDataRecoveryEnvironment;
  verified: true;
  verifiedTableCount: typeof MANAGED_DATA_RECOVERY_TABLE_COUNT;
  createdAt: string;
  expiresAt: string;
  integrity: string;
}

type ReceiptPayload = Omit<ManagedDataRecoveryReceipt, "integrity">;

function payloadIntegrity(payload: ReceiptPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function receiptPayload(
  manifestChecksum: string,
  environment: ManagedDataRecoveryEnvironment,
  createdAt: string,
  expiresAt: string,
): ReceiptPayload {
  return {
    format: MANAGED_DATA_RECOVERY_RECEIPT_FORMAT,
    manifestChecksum,
    environment,
    verified: true,
    verifiedTableCount: MANAGED_DATA_RECOVERY_TABLE_COUNT,
    createdAt,
    expiresAt,
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function equalChecksum(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Creates a data-free proof that a recovery manifest was fully reconciled.
 * Callers must only invoke this after all eleven table checks and the restore
 * transaction have completed.
 */
export function createRecoveryReceipt(
  manifestChecksum: string,
  environment: ManagedDataRecoveryEnvironment,
  now: Date = new Date(),
): ManagedDataRecoveryReceipt {
  if (!isSha256(manifestChecksum)) {
    throw new Error("Recovery manifest checksum must be a lowercase SHA-256");
  }
  if (environment !== "development" && environment !== "production") {
    throw new Error("Recovery environment must be development or production");
  }
  const createdTime = now.getTime();
  if (!Number.isFinite(createdTime)) {
    throw new Error("Recovery receipt creation time is invalid");
  }
  const payload = receiptPayload(
    manifestChecksum,
    environment,
    new Date(createdTime).toISOString(),
    new Date(createdTime + MANAGED_DATA_RECOVERY_RECEIPT_TTL_MS).toISOString(),
  );
  return { ...payload, integrity: payloadIntegrity(payload) };
}

/**
 * Validates structure, reconciliation assertions, time window, environment,
 * expected manifest, and self-integrity. The checksum is tamper evidence only:
 * this receipt is not an authentication credential and is trusted only because
 * deployment supplies it through a protected local file.
 */
export function validateRecoveryReceipt(
  value: unknown,
  expectedChecksum: string,
  environment: ManagedDataRecoveryEnvironment,
  now: Date = new Date(),
): ManagedDataRecoveryReceipt {
  if (!isSha256(expectedChecksum)) {
    throw new Error("Expected recovery checksum is invalid");
  }
  if (environment !== "development" && environment !== "production") {
    throw new Error("Expected recovery environment is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recovery receipt is not an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "format", "manifestChecksum", "environment", "verified",
    "verifiedTableCount", "createdAt", "expiresAt", "integrity",
  ];
  if (
    Object.keys(record).length !== expectedKeys.length
    || expectedKeys.some(key => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error("Recovery receipt structure is invalid");
  }
  if (
    record.format !== MANAGED_DATA_RECOVERY_RECEIPT_FORMAT
    || !isSha256(record.manifestChecksum)
    || record.environment !== environment
    || record.verified !== true
    || record.verifiedTableCount !== MANAGED_DATA_RECOVERY_TABLE_COUNT
    || typeof record.createdAt !== "string"
    || typeof record.expiresAt !== "string"
    || !isSha256(record.integrity)
  ) {
    throw new Error("Recovery receipt assertions are invalid");
  }
  if (!equalChecksum(record.manifestChecksum, expectedChecksum)) {
    throw new Error("Recovery receipt manifest does not match");
  }

  const createdAt = Date.parse(record.createdAt);
  const expiresAt = Date.parse(record.expiresAt);
  const currentTime = now.getTime();
  if (
    !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(currentTime)
    || new Date(createdAt).toISOString() !== record.createdAt
    || new Date(expiresAt).toISOString() !== record.expiresAt
    || createdAt > currentTime
    || expiresAt <= currentTime
    || expiresAt - createdAt !== MANAGED_DATA_RECOVERY_RECEIPT_TTL_MS
  ) {
    throw new Error("Recovery receipt time window is invalid");
  }

  const payload = receiptPayload(
    record.manifestChecksum,
    environment,
    record.createdAt,
    record.expiresAt,
  );
  if (!equalChecksum(record.integrity, payloadIntegrity(payload))) {
    throw new Error("Recovery receipt integrity is invalid");
  }
  return { ...payload, integrity: record.integrity };
}