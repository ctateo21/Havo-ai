import { TABLES } from "./managed-data-migration-common";
import { parseRecoveryJson, stringifyRecoveryJson } from "./managed-data-recovery-json";
import { createRecoveryTargetReader } from "./managed-data-recovery-target";

const REQUEST_TIMEOUT_MS = 30_000;

export type MigrationTargetEncoding = "exact-json-v1" | "exact-json-v2";

export interface MigrationTargetClient {
  readPage(
    table: string,
    primaryKey: string[],
    from: number,
    to: number,
    encoding?: MigrationTargetEncoding,
  ): Promise<{ rows: unknown[]; count: number }>;
  upsert(
    table: string,
    primaryKey: string,
    rows: unknown[],
    encoding?: MigrationTargetEncoding,
  ): Promise<void>;
  reseed(): Promise<void>;
}

function isAllowedTarget(table: string, primaryKey: string): boolean {
  return TABLES.some(([, target, keys]) => target === table && keys === primaryKey);
}

function unknownTarget(): never {
  throw new Error("Unknown migration target");
}

function targetHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Accept-Profile": "public",
  };
}

function targetUrl(baseUrl: string, table: string): URL {
  return new URL(`/rest/v1/${table}`, baseUrl);
}

function countFromContentRange(response: Response): number {
  const contentRange = response.headers.get("content-range");
  const countToken = contentRange?.slice(contentRange.lastIndexOf("/") + 1);
  if (!countToken || !/^\d+$/.test(countToken)) {
    throw new Error("Missing target count");
  }
  const count = Number(countToken);
  if (!Number.isSafeInteger(count)) throw new Error("Invalid target count");
  return count;
}

/**
 * Use PostgREST directly so lossless JSON numbers never pass through an SDK
 * response decoder or JSON.stringify before they reach the target.
 */
export function createMigrationTargetClient(
  baseUrl: string,
  serviceKey: string,
  request: typeof fetch = fetch,
): MigrationTargetClient {
  const recoveryReader = createRecoveryTargetReader(baseUrl, serviceKey, request);
  return {
    async readPage(table, primaryKey, from, to, encoding) {
      const key = Array.isArray(primaryKey) ? primaryKey.join(",") : "";
      if (!isAllowedTarget(table, key)) unknownTarget();
      // v2 projects JSON/JSONB columns as text (with JS null for SQL NULL),
      // matching the representation consumed by the exact forward manifest.
      if (encoding === "exact-json-v2") {
        return recoveryReader.readPage(table, primaryKey, from, to);
      }

      try {
        const url = targetUrl(baseUrl, table);
        url.searchParams.set("select", "*");
        url.searchParams.set("order", primaryKey.map(column => `${column}.asc`).join(","));
        url.searchParams.set("offset", String(from));
        url.searchParams.set("limit", String(to - from + 1));

        const response = await request(url, {
          headers: { ...targetHeaders(serviceKey), Prefer: "count=exact" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error("Target read request failed");

        const rows = parseRecoveryJson(await response.text());
        if (!Array.isArray(rows)) throw new Error("Invalid target rows");
        return { rows, count: countFromContentRange(response) };
      } catch {
        throw new Error(`Migration target read failed: ${table}`);
      }
    },

    async upsert(table, primaryKey, rows, encoding) {
      if (!isAllowedTarget(table, primaryKey)) unknownTarget();

      try {
        if (encoding === "exact-json-v2") {
          // The RPC applies schema-owned JSON/JSONB casts.  Do not send v2
          // rows through PostgREST's ordinary table upsert: an outer null and
          // the JSON text "null" must arrive as different SQL values.
          const url = new URL(
            "/rest/v1/rpc/upsert_managed_migration_rows",
            baseUrl,
          );
          const response = await request(url, {
            method: "POST",
            headers: {
              ...targetHeaders(serviceKey),
              "Content-Type": "application/json",
            },
            body: stringifyRecoveryJson({
              p_target: table,
              p_primary_key: primaryKey,
              p_rows: rows,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!response.ok) throw new Error("Target upsert request failed");
          return;
        }

        const url = targetUrl(baseUrl, table);
        url.searchParams.set("on_conflict", primaryKey);
        const response = await request(url, {
          method: "POST",
          headers: {
            ...targetHeaders(serviceKey),
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
          },
          body: stringifyRecoveryJson(rows),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error("Target upsert request failed");
      } catch {
        throw new Error(`Migration target upsert failed: ${table}`);
      }
    },

    async reseed() {
      try {
        const url = new URL(
          "/rest/v1/rpc/reseed_managed_migration_sequences",
          baseUrl,
        );
        const response = await request(url, {
          method: "POST",
          headers: {
            ...targetHeaders(serviceKey),
            "Content-Type": "application/json",
          },
          body: stringifyRecoveryJson({}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error("Target sequence reseed request failed");
      } catch {
        throw new Error("Migration target sequence reseed failed");
      }
    },
  };
}