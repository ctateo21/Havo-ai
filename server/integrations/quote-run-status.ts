import { and, desc, eq, gte, or } from "drizzle-orm";
import { insuranceQuoteCache, type UserInsuranceQuoteResult } from "@shared/schema";
import {
  SAVED_QUOTE_STALE_MS,
  topThreeSavedQuotes,
} from "./saved-quote-results";

/** Server poll window (20 s × 36 polls = 12 min) plus grace for a slow
 * final poll, results save, or a deploy restart. A pending marker older than
 * this without a result is treated as needing agent follow-up. */
export const RUN_POLL_WINDOW_MS = 12 * 60_000;
export const RUN_STATUS_GRACE_MS = 3 * 60_000;
export const RUN_RUNNING_MAX_AGE_MS = RUN_POLL_WINDOW_MS + RUN_STATUS_GRACE_MS;
/** Older cache outcomes are not shown as this property's current status. */
export const RUN_OUTCOME_MAX_AGE_MS = SAVED_QUOTE_STALE_MS;

export type QuoteRunStatus = "running" | "completed" | "failed" | "agent_follow_up";

/** Minimal view of an insurance_quote_cache row that this user requested.
 * Never exposed directly: only status and timestamps leave the server. */
export interface OwnedCacheRun {
  id: number;
  addressNormalized: string;
  policyType: string;
  status: string;
  quotes: unknown;
  leadId: number | null;
  triggeredAt: Date;
  completedAt: Date | null;
  ownerUserId: string | null;
  emailUserId: string | null;
}

export interface DerivedRunStatus {
  status: QuoteRunStatus | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Set when a successful cache run for this user has no saved row yet. */
  backfill: OwnedCacheRun | null;
}

const time = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

function cacheOutcome(run: OwnedCacheRun): QuoteRunStatus | null {
  if (run.status === "success") {
    return topThreeSavedQuotes(run.quotes, false).length > 0 ? "completed" : "agent_follow_up";
  }
  if (run.status === "failed" || run.status === "error") return "failed";
  return null;
}

/**
 * Status for one user + property + policy type. Pure; the caller supplies
 * only rows that belong to this user.
 *  - running: a pending marker newer than the last completed result, still
 *    inside the poll window plus grace, with no terminal cache outcome yet.
 *  - completed: saved top 3 exists and no newer run is in flight or ended
 *    without quotes (or a successful cache run needs backfilling).
 *  - failed / agent_follow_up: the latest run ended without usable quotes,
 *    or its window expired with no result.
 */
export function deriveQuoteRunStatus(args: {
  saved: Pick<UserInsuranceQuoteResult, "quotes" | "completedAt" | "pendingStartedAt"> | null;
  cache: OwnedCacheRun | null;
  now: Date;
}): DerivedRunStatus {
  const now = args.now.getTime();
  const savedCompleted = time(args.saved?.completedAt);
  const savedHasQuotes = !!args.saved && topThreeSavedQuotes(args.saved.quotes, false).length > 0;
  const pending = time(args.saved?.pendingStartedAt);
  const cache = args.cache;
  const cacheTriggered = cache ? time(cache.triggeredAt) : null;
  const cacheCompleted = cache ? time(cache.completedAt) ?? cacheTriggered : null;
  const outcome = cache ? cacheOutcome(cache) : null;
  const needsBackfill = (_run: OwnedCacheRun) =>
    savedCompleted == null || (cacheCompleted != null && cacheCompleted > savedCompleted);

  const pendingActive = pending != null && (savedCompleted == null || pending > savedCompleted);
  if (pendingActive) {
    // A cache row triggered before this marker belongs to an older run.
    const runCache = cache && cacheTriggered != null && cacheTriggered >= pending ? cache : null;
    const runOutcome = runCache ? outcome : null;
    if (runOutcome === "completed") {
      return { status: "completed", startedAt: iso(pending), finishedAt: iso(cacheCompleted),
        backfill: needsBackfill(runCache!) ? runCache : null };
    }
    if (runOutcome) {
      return { status: runOutcome, startedAt: iso(pending), finishedAt: iso(cacheCompleted), backfill: null };
    }
    if (now - pending < RUN_RUNNING_MAX_AGE_MS) {
      return { status: "running", startedAt: iso(pending), finishedAt: null, backfill: null };
    }
    return { status: "agent_follow_up", startedAt: iso(pending), finishedAt: null, backfill: null };
  }

  // No marker in flight. A recent owned cache outcome newer than the saved
  // result (e.g. the worker cleared the marker on failure) decides.
  const recentCache = cache && cacheTriggered != null && now - cacheTriggered < RUN_OUTCOME_MAX_AGE_MS
    && (savedCompleted == null || (cacheCompleted ?? cacheTriggered) > savedCompleted) ? cache : null;
  if (recentCache && cache!.status === "pending" && now - cacheTriggered! < RUN_RUNNING_MAX_AGE_MS) {
    return { status: "running", startedAt: iso(cacheTriggered), finishedAt: null, backfill: null };
  }
  if (recentCache && outcome === "completed") {
    return { status: "completed", startedAt: iso(cacheTriggered), finishedAt: iso(cacheCompleted),
      backfill: needsBackfill(recentCache) ? recentCache : null };
  }
  if (recentCache && outcome) {
    return { status: outcome, startedAt: iso(cacheTriggered), finishedAt: iso(cacheCompleted), backfill: null };
  }
  if (savedHasQuotes) {
    return { status: "completed", startedAt: null, finishedAt: iso(savedCompleted), backfill: null };
  }
  return { status: null, startedAt: null, finishedAt: null, backfill: null };
}

/** Latest cache run per address + policy type, only rows this user requested. */
export function latestOwnedRuns(userId: string, rows: readonly OwnedCacheRun[]): Map<string, OwnedCacheRun> {
  const latest = new Map<string, OwnedCacheRun>();
  for (const row of rows) {
    if (row.ownerUserId !== userId && row.emailUserId !== userId) continue;
    const key = runKey(row.addressNormalized, row.policyType);
    const prior = latest.get(key);
    if (!prior || (time(row.triggeredAt) ?? 0) > (time(prior.triggeredAt) ?? 0)) latest.set(key, row);
  }
  return latest;
}

export const runKey = (addressNormalized: string, policyType: string) => `${addressNormalized}\u0000${policyType}`;

export type OwnedCacheRunReader = (
  userId: string,
  filter: { addressNormalized?: string; policyType?: string; since: Date },
) => Promise<OwnedCacheRun[]>;

/** Cache rows requested by this user (owner or results-email recipient). */
export const readOwnedCacheRuns: OwnedCacheRunReader = async (userId, filter) => {
  const { db } = await import("../db");
  const t = insuranceQuoteCache;
  const conditions = [
    or(eq(t.ownerUserId, userId), eq(t.emailUserId, userId))!,
    gte(t.triggeredAt, filter.since),
  ];
  if (filter.addressNormalized) conditions.push(eq(t.addressNormalized, filter.addressNormalized));
  if (filter.policyType) conditions.push(eq(t.policyType, filter.policyType));
  return db.select({
    id: t.id, addressNormalized: t.addressNormalized, policyType: t.policyType,
    status: t.status, quotes: t.quotes, leadId: t.leadId, triggeredAt: t.triggeredAt,
    completedAt: t.completedAt, ownerUserId: t.ownerUserId, emailUserId: t.emailUserId,
  }).from(t).where(and(...conditions)).orderBy(desc(t.triggeredAt)).limit(100);
};
