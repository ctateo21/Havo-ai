import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { insuranceQuoteCache } from "@shared/schema";
import { db } from "./db";
import { supabaseAdmin } from "./supabase";
import {
  mirrorSourceResultOrWriteTarget,
  routedRead,
  routedWrite,
} from "./managed-data-routing";

export type QuoteCacheRow = typeof insuranceQuoteCache.$inferSelect;
export type QuoteCacheInsert = typeof insuranceQuoteCache.$inferInsert;
type Identity = Partial<Pick<QuoteCacheRow, "id" | "leadId" | "addressNormalized" | "policyType" | "cacheScope">>;
export type QuoteCacheGeneration = Pick<QuoteCacheRow, "triggeredAt" | "leadId"> & {
  /** The durable poll lease owner. Omit this for non-polling writes. */
  quotePollClaimedAt?: QuoteCacheRow["quotePollClaimedAt"];
  /** Expected row status for a compare-and-set write. */
  expectedStatus?: QuoteCacheRow["status"];
};
export const EMAIL_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

function targetRow(row: Record<string, any>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
    value instanceof Date ? value.toISOString() : value,
  ]));
}
function sourceRow(row: Record<string, any>): QuoteCacheRow {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camel] = /(?:At|Until|ExpiresAt)$/.test(camel) && typeof value === "string"
      ? new Date(value) : value;
  }
  return result as QuoteCacheRow;
}
function sourceWhere(identity: Identity) {
  const terms = [];
  if (identity.id != null) terms.push(eq(insuranceQuoteCache.id, identity.id));
  if (identity.leadId != null) terms.push(eq(insuranceQuoteCache.leadId, identity.leadId));
  if (identity.addressNormalized != null) terms.push(eq(insuranceQuoteCache.addressNormalized, identity.addressNormalized));
  if (identity.policyType != null) terms.push(eq(insuranceQuoteCache.policyType, identity.policyType));
  if (identity.cacheScope != null) terms.push(eq(insuranceQuoteCache.cacheScope, identity.cacheScope));
  if (!terms.length) throw new Error("Quote cache read requires an identity");
  return and(...terms)!;
}

export async function readQuoteCache(identity: Identity, limit = 20): Promise<QuoteCacheRow[]> {
  return routedRead(
    () => db.select().from(insuranceQuoteCache).where(sourceWhere(identity)).limit(limit),
    async () => {
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      let query: any = supabaseAdmin.from("insurance_quote_cache").select("*");
      for (const [key, value] of Object.entries(targetRow(identity))) query = query.eq(key, value);
      const { data, error } = await query.limit(limit);
      if (error) throw error;
      return (data ?? []).map(sourceRow);
    },
  );
}

/** Pending jobs are server work, not a browser-owned queue. Keep this read
 * private to the background worker; public routes must use an identity-bound
 * lookup and explicit response projection. */
export async function listPendingQuoteCaches(limit = 200): Promise<QuoteCacheRow[]> {
  return routedRead(
    () => db.select().from(insuranceQuoteCache)
      .where(eq(insuranceQuoteCache.status, "pending"))
      .limit(limit),
    async () => {
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      const { data, error } = await supabaseAdmin
        .from("insurance_quote_cache")
        .select("*")
        .eq("status", "pending")
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(sourceRow);
    },
  );
}

/** Successful rows whose email handoff may have been interrupted. The
 * provider idempotency key makes a retry safe after a crash between provider
 * acceptance and the durable sent marker. */
export async function listQuoteEmailRecoveryRows(limit = 200): Promise<QuoteCacheRow[]> {
  return routedRead(
    () => db.select().from(insuranceQuoteCache)
      .where(and(
        eq(insuranceQuoteCache.status, "success"),
        or(
          isNull(insuranceQuoteCache.emailDeliveryStatus),
          eq(insuranceQuoteCache.emailDeliveryStatus, "pending"),
          eq(insuranceQuoteCache.emailDeliveryStatus, "sending"),
          eq(insuranceQuoteCache.emailDeliveryStatus, "failed"),
        ),
      ))
      .limit(limit),
    async () => {
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      const { data, error } = await supabaseAdmin
        .from("insurance_quote_cache")
        .select("*")
        .eq("status", "success")
        .or("email_delivery_status.is.null,email_delivery_status.eq.pending,email_delivery_status.eq.sending,email_delivery_status.eq.failed")
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(sourceRow);
    },
  );
}

export async function updateQuoteCache(
  id: number,
  values: Partial<QuoteCacheInsert>,
  generation?: QuoteCacheGeneration,
) {
  const generationWhere = generation
    ? and(
        eq(insuranceQuoteCache.triggeredAt, generation.triggeredAt),
        generation.leadId == null
          ? isNull(insuranceQuoteCache.leadId)
          : eq(insuranceQuoteCache.leadId, generation.leadId),
        generation.quotePollClaimedAt === undefined
          ? undefined
          : generation.quotePollClaimedAt == null
            ? isNull(insuranceQuoteCache.quotePollClaimedAt)
            : eq(insuranceQuoteCache.quotePollClaimedAt, generation.quotePollClaimedAt),
        generation.expectedStatus === undefined
          ? undefined
          : eq(insuranceQuoteCache.status, generation.expectedStatus),
      )
    : undefined;
  const updateWhere = generationWhere
    ? and(eq(insuranceQuoteCache.id, id), generationWhere)
    : eq(insuranceQuoteCache.id, id);
  return routedWrite<QuoteCacheRow | undefined>(
    async () => {
      const [row] = await db.update(insuranceQuoteCache).set(values)
        .where(updateWhere).returning();
      return row;
    },
    (sourceResult, context) => mirrorSourceResultOrWriteTarget(
      sourceResult,
      context,
      mirrorTargetRow,
      async () => {
        if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
         let query = supabaseAdmin.from("insurance_quote_cache")
           .update(targetRow(values)).eq("id", id);
         if (generation) {
           query = query.eq("triggered_at", generation.triggeredAt.toISOString());
           query = generation.leadId == null
             ? query.is("lead_id", null)
             : query.eq("lead_id", generation.leadId);
            query = generation.quotePollClaimedAt === undefined
              ? query
              : generation.quotePollClaimedAt == null
                ? query.is("quote_poll_claimed_at", null)
                : query.eq(
                  "quote_poll_claimed_at",
                  generation.quotePollClaimedAt.toISOString(),
                );
            if (generation.expectedStatus !== undefined) {
              query = query.eq("status", generation.expectedStatus);
            }
         }
         const { data, error } = await query.select().maybeSingle();
        if (error) throw error;
         return data ? sourceRow(data) : undefined;
      },
    ),
  );
}

/** Atomically acquire a short poll lease. Multiple app instances may resume
 * the same pending row, but only the lease holder is allowed to contact
 * QuoteRUSH. The generation predicate prevents a stale lease holder from
 * touching a reclaimed row. */
export async function claimQuotePollJob(
  id: number,
  generation: QuoteCacheGeneration,
  now = new Date(),
  leaseMs = 2 * 60 * 1000,
): Promise<QuoteCacheRow | undefined> {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  return routedWrite(
    async (): Promise<QuoteCacheRow | undefined> => {
      const [row] = await db.update(insuranceQuoteCache)
        .set({
          quotePollClaimedAt: now,
          quotePollLeaseUntil: leaseUntil,
        })
        .where(and(
          eq(insuranceQuoteCache.id, id),
          eq(insuranceQuoteCache.status, "pending"),
          eq(insuranceQuoteCache.triggeredAt, generation.triggeredAt),
          generation.leadId == null
            ? isNull(insuranceQuoteCache.leadId)
            : eq(insuranceQuoteCache.leadId, generation.leadId),
          or(
            isNull(insuranceQuoteCache.quotePollLeaseUntil),
            lte(insuranceQuoteCache.quotePollLeaseUntil, now),
          ),
        ))
        .returning();
      return row;
    },
    async (sourceResult, context) => {
      if (context.sourceWasWritten) {
        if (sourceResult) await mirrorTargetRow(sourceResult);
        return sourceResult;
      }
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      let query = supabaseAdmin.from("insurance_quote_cache")
        .update({
          quote_poll_claimed_at: now.toISOString(),
          quote_poll_lease_until: leaseUntil.toISOString(),
        })
        .eq("id", id)
        .eq("status", "pending")
        .eq("triggered_at", generation.triggeredAt.toISOString());
      query = generation.leadId == null
        ? query.is("lead_id", null)
        : query.eq("lead_id", generation.leadId);
      const { data, error } = await query
        .or(
          `quote_poll_lease_until.is.null,quote_poll_lease_until.lte.${now.toISOString()}`,
        )
        .select()
        .maybeSingle();
      if (error) throw error;
      return data ? sourceRow(data) : undefined;
    },
  );
}

export async function reclaimQuoteCache(id: number, now: Date, values: QuoteCacheInsert) {
  let effectiveValues = values;
  return routedWrite(
    async () => {
      const [existing] = await db.select({
        triggeredAt: insuranceQuoteCache.triggeredAt,
      }).from(insuranceQuoteCache)
        .where(eq(insuranceQuoteCache.id, id))
        .limit(1);
      const nextTriggeredAt = existing
        ? new Date(Math.max(
            now.getTime(),
            existing.triggeredAt.getTime() + 1,
          ))
        : now;
      effectiveValues = { ...values, triggeredAt: nextTriggeredAt };
      return db.update(insuranceQuoteCache).set(effectiveValues).where(and(
        eq(insuranceQuoteCache.id, id),
        or(
          lte(insuranceQuoteCache.expiresAt, now),
          eq(insuranceQuoteCache.status, "error"),
          eq(insuranceQuoteCache.status, "failed"),
        ),
      )).returning();
    },
    async sourceResult => {
      if (sourceResult) {
        const row = sourceResult[0] ?? (await db.select()
          .from(insuranceQuoteCache)
          .where(eq(insuranceQuoteCache.id, id))
          .limit(1))[0];
        if (row) await mirrorTargetRow(row);
        return sourceResult;
      }
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      const { data, error } = await supabaseAdmin.rpc("claim_insurance_quote_cache", {
        p_address_normalized: values.addressNormalized,
        p_policy_type: effectiveValues.policyType,
        p_values: targetRow({ ...effectiveValues, id }),
         p_now: now.toISOString(),
      });
      if (error) throw error;
      if (!data?.[0]?.claimed) return [];
      const { data: claimedRow, error: readError } = await supabaseAdmin
        .from("insurance_quote_cache")
        .select("*")
        .eq("id", Number(data[0].row_id))
        .single();
      if (readError) throw readError;
      return [sourceRow(claimedRow)];
    },
  );
}

/** Atomically reserve one result-email delivery. A stale `sending` claim is
 * recoverable after a process crash; a fresh claim remains owned by the
 * in-flight worker. */
export async function claimQuoteResultEmail(
  id: number,
  now = new Date(),
  staleAfterMs = 10 * 60 * 1000,
): Promise<QuoteCacheRow | undefined> {
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  const retryDeadline = new Date(now.getTime() - EMAIL_RETRY_WINDOW_MS);
  return routedWrite(
    async (): Promise<QuoteCacheRow | undefined> => {
      const [current] = await db.select().from(insuranceQuoteCache)
        .where(eq(insuranceQuoteCache.id, id))
        .limit(1);
      if (!current || current.status !== "success") return undefined;
      const sendingFresh = current.emailDeliveryStatus === "sending" &&
        current.emailClaimedAt != null &&
        current.emailClaimedAt > staleBefore;
      if (sendingFresh) return undefined;
      if (
        current.emailFirstAttemptAt &&
        current.emailFirstAttemptAt <= retryDeadline &&
        current.emailDeliveryStatus !== "sent" &&
        current.emailDeliveryStatus !== "skipped"
      ) {
        const [quarantined] = await db.update(insuranceQuoteCache)
          .set({
            emailDeliveryStatus: "quarantined",
            emailQuarantineAt: now,
            emailError: "email retry window expired before delivery was confirmed",
          })
          .where(and(
            eq(insuranceQuoteCache.id, id),
            eq(insuranceQuoteCache.status, "success"),
            or(
              isNull(insuranceQuoteCache.emailDeliveryStatus),
              eq(insuranceQuoteCache.emailDeliveryStatus, "pending"),
              eq(insuranceQuoteCache.emailDeliveryStatus, "failed"),
              and(
                eq(insuranceQuoteCache.emailDeliveryStatus, "sending"),
                or(
                  isNull(insuranceQuoteCache.emailClaimedAt),
                  lte(insuranceQuoteCache.emailClaimedAt, staleBefore),
                ),
              ),
            ),
          ))
          .returning();
        return quarantined;
      }
      const [row] = await db.update(insuranceQuoteCache)
        .set({
          emailDeliveryStatus: "sending",
          emailClaimedAt: now,
          emailFirstAttemptAt: sql`coalesce(${insuranceQuoteCache.emailFirstAttemptAt}, ${now})`,
          emailRetryCount: sql`coalesce(${insuranceQuoteCache.emailRetryCount}, 0) + 1`,
          emailError: null,
        })
        .where(and(
          eq(insuranceQuoteCache.id, id),
          eq(insuranceQuoteCache.status, "success"),
          or(
            isNull(insuranceQuoteCache.emailDeliveryStatus),
            eq(insuranceQuoteCache.emailDeliveryStatus, "pending"),
            eq(insuranceQuoteCache.emailDeliveryStatus, "failed"),
            and(
              eq(insuranceQuoteCache.emailDeliveryStatus, "sending"),
              or(
                isNull(insuranceQuoteCache.emailClaimedAt),
                lte(insuranceQuoteCache.emailClaimedAt, staleBefore),
              ),
            ),
          ),
        ))
        .returning();
      return row;
    },
    async (claimedRow, context) => {
      if (context.sourceWasWritten) {
        if (claimedRow) await mirrorTargetRow(claimedRow);
        return claimedRow;
      }
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      const { data: current, error: readError } = await supabaseAdmin
        .from("insurance_quote_cache")
        .select("email_first_attempt_at,email_retry_count,email_delivery_status,email_claimed_at")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw readError;
      if (!current || current.email_delivery_status === "sent" || current.email_delivery_status === "skipped") {
        return undefined;
      }
      if (
        current.email_delivery_status === "sending" &&
        current.email_claimed_at &&
        new Date(current.email_claimed_at).getTime() > staleBefore.getTime()
      ) return undefined;
      if (
        current.email_first_attempt_at &&
        new Date(current.email_first_attempt_at).getTime() <= retryDeadline.getTime()
      ) {
        const { data: quarantined, error: quarantineError } = await supabaseAdmin
          .from("insurance_quote_cache")
          .update({
            email_delivery_status: "quarantined",
            email_quarantine_at: now.toISOString(),
            email_error: "email retry window expired before delivery was confirmed",
          })
          .eq("id", id)
          .eq("status", "success")
          .or(
            `email_delivery_status.eq.pending,email_delivery_status.eq.failed,and(email_delivery_status.eq.sending,email_claimed_at.is.null),and(email_delivery_status.eq.sending,email_claimed_at.lte.${staleBefore.toISOString()})`,
          )
          .select()
          .maybeSingle();
        if (quarantineError) throw quarantineError;
        return quarantined ? sourceRow(quarantined) : undefined;
      }
      const firstAttemptAt = current.email_first_attempt_at ?? now.toISOString();
      const { data, error } = await supabaseAdmin
        .from("insurance_quote_cache")
        .update({
          email_delivery_status: "sending",
          email_claimed_at: now.toISOString(),
          email_first_attempt_at: firstAttemptAt,
          email_retry_count: Number(current.email_retry_count ?? 0) + 1,
          email_error: null,
        })
        .eq("id", id)
        .eq("status", "success")
        .or(
          `email_delivery_status.is.null,email_delivery_status.eq.pending,email_delivery_status.eq.failed,and(email_delivery_status.eq.sending,email_claimed_at.is.null),and(email_delivery_status.eq.sending,email_claimed_at.lte.${staleBefore.toISOString()})`,
        )
        .select()
        .maybeSingle();
      if (error) throw error;
      return data ? sourceRow(data) : undefined;
    },
  );
}

async function mirrorTargetRow(row: QuoteCacheRow) {
  if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
  const { error } = await supabaseAdmin.from("insurance_quote_cache").upsert(
    targetRow(row),
    { onConflict: "address_normalized,policy_type,cache_scope" },
  );
  if (error) throw error;
}

export async function claimNewQuoteCache(values: QuoteCacheInsert) {
  const policyType = values.policyType ?? "HO3";
  return routedWrite(
    () => db.insert(insuranceQuoteCache).values(values).onConflictDoNothing()
      .returning(),
    async sourceResult => {
      if (sourceResult) {
        const row = sourceResult[0] ?? (await db.select()
          .from(insuranceQuoteCache)
          .where(and(
            eq(insuranceQuoteCache.addressNormalized, values.addressNormalized),
            eq(insuranceQuoteCache.policyType, policyType),
            eq(insuranceQuoteCache.cacheScope, values.cacheScope??"shared"),
          ))
          .limit(1))[0];
        if (row) await mirrorTargetRow(row);
        return sourceResult;
      }
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      const { data, error } = await supabaseAdmin.rpc("claim_insurance_quote_cache", {
        p_address_normalized: values.addressNormalized,
        p_policy_type: policyType,
        p_values: targetRow({ ...values, policyType }),
        p_now: new Date().toISOString(),
      });
      if (error) throw error;
      if (!data?.[0]?.claimed) return [];
      const { data: claimedRow, error: readError } = await supabaseAdmin
        .from("insurance_quote_cache")
        .select("*")
        .eq("id", Number(data[0].row_id))
        .single();
      if (readError) throw readError;
      return [sourceRow(claimedRow)];
    },
  );
}