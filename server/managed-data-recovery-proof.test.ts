import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecoveryReceipt,
  validateRecoveryReceipt,
} from "./managed-data-recovery-proof";

const CHECKSUM = "a".repeat(64);
const NOW = new Date("2026-01-15T12:00:00.000Z");

test("creates and validates a data-free receipt for all managed tables", () => {
  const receipt = createRecoveryReceipt(CHECKSUM, "production", NOW);
  assert.deepEqual(Object.keys(receipt), [
    "format", "manifestChecksum", "environment", "verified",
    "verifiedTableCount", "createdAt", "expiresAt", "integrity",
  ]);
  assert.equal(receipt.verifiedTableCount, 11);
  assert.equal(receipt.expiresAt, "2026-01-15T13:00:00.000Z");
  assert.deepEqual(
    validateRecoveryReceipt(receipt, CHECKSUM, "production", NOW),
    receipt,
  );
});

test("rejects malformed and tampered receipts", () => {
  assert.throws(
    () => validateRecoveryReceipt(null, CHECKSUM, "production", NOW),
    /not an object/,
  );
  const receipt = createRecoveryReceipt(CHECKSUM, "production", NOW);
  assert.throws(
    () => validateRecoveryReceipt(
      { ...receipt, verifiedTableCount: 10 },
      CHECKSUM,
      "production",
      NOW,
    ),
    /assertions/,
  );
  assert.throws(
    () => validateRecoveryReceipt(
      { ...receipt, manifestChecksum: "b".repeat(64) },
      "b".repeat(64),
      "production",
      NOW,
    ),
    /integrity/,
  );
});

test("rejects expired and future receipts", () => {
  const expired = createRecoveryReceipt(
    CHECKSUM,
    "development",
    new Date(NOW.getTime() - 60 * 60 * 1000),
  );
  assert.throws(
    () => validateRecoveryReceipt(expired, CHECKSUM, "development", NOW),
    /time window/,
  );
  const future = createRecoveryReceipt(
    CHECKSUM,
    "development",
    new Date(NOW.getTime() + 1),
  );
  assert.throws(
    () => validateRecoveryReceipt(future, CHECKSUM, "development", NOW),
    /time window/,
  );
});