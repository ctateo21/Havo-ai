// Weekly Market Analysis scheduler + fast-read display path.
//
// Two responsibilities:
//   1. `getMarketAnalysisForDisplay(input)` — fast read used by the seller UI.
//      Returns the saved current-cycle analysis instantly from Supabase. When
//      stale/missing/insufficient, queues a background generation and returns
//      the prior saved analysis (or a "generating" stub). The HTTP request
//      NEVER waits on the Anthropic call.
//   2. `startMarketAnalysisScheduler()` — fires once per Friday-8AM-ET cycle
//      to precompute analyses for every saved seller scenario, so the very
//      first user open of the week is already warm.
//
// In-memory locks (`inflight`) prevent duplicate Anthropic calls for the
// same (listingId, weekOf) across concurrent requests and the scheduler.
import { supabaseAdmin } from "../supabase";
import {
  getOrGenerateMarketAnalysis,
  currentWeekWindow,
  type ListingInput,
  type MarketAnalysisRecord,
  type StructuredAnalysis,
} from "./listing-market-analysis";
import { enrichListingFromPropertyCache } from "./listing-enrichment";

// ── In-memory dedupe lock ────────────────────────────────────────────────
const inflight = new Map<string, Promise<MarketAnalysisRecord>>();
// Suppress polling-driven retries after failed/weak generations. This is not
// the authoritative usage limit (the database enforces that across instances).
const cooldowns = new Map<string, { until: number; record: MarketAnalysisRecord }>();

function lockKey(listingId: string, weekOfStr: string) {
  return `${listingId}::${weekOfStr}`;
}

export function isGenerating(listingId: string, weekOfStr?: string): boolean {
  if (weekOfStr) return inflight.has(lockKey(listingId, weekOfStr));
  for (const k of Array.from(inflight.keys())) if (k.startsWith(listingId + "::")) return true;
  return false;
}

/**
 * Single-flight wrapper around `getOrGenerateMarketAnalysis`. Concurrent
 * callers for the same (listingId, weekOf) share one Anthropic call.
 */
export function ensureMarketAnalysis(
  input: ListingInput,
  opts: { forceRefresh?: boolean } = {},
): Promise<MarketAnalysisRecord> {
  const cur = currentWeekWindow();
  const key = lockKey(input.listingId, cur.weekOfStr);
  const cooldown = cooldowns.get(key);
  if (cooldown && cooldown.until > Date.now()) return Promise.resolve(cooldown.record);
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    try {
      const record = await getOrGenerateMarketAnalysis(input, opts);
      if (record.error_message || !isRichEnoughLite(record.structured)) {
        for (const [k, v] of cooldowns) if (v.until <= Date.now()) cooldowns.delete(k);
        if (cooldowns.size >= 5000) cooldowns.delete(cooldowns.keys().next().value!);
        cooldowns.set(key, { until: Date.now() + 15 * 60_000, record });
      }
      return record;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

// Lightweight rich-enough check (mirror of the one in listing-market-analysis,
// kept local so we don't have to export the internal helper).
function isRichEnoughLite(s: StructuredAnalysis | null | undefined): boolean {
  if (!s) return false;
  if ((s as any).status_label === "Insufficient Data") return false;
  if (!s.market_comps?.comps?.length) return false;
  if (s.projected_sale_price?.projected_low == null) return false;
  if (s.projected_sale_price?.projected_high == null) return false;
  return true;
}

export interface DisplayResult {
  analysis: MarketAnalysisRecord | null;
  generating: boolean;
  source: "current_cache" | "previous_pending_refresh" | "generating_first_run";
}

/**
 * Fast-read entrypoint for the seller UI. Never blocks on Anthropic.
 */
export async function getMarketAnalysisForDisplay(
  input: ListingInput,
): Promise<DisplayResult> {
  if (!supabaseAdmin) throw new Error("Supabase admin client is not configured");
  const cur = currentWeekWindow();

  const { data: rows, error } = await supabaseAdmin
    .from("listing_market_analyses")
    .select("*")
    .eq("listing_id", input.listingId)
    .eq("user_id", input.userId)
    .order("analysis_week_of", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Failed to read listing_market_analyses: ${error.message}`);

  const prior = rows?.[0] as (MarketAnalysisRecord & { raw_anthropic_response?: string | null }) | undefined;
  let priorStructured: StructuredAnalysis | null = null;
  if (prior?.raw_anthropic_response) {
    try { priorStructured = JSON.parse(prior.raw_anthropic_response) as StructuredAnalysis; } catch { /* ignore */ }
  }

  const isCurrentCycle =
    !!prior &&
    prior.analysis_week_of === cur.weekOfStr &&
    new Date(prior.next_update_due_at).getTime() > Date.now();
  const rich = isRichEnoughLite(priorStructured);

  // Happy path: serve saved current-cycle rich analysis instantly.
  if (prior && isCurrentCycle && rich && prior.status === "published") {
    return {
      analysis: { ...prior, structured: priorStructured },
      generating: false,
      source: "current_cache",
    };
  }

  const cooldown = cooldowns.get(lockKey(input.listingId, cur.weekOfStr));
  if (cooldown && cooldown.until > Date.now()) {
    return { analysis: cooldown.record, generating: false, source: "current_cache" };
  }

  // Need to generate. Queue background work (single-flight), return fast.
  const alreadyRunning = isGenerating(input.listingId, cur.weekOfStr);
  if (!alreadyRunning) {
    // Fire-and-forget — never blocks the response.
    void ensureMarketAnalysis(input).catch((e) =>
      console.warn("[market-analysis-display] background generation failed:", e?.message),
    );
  } else {
  }

  if (prior && rich) {
    // Show the prior week's saved analysis while the new one cooks.
    return {
      analysis: {
        ...prior,
        structured: priorStructured,
        error_message: prior.error_message ?? "This week's update is being prepared.",
      },
      generating: true,
      source: "previous_pending_refresh",
    };
  }

  // No usable prior — return a transient "generating" stub. Not persisted
  // to Supabase; once generation completes the real row appears.
  const stub: MarketAnalysisRecord = {
    id: `pending_${input.listingId}_${cur.weekOfStr}`,
    listing_id: input.listingId,
    user_id: input.userId,
    property_address: input.address,
    analysis_week_of: cur.weekOfStr,
    generated_at: null as any,
    next_update_due_at: cur.nextUpdateDueAt.toISOString(),
    status: "generating",
    market_summary: null,
    pricing_analysis: null,
    comps_summary: null,
    online_interest_summary: null,
    showing_summary: null,
    recommended_next_steps: null,
    risk_flags: null,
    price_review_recommended: null,
    confidence_level: null,
    data_limitations: null,
    raw_prompt: null,
    error_message: "This week's market analysis is being prepared.",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    structured: priorStructured,
  } as unknown as MarketAnalysisRecord;
  return { analysis: stub, generating: true, source: "generating_first_run" };
}

// ── Weekly precompute job ────────────────────────────────────────────────

let lastJobRunForCycle: string | null = null;

export async function precomputeWeeklyMarketAnalysesForAllSellerScenarios(): Promise<{
  processed: number; generated: number; skipped: number; errors: number;
}> {
  if (!supabaseAdmin) throw new Error("Supabase admin client is not configured");
  const cur = currentWeekWindow();

  // Spec: weekly job processes ONLY scenarios that are actually being
  // marketed. Draft/blank/sold scenarios are skipped entirely so we
  // never spend Anthropic/Realtor.com calls on inactive listings.
  const { data: scenarios, error } = await supabaseAdmin
    .from("seller_scenarios")
    .select("id, user_id, full_address, normalized_property_key, estimated_sale_price, mortgage_payoff, seller_closing_costs, realtor_commission, net_proceeds, status, primary_photo_url, property_photos, updated_at")
    .in("status", ["ready_to_list", "listed"]);
  if (error) {
    console.warn("[market-analysis-weekly] failed to fetch seller_scenarios:", error.message);
    throw error;
  }
  const rows = scenarios || [];

  let generated = 0, skipped = 0, errors = 0;
  for (const row of rows as any[]) {
    try {
      // Defense-in-depth: the `.in("status", ...)` filter above
      // should make this unreachable, but if a Draft row slips
      // through (e.g. concurrent status change mid-job) we still
      // skip it and emit the debug log the spec requires.
      if (row.status !== "ready_to_list" && row.status !== "listed") {
        skipped++;
        continue;
      }

      // Check existing first to avoid unneeded enrichment work.
      const { data: existingRows } = await supabaseAdmin
        .from("listing_market_analyses")
        .select("id, analysis_week_of, next_update_due_at, status, raw_anthropic_response")
        .eq("listing_id", row.id)
        .eq("user_id", row.user_id)
        .order("analysis_week_of", { ascending: false })
        .limit(1);
      const existing = existingRows?.[0] as any;
      let existingStructured: StructuredAnalysis | null = null;
      if (existing?.raw_anthropic_response) {
        try { existingStructured = JSON.parse(existing.raw_anthropic_response); } catch { /* ignore */ }
      }
      const isCurrent =
        existing &&
        existing.analysis_week_of === cur.weekOfStr &&
        new Date(existing.next_update_due_at).getTime() > Date.now();
      const rich = isRichEnoughLite(existingStructured);

      if (existing && isCurrent && rich && existing.status === "published") {
        skipped++;
        continue;
      }
      if (isGenerating(row.id, cur.weekOfStr)) {
        skipped++;
        continue;
      }

      const baseInput: ListingInput = {
        listingId: row.id,
        userId: row.user_id,
        address: row.full_address,
        normalizedPropertyKey: row.normalized_property_key ?? null,
        listPrice: row.estimated_sale_price ?? null,
        estimatedSalePrice: row.estimated_sale_price ?? null,
        mortgagePayoff: row.mortgage_payoff ?? null,
        sellerClosingCosts: row.seller_closing_costs ?? null,
        realtorCommissionPct: row.realtor_commission ?? null,
        netProceeds: row.net_proceeds ?? null,
        primaryPhotoUrl: row.primary_photo_url ?? null,
        photoCount: Array.isArray(row.property_photos) ? row.property_photos.length : null,
        status: row.status ?? null,
        scenarioUpdatedAt: row.updated_at ?? null,
      };
      const input = await enrichListingFromPropertyCache(baseInput);

      await ensureMarketAnalysis(input);
      generated++;
    } catch (e: any) {
      console.warn("[market-analysis-weekly] failed for scenario", { id: (row as any)?.id, error: e?.message });
      errors++;
    }
  }
  return { processed: rows.length, generated, skipped, errors };
}

/**
 * Lightweight Friday-8AM-ET scheduler. Checks every 5 minutes; runs the
 * precompute job exactly once per weekly cycle. Also fires a deferred
 * first tick after boot to catch a missed Friday (e.g. deploy on Saturday
 * with no analyses for the current cycle).
 */
export function startMarketAnalysisScheduler(): void {
  if (!supabaseAdmin) {
    return;
  }
  const tick = async () => {
    const cur = currentWeekWindow();
    if (lastJobRunForCycle === cur.weekOfStr) return;
    try {
      const result = await precomputeWeeklyMarketAnalysesForAllSellerScenarios();
      // Only mark this cycle "done" if every scenario succeeded. If any
      // failed, leave the marker unset so the next 5-min interval retries
      // them (the inflight lock + rich-enough skip make retries cheap —
      // already-successful listings short-circuit immediately).
      if (result.errors === 0) {
        lastJobRunForCycle = cur.weekOfStr;
      } else {
        console.warn("[market-analysis-weekly] cycle had errors, will retry next tick", { errors: result.errors });
      }
    } catch (e: any) {
      console.warn("[market-analysis-weekly] scheduler tick failed:", e?.message);
    }
  };
  setTimeout(() => { void tick(); }, 15_000);
  setInterval(() => { void tick(); }, 5 * 60 * 1000);
}
