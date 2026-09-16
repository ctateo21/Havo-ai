import { getTableConfig } from "drizzle-orm/pg-core";
import {
  users, services, submissions, integrationRequests, questionnaireResponses,
  userSubscriptions, privateUserProfiles, privateInsuranceProperties,
  insuranceQuoteCache, nonAdValoremCache, ifwActivityClaims,
} from "../shared/schema";
import { TABLES } from "./managed-data-migration-common";
import { parseRecoveryJson, stringifyRecoveryJson } from "./managed-data-recovery-json";

const sourceTables = {
  users, services, submissions, integration_requests: integrationRequests,
  questionnaire_responses: questionnaireResponses, user_subscriptions: userSubscriptions,
  private_user_profiles: privateUserProfiles, private_insurance_properties: privateInsuranceProperties,
  insurance_quote_cache: insuranceQuoteCache, non_ad_valorem_cache: nonAdValoremCache,
  ifw_activity_claims: ifwActivityClaims,
};

export function recoveryTimestampColumns(target: string): string[] {
  const descriptor = TABLES.find(([, name]) => name === target);
  if (!descriptor) throw new Error("Unknown recovery table");
  return getTableConfig(sourceTables[descriptor[0]]).columns
    .filter(column => /^timestamp(?:\(| |$)/i.test(column.getSQLType()))
    .map(column => column.name);
}

/** Schema-owned allowlist; manifest data can never nominate a castable column. */
export function recoveryJsonColumns(target: string): string[] {
  const descriptor = TABLES.find(([, name]) => name === target);
  if (!descriptor) throw new Error("Unknown recovery table");
  return getTableConfig(sourceTables[descriptor[0]]).columns
    .filter(column => /^jsonb?$/i.test(column.getSQLType()))
    .map(column => column.name);
}

/**
 * Only typed SQL timestamp and JSON columns are normalized. JSON values in the
 * v2 manifest are canonical text; JavaScript null is reserved for SQL NULL.
 * Missing schema columns are tolerated here for small synthetic fixtures. The
 * production source schema check still requires complete rows.
 */
export function normalizeRecoveryRows(target: string, rows: any[]): any[] {
  const jsonColumns = recoveryJsonColumns(target);
  return normalizeMigrationTimestamps(target, rows).map(result => {
    for (const column of jsonColumns) {
      if (!Object.prototype.hasOwnProperty.call(result, column) || result[column] === null) continue;
      if (typeof result[column] !== "string") throw new Error("Invalid recovery JSON column");
      result[column] = stringifyRecoveryJson(parseRecoveryJson(result[column]), true);
    }
    return result;
  });
}

/** Shared by both transfer directions; never normalize arbitrary JSON strings. */
export function normalizeMigrationTimestamps(target: string, rows: any[]): any[] {
  const timestamps = recoveryTimestampColumns(target);
  return rows.map(row => {
    const result = { ...row };
    for (const column of timestamps) {
      const value = result[column];
      if (value == null || value === "infinity" || value === "-infinity") continue;
      if (typeof value !== "string") throw new Error("Invalid recovery timestamp column");
      const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value);
      if (!timestamp) throw new Error("Invalid recovery timestamp column");
      // Source timestamp WITHOUT time zone uses UTC, not the CLI host timezone.
      const utcValue = timestamp[3] ? value : `${value}Z`;
      if (!Number.isFinite(Date.parse(utcValue))) throw new Error("Invalid recovery timestamp column");
      const subMillis = (timestamp[2] ?? "").slice(3).replace(/0+$/, "");
      result[column] = new Date(utcValue).toISOString().replace(/Z$/, `${subMillis}Z`);
    }
    return result;
  });
}