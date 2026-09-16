import { createHash } from "node:crypto";
import { LosslessNumber } from "lossless-json";
import { parseExactRecoveryJson } from "./managed-data-recovery-json-parser";

/** Never let JSON.parse round arbitrary PostgreSQL JSON/JSONB numeric tokens. */
export function parseRecoveryJson(text: string): unknown {
  return parseExactRecoveryJson(text);
}

function canonicalNumber(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new Error("Invalid recovery numeric token");
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  let exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  const zeros = digits.length - digits.replace(/0+$/, "").length;
  digits = digits.slice(0, digits.length - zeros);
  exponent += BigInt(zeros);
  return `${match[1]}${digits}e${exponent}`;
}

/**
 * Own serializer deliberately checks instanceof, not lossless-json's duck-type
 * marker: a user's JSON object named "isLosslessNumber" must remain an object.
 * Canonical form equates numeric notation, never arbitrary string content.
 */
export function stringifyRecoveryJson(value: unknown, canonical = false): string {
  if (value instanceof LosslessNumber) {
    return canonical ? canonicalNumber(value.value) : value.value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite recovery number");
    return canonical ? canonicalNumber(String(value)) : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stringifyRecoveryJson(item, canonical)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (canonical) entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stringifyRecoveryJson(item, canonical)}`).join(",")}}`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  throw new Error("Unsupported recovery JSON value");
}

export function recoveryChecksum(value: unknown): string {
  return createHash("sha256").update(stringifyRecoveryJson(value, true)).digest("hex");
}