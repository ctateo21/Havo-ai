import { and, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  userInsuranceQuoteResults,
  type SavedInsuranceQuote,
  type UserInsuranceQuoteResult,
} from "@shared/schema";
import { normalizeQuoteAddress } from "@shared/quote-address";
import { assumeWindAttachments } from "@shared/wind-mitigation";

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

type WindSource = "report" | "user" | "assumed";
export interface WindFactSnapshot { value: string | boolean | null; userProvided: boolean; source: WindSource }

/** Wind-mitigation inputs with provenance. Values only: never report
 * references, upload ids, inspector names, or inspection dates. */
export function windMitigationSnapshot(
  request: Record<string, any>,
  county: string | null,
): Record<"roofCovering" | "roofDeck" | "roofToWall" | "roofShape" | "secondaryWaterResistance" | "openingProtection", WindFactSnapshot> {
  const answers = request.windAnswers && typeof request.windAnswers === "object" ? request.windAnswers : {};
  const report = answers.reportAvailable === true && answers.report && typeof answers.report === "object"
    ? answers.report as Record<string, any> : null;
  const reportAssumed: string[] = Array.isArray(report?.assumedFields) ? report!.assumedFields : [];
  const locks = request.windMitigationLocks && typeof request.windMitigationLocks === "object"
    ? request.windMitigationLocks : {};
  const yearBuilt = Number(request.yearBuilt), roofYear = Number(request.roofYear);
  const assumed = assumeWindAttachments(county ?? "", yearBuilt, roofYear);
  const fact = (value: unknown, source: WindSource): WindFactSnapshot => ({
    value: typeof value === "string" || typeof value === "boolean" ? value : null,
    userProvided: source !== "assumed",
    source,
  });
  const fromReport = (key: string, reportValue: unknown) =>
    report && reportValue !== undefined
      ? fact(reportValue, reportAssumed.includes(key) ? "assumed" : "report")
      : null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    roofCovering: fromReport("roofCovering", report?.productApproval ?? report?.roofCovering) ??
      (str(answers.roofCovering) ? fact(answers.roofCovering, "user") : fact(str(request.roofCovering) ?? null, "assumed")),
    roofDeck: fromReport("roofDeck", report?.roofDeck) ??
      (str(answers.roofDeck) ? fact(answers.roofDeck, "user") : fact(assumed.roofDeck, "assumed")),
    roofToWall: fromReport("roofToWall", report?.roofToWall) ??
      (str(answers.roofToWall) ? fact(answers.roofToWall, "user") : fact(assumed.roofToWall, "assumed")),
    roofShape: fromReport("shape", report?.shape) ??
      ((request.roofShapeUserSet === true || (str(answers.shape) && answers.shape !== "Not sure"))
        ? fact(str(request.roofShape) ?? answers.shape, "user")
        : fact(str(request.roofShape) ?? null, "assumed")),
    secondaryWaterResistance: fromReport("swr", report?.swr) ??
      ((locks.secondaryWaterResistance === true || (str(answers.peelAndStick) && answers.peelAndStick !== "unsure"))
        ? fact(str(request.secondaryWaterResistance) ?? null, "user")
        : fact(str(request.secondaryWaterResistance) ?? null, "assumed")),
    openingProtection: fromReport("opening", report?.opening) ??
      ((locks.openingProtection === true || answers.openingsConfirmed === true)
        ? fact(typeof request.openingProtection === "boolean" ? request.openingProtection : null, "user")
        : fact(typeof request.openingProtection === "boolean" ? request.openingProtection : null, "assumed")),
  };
}

const CONSTRUCTION = ["Masonry", "Mixed", "Frame"];
const HURRICANE = ["2%", "5%", "10%"];

/** Explicit allowlist. Every value is a property/estimate fact; nothing from
 * the request's identity, contact, address, claims, or prior-carrier fields. */
export function buildEstimateSnapshot(
  request: Record<string, any>,
  estimate: EstimateInput | null,
  extra: { usageType?: string; county?: string | null } = {},
): Record<string, unknown> {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const county = str(extra.county) ?? estimate?.county ?? null;
  return {
    version: ESTIMATE_SNAPSHOT_VERSION,
    modelVersion: estimate?.modelVersion ?? null,
    annual: estimate?.annual ?? null,
    monthly: estimate?.monthly ?? (estimate ? Math.round((estimate.annual / 12) * 100) / 100 : null),
    county,
    policyType: str(request.policyType),
    coverageA: num(request.coverageA),
    yearBuilt: num(request.yearBuilt),
    roofYear: num(request.roofYear),
    sqFt: num(request.sqFt),
    construction: typeof request.constIdx === "number" ? CONSTRUCTION[request.constIdx] ?? null : null,
    roofMaterial: str(request.roofMaterial),
    windMitigationReport: request.windAnswers?.reportAvailable === true,
    windMitigation: windMitigationSnapshot(request, county),
    hurricaneDeductible: typeof request.hurrIdx === "number" ? HURRICANE[request.hurrIdx] ?? null : null,
    aopDeductible: num(request.aopDeductible),
    floodZone: str(request.floodZone),
    floodZoneUnknown: request.floodZoneUnknown === true,
    newPurchase: typeof request.newPurchase === "boolean" ? request.newPurchase : null,
    occupancy: str(extra.usageType) ?? str(request.usageType),
    rentalTerm: str(request.rentalTerm),
  };
}

// ── Estimate vs. lowest quote (data capture only) ───────────────────────
export interface QuoteDelta {
  estimateAnnual: number | null;
  lowestAnnual: number | null;
  quoteDelta: number | null;
  quoteDeltaPct: number | null;
}

/** delta = lowest - estimate; pct = delta / estimate, null when the
 * estimate is missing or zero. Rounded to cents / 4 decimal places. */
export function computeQuoteDelta(estimateAnnual: unknown, lowestAnnual: unknown): QuoteDelta {
  const valid = (v: unknown) => {
    const n = typeof v === "string" && v.trim() ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  const estimate = valid(estimateAnnual);
  const lowest = valid(lowestAnnual);
  const usable = estimate != null && estimate > 0 ? estimate : null;
  const delta = usable != null && lowest != null ? Math.round((lowest - usable) * 100) / 100 : null;
  return {
    estimateAnnual: estimate,
    lowestAnnual: lowest,
    quoteDelta: delta,
    quoteDeltaPct: delta != null && usable != null ? Math.round((delta / usable) * 10_000) / 10_000 : null,
  };
}

/** Which estimate snapshot a completed run keeps: the run's own, else the
 * pending one started by this run (or earlier), else the existing one. */
export function resolveCompletedSnapshot(
  existing: Pick<UserInsuranceQuoteResult, "estimateSnapshot" | "pendingEstimateSnapshot" | "pendingStartedAt"> | null,
  direct: Record<string, unknown> | null | undefined,
  runStartedAt: Date,
): { snapshot: Record<string, unknown> | null; consumedPending: boolean } {
  const pendingBelongs = !!existing?.pendingStartedAt &&
    new Date(existing.pendingStartedAt).getTime() <= runStartedAt.getTime();
  if (direct) return { snapshot: direct, consumedPending: pendingBelongs };
  if (pendingBelongs && existing?.pendingEstimateSnapshot) {
    return { snapshot: existing.pendingEstimateSnapshot as Record<string, unknown>, consumedPending: true };
  }
  return { snapshot: (existing?.estimateSnapshot as Record<string, unknown> | null) ?? null, consumedPending: pendingBelongs };
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
  /** Clears the in-flight marker of a run that ended without usable quotes.
   * Only markers started at or before that run are cleared, so a newer run
   * started meanwhile keeps showing as running. */
  clearPending?(args: {
    userId: string; addressNormalized: string; policyType: string; startedAtOrBefore: Date;
  }): Promise<void>;
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
      const key = and(eq(t.userId, userId), eq(t.addressNormalized, addressNormalized), eq(t.policyType, policyType));
      await db.transaction(async (tx: any) => {
        const [existing] = await tx.select().from(t).where(key).for("update");
        // A late-finishing older run never replaces newer completed results.
        if (existing?.completedAt && new Date(existing.completedAt).getTime() > completedAt.getTime()) return;
        const { snapshot, consumedPending } = resolveCompletedSnapshot(existing ?? null, estimateSnapshot, runStartedAt);
        const delta = computeQuoteDelta(snapshot?.annual, best.annualPremium);
        const values = {
          leadId, quotes,
          bestCarrier: best.siteName,
          bestAnnual: String(best.annualPremium),
          completedAt,
          estimateSnapshot: snapshot,
          estimateAnnual: delta.estimateAnnual != null ? String(delta.estimateAnnual) : null,
          lowestAnnual: delta.lowestAnnual != null ? String(delta.lowestAnnual) : null,
          quoteDelta: delta.quoteDelta != null ? String(delta.quoteDelta) : null,
          quoteDeltaPct: delta.quoteDeltaPct != null ? String(delta.quoteDeltaPct) : null,
          ...(consumedPending ? { pendingEstimateSnapshot: null, pendingStartedAt: null } : {}),
          updatedAt: new Date(),
        };
        await tx.insert(t).values({ userId, addressNormalized, policyType, ...values })
          .onConflictDoUpdate({
            target: [t.userId, t.addressNormalized, t.policyType],
            set: values,
            setWhere: sql`${t.completedAt} is null or ${t.completedAt} <= ${completedAt}`,
          });
      });
    },
    async listForUser(userId, filter = {}) {
      const conditions = [eq(t.userId, userId)];
      if (filter.addressNormalized) conditions.push(eq(t.addressNormalized, filter.addressNormalized));
      if (filter.policyType) conditions.push(eq(t.policyType, filter.policyType));
      return db.select().from(t).where(and(...conditions)).limit(200);
    },
    async clearPending({ userId, addressNormalized, policyType, startedAtOrBefore }) {
      await db.update(t)
        .set({ pendingEstimateSnapshot: null, pendingStartedAt: null, updatedAt: new Date() })
        .where(and(
          eq(t.userId, userId), eq(t.addressNormalized, addressNormalized), eq(t.policyType, policyType),
          lte(t.pendingStartedAt, startedAtOrBefore),
        ));
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

/** Clears the requester's pending marker for a run that ended without usable
 * quotes, so the account shows the agent follow-up message instead of a
 * spinner. Best effort; never throws. */
export async function clearPendingQuoteRun(
  run: Pick<CompletedRunLike, "emailUserId" | "ownerUserId" | "addressNormalized" | "policyType" | "triggeredAt">,
  store?: SavedQuoteStore,
): Promise<void> {
  const userIds = Array.from(new Set([run.emailUserId, run.ownerUserId]
    .map(id => (id ?? "").trim()).filter(Boolean)));
  if (!userIds.length) return;
  try {
    const target = store ?? await getDefaultStore();
    if (!target.clearPending) return;
    for (const userId of userIds) {
      await target.clearPending({
        userId, addressNormalized: run.addressNormalized, policyType: run.policyType,
        startedAtOrBefore: run.triggeredAt,
      });
    }
  } catch {
    console.error("[saved-quotes] pending marker clear failed");
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
