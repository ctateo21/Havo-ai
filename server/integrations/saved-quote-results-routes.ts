import type { Express } from "express";
import { z } from "zod";
import {
  getDefaultSavedQuoteStore,
  publicSavedQuoteResult,
  type SavedQuoteStore,
} from "./saved-quote-results";

type Dependencies = {
  optionalUser: (req: any) => Promise<{ id: string } | null>;
  normalizeAddress: (address: string) => string;
  store?: SavedQuoteStore;
  now?: () => Date;
};

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
      const rows = await store.listForUser(user.id, {
        ...(query.address ? { addressNormalized: deps.normalizeAddress(query.address) } : {}),
        ...(query.policyType ? { policyType: query.policyType } : {}),
      });
      const now = deps.now?.() ?? new Date();
      const results = rows
        // Defense in depth: never return another user's row.
        .filter(row => row.userId === user.id && row.completedAt)
        .map(row => publicSavedQuoteResult(row, now))
        .filter(row => row.quotes.length > 0)
        .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
      return res.json({ results });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("[my-quotes] read failed");
      return res.status(500).json({ error: "Saved quotes unavailable" });
    }
  });
}
