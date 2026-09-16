import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import {
  date,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import ws from "ws";
import { registerInsuranceCacheRoutes } from "./insurance-cache-routes";

test("renewal date changes preserve the shared quote cache identity", async t => {
  const connectionString =
    process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
  assert.ok(connectionString, "An isolated managed test database is required");
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString });
  const schemaName = `renewal_scope_${randomUUID().replaceAll("-", "_")}`;
  let schemaCreated = false;
  t.after(async () => {
    if (schemaCreated) {
      await pool.query(`drop schema if exists "${schemaName}" cascade`);
    }
    await pool.end();
  });
  const isolated = pgSchema(schemaName);
  const privateProperties = isolated.table(
    "private_insurance_properties",
    {
      userId: text("user_id").notNull(),
      addressNormalized: text("address_normalized").notNull(),
      currentPolicyExpirationDate: date("current_policy_expiration_date"),
      quoteCacheScope: text("quote_cache_scope").notNull().default("unused"),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at").defaultNow().notNull(),
    },
    table => ({
      pk: primaryKey({ columns: [table.userId, table.addressNormalized] }),
    }),
  );
  const quoteCache = isolated.table(
    "insurance_quote_cache",
    {
      id: serial("id").primaryKey(),
      addressNormalized: text("address_normalized").notNull(),
      addressDisplay: text("address_display").notNull(),
      leadId: integer("lead_id"),
      status: text("status").notNull().default("pending"),
      quotes: jsonb("quotes").default([]),
      quoteCounter: integer("quote_counter").default(0),
      coverageA: integer("coverage_a").default(0),
      policyType: text("policy_type").notNull().default("HO3"),
      cacheScope: text("cache_scope").notNull().default("shared"),
      propertyDataSnapshot: jsonb("property_data_snapshot").default({}),
      propertyDataProvenance: jsonb("property_data_provenance").default({}),
      agencyDefaultSnapshot: jsonb("agency_default_snapshot").default({}),
      consumerPropertyAnswers: jsonb("consumer_property_answers").default({}),
      quoteProfileVersion: text("quote_profile_version")
        .notNull()
        .default("legacy-v1"),
      assumptions: jsonb("assumptions").default([]),
      triggeredAt: timestamp("triggered_at").defaultNow().notNull(),
      expiresAt: timestamp("expires_at").notNull(),
    },
    table => ({
      identity: unique("quote_identity").on(
        table.addressNormalized,
        table.policyType,
      ),
    }),
  );

  await pool.query(`create schema "${schemaName}"`);
  schemaCreated = true;
  await pool.query(`
    create table "${schemaName}".private_insurance_properties (
      user_id text not null,
      address_normalized text not null,
      current_policy_expiration_date date,
      quote_cache_scope text not null default 'unused',
      created_at timestamp not null default now(),
      updated_at timestamp not null default now(),
      primary key (user_id, address_normalized)
    );
    create table "${schemaName}".insurance_quote_cache (
      id serial primary key,
      address_normalized text not null,
      address_display text not null,
      lead_id integer,
      status text not null default 'pending',
      quotes jsonb default '[]',
      quote_counter integer default 0,
      coverage_a integer default 0,
      policy_type text not null default 'HO3',
      cache_scope text not null default 'shared',
      property_data_snapshot jsonb default '{}',
      property_data_provenance jsonb default '{}',
      agency_default_snapshot jsonb default '{}',
      consumer_property_answers jsonb default '{}',
      quote_profile_version text not null default 'legacy-v1',
      assumptions jsonb default '[]',
      triggered_at timestamp not null default now(),
      expires_at timestamp not null,
      unique (address_normalized, policy_type)
    )
  `);

  const database = drizzle({ client: pool });
  const app = express();
  app.use(express.json());
  registerInsuranceCacheRoutes(app, {
    db: database,
    optionalUser: async () => ({ id: "route-test-user" }),
    normalizeAddress: address => address.trim().toLowerCase(),
    tables: {
      privateInsuranceProperties: privateProperties,
      insuranceQuoteCache: quoteCache,
    } as any,
  });
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = "123 Renewal Way";
  const normalizedAddress = address.toLowerCase();
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const saveDate = (currentPolicyExpirationDate: string | null) =>
    fetch(`${baseUrl}/api/profile/insurance-property`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, currentPolicyExpirationDate }),
    });
  const readCache = () =>
    fetch(`${baseUrl}/api/insurance/qr-cache?address=${encodeURIComponent(address)}`)
      .then(response => response.json());

  assert.equal((await saveDate("2026-10-15")).status, 200);
  const [firstProperty] = await database.select().from(privateProperties);
  assert.equal(firstProperty.quoteCacheScope, "unused");
  await database.insert(quoteCache).values({
    addressNormalized: normalizedAddress,
    addressDisplay: address,
    status: "complete",
    leadId: 101,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  });
  assert.equal((await readCache()).leadId, 101);

  assert.equal((await saveDate("2026-11-15")).status, 200);
  const [updatedProperty] = await database.select().from(privateProperties);
  assert.equal(updatedProperty.quoteCacheScope, "unused");
  assert.equal(updatedProperty.currentPolicyExpirationDate, "2026-11-15");
  assert.equal((await readCache()).leadId, 101);

  assert.equal((await saveDate(null)).status, 200);
  const [clearedProperty] = await database.select().from(privateProperties);
  assert.equal(clearedProperty.currentPolicyExpirationDate, null);
  assert.equal(clearedProperty.quoteCacheScope, "unused");
  assert.equal((await readCache()).leadId, 101);
});