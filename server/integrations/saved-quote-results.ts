import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  userInsuranceQuoteResults,
  type SavedInsuranceQuote,
  type UserInsuranceQuoteResult,
} from "@shared/schema";
import { normalizeQuoteAddress } from "@shared/quote-address";

export const SAVED_QUOTE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const ESTIMATE_SNAPSHOT_VERSION = "estimate-snapshot-v1";

// ── Estimate snapshot ────────────────────────────────────────────────────
// Optional client-supplied estimate figures. Invalid values are dropped, not
// rejected: the snapshot is analytics capture and must never block a quote.
export const estimateInputSchema = z.object({
  annual: z.number().finite().positive().max(1_000_000),
  monthly: z.number().finite().positive().max(100_000).optional(),
  county: z.string().trim().max(60).optional(),
  modelVersion: z.string().trim().max(60).optional(),
});
export type EstimateInput = z.infer<typeof estimateInputSchema>;

export function parseEstimateInput(value: unknown): EstimateInput | null {
  const parsed = estimateInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Only the wind-mitigation answer values, never report identifiers,
 * inspector names, upload ids, or dates. */
function windAnswerValues(answers: unknown): Record<string, unknown> | null {
  if (!answers || typeof answers !== "object") return null;
  const a = answers as Record<string, unknown>;
  const pick = (source: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
  const out: Record<string, unknown> = pick(a, [
    "reportAvailable", "shape", "roofDeck", "roofToWall", "roofCovering",
    "allOpenings", "openingsConfirmed", "peelAndStick", "gated",
  ]);
  if (a.report && typeof a.report === "object") {
    const report = a.report as Record<string, unknown>;
    out.reportValues = pick(report, [
      "roofToWall", "roofDeck", "swr", "opening", "shape",
      "productApproval", "assumedFields", "yearBuilt",
    ]);
  }
  return out;
}

const CONSTRUCTION = ["Masonry", "Mixed", "Frame"];
const HURRICANE = ["2%", "5%", "10%"];

/** Explicit allowlist. Every value is a property/estimate fact; nothing from
 * the request's identity, contact, claims, or prior-carrier fields. */
export function buildEstimateSnapshot(
  request: Record<string, any>,
  estimate: EstimateInput | null,
  extra: { usageType?: string; county?: string | null } = {},
): Record<string, unknown> {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    version: ESTIMATE_SNAPSHOT_VERSION,
    modelVersion: estimate?.modelVersion ?? null,
    annual: estimate?.annual ?? null,
    monthly: estimate?.monthly ?? (estimate ? Math.round((estimate.annual / 12) * 100) / 100 : null),
    county: str(extra.county) ?? estimate?.county ?? null,
    policyType: str(request.policyType),
    coverageA: num(request.coverageA),
    yearBuilt: num(request.yearBuilt),
    roofYear: num(request.roofYear),
    sqFt: num(request.sqFt),
    construction: typeof request.constIdx === "number" ? CONSTRUCTION[request.constIdx] ?? null : null,
    roofShape: str(request.roofShape),
    roofMaterial: str(request.roofMaterial),
    openingProtection: typeof request.openingProtection === "boolean" ? request.openingProtection : null,
    secondaryWaterResistance: str(request.secondaryWaterResistance),
    windMitigationLocks: request.windMitigationLocks && typeof request.windMitigationLocks === "object"
      ? {
          openingProtection: request.windMitigationLocks.openingProtection === true,
          secondaryWaterResistance: request.windMitigationLocks.secondaryWaterResistance === true,
        }
      : null,
    windAnswers: windAnswerValues(request.windAnswers),
    hurricaneDeductible: typeof request.hurrIdx === "number" ? HURRICANE[request.hurrIdx] ?? null : null,
    aopDeductible: num(request.aopDeductible),
    floodZone: str(request.floodZone),
    floodZoneUnknown: request.floodZoneUnknown === true,
    newPurchase: typeof request.newPurchase === "boolean" ? request.newPurchase : null,
    occupancy: str(extra.usageType) ?? str(request.usageType),
    rentalTerm: str(request.rentalTerm),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────
export interface SavedQuoteStore {
  recordPending(args: {
    userId: string; addressNormalized: string; policyType: string;
    snapshot: Record<string, unknown>; startedAt: Date;
  }): Promise<void>;
  saveCompleted(args: {
    userId: string; addressNormalized: string; policyType: string;
    leadId: number | null; quotes: SavedInsuranceQuote[]; completedAt: Date;
    runStartedAt: Date; estimateSnapshot?: Record<string, unknown> | null;
  }): Promise<void>;
  listForUser(userId: string, filter?: {
    addressNormalized?: string; policyType?: string;
  }): Promise<UserInsuranceQuoteResult[]>;
}

export function topThreeSavedQuotes(quotes: unknown, keepUrls: boolean): SavedInsuranceQuote[] {
  const list = Array.isArray(quotes) ? quotes : [];
  return list
    .filter((q: any) => q && Number(q.annualPremium) > 0)
    .sort((a: any, b: any) => Number(a.annualPremium) - Number(b.annualPremium))
    .slice(0, 3)
    .map((q: any, index) => ({
      siteName: String(q.siteName ?? ""),
      annualPremium: Number(q.annualPremium),
      monthlyPremium: Number(q.monthlyPremium) || Math.round((Number(q.annualPremium) / 12) * 100) / 100,
      coverageA: Number(q.coverageA) || 0,
      hurricaneDeductible: String(q.hurricaneDeductible ?? ""),
      aop: String(q.aop ?? ""),
      quoteUrl: keepUrls && typeof q.quoteUrl === "string" ? q.quoteUrl : null,
      quoteDate: String(q.quoteDate ?? ""),
      rank: index + 1,
    }));
}

export function createDbSavedQuoteStore(db: any): SavedQuoteStore {
  const t = userInsuranceQuoteResults;
  return {
    async recordPending({ userId, addressNormalized, policyType, snapshot, startedAt }) {
      // Never touches quotes/completed_at: prior completed results stay
      // visible until this run succeeds.
      await db.insert(t).values({
        userId, addressNormalized, policyType,
        pendingEstimateSnapshot: snapshot, pendingStartedAt: startedAt,
      }).onConflictDoUpdate({
        target: [t.userId, t.addressNormalized, t.policyType],
        set: { pendingEstimateSnapshot: snapshot, pendingStartedAt: startedAt, updatedAt: new Date() },
      });
    },
    async saveCompleted({ userId, addressNormalized, policyType, leadId, quotes, completedAt, runStartedAt, estimateSnapshot }) {
      if (!quotes.length) return;
      const best = quotes[0];
      const direct = estimateSnapshot ? JSON.stringify(estimateSnapshot) : null;
      // The pending snapshot is promoted only when it belongs to this run
      // (started at or before it). A late-finishing older run never
      // replaces newer completed results.
      const pendingBelongs = sql`(${t.pendingStartedAt} is not null and ${t.pendingStartedAt} <= ${runStartedAt})`;
      await db.insert(t).values({
        userId, addressNormalized, policyType, leadId, quotes,
        bestCarrier: best.siteName, bestAnnual: String(best.annualPremium),
        completedAt, estimateSnapshot: estimateSnapshot ?? null,
      }).onConflictDoUpdate({
        target: [t.userId, t.addressNormalized, t.policyType],
        set: {
          leadId, quotes,
          bestCarrier: best.siteName,
          bestAnnual: String(best.annualPremium),
          completedAt,
          estimateSnapshot: sql`case
            when ${direct}::jsonb is not null then ${direct}::jsonb
            when ${pendingBelongs} then ${t.pendingEstimateSnapshot}
            else ${t.estimateSnapshot} end`,
          pendingEstimateSnapshot: sql`case when ${pendingBelongs} then null else ${t.pendingEstimateSnapshot} end`,
          pendingStartedAt: sql`case when ${pendingBelongs} then null else ${t.pendingStartedAt} end`,
          updatedAt: new Date(),
        },
        setWhere: sql`${t.completedAt} is null or ${t.completedAt} <= ${completedAt}`,
      });
    },
    async listForUser(userId, filter = {}) {
      const conditions = [eq(t.userId, userId)];
      if (filter.addressNormalized) conditions.push(eq(t.addressNormalized, filter.addressNormalized));
      if (filter.policyType) conditions.push(eq(t.policyType, filter.policyType));
      return db.select().from(t).where(and(...conditions)).limit(200);
    },
  };
}

let defaultStore: SavedQuoteStore | null = null;
async function getDefaultStore(): Promise<SavedQuoteStore> {
  if (!defaultStore) {
    const { db } = await import("../db");
    defaultStore = createDbSavedQuoteStore(db);
  }
  return defaultStore;
}

// ── Supabase scenario mirror ─────────────────────────────────────────────
export type ScenarioMirror = (args: {
  userId: string; addressNormalized: string; policyType: string;
  quote: SavedInsuranceQuote; leadId: number | null; completedAt: Date;
}) => Promise<void>;

/** Adds live-quote keys to the user's own saved insurance scenario. Writes
 * nothing when the property was never saved. Never changes the estimate
 * inputs, premium, or premium source. */
export const mirrorToInsuranceScenario: ScenarioMirror = async args => {
  const { supabaseAdmin } = await import("../supabase");
  if (!supabaseAdmin) return;
  const { data, error } = await supabaseAdmin
    .from("insurance_scenarios")
    .select("id,address,user_answer_sources")
    .eq("user_id", args.userId);
  if (error) throw new Error("scenario lookup failed");
  const match = (data ?? []).find(
    (row: any) => typeof row.address === "string" &&
      normalizeQuoteAddress(row.address) === args.addressNormalized,
  );
  if (!match) return;
  const existing = match.user_answer_sources && typeof match.user_answer_sources === "object"
    ? match.user_answer_sources as Record<string, unknown> : {};
  const { error: updateError } = await supabaseAdmin
    .from("insurance_scenarios")
    .update({
      user_answer_sources: {
        ...existing,
        live_quote_carrier: args.quote.siteName,
        live_quote_annual: args.quote.annualPremium,
        live_quote_monthly: args.quote.monthlyPremium,
        live_quote_policy_type: args.policyType,
        live_quote_lead_id: args.leadId,
        live_quote_completed_at: args.completedAt.toISOString(),
        live_quote_source: "quoterush",
      },
    })
    .eq("id", match.id)
    .eq("user_id", args.userId);
  if (updateError) throw new Error("scenario update failed");
};

// ── Entry points used by qr-start and the polling worker ────────────────
/** Best effort. Never throws; logs without addresses or user ids. */
export async function recordPendingQuoteRun(
  args: Parameters<SavedQuoteStore["recordPending"]>[0],
  store?: SavedQuoteStore,
): Promise<void> {
  try {
    await (store ?? await getDefaultStore()).recordPending(args);
  } catch {
    console.error("[saved-quotes] pending snapshot save failed");
  }
}

export interface CompletedRunLike {
  emailUserId?: string | null;
  ownerUserId?: string | null;
  addressNormalized: string;
  policyType: string;
  leadId: number | null;
  quotes: unknown;
  completedAt: Date | null;
  triggeredAt: Date;
}

/** Saves a successful run for the user who requested it. Idempotent; never
 * throws, so it cannot break the polling run or the results email. */
export async function saveCompletedQuoteRun(
  run: CompletedRunLike,
  options: {
    userId?: string;
    estimateSnapshot?: Record<string, unknown> | null;
    store?: SavedQuoteStore;
    mirror?: ScenarioMirror | null;
  } = {},
): Promise<void> {
  const userId = (options.userId ?? run.emailUserId ?? run.ownerUserId ?? "").trim();
  if (!userId) return;
  const quotes = topThreeSavedQuotes(run.quotes, run.ownerUserId === userId);
  if (!quotes.length) return;
  const completedAt = run.completedAt ?? new Date();
  try {
    await (options.store ?? await getDefaultStore()).saveCompleted({
      userId,
      addressNormalized: run.addressNormalized,
      policyType: run.policyType,
      leadId: run.leadId,
      quotes,
      completedAt,
      runStartedAt: run.triggeredAt,
      estimateSnapshot: options.estimateSnapshot,
    });
  } catch {
    console.error("[saved-quotes] result save failed");
    return;
  }
  const mirror = options.mirror === undefined ? mirrorToInsuranceScenario : options.mirror;
  if (!mirror) return;
  try {
    await mirror({
      userId, addressNormalized: run.addressNormalized, policyType: run.policyType,
      quote: quotes[0], leadId: run.leadId, completedAt,
    });
  } catch {
    console.error("[saved-quotes] scenario mirror failed");
  }
}

// ── Public response shape (no snapshots, no raw data) ───────────────────
export function publicSavedQuoteResult(row: UserInsuranceQuoteResult, now = new Date()) {
  const completedAt = row.completedAt ? new Date(row.completedAt) : null;
  return {
    addressNormalized: row.addressNormalized,
    policyType: row.policyType,
    leadId: row.leadId ?? null,
    completedAt: completedAt ? completedAt.toISOString() : null,
    stale: completedAt ? now.getTime() - completedAt.getTime() > SAVED_QUOTE_STALE_MS : false,
    bestCarrier: row.bestCarrier ?? null,
    bestAnnual: row.bestAnnual != null ? Number(row.bestAnnual) : null,
    quotes: topThreeSavedQuotes(row.quotes, true),
  };
}
export type PublicSavedQuoteResult = ReturnType<typeof publicSavedQuoteResult>;

export { getDefaultStore as getDefaultSavedQuoteStore };
