import { createHash } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import type { SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { LosslessNumber } from "lossless-json";

// Node 20 has no global WebSocket. Migration and recovery CLIs run
// independently from server/db.ts, so bootstrap Neon before creating a Pool.
neonConfig.webSocketConstructor = ws;

export function createMigrationSourcePool(connectionString: string) {
  return new Pool({ connectionString });
}

export const TABLES = [
  ["users", "managed_users", "id"],
  ["services", "managed_services", "id"],
  ["submissions", "managed_submissions", "id"],
  ["integration_requests", "managed_integration_requests", "id"],
  ["questionnaire_responses", "managed_questionnaire_responses", "id"],
  ["user_subscriptions", "user_subscriptions", "user_id"],
  ["private_user_profiles", "private_user_profiles", "user_id"],
  ["private_insurance_properties", "private_insurance_properties", "user_id,address_normalized"],
  ["insurance_quote_cache", "insurance_quote_cache", "address_normalized,policy_type"],
  ["non_ad_valorem_cache", "non_ad_valorem_cache", "folio"],
  ["ifw_activity_claims", "ifw_activity_claims", "dedupe_key"],
] as const;

export type ExportFile = {
  format: "havo-managed-data-v1";
  // Absent on legacy manifests, whose original checksum rules remain valid.
  checksumEncoding?: "exact-json-v1" | "exact-json-v2";
  environment: "development" | "production";
  exportedAt: string;
  tables: Record<string, {
    sourceTable: string; rows: unknown[]; count: number;
    primaryKeyChecksum: string; checksum: string;
  }>;
  checksum: string;
};

export function stable(value: unknown): string {
  // Legacy v1 checksums used native JSON.parse/JSON.stringify numeric rules,
  // including scientific notation. New exact manifests use recoveryChecksum,
  // never this deliberately backward-compatible (potentially lossy) hash.
  if (value instanceof LosslessNumber) return JSON.stringify(Number(value.value));
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  ) {
    // Date truncates PostgreSQL microseconds. Preserve sub-millisecond digits
    // so recovery cannot approve rows whose timestamps differ at that precision.
    const fraction = value.match(/T\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1] ?? "";
    const subMillis = fraction.slice(3).replace(/0+$/, "");
    return JSON.stringify(new Date(value).toISOString().replace(/Z$/, `${subMillis}Z`));
  }
  return JSON.stringify(value);
}

export function contentChecksum(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function canonicalRows(rows: any[], primaryKey: string): any[] {
  const keys = primaryKey.split(",");
  return [...rows].sort((a, b) =>
    keys.map(key => String(a[key] ?? "")).join("\0")
      .localeCompare(keys.map(key => String(b[key] ?? "")).join("\0")));
}

export function primaryKeys(rows: any[], primaryKey: string) {
  const keys = primaryKey.split(",");
  return rows.map(row => keys.map(key => row[key] ?? null));
}

export async function fetchAllTargetRows(
  client: SupabaseClient,
  table: string,
  orderColumns: string[] = [],
  pageSize = 1_000,
): Promise<any[]> {
  const rows: any[] = [];
  let expectedCount: number | null = null;
  for (;;) {
    const from = rows.length;
    let query = client.from(table).select("*", { count: "exact" });
    for (const column of orderColumns) query = query.order(column);
    const { data, error, count } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(`Reconcile read failed for ${table}: ${error.message}`);
    const page = data ?? [];
    if (count != null) expectedCount = count;
    rows.push(...page);
    if (
      (expectedCount != null && rows.length >= expectedCount) ||
      (expectedCount == null && page.length < pageSize)
    ) {
      return rows;
    }
    if (page.length === 0) {
      throw new Error(`Reconcile pagination ended early for ${table}`);
    }
  }
}

export type MigrationSqlClient = {
  query: (text: string, values?: unknown[]) => Promise<any>;
};