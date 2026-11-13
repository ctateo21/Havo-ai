---
name: Supabase vs managed Postgres split
description: Which Postgres holds which tables, and why DATABASE_URL must not be confused with an external Neon secret.
---

# Two active Postgres databases, plus an unused external URL

This app actively talks to two Postgres databases:

- **Replit-managed PostgreSQL** (`DATABASE_URL`) — holds a small set of
  server-managed tables. Replit injects isolated development and production
  connections under the same variable name.
- **User's Supabase** (`VITE_SUPABASE_URL` + service role key) — holds the
  user-facing scenario data, property caches, alerts, and related records.

`NEON_DATABASE_URL` is a separate external connection and is not referenced by
the current application source or Drizzle configuration. Do not assume it is
the app database, enable it, or migrate it merely because the Drizzle driver is
`@neondatabase/serverless`.

**Why:** the Neon-compatible driver does not determine who manages the
database. Confusing the two URLs can direct audits and migrations at the wrong
database while the actual Replit-managed production database remains unchanged.

**How to apply:** trace the runtime variable used by the client before any
database operation. For `DATABASE_URL`, use Replit's development/production
database tooling. Treat `NEON_DATABASE_URL` as unrelated unless source code or a
user instruction explicitly establishes otherwise.

When adding columns to any Supabase-backed table:
1. Add the columns to `supabase/schema.sql` (canonical) AND a dated file under
   `supabase/migrations/` (idempotent `add column if not exists`). The USER
   applies it manually in the Supabase SQL editor.
2. Add the new column names to the relevant `*_OPTIONAL_COLUMNS` list in
   `client/src/lib/auth.ts` (e.g. `SELLER_OPTIONAL_COLUMNS`). The persistence
   layer strips-and-retries unknown columns and warns the user, so saves keep
   working before the migration is applied. Skipping step 2 means every save
   fails for users on the old schema.

**How to apply:** any new persisted field on a Supabase table → schema.sql +
migration + optional-columns list, all three, every time.

## Partial legacy-draft migrations

**Rule:** Supabase upgrade migrations must tolerate optional legacy tables being
absent and retain old draft columns while relaxing incompatible `NOT NULL`
constraints before the finalized writer omits them.

**Why:** shared projects can have only part of a historical draft applied; an
unconditional backfill can fail on a missing legacy table, while a preserved
legacy required field can reject a new-format upsert even after the new columns
exist.

**How to apply:** guard optional backfills with `to_regclass`, inspect legacy
columns through `information_schema`, copy historical values where present, and
drop only the incompatible `NOT NULL` constraint—never the legacy column.

**Migration-free alternative (preferred for small scalar/UI fields):** stash the
value inside the existing `user_answer_sources` jsonb column instead of a new
column. It already round-trips end-to-end (rowToInsurance/insuranceToRow and is
in `INSURANCE_OPTIONAL_COLUMNS`), so NO schema.sql/migration is needed.
**Why:** avoids forcing the user to run SQL for every new field.
Examples already living there: `factor_*` insurance picks, and the insurance
detail view's `aop_deductible`, `carrier`, `flood_zone`/`flood_zone_source`
(flood zone resolved from `GET /api/flood-zone`, FEMA NFHL). Reuse the existing
dedicated `*_source` columns (e.g. `aop_deductible_source`, `carrier_source`)
for manual-lock provenance when they already exist.

**Quote-cache rolling upgrades:** inspect both the active routing and the
physical cache schema before applying answer-identity migrations. Preserve
legacy uniqueness while an old published reader still performs address-only
lookups; use an isolated versioned table or a coordinated cutover for multiple
answer variants.
**Why:** the shared Supabase cache was legacy address-only while preview used
the managed source database. Applying only Supabase changes would not upgrade
the active writer, and dropping old uniqueness could expose new variants to
an old reader.
**How to apply:** additive ownership fields are a separate stage from changing
uniqueness or routing. Approval to prepare the managed upgrade is not approval
to apply it or publish.
