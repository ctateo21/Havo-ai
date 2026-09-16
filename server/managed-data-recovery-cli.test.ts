import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TABLES } from "../scripts/managed-data-migration-common";
import { parseRecoveryJson, recoveryChecksum } from "../scripts/managed-data-recovery-json";
import {
  validateRecoveryManifest,
  type RecoveryManifest,
} from "../scripts/managed-data-recovery";

const SAFE_ERROR =
  "Managed-data command failed; no rollback approval issued. " +
  "Check prerequisites and reconciliation status; do not log private records.";

function runNpmEntryPoint(
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  code: number | null;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script, "--", ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
}

const unsafeInteger = "900719925474099312345";
const highPrecisionDecimal = "1234567890.1234567890123456789";

function rawRows(primaryKey: string): string[] {
  return [1, 2, 3].map(number => {
    const keys = primaryKey.split(",");
    const keyFields = keys.map((key, index) => {
      const value = key === "address_normalized" ? `"address-${number}"` :
        key === "policy_type" ? `"policy-${number}"` :
        key === "dedupe_key" ? `"claim-${number}"` :
        key === "folio" ? `"folio-${number}"` : String(number + index);
      return `${JSON.stringify(key)}:${value}`;
    });
    return `{${[
      ...keyFields,
      `"unsafe_number":${unsafeInteger}`,
      `"precise_decimal":${highPrecisionDecimal}`,
    ].join(",")}}`;
  });
}

function projectJsonAliases(row: string, select: string, rowIndex: number): string {
  const projections = select.split(",").slice(1).map(projection => {
    const match = /^(__recovery_json_([^:]+)):\2::text$/.exec(projection);
    assert.ok(match, `Unexpected recovery projection: ${projection}`);
    const [, alias, column] = match;
    const jsonText = rowIndex === 0 ? "null" : rowIndex === 1 ? null :
      `{"unsafe_number":${unsafeInteger},"precise_decimal":${highPrecisionDecimal}}`;
    const ordinaryJson = jsonText === null || jsonText === "null" ? "null" : jsonText;
    return [
      `${JSON.stringify(column)}:${ordinaryJson}`,
      `${JSON.stringify(alias)}:${jsonText === null ? "null" : JSON.stringify(jsonText)}`,
    ].join(",");
  });
  return projections.length === 0 ? row :
    `${row.slice(0, -1)},${projections.join(",")}}`;
}

async function withRecoveryTarget(
  work: (fixture: {
    baseUrl: string;
    env: NodeJS.ProcessEnv;
    requests: Map<string, number>;
    directory: string;
  }) => Promise<void>,
): Promise<void> {
  const rows = new Map(TABLES.map(([, target, primaryKey]) => [
    target, rawRows(primaryKey),
  ]));
  const requests = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/rest\/v1\/([^/]+)$/.exec(url.pathname);
    const table = match?.[1];
    const tableRows = table && rows.get(table);
    if (!tableRows ||
        request.headers.apikey !== "test-service-key" ||
        request.headers.authorization !== "Bearer test-service-key" ||
        request.headers.prefer !== "count=exact") {
      response.writeHead(400).end();
      return;
    }
    const offset = Number(url.searchParams.get("offset"));
    const select = url.searchParams.get("select");
    if (!select) {
      response.writeHead(400).end();
      return;
    }
    requests.set(table!, (requests.get(table!) ?? 0) + 1);
    response.writeHead(200, {
      "content-type": "application/json",
      // Deliberately return one row despite the larger requested page. This
      // proves pagination advances by rows received while retaining exact count.
      "content-range": `${offset}-${offset}/${tableRows.length}`,
    });
    response.end(`[${projectJsonAliases(tableRows[offset], select, offset)}]`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "recovery-cli-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    VITE_SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  };
  try {
    await work({ baseUrl: env.VITE_SUPABASE_URL!, env, requests, directory });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const script of [
  "managed-data:reverse-dry-run",
  "managed-data:reverse-restore",
]) {
  test(`${script} rejects missing arguments without a top-level-await cycle`, async () => {
    const result = await runNpmEntryPoint(script);
    assert.notEqual(result.code, 0);
    assert.notEqual(result.code, 13);
    assert.match(result.output, new RegExp(SAFE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.output, /--environment is required/);
  });
}

test("actual recovery dry-run paginates raw target JSON without a source database", async () => {
  await withRecoveryTarget(async ({ env, requests, directory }) => {
    assert.equal(env.DATABASE_URL, undefined);
    const output = join(directory, "recovery.json");
    const result = await runNpmEntryPoint("managed-data:reverse-dry-run", [
      "--environment", "development",
      "--acknowledge-writers-stopped",
      "--output", output,
    ], env);

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Recovery dry-run verified 11 tables/);
    assert.doesNotMatch(result.output, /Receipt issued/);
    assert.deepEqual(await readdir(directory), ["recovery.json"]);
    assert.equal((await stat(output)).mode & 0o777, 0o600);

    const raw = await readFile(output, "utf8");
    assert.match(raw, new RegExp(unsafeInteger));
    assert.match(raw, new RegExp(highPrecisionDecimal.replace(".", "\\.")));
    const manifest = parseRecoveryJson(raw);
    validateRecoveryManifest(manifest);
    assert.equal((manifest as RecoveryManifest).format, "havo-managed-recovery-v2");
    assert.equal(
      recoveryChecksum((manifest as RecoveryManifest).tables),
      (manifest as RecoveryManifest).checksum,
    );
    for (const [, target] of TABLES) {
      assert.equal(requests.get(target), 6, `${target} was not fully read twice`);
    }
    const options = (manifest as RecoveryManifest).tables.managed_services.rows
      .map(row => (row as Record<string, unknown>).options);
    assert.equal(options[0], "null", "JSON null must remain canonical JSON text");
    assert.equal(options[1], null, "SQL NULL must remain JavaScript null");
    assert.match(String(options[2]), new RegExp(unsafeInteger));
    assert.match(String(options[2]), /12345678901234567890123456789e-19/);
  });
});

test("malformed actual restore fails before creating a receipt or connecting a source", async () => {
  await withRecoveryTarget(async ({ env, requests, directory }) => {
    const input = join(directory, "recovery.json");
    const dryRun = await runNpmEntryPoint("managed-data:reverse-dry-run", [
      "--environment", "development",
      "--acknowledge-writers-stopped",
      "--output", input,
    ], env);
    assert.equal(dryRun.code, 0, dryRun.output);
    const manifest = parseRecoveryJson(await readFile(input, "utf8")) as RecoveryManifest;
    requests.clear();

    const receipt = join(directory, "receipt.json");
    const result = await runNpmEntryPoint("managed-data:reverse-restore", [
      "--environment", "development",
      "--acknowledge-writers-stopped",
      "--input", input,
      "--expected-checksum", manifest.checksum,
      "--receipt", receipt,
      // Deliberately omit --approve-restore.
    ], env);

    assert.notEqual(result.code, 0);
    assert.notEqual(result.code, 13);
    assert.match(result.output, new RegExp(SAFE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(requests.size, 0, "malformed restore must not contact the target or source");
    await assert.rejects(access(receipt));
  });
});