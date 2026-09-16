import type { Pool } from "pg";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  ifwActivityClaims,
  insuranceQuoteCache,
  integrationRequests,
  nonAdValoremCache,
  privateInsuranceProperties,
  privateUserProfiles,
  questionnaireResponses,
  services,
  submissions,
  userSubscriptions,
  users,
} from "../shared/schema";

/** Kept deliberately above PostgREST's default page size. */
export const ROWS_PER_TABLE = 1257;

const FIXTURE_PASSWORD = "SYNTHETIC_FIXTURE_NOT_A_USABLE_CREDENTIAL";
const frozen = (index: number, hour = 9) =>
  new Date(Date.UTC(2026, 1, (index % 27) + 1, hour + (index % 8), index % 60))
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
const address = (index: number) =>
  `${100 + (index % 419)} Fixture Way, Unit ${(index % 17) + 1}, Exampleville, FL 33${String(index % 1000).padStart(3, "0")}.invalid`;
const json = (value: unknown) => JSON.stringify(value);

const schemaSql = `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    phone TEXT, contact_preference TEXT DEFAULT 'email', created_at TIMESTAMP DEFAULT now()
  );
  CREATE TABLE services (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    description TEXT NOT NULL, options JSON NOT NULL
  );
  CREATE TABLE submissions (
    id SERIAL PRIMARY KEY, user_id INTEGER, selected_services JSON NOT NULL,
    form_data JSON NOT NULL, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT now()
  );
  CREATE TABLE integration_requests (
    id SERIAL PRIMARY KEY, submission_id INTEGER NOT NULL, provider TEXT NOT NULL,
    request_data JSON NOT NULL, response_data JSON, status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT now()
  );
  CREATE TABLE questionnaire_responses (
    id SERIAL PRIMARY KEY, session_id TEXT NOT NULL, service_type TEXT NOT NULL,
    step_name TEXT NOT NULL, response_data JSON NOT NULL, is_completed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now()
  );
  CREATE TABLE user_subscriptions (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, email TEXT,
    stripe_customer_id TEXT, stripe_subscription_id TEXT, status TEXT NOT NULL DEFAULT 'inactive',
    current_period_end TIMESTAMP, updated_at TIMESTAMP DEFAULT now()
  );
  CREATE TABLE private_user_profiles (
    user_id TEXT PRIMARY KEY, date_of_birth DATE NOT NULL, credit_score_consent_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
  );
  CREATE TABLE private_insurance_properties (
    user_id TEXT NOT NULL, address_normalized TEXT NOT NULL,
    current_policy_expiration_date DATE, quote_cache_scope TEXT NOT NULL DEFAULT 'unused',
    created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, address_normalized)
  );
  CREATE TABLE insurance_quote_cache (
    id SERIAL PRIMARY KEY, address_normalized TEXT NOT NULL, address_display TEXT NOT NULL,
    lead_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', quotes JSONB DEFAULT '[]',
    quote_counter INTEGER DEFAULT 0,
    quote_poll_attempts INTEGER NOT NULL DEFAULT 0,
    quote_stable_polls INTEGER NOT NULL DEFAULT 0,
    quote_previous_counter INTEGER,
    quote_poll_claimed_at TIMESTAMP,
    quote_poll_lease_until TIMESTAMP,
    coverage_a INTEGER DEFAULT 0, policy_type TEXT NOT NULL DEFAULT 'HO3',
    cache_scope TEXT NOT NULL DEFAULT 'shared', property_data_snapshot JSONB DEFAULT '{}',
    property_data_provenance JSONB DEFAULT '{}', agency_default_snapshot JSONB DEFAULT '{}',
    consumer_property_answers JSONB DEFAULT '{}', quote_profile_version TEXT NOT NULL DEFAULT 'legacy-v1',
    raw_quoterush_property_data JSONB, raw_quoterush_property_data_source TEXT,
    raw_quoterush_property_data_fetched_at TIMESTAMP, raw_quoterush_property_data_expires_at TIMESTAMP,
    assumptions JSONB DEFAULT '[]', triggered_at TIMESTAMP NOT NULL DEFAULT now(),
    completed_at TIMESTAMP, expires_at TIMESTAMP NOT NULL,
    email_recipient TEXT, email_user_id TEXT,
    email_delivery_status TEXT NOT NULL DEFAULT 'pending',
    email_claimed_at TIMESTAMP, email_first_attempt_at TIMESTAMP,
    email_retry_count INTEGER NOT NULL DEFAULT 0,
    email_quarantine_at TIMESTAMP, email_sent_at TIMESTAMP,
    email_error TEXT,
    CONSTRAINT insurance_quote_cache_address_policy_unique UNIQUE (address_normalized, policy_type)
  );
  CREATE INDEX insurance_quote_cache_expires_at_idx ON insurance_quote_cache (expires_at);
  CREATE TABLE non_ad_valorem_cache (
    id SERIAL PRIMARY KEY, folio TEXT NOT NULL UNIQUE, account_number TEXT, bill_year INTEGER,
    status TEXT NOT NULL DEFAULT 'pending', lines JSONB DEFAULT '[]', total_non_ad_valorem INTEGER DEFAULT 0,
    total_ad_valorem_cents INTEGER, total_millage INTEGER, ad_valorem_mills JSONB,
    fetched_at TIMESTAMP NOT NULL DEFAULT now(), expires_at TIMESTAMP NOT NULL
  );
  CREATE TABLE ifw_activity_claims (
    dedupe_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT now(),
    expires_at TIMESTAMP NOT NULL
  );
  CREATE INDEX ifw_activity_claims_user_created_at_idx ON ifw_activity_claims (user_id, created_at);
  CREATE INDEX ifw_activity_claims_expires_at_idx ON ifw_activity_claims (expires_at);
`;

const managedSourceTables: PgTable[] = [
  users,
  services,
  submissions,
  integrationRequests,
  questionnaireResponses,
  userSubscriptions,
  privateUserProfiles,
  privateInsuranceProperties,
  insuranceQuoteCache,
  nonAdValoremCache,
  ifwActivityClaims,
];

function databaseType(sqlType: string): string {
  const normalized = sqlType.toLowerCase();
  if (normalized === "serial" || normalized === "integer") return "integer";
  if (normalized.startsWith("timestamp")) return "timestamp without time zone";
  return normalized;
}

function sortedKeys(keys: Array<{ type: string; columns: string[] }>): string[] {
  return keys.map(key => `${key.type}:${key.columns.join(",")}`).sort();
}

/**
 * Manual source DDL is intentional: applying the target migration would let a
 * stale target mask drift. Compare that DDL to the live Drizzle definitions so
 * any changed column, nullability rule, or migration key fails immediately.
 */
async function assertSourceSchemaMatchesDrizzle(pool: Pool): Promise<void> {
  for (const table of managedSourceTables) {
    const config = getTableConfig(table);
    const columns = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
    }>(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [config.name]);
    const expectedColumns = config.columns.map(column => ({
      column_name: column.name,
      data_type: databaseType(column.getSQLType()),
      is_nullable: column.notNull ? "NO" : "YES",
    }));
    if (JSON.stringify(columns.rows) !== JSON.stringify(expectedColumns)) {
      throw new Error(
        `Rehearsal source schema drift for ${config.name}: columns/types/nullability no longer match shared/schema.ts`,
      );
    }

    const constraints = await pool.query<{
      type: "p" | "u";
      columns: string[];
    }>(`
      SELECT constraint_record.contype AS type,
              array_agg(attribute.attname::text ORDER BY key_column.ordinality) AS columns
      FROM pg_constraint AS constraint_record
      CROSS JOIN LATERAL unnest(constraint_record.conkey)
        WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = constraint_record.conrelid
       AND attribute.attnum = key_column.attnum
       WHERE constraint_record.conrelid = format('%I.%I', 'public', $1::text)::regclass
        AND constraint_record.contype IN ('p', 'u')
      GROUP BY constraint_record.oid, constraint_record.contype
    `, [config.name]);
    const expectedKeys: Array<{ type: string; columns: string[] }> = [
      ...config.columns
        .filter(column => column.primary)
        .map(column => ({ type: "p", columns: [column.name] })),
      ...config.primaryKeys.map(key => ({
        type: "p",
        columns: key.columns.map(column => column.name),
      })),
      ...config.columns
        .filter(column => column.isUnique)
        .map(column => ({ type: "u", columns: [column.name] })),
      ...config.uniqueConstraints.map(key => ({
        type: "u",
        columns: key.columns.map(column => column.name),
      })),
    ];
    if (
      JSON.stringify(sortedKeys(constraints.rows)) !==
      JSON.stringify(sortedKeys(expectedKeys))
    ) {
      throw new Error(
        `Rehearsal source schema drift for ${config.name}: primary/unique keys no longer match shared/schema.ts`,
      );
    }
  }
}

async function insert(
  pool: Pool,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  // Smaller batches keep the fixture useful with both node-postgres and Neon.
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const values = batch.flat();
    const placeholders = batch.map((row, rowIndex) =>
      `(${row.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(", ")})`,
    ).join(", ");
    await pool.query(
      `INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(", ")}) VALUES ${placeholders}`,
      values,
    );
  }
}

/**
 * Creates a fully synthetic copy of the managed-source shape.  This must stay
 * independent of the target migration so a stale target schema cannot make a
 * rehearsal appear healthy.
 */
export async function seedRehearsalSource(pool: Pool): Promise<void> {
  await pool.query(schemaSql);
  await assertSourceSchemaMatchesDrizzle(pool);
  const n = ROWS_PER_TABLE;
  const rows = Array.from({ length: n }, (_, zero) => zero + 1);

  await insert(pool, "users",
    ["id", "username", "password", "email", "first_name", "last_name", "phone", "contact_preference", "created_at"],
    rows.map(i => [i, `fixture-user-${i}`, `${FIXTURE_PASSWORD}-${i}`, `fixture-user-${i}@example.invalid`,
      `Fixture${i}`, `Person${i}`, i % 3 ? `555-01${String(i % 10000).padStart(4, "0")}` : null,
      ["email", "phone", "text"][i % 3], frozen(i)]));

  await insert(pool, "services", ["id", "name", "display_name", "description", "options"],
    rows.map(i => [i, `fixture-service-${i}`, `Fixture Service ${i}`,
      `Generated managed-data rehearsal service ${i}`, json(["Consultation", `Option-${i % 11}`, `Tier-${i % 4}`])]));

  await insert(pool, "submissions", ["id", "user_id", "selected_services", "form_data", "status", "created_at"],
    rows.map(i => [i, i % 7 ? ((i % n) + 1) : null, json(["mortgage", i % 2 ? "insurance" : "real-estate"]),
      json({ fixture: true, ordinal: i, nested: { address: address(i), flags: [i % 2 === 0, null, `v${i % 5}`] },
        amounts: { dollars: i * 137, cents: i % 100 } }), ["pending", "reviewed", "complete"][i % 3], frozen(i, 10)]));

  await insert(pool, "integration_requests",
    ["id", "submission_id", "provider", "request_data", "response_data", "status", "created_at"],
    rows.map(i => [i, i, ["netcalcsheet", "arive", "canopy"][i % 3],
      json({ requestId: `fixture-request-${i}`, payload: { ordinal: i, retry: i % 4 } }),
      i % 4 ? json({ accepted: i % 5 !== 0, result: { reference: `result-${i}`, values: [i, i * 2] } }) : null,
      ["pending", "sent", "complete", "failed"][i % 4], frozen(i, 11)]));

  await insert(pool, "questionnaire_responses",
    ["id", "session_id", "service_type", "step_name", "response_data", "is_completed", "created_at", "updated_at"],
    rows.map(i => [i, `fixture-session-${i}`, ["mortgage", "insurance", "realEstate"][i % 3],
      ["initial", "property-type", "financing", "review"][i % 4],
      json({ answer: `fixture-${i}`, selected: ["one", `item-${i % 9}`], details: { ordinal: i, omitted: null } }),
      i % 3 === 0, frozen(i, 8), frozen(i, 16)]));

  await insert(pool, "user_subscriptions",
    ["id", "user_id", "email", "stripe_customer_id", "stripe_subscription_id", "status", "current_period_end", "updated_at"],
    rows.map(i => [i, `subscription-user-${i}`, i % 4 ? `subscriber-${i}@example.invalid` : null,
      i % 3 ? `cus_fixture_${i}` : null, i % 5 ? `sub_fixture_${i}` : null,
      ["inactive", "active", "past_due"][i % 3], i % 4 ? frozen(i, 18) : null, frozen(i, 12)]));

  await insert(pool, "private_user_profiles",
    ["user_id", "date_of_birth", "credit_score_consent_at", "created_at", "updated_at"],
    rows.map(i => [`profile-user-${i}`, `19${70 + (i % 30)}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
      i % 3 ? frozen(i, 7) : null, frozen(i, 6), frozen(i, 15)]));

  // 419 addresses × three users: each user repeats addresses and every address
  // belongs to multiple users, exercising the composite source key.
  await insert(pool, "private_insurance_properties",
    ["user_id", "address_normalized", "current_policy_expiration_date", "quote_cache_scope", "created_at", "updated_at"],
    rows.map(i => [`property-user-${Math.floor((i - 1) / 419) + 1}`, address(i % 419),
      i % 4 ? `202${6 + (i % 3)}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}` : null,
      i % 2 ? "unused" : "legacy-fixture", frozen(i, 5), frozen(i, 14)]));

  // Adjacent rows intentionally share one address, once for each policy type.
  await insert(pool, "insurance_quote_cache",
    ["id", "address_normalized", "address_display", "lead_id", "status", "quotes", "quote_counter",
      "quote_poll_attempts", "quote_stable_polls", "quote_previous_counter",
      "quote_poll_claimed_at", "quote_poll_lease_until", "coverage_a",
      "policy_type", "cache_scope", "property_data_snapshot", "property_data_provenance", "agency_default_snapshot",
      "consumer_property_answers", "quote_profile_version", "raw_quoterush_property_data",
      "raw_quoterush_property_data_source", "raw_quoterush_property_data_fetched_at",
      "raw_quoterush_property_data_expires_at", "assumptions", "triggered_at", "completed_at", "expires_at",
      "email_recipient", "email_user_id", "email_delivery_status", "email_claimed_at",
      "email_first_attempt_at", "email_retry_count", "email_quarantine_at", "email_sent_at", "email_error"],
    rows.map(i => {
      const pair = Math.floor((i - 1) / 2) + 1;
      const policy = i % 2 ? "HO3" : "HO6";
      return [i, address(pair), `Fixture display ${address(pair)}`, i % 5 ? i : null,
        ["pending", "complete", "failed"][i % 3],
         json([{ siteName: "Fixture Carrier", annualPremium: 1000 + i, monthlyPremium: +(83.33 + i / 12).toFixed(2),
          coverageA: 200000 + i, hurricaneDeductible: "2%", aop: "$2,500", quoteUrl: i % 3 ? `https://quote-${i}.invalid` : null,
           quoteDate: "2026-02-15", rank: 1 }]), i % 9,
         i % 17, i % 4, i % 5 ? i % 9 : null,
         i % 3 ? frozen(i, 12) : null,
         i % 4 ? frozen(i, 13) : null,
         200000 + i, policy, "shared",
        json({ yearBuilt: 1980 + (i % 40), squareFeet: 1200 + i, features: { roof: i % 2 ? "shingle" : "metal" } }),
        json({ yearBuilt: "provider", squareFeet: "county", nested: { fixture: true } }),
        json({ deductible: 2500, carrier: "fixture" }), json({ occupancy: i % 2 ? "primary" : "secondary", pets: i % 4 }),
        `fixture-v${i % 3}`, i % 3 ? json({ propertyId: `synthetic-${i}`, providerFields: { stable: true, ordinal: i } }) : null,
        i % 3 ? "fixture-provider" : null, i % 3 ? frozen(i, 13) : null, i % 3 ? frozen(i, 19) : null,
        json(["Synthetic fixture only", `policy=${policy}`, i % 2 ? "verified" : "estimated"]),
         frozen(i, 9), i % 3 === 1 ? null : frozen(i, 11), frozen(i, 20),
         i % 3 ? `quote-recipient-${i}@example.invalid` : null,
         i % 3 ? `fixture-user-${i}` : null,
         ["pending", "sending", "sent", "failed", "skipped"][i % 5],
         i % 4 ? frozen(i, 12) : null,
         i % 3 ? frozen(i, 13) : null,
         i % 6,
         i % 7 === 0 ? frozen(i, 14) : null,
         i % 4 === 0 ? frozen(i, 15) : null,
         i % 5 === 0 ? `fixture delivery error ${i}` : null];
    }));

  await insert(pool, "non_ad_valorem_cache",
    ["id", "folio", "account_number", "bill_year", "status", "lines", "total_non_ad_valorem", "total_ad_valorem_cents",
      "total_millage", "ad_valorem_mills", "fetched_at", "expires_at"],
    rows.map(i => [i, `fixture-folio-${String(i).padStart(6, "0")}`, i % 3 ? `account-${i}` : null, 2026 - (i % 2),
      ["pending", "complete", "expired"][i % 3],
      json([{ authority: "Fixture CDD", amount: i * 10 }, { authority: "Fixture Stormwater", amount: i % 47 }]),
      i * 11, i % 4 ? i * 100 : null, i % 5 ? 199197 + i : null,
      i % 3 ? json([{ authority: "FIXTURE CITY", mills: 6.4525 }, { authority: "FIXTURE COUNTY", mills: +(3 + i / 1000).toFixed(4) }]) : null,
      frozen(i, 4), frozen(i, 21)]));

  await insert(pool, "ifw_activity_claims", ["dedupe_key", "user_id", "created_at", "expires_at"],
    rows.map(i => [`ifw-fixture-${i}`, `ifw-user-${(i % 251) + 1}`, frozen(i, 3), frozen(i, 22)]));

  // Explicit IDs above must leave source serials in the same usable state as a
  // normally populated source database.
  for (const table of ["users", "services", "submissions", "integration_requests", "questionnaire_responses",
    "user_subscriptions", "insurance_quote_cache", "non_ad_valorem_cache"]) {
    await pool.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), $2, true)`, [table, n]);
  }
}