# Managed database to Supabase staged migration

This procedure does not use `NEON_DATABASE_URL`. Replit's managed development
and production databases are separate deployments and each exposes its own
source as `DATABASE_URL`.

## Controls

`MANAGED_DATA_MODE` defaults to `source-only`.

| Mode | Reads | Writes |
|---|---|---|
| `source-only` | `DATABASE_URL` | `DATABASE_URL` |
| `dual-write` | `DATABASE_URL` | source, then Supabase |
| `supabase-canary` | Supabase | source, then Supabase |
| `supabase-read` | Supabase | Supabase |

`MANAGED_DATA_ROLLBACK=true` restores source reads and source-only writes during
canary. In `supabase-read`, startup refuses rollback without a fresh, verified
disaster-recovery receipt (below). Do not log connection variables or export
contents. A failed secondary dual-write is redacted and logged without failing
the user's completed source write; final sync is the repair authority.

## Procedure

Forward exports keep the `havo-managed-data-v1` envelope and now include
`checksumEncoding: "exact-json-v2"`. Use the updated migration CLI for these
files: it preserves JSON numeric tokens and PostgreSQL timestamp microseconds
across export, import, and reconciliation. It still accepts older v1 files
without this marker, and `exact-json-v1` files, using their original checksum rules,
but cannot recover precision or null distinctions already lost in an old export.
In v2, schema-declared JSON/JSONB cells contain canonical JSON text: outer `null`
means SQL NULL, while the string `"null"` means JSON null. Generate a fresh export for the final
handoff; do not edit the marker or round-trip export files through ordinary
`JSON.parse` / `JSON.stringify`. Only schema-declared timestamps are normalized
by the new checksum rules; date-looking JSON answers remain literal content.

1. Apply `supabase/migrations/2026_09_06_managed_database_staged_migration.sql`
   in the Supabase SQL editor. It is standalone and is also mirrored in the
   canonical `supabase/schema.sql`. Then apply
   `supabase/migrations/2026_09_07_managed_database_exact_json_v2.sql` to install
   the service-role-only forward upsert function required by v2 imports and
   final-sync. Older manifests still use the original REST upsert path.
   Leave runtime mode at `source-only`.
2. In each Replit environment, export from that environment's `DATABASE_URL`:
   `npm run managed-data:export -- --environment development --output <secure-file>`
   and repeat in the production deployment with `--environment production`.
   Store the printed SHA-256 separately. Export files contain private data and
   must be encrypted at rest, access restricted, and deleted after retention.
3. Verify the manifest and table checksums. Import is an operator action:
   `npm run managed-data:import -- --input <secure-file>`. Production manifests
   additionally require `--allow-production-import` to prevent accidental
   mutation. Imports are primary-key upserts and safe to repeat.
4. Run `npm run managed-data:reconcile -- --input <secure-file>`. It compares
   count, sorted primary keys (as part of the row stream), and SHA-256 content
   for every table. Any mismatch exits nonzero. Resolve mismatches before flags.
5. Deploy `dual-write`, observe a full business cycle, then run
   the applicable command:
   - Development: `npm run managed-data:final-sync -- --environment development --output <secure-file>`
   - Production: `npm run managed-data:final-sync -- --environment production --output <secure-file> --allow-production-import`
   This is mandatory for cutover: it first acquires the session-level exclusive
   source write fence, then opens one REPEATABLE READ READ ONLY snapshot,
   imports it, and fully paginates reconciliation. Acquiring the fence before
   the transaction guarantees that already-running shared writes are included.
   Later app writes queue briefly until this succeeds or rolls back.
6. Only after a clean final reconciliation, deploy `supabase-canary`. This
   switches reads to Supabase while continuing source-first dual writes so the
   rollback source stays current. Exercise `MANAGED_DATA_ROLLBACK=true` in a
   non-production environment before approval.
7. After the canary is stable, run final sync once more to repair any logged
   mirror failures. With owner approval, deploy `supabase-read`; only this final
   mode stops source writes. This task does not authorize or perform either
   production flag change.

### Disposable rehearsal (no project credentials)

Before scheduling a real handoff, run:

```sh
npm run test:managed-data-rehearsal
```

Requirements: Node 20+, installed npm dependencies, PostgreSQL 16 tools
(`initdb`, `pg_ctl`, `createdb`, `psql`) and PostgREST 12+ on `PATH`.
The Replit configuration includes these tools. Run as a non-root user;
no Docker, Supabase account, or existing database is required.

The runner accepts no connection arguments. It creates a private temporary
PostgreSQL cluster with source and target databases, passes an allowlisted
environment to child processes, and never uses the project's database URLs,
Supabase key, or private exports. PostgreSQL accepts only a private Unix socket;
PostgREST and its small `/rest/v1` gateway bind only to loopback. The gateway
removes a fixed synthetic API key, not a real credential. It is test-only and
does **not** simulate Supabase authentication.

The test applies the standalone SQL below twice, seeds 1,257 generated rows
in each of the 11 source tables, writes a synthetic export, imports it twice,
and compares counts, primary keys, and full-content checksums. Source fixture
columns and keys are checked against the app's Drizzle schema. The actual
PostgREST 1,000-row cap exercises pagination, including deliberate changes
past the first page that must fail reconciliation. It also checks sequence
reseeding, RLS/RPC grants, lock queuing through final sync, unlock after failure,
and simultaneous IFW/QuoteRUSH claims using the application wrappers.

The runner removes its cluster and synthetic manifests on success, test
failure, timeout, SIGINT, or SIGTERM. SIGKILL or a host crash cannot run cleanup;
only disposable files under the temporary `managed-data-rehearsal-*` directory
can be affected, never project databases. The dedicated command is separate
from ordinary unit tests and does not require any production opt-in.

This is a correctness rehearsal, not a production throughput benchmark, a
live Supabase authentication test, or authorization to change cutover flags.
It found and covers date-only export encoding and concurrent quote-reclaim ID
conflicts. If the staged SQL was already applied, reapply its updated idempotent
definition before cutover to install the corrected claim RPC.

## Canary rollback — source is still authoritative

During `supabase-canary`, if target reads regress, set
`MANAGED_DATA_ROLLBACK=true` and redeploy; source data is still current because
every acknowledged write went source-first. No reverse restore is needed.
Do not use this procedure after target-only writes have begun.

## Post-retirement disaster recovery — Supabase is authoritative

This is a **maintenance-window, owner-approved data replacement**, not the canary
flag flip. No commands here are permission to run a production restore. Obtain
written incident-owner approval first. If Supabase cannot be read, reconciliation
cannot pass: leave rollback disabled and escalate to the backup recovery process.
Never describe a stale-source flag flip as lossless.

### Prerequisites and writer freeze

1. Identify the intended environment and both database endpoints out of band.
   The CLI uses **only `DATABASE_URL` for the old managed database**, never
   `NEON_DATABASE_URL`. `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must
   point at the authoritative target in that same environment. The environment
   argument is an explicit operator assertion, not automatic endpoint discovery.
2. Stop and drain **all** target and source writers: all web instances,
   background jobs, cron jobs, webhooks, external integrations, queued retries,
   manual SQL sessions, and any direct clients. Block new write requests; do not
   silently acknowledge/discard them. Revoke/disable target application writes
   for the window. Keep the service stopped until the recovery deployment is
   ready. The acknowledgement flag records this prerequisite; it does not stop
   services for you.
3. Keep the old application's database role read-only/revoked. Use an approved,
   dedicated recovery connection in the incident CLI's `DATABASE_URL` only.
   It must be allowed to read, lock, truncate/insert the 11 managed tables and
   restart their owned sequences. Do not grant write access to the application
   while restoring. A role/database default read-only setting is supported;
   a physical read-only replica is not a restore destination.
4. Make an owner-approved encrypted backup of the frozen old database before
   replacement. Prepare an encrypted, restricted directory outside the repo,
   web root, deployment build, and application logs (`0700` directory).
   Both export and receipt require **new filenames**. Files are created `0600`
   exclusively; existing files and symlinks are refused. The export contains
   private records; do not open it in chat, attach it to tickets, or commit it.

### Dry-run: export and verify all target tables

```sh
npm run managed-data:reverse-dry-run -- \
  --environment production \
  --acknowledge-writers-stopped \
  --output /secure/incident/target-recovery.json
```

For a rehearsal use `--environment development` and development endpoints.
Dry-run never connects to or changes the old database and never enables rollback.
It exports every table in the migration allowlist, fully paginates each one in
primary-key order, checks table counts, primary-key and content SHA-256s, and
re-reads the target to detect drift. Store the printed manifest SHA-256 separately
as the approved recovery artifact's checksum.

Recovery uses raw REST JSON and lossless numeric parsing, and reads source rows
as JSON text for reconciliation. Large JSON integers, high-precision decimals,
and PostgreSQL timestamp microseconds are not rounded away by JavaScript before
comparison. UTC/offset normalization applies only to declared database timestamp
columns; text fields and all strings inside JSON remain exact, including
timestamp-looking answers. Arbitrary own JSON keys are retained safely.
The `havo-managed-recovery-v2` format stores declared JSON/JSONB cells as
canonical JSON text, reserving an outer `null` for SQL NULL. This preserves the
difference between JSON `null` and SQL NULL—even in required JSON columns.
Target text projections and explicit restore casts preserve that distinction
through reconciliation. Older recovery formats and forward exports are refused;
always generate a fresh dry-run artifact for this procedure.

These REST reads are **not** a cross-table database snapshot or a target write
lock. Two matching scans cannot prove there were no intervening writes. Keeping
all writers frozen from before export through recovery activation is mandatory.
If any writer resumes, discard the export/receipt and restart the procedure.

### Approved restore: exact, repeatable, atomic replacement

**Destructive scope:** replaces only the 11 allowlisted old managed tables with
the approved Supabase snapshot, including removal of source-only rows deleted
from Supabase. It does not merge stale source records, touch Supabase Auth or
borrower-facing Supabase tables, or change the database schema/roles. Foreign
keys from outside that allowlist cause failure; there is no `CASCADE` bypass.

```sh
npm run managed-data:reverse-restore -- \
  --environment production \
  --acknowledge-writers-stopped \
  --approve-restore \
  --allow-production-restore \
  --input /secure/incident/target-recovery.json \
  --expected-checksum <approved-sha256> \
  --receipt /secure/incident/rollback-receipt.json
```

Development requires all the same arguments except `--allow-production-restore`.
The production flag is required for production manifests/runtimes. Wrong
environment, missing tables, mismatched checksums, duplicate/missing keys, or
changed target data fail closed before source mutation.

The dedicated source session sets default read-only, acquires the exclusive
source write fence, and opens **one explicitly READ WRITE transaction**. It locks
the table set, validates columns, replaces rows, transactionally restarts
sequences, and requires count, primary-key, and full-content reconciliation of
every source table plus a fresh target comparison **before COMMIT**. All other
source sessions retain their original permissions. The CLI never changes grants
or makes a database/role globally writable.

Any insert, constraint, schema, sequence, target-drift, or reconciliation failure
rolls back the transaction and issues no valid receipt. Re-running the same
approved manifest with stopped writers produces the same rows and next sequence
values. If interrupted around COMMIT or receipt writing, keep services stopped:
do not infer success from an exit, an empty receipt file, or partial log output.
Repeat the approved restore with a **new receipt filename**. Only aggregated
counts, match status, allowlisted table names and hashes appear in CLI output;
raw driver errors are suppressed because they can contain private records.

### Enable rollback only after verification

After COMMIT succeeds, the CLI writes a data-free receipt valid for **one hour**.
Move it securely into a protected absolute path readable by the recovery
deployment (regular file, no symlinks, not group/world writable). Do not bundle
the private export. While all writers remain stopped, configure:

```text
MANAGED_DATA_MODE=supabase-read
MANAGED_DATA_ROLLBACK=true
MANAGED_DATA_RECOVERY_ENVIRONMENT=production
MANAGED_DATA_RECOVERY_CHECKSUM=<approved-sha256>
MANAGED_DATA_RECOVERY_RECEIPT=/secure/incident/rollback-receipt.json
```

Use development for a rehearsal. Production rejects development receipts.
Startup rejects missing, malformed, expired, future-dated, tampered,
wrong-environment or wrong-checksum receipts before permitting source writes.
This receipt is a trusted-file operational interlock, **not a signed
authentication credential**; protect the file, parent directory, configuration,
and deployment access. Never fabricate receipts or change the mode to
`source-only`/canary to bypass the recovery gate.

Only after the incident owner confirms the recovery checks and credentials are
ready, restore the old application's approved write permissions and start the
source-only rollback deployment. Keep target writers stopped. Verify startup
and smoke-test the recovered flows before accepting traffic. In the same
approved handoff, move steady-state configuration to `source-only`, remove the
rollback and receipt settings, and archive the data-free receipt in the incident
record. The one-hour receipt is an activation gate, not an ongoing lease on app
traffic; later restarts with an expired receipt fail closed. Do not reuse it for
a later cutover or once target writes have resumed.

## Retention

After a stable cutover, revoke application write credentials from the old
managed database and retain it read-only for the owner-approved window
(recommended minimum 30 days, longer when legal/financial retention requires).
Keep encrypted exports for the same approved window. During retention, perform
weekly count/checksum checks and document access; target-only writes mean the
retired source is expected to diverge and is not a current recovery authority.
At window end, obtain
written owner approval, verify backups and legal holds, then delete exports and
retire the old database. Never reuse or infer an unrelated Neon connection.

### Operator handoff

1. Apply `supabase/migrations/2026_09_06_managed_database_staged_migration.sql`
   in the Supabase SQL editor. It is standalone and is also mirrored in the
   canonical `supabase/schema.sql`. For incremental installation, also apply
   `supabase/migrations/2026_09_07_managed_database_exact_json_v2.sql` before
   importing or final-syncing new exports. The current canonical schema includes
   both migrations. Leave runtime mode at `source-only`.
2. In each Replit environment, export from that environment's `DATABASE_URL`:
   `npm run managed-data:export -- --environment development --output <secure-file>`
   and repeat in the production deployment with `--environment production`.
   Store the printed SHA-256 separately. Export files contain private data and
   must be encrypted at rest, access restricted, and deleted after retention.
3. Verify the manifest and table checksums. Import is an operator action:
   `npm run managed-data:import -- --input <secure-file>`. Production manifests
   additionally require `--allow-production-import` to prevent accidental
   mutation. Imports are primary-key upserts and safe to repeat.
4. Run `npm run managed-data:reconcile -- --input <secure-file>`. It compares
   count, sorted primary keys (as part of the row stream), and SHA-256 content
   for every table. Any mismatch exits nonzero. Resolve mismatches before flags.
5. Deploy `dual-write`, observe a full business cycle, then run
   the applicable command:
   - Development: `npm run managed-data:final-sync -- --environment development --output <secure-file>`
   - Production: `npm run managed-data:final-sync -- --environment production --output <secure-file> --allow-production-import`
   This is mandatory for cutover: it first acquires the session-level exclusive
   source write fence, then opens one REPEATABLE READ READ ONLY snapshot,
   imports it, and fully paginates reconciliation. Acquiring the fence before
   the transaction guarantees that already-running shared writes are included.
   Later app writes queue briefly until this succeeds or rolls back.
6. Only after a clean final reconciliation, deploy `supabase-canary`. This
   switches reads to Supabase while continuing source-first dual writes so the
   rollback source stays current. Exercise `MANAGED_DATA_ROLLBACK=true` in a
   non-production environment before approval.
7. After the canary is stable, run final sync once more to repair any logged
   mirror failures. With owner approval, deploy `supabase-read`; only this final
   mode stops source writes. This task does not authorize or perform either
   production flag change.
