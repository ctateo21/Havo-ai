import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REHEARSAL_TIMEOUT_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 30_000;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Signal = "SIGINT" | "SIGTERM";

function safeProcessEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    ...extra,
  };
}

async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching the explicitly inherited executable search path.
    }
  }
  throw new Error(`Required rehearsal executable was not found: ${name}`);
}

function run(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? safeProcessEnvironment(),
      signal: options.signal,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(new Error(
          `${command} exited ${signal ? `on ${signal}` : `with status ${code}`}`,
        ));
      }
    });
  });
}

async function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close(error => {
        if (error) reject(error);
        else resolvePromise(address.port);
      });
    });
  });
}

function databaseUrl(socketDirectory: string, port: number, database: string): string {
  const query = new URLSearchParams({
    host: socketDirectory,
    port: String(port),
  });
  return `postgresql://rehearsal@localhost/${database}?${query}`;
}

async function waitForPostgrest(
  processHandle: ChildProcess,
  apiUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      throw new Error("PostgREST exited before becoming ready");
    }
    try {
      const response = await fetch(apiUrl, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status < 500) return;
    } catch {
      // The server commonly refuses connections during its short startup.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error("Timed out waiting for PostgREST to become ready");
}

/**
 * Supabase clients address PostgREST below /rest/v1 and always attach their
 * API key as a bearer token.  This deliberately tiny loopback-only adapter
 * makes that wire format usable with an unauthenticated disposable PostgREST;
 * it neither authenticates nor invents headers, and proxies every response
 * unchanged.
 */
async function startSupabaseGateway(
  port: number,
  postgrestUrl: string,
): Promise<HttpServer> {
  const upstream = new URL(postgrestUrl);
  const gateway = createHttpServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://gateway.invalid");
    if (
      requestUrl.pathname !== "/rest/v1" &&
      !requestUrl.pathname.startsWith("/rest/v1/")
    ) {
      response.writeHead(404);
      response.end("Only /rest/v1 is available in the rehearsal gateway");
      return;
    }
    const upstreamPath = requestUrl.pathname.slice("/rest/v1".length) || "/";
    const headers = { ...request.headers };
    delete headers.authorization;
    delete headers.apikey;
    const upstreamRequest = httpRequest({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: `${upstreamPath}${requestUrl.search}`,
      headers,
    }, upstreamResponse => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    });
    upstreamRequest.once("error", error => {
      if (!response.headersSent) response.writeHead(502);
      response.end(`PostgREST proxy error: ${error.message}`);
    });
    request.pipe(upstreamRequest);
  });
  await new Promise<void>((resolvePromise, reject) => {
    gateway.once("error", reject);
    gateway.listen(port, "127.0.0.1", () => resolvePromise());
  });
  return gateway;
}

async function stopHttpServer(server: HttpServer | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise());
    // A test interrupted in the middle of a proxied request must not keep
    // server.close() waiting indefinitely.
    server.closeAllConnections();
  });
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  if (group && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group already disappeared.
    }
  }
  child.kill(signal);
}

async function stopProcess(
  child: ChildProcess | undefined,
  group = false,
): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    // The node:test leader can exit before a helper it spawned. Its detached
    // process-group ID remains addressable while any such descendant survives.
    if (group && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH means the complete group is already gone.
      }
    }
    return;
  }
  signalProcess(child, "SIGTERM", group);
  await Promise.race([
    new Promise<void>(resolvePromise => child.once("exit", () => resolvePromise())),
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    signalProcess(child, "SIGKILL", group);
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>(resolvePromise => child.once("exit", () => resolvePromise())),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`Process ${child.pid ?? "unknown"} survived SIGKILL`)),
          3_000,
        )),
      ]);
    }
  }
  if (group && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group exited together as requested.
    }
  }
}

async function stopPostgres(pgCtl: string, dataDirectory: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await run(pgCtl, [
        "-D", dataDirectory,
        "-m", "immediate",
        "-w",
        "stop",
      ]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
  }

  // pg_ctl can itself be interrupted just after forking postgres. If its stop
  // command also loses that startup race, use the PID written inside our
  // private data directory and do not remove the directory until it is dead.
  try {
    let contents: string;
    try {
      contents = await readFile(join(dataDirectory, "postmaster.pid"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const pid = Number.parseInt(contents.split("\n", 1)[0], 10);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid postmaster PID");
    process.kill(pid, "SIGTERM");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }
    process.kill(pid, "SIGKILL");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }
    throw new Error(`Temporary PostgreSQL process ${pid} did not exit`);
  } catch (fallbackError) {
    throw new AggregateError(
      [lastError, fallbackError],
      "Could not prove temporary PostgreSQL stopped",
    );
  }
}

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    throw new Error("This runner does not accept database URLs or other arguments");
  }

  const [initdb, pgCtl, createdb, psql, postgrest] = await Promise.all([
    executable("initdb"),
    executable("pg_ctl"),
    executable("createdb"),
    executable("psql"),
    executable("postgrest"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "managed-data-rehearsal-"));
  await chmod(root, 0o700);
  const dataDirectory = join(root, "postgres");
  const socketDirectory = join(root, "socket");
  const postgresLog = join(root, "postgres.log");
  const postgrestConfig = join(root, "postgrest.conf");
  await mkdir(socketDirectory, { mode: 0o700 });

  let postgresStarted = false;
  let postgrestProcess: ChildProcess | undefined;
  let gateway: HttpServer | undefined;
  let testProcess: ChildProcess | undefined;
  let receivedSignal: Signal | undefined;
  let cleaningUp: Promise<void> | undefined;
  let stoppingTests: Promise<void> | undefined;
  const startupAbort = new AbortController();

  const cleanup = (): Promise<void> => {
    cleaningUp ??= (async () => {
      const failures: unknown[] = [];
      for (const [label, action] of [
        ["rehearsal test process", () => {
          stoppingTests ??= stopProcess(testProcess, true);
          return stoppingTests;
        }],
        ["rehearsal gateway", () => stopHttpServer(gateway)],
        ["temporary PostgREST", () => stopProcess(postgrestProcess)],
      ] as const) {
        try {
          await action();
        } catch (error) {
          // Continue toward PostgreSQL shutdown and temp-directory cleanup even
          // if an earlier component did not acknowledge shutdown normally.
          console.error(`Failed to stop ${label}: ${String(error)}`);
          failures.push(new Error(`Failed to stop ${label}`, { cause: error }));
        }
      }
      let postgresStopped = !postgresStarted;
      if (postgresStarted) {
        try {
          await stopPostgres(pgCtl, dataDirectory);
          postgresStopped = true;
        } catch (error) {
          console.error(`Failed to stop temporary PostgreSQL: ${String(error)}`);
          failures.push(new Error(
            "Failed to stop temporary PostgreSQL",
            { cause: error },
          ));
        }
      }
      if (postgresStopped) {
        try {
          await rm(root, { recursive: true, force: true });
        } catch (error) {
          failures.push(new Error(
            `Failed to remove rehearsal directory ${root}`,
            { cause: error },
          ));
        }
      }
      // Preserve the data directory if PostgreSQL may still be alive, and make
      // every incomplete cleanup turn an otherwise-passing run into a failure.
      if (failures.length > 0) {
        throw new AggregateError(failures, "Managed-data rehearsal cleanup failed");
      }
    })();
    return cleaningUp;
  };

  const onSignal = (signal: Signal) => {
    receivedSignal ??= signal;
    startupAbort.abort(new Error(`Rehearsal interrupted by ${signal}`));
    if (testProcess) {
      stoppingTests ??= stopProcess(testProcess, true);
      void stoppingTests;
    }
  };
  // Keep handlers installed throughout teardown. Repeated terminal signals are
  // intentionally idempotent rather than reverting to Node's default exit.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await run(initdb, [
      "-D", dataDirectory,
      "--username=rehearsal",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-instructions",
    ], { signal: startupAbort.signal });

    // PostgreSQL is reachable only through this run's private Unix socket.
    // The otherwise-unused port only names the socket file.
    const postgresPort = await unusedLoopbackPort();
    // Set this before invoking pg_ctl: if interruption lands after postgres has
    // forked but before pg_ctl reports success, cleanup must still attempt stop.
    postgresStarted = true;
    await run(pgCtl, [
      "-D", dataDirectory,
      "-l", postgresLog,
      "-w",
      "start",
      "-o",
      `-F -h '' -k '${socketDirectory}' -p ${postgresPort}`,
    ], { signal: startupAbort.signal });
    startupAbort.signal.throwIfAborted();

    const postgresArgs = [
      "--host", socketDirectory,
      "--port", String(postgresPort),
      "--username", "rehearsal",
    ];
    await run(createdb, [
      ...postgresArgs,
      "--owner", "rehearsal",
      "rehearsal_source",
    ], { signal: startupAbort.signal });
    await run(createdb, [
      ...postgresArgs,
      "--owner", "rehearsal",
      "rehearsal_target",
    ], { signal: startupAbort.signal });

    await run(psql, [
      ...postgresArgs,
      "--dbname", "postgres",
      "--set", "ON_ERROR_STOP=1",
      "--command", [
        "CREATE ROLE anon NOLOGIN;",
        "CREATE ROLE authenticated NOLOGIN;",
        "CREATE ROLE service_role NOLOGIN BYPASSRLS;",
        "CREATE ROLE authenticator LOGIN NOINHERIT;",
        "GRANT service_role TO authenticator;",
      ].join("\n"),
    ], { signal: startupAbort.signal });
    await run(psql, [
      ...postgresArgs,
      "--dbname", "rehearsal_target",
      "--set", "ON_ERROR_STOP=1",
      "--command", [
        "GRANT USAGE, CREATE ON SCHEMA public TO service_role;",
        "ALTER DEFAULT PRIVILEGES FOR ROLE rehearsal IN SCHEMA public",
        "  GRANT ALL PRIVILEGES ON TABLES TO service_role;",
        "ALTER DEFAULT PRIVILEGES FOR ROLE rehearsal IN SCHEMA public",
        "  GRANT ALL PRIVILEGES ON SEQUENCES TO service_role;",
        "ALTER DEFAULT PRIVILEGES FOR ROLE rehearsal IN SCHEMA public",
        "  GRANT ALL PRIVILEGES ON FUNCTIONS TO service_role;",
      ].join("\n"),
    ], { signal: startupAbort.signal });
    startupAbort.signal.throwIfAborted();

    const targetUrl = databaseUrl(
      socketDirectory,
      postgresPort,
      "rehearsal_target",
    );
    const authenticatorUrl = targetUrl.replace(
      "postgresql://rehearsal@",
      "postgresql://authenticator@",
    );
    const postgrestPort = await unusedLoopbackPort();
    const postgrestUrl = `http://127.0.0.1:${postgrestPort}`;
    await writeFile(postgrestConfig, [
      `db-uri = ${JSON.stringify(authenticatorUrl)}`,
      'db-schemas = "public"',
      'db-extra-search-path = "public"',
      'db-anon-role = "service_role"',
      'server-host = "127.0.0.1"',
      `server-port = ${postgrestPort}`,
      "max-rows = 1000",
      "",
    ].join("\n"), { mode: 0o600 });

    postgrestProcess = spawn(postgrest, [postgrestConfig], {
      cwd: projectRoot,
      env: safeProcessEnvironment(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    postgrestProcess.once("error", error => {
      console.error(`Could not start PostgREST: ${error.message}`);
    });
    await waitForPostgrest(postgrestProcess, postgrestUrl, startupAbort.signal);
    const gatewayPort = await unusedLoopbackPort();
    const apiUrl = `http://127.0.0.1:${gatewayPort}`;
    gateway = await startSupabaseGateway(gatewayPort, postgrestUrl);
    startupAbort.signal.throwIfAborted();

    const sourceUrl = databaseUrl(
      socketDirectory,
      postgresPort,
      "rehearsal_source",
    );
    const testEnvironment = safeProcessEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: sourceUrl,
      REHEARSAL_SOURCE_URL: sourceUrl,
      REHEARSAL_TARGET_URL: targetUrl,
      REHEARSAL_API_URL: apiUrl,
      REHEARSAL_ROOT: root,
      VITE_SUPABASE_URL: apiUrl,
      SUPABASE_SERVICE_ROLE_KEY: "synthetic-rehearsal-key",
      MANAGED_DATA_MODE: "supabase-read",
    });
    const testFile = join(projectRoot, "scripts", "managed-data-rehearsal.test.ts");
    testProcess = spawn(process.execPath, [
      "--import", "tsx",
      "--test",
      testFile,
    ], {
      cwd: projectRoot,
      env: testEnvironment,
      detached: true,
      stdio: "inherit",
    });

    let timedOut = false;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, reject) => {
        testProcess!.once("error", reject);
        testProcess!.once("exit", (code, signal) => resolvePromise({ code, signal }));
        setTimeout(() => {
          if (testProcess?.exitCode === null && testProcess.signalCode === null) {
            timedOut = true;
            console.error(
              `Managed-data rehearsal exceeded ${REHEARSAL_TIMEOUT_MS / 1000} seconds`,
            );
            void stopProcess(testProcess, true);
          }
        }, REHEARSAL_TIMEOUT_MS).unref();
      },
    );
    if (receivedSignal) return receivedSignal === "SIGINT" ? 130 : 143;
    if (timedOut) {
      throw new Error(
        `Managed-data rehearsal exceeded ${REHEARSAL_TIMEOUT_MS / 1000} seconds`,
      );
    }
    if (result.signal) {
      throw new Error(`Rehearsal tests were terminated by ${result.signal}`);
    }
    return result.code ?? 1;
  } catch (error) {
    if (receivedSignal) return receivedSignal === "SIGINT" ? 130 : 143;
    throw error;
  } finally {
    try {
      await cleanup();
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}