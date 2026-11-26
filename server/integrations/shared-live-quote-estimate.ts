import type { Express } from "express";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { insuranceQuoteCache, userInsuranceQuoteResults } from "@shared/schema";
import { topThreeSavedQuotes } from "./saved-quote-results";

export {
  LIVE_QUOTE_REUSE_MAX_AGE_MS as SHARED_ESTIMATE_MAX_AGE_MS,
  normalizeOccupancy, runMatchesScenario, sharedEstimateRequest,
} from "@shared/live-quote-reuse";
export type { Occupancy, PolicyForm } from "@shared/live-quote-reuse";
import {
  LIVE_QUOTE_REUSE_MAX_AGE_MS as SHARED_ESTIMATE_MAX_AGE_MS,
  normalizeOccupancy, runMatchesScenario, sharedEstimateRequest,
  type Occupancy, type PolicyForm,
} from "@shared/live-quote-reuse";
export const SHARED_ESTIMATE_SOURCE = "recent_live_quote" as const;

/** One completed run's lowest premium. Server-only: occupancy never leaves. */
export interface SharedQuoteCandidate {
  annual: number;
  completedAt: Date;
  policyType: string;
  /** Occupancy the run was quoted for, from the estimate snapshot or the
   * agency-default usageType. Null when unknown. */
  occupancy: Occupancy | null;
}

export interface SharedEstimate {
  annual: number;
  monthly: number;
  quotedDate: string;
  source: typeof SHARED_ESTIMATE_SOURCE;
}

/** Lowest annual premium among matching runs within 90 days; number and
 * date only. Ties go to the most recent quote. */
export function selectSharedEstimate(
  candidates: readonly SharedQuoteCandidate[],
  request: { policyType: PolicyForm; occupancy: Occupancy | null },
  now: Date,
): SharedEstimate | null {
  const fresh = candidates.filter(c =>
    Number.isFinite(c.annual) && c.annual > 0 &&
    now.getTime() - c.completedAt.getTime() <= SHARED_ESTIMATE_MAX_AGE_MS &&
    c.completedAt.getTime() <= now.getTime() + 60_000 &&
    runMatchesScenario(c, request));
  if (!fresh.length) return null;
  const best = fresh.reduce((a, b) =>
    b.annual < a.annual || (b.annual === a.annual && b.completedAt > a.completedAt) ? b : a);
  const annual = Math.round(best.annual * 100) / 100;
  return {
    annual,
    monthly: Math.round((annual / 12) * 100) / 100,
    quotedDate: best.completedAt.toISOString(),
    source: SHARED_ESTIMATE_SOURCE,
  };
}

export type SharedCandidateReader = (
  addressNormalized: string,
  policyType: PolicyForm,
  since: Date,
) => Promise<SharedQuoteCandidate[]>;

/** Completed runs for this address from every user's saved results and the
 * address cache. Reads only premiums, dates, and occupancy. */
export const readSharedCandidates: SharedCandidateReader = async (addressNormalized, policyType, since) => {
  const { db } = await import("../db");
  const saved = userInsuranceQuoteResults;
  const cache = insuranceQuoteCache;
  const [savedRows, cacheRows] = await Promise.all([
    db.select({
      quotes: saved.quotes, completedAt: saved.completedAt, snapshot: saved.estimateSnapshot,
    }).from(saved).where(and(
      eq(saved.addressNormalized, addressNormalized), eq(saved.policyType, policyType),
      gte(saved.completedAt, since),
    )).limit(200),
    db.select({
      quotes: cache.quotes, completedAt: cache.completedAt, defaults: cache.agencyDefaultSnapshot,
    }).from(cache).where(and(
      eq(cache.addressNormalized, addressNormalized), eq(cache.policyType, policyType),
      eq(cache.status, "success"), gte(cache.completedAt, since),
    )).limit(50),
  ]);
  const lowest = (quotes: unknown) => topThreeSavedQuotes(quotes, false)[0]?.annualPremium;
  const out: SharedQuoteCandidate[] = [];
  for (const row of savedRows) {
    const annual = lowest(row.quotes);
    if (annual && row.completedAt) out.push({
      annual, completedAt: new Date(row.completedAt), policyType,
      occupancy: normalizeOccupancy((row.snapshot as Record<string, unknown> | null)?.occupancy),
    });
  }
  for (const row of cacheRows) {
    const annual = lowest(row.quotes);
    if (annual && row.completedAt) out.push({
      annual, completedAt: new Date(row.completedAt), policyType,
      occupancy: normalizeOccupancy((row.defaults as Record<string, unknown> | null)?.usageType),
    });
  }
  return out;
};

const LIMIT = 60;
const WINDOW_MS = 60_000;

export function registerSharedLiveQuoteEstimateRoute(app: Express, deps: {
  normalizeAddress: (address: string) => string;
  readCandidates?: SharedCandidateReader;
  now?: () => Date;
  clientKey?: (req: any) => string;
}) {
  const hits = new Map<string, number[]>();
  const rateLimited = (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter(t => now - t < WINDOW_MS);
    if (recent.length >= LIMIT) { hits.set(key, recent); return true; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5_000) {
      for (const [k, times] of Array.from(hits.entries())) {
        if (!times.some(t => now - t < WINDOW_MS)) hits.delete(k);
      }
    }
    return false;
  };

  /** Recent lowest live premium for an address + policy form + occupancy.
   * Open to guests; returns only {annual, monthly, quotedDate, source}. */
  app.get("/api/insurance/shared-estimate", async (req, res) => {
    try {
      const key = deps.clientKey?.(req) ?? String(req.ip ?? "unknown");
      if (rateLimited(key)) return res.status(429).json({ error: "Too many requests" });
      const query = z.object({
        address: z.string().trim().min(5).max(300),
        policyType: z.enum(["HO3", "HO6", "DP3"]),
        occupancy: z.enum(["primary", "secondary", "investment"]).optional(),
      }).parse({
        address: req.query.address,
        policyType: req.query.policyType,
        occupancy: typeof req.query.occupancy === "string" && req.query.occupancy ? req.query.occupancy : undefined,
      });
      const now = deps.now?.() ?? new Date();
      const request = sharedEstimateRequest(query.policyType, query.occupancy ?? null);
      const candidates = await (deps.readCandidates ?? readSharedCandidates)(
        deps.normalizeAddress(query.address), request.policyType,
        new Date(now.getTime() - SHARED_ESTIMATE_MAX_AGE_MS),
      );
      const estimate = selectSharedEstimate(candidates, request, now);
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.json({ estimate });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("[shared-estimate] read failed");
      return res.status(500).json({ error: "Estimate unavailable" });
    }
  });
}
