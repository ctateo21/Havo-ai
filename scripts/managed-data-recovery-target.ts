import { TABLES } from "./managed-data-migration-common";
import { parseRecoveryJson } from "./managed-data-recovery-json";
import { recoveryJsonColumns } from "./managed-data-recovery-columns";

export const recoveryJsonAlias = (column: string) => `__recovery_json_${column}`;

export interface RecoveryTargetReader {
  readPage(table: string, primaryKey: string[], from: number, to: number):
    Promise<{ rows: unknown[]; count: number }>;
}

/** Read raw REST JSON before an SDK or driver can round private JSON numbers. */
export function createRecoveryTargetReader(
  baseUrl: string, serviceKey: string, request: typeof fetch = fetch,
): RecoveryTargetReader {
  return {
    async readPage(table, primaryKey, from, to) {
      if (!TABLES.some(([, target, pk]) => target === table && pk === primaryKey.join(","))) {
        throw new Error("Unknown recovery target");
      }
      try {
        const jsonColumns = recoveryJsonColumns(table);
        const url = new URL(`/rest/v1/${table}`, baseUrl);
        url.searchParams.set("select", [
          "*",
          ...jsonColumns.map(column => `${recoveryJsonAlias(column)}:${column}::text`),
        ].join(","));
        url.searchParams.set("order", primaryKey.map(key => `${key}.asc`).join(","));
        url.searchParams.set("offset", String(from));
        url.searchParams.set("limit", String(to - from + 1));
        const response = await request(url, {
          headers: {
            apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
            Prefer: "count=exact", "Accept-Profile": "public",
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error("Target read failed");
        const countToken = response.headers.get("content-range")?.split("/")[1];
        if (!countToken || !/^\d+$/.test(countToken)) throw new Error("Missing target count");
        const count = Number(countToken);
        if (!Number.isSafeInteger(count)) throw new Error("Invalid target count");
        const rows = parseRecoveryJson(await response.text());
        if (!Array.isArray(rows)) throw new Error("Invalid target rows");
        for (const candidate of rows) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new Error("Invalid target row");
          }
          const row = candidate as Record<string, unknown>;
          for (const column of jsonColumns) {
            const alias = recoveryJsonAlias(column);
            if (!Object.prototype.hasOwnProperty.call(row, alias)) {
              throw new Error("Missing target JSON projection");
            }
            const value = row[alias];
            if (value !== null && typeof value !== "string") {
              throw new Error("Invalid target JSON projection");
            }
            row[column] = value;
            delete row[alias];
          }
        }
        return { rows, count };
      } catch {
        throw new Error(`Recovery target read failed: ${table}`);
      }
    },
  };
}

export async function fetchAllRecoveryTargetRows(
  client: RecoveryTargetReader, table: string, primaryKey: string[], pageSize = 1_000,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let expectedCount: number | undefined;
  for (;;) {
    const page = await client.readPage(table, primaryKey, rows.length, rows.length + pageSize - 1);
    if (!Number.isSafeInteger(page.count) || page.count < 0 ||
        (expectedCount !== undefined && expectedCount !== page.count)) {
      throw new Error(`Recovery target count changed: ${table}`);
    }
    expectedCount = page.count;
    rows.push(...page.rows);
    if (rows.length > expectedCount) throw new Error(`Recovery target pagination mismatch: ${table}`);
    if (rows.length === expectedCount) return rows;
    if (!page.rows.length) throw new Error(`Recovery target pagination ended early: ${table}`);
  }
}