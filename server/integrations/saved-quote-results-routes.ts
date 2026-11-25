import type { Express } from "express";
import { z } from "zod";
import {
  getDefaultSavedQuoteStore,
  publicSavedQuoteResult,
  saveCompletedQuoteRun,
  type SavedQuoteStore,
  type ScenarioMirror,
} from "./saved-quote-results";
import {
  RUN_OUTCOME_MAX_AGE_MS,
  deriveQuoteRunStatus,
  latestOwnedRuns,
  readOwnedCacheRuns,
  runKey,
  type OwnedCacheRun,
  type OwnedCacheRunReader,
  type QuoteRunStatus,
} from "./quote-run-status";

type Dependencies = {
  optionalUser: (req: any) => Promise<{ id: string } | null>;
  normalizeAddress: (address: string) => string;
  store?: SavedQuoteStore;
  now?: () => Date;
  /** Reads insurance_quote_cache rows this user requested. */
  readCacheRuns?: OwnedCacheRunReader;
  /** Scenario mirror used when backfilling; null disables it (tests). */
  mirror?: ScenarioMirror | null;
};

export interface PublicQuoteRun {
  addressNormalized: string;
  policyType: string;
  status: QuoteRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

const MY_QUOTES_LIMIT = 30;
const MY_QUOTES_WINDOW_MS = 60_000;

export function registerSavedQuoteResultRoutes(app: Express, deps: Dependencies) {
  const hits = new Map<string, number[]>();
  const rateLimited = (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter(t => now - t < MY_QUOTES_WINDOW_MS);
    if (recent.length >= MY_QUOTES_LIMIT) { hits.set(key, recent); return true; }
    recent.push(now);
    hits.set(key, recent);
    return false;
  };

  /** The signed-in user's own saved live-carrier results. With `address`
   * returns that property's rows; without it lists all for the dashboard. */
  app.get("/api/insurance/my-quotes", async (req, res) => {
    try {
      const user = await deps.optionalUser(req);
      if (!user) return res.status(401).json({ error: "Sign in required" });
      if (rateLimited(user.id)) return res.status(429).json({ error: "Too many requests" });
      const query = z.object({
        address: z.string().trim().min(5).max(300).optional(),
        policyType: z.enum(["HO3", "HO6", "DP3"]).optional(),
      }).parse({
        address: typeof req.query.address === "string" && req.query.address.trim() ? req.query.address : undefined,
        policyType: typeof req.query.policyType === "string" && req.query.policyType ? req.query.policyType : undefined,
      });
      const store = deps.store ?? await getDefaultSavedQuoteStore();
      const filter = {
        ...(query.address ? { addressNormalized: deps.normalizeAddress(query.address) } : {}),
        ...(query.policyType ? { policyType: query.policyType } : {}),
      };
      const now = deps.now?.() ?? new Date();
      // Defense in depth: never use another user's row.
      let rows = (await store.listForUser(user.id, filter)).filter(row => row.userId === user.id);
      let cacheRuns = new Map<string, OwnedCacheRun>();
      try {
        const reader = deps.readCacheRuns ?? readOwnedCacheRuns;
        cacheRuns = latestOwnedRuns(user.id, await reader(user.id, {
          ...filter, since: new Date(now.getTime() - RUN_OUTCOME_MAX_AGE_MS),
        }));
      } catch {
        console.error("[my-quotes] run status read failed");
      }

      const keys = new Set<string>([
        ...rows.map(row => runKey(row.addressNormalized, row.policyType)),
        ...Array.from(cacheRuns.keys()),
      ]);
      const runs: PublicQuoteRun[] = [];
      let backfilled = false;
      for (const key of Array.from(keys)) {
        const saved = rows.find(row => runKey(row.addressNormalized, row.policyType) === key) ?? null;
        const cache = cacheRuns.get(key) ?? null;
        const derived = deriveQuoteRunStatus({ saved, cache, now });
        if (derived.backfill) {
          // A successful run this user requested that never reached the
          // saved table (e.g. the worker's save failed). Idempotent.
          await saveCompletedQuoteRun(derived.backfill, {
            userId: user.id, store,
            ...(deps.mirror !== undefined ? { mirror: deps.mirror } : {}),
          });
          backfilled = true;
        }
        if (!derived.status) continue;
        const [addressNormalized, policyType] = key.split("\u0000");
        runs.push({
          addressNormalized, policyType, status: derived.status,
          startedAt: derived.startedAt, finishedAt: derived.finishedAt,
        });
      }
      if (backfilled) {
        rows = (await store.listForUser(user.id, filter)).filter(row => row.userId === user.id);
      }
      const results = rows
        .filter(row => row.completedAt)
        .map(row => publicSavedQuoteResult(row, now))
        .filter(row => row.quotes.length > 0)
        .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
      return res.json({ results, runs });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("[my-quotes] read failed");
      return res.status(500).json({ error: "Saved quotes unavailable" });
    }
  });
}
