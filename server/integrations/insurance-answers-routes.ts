import type { Express } from "express";
import { z } from "zod";
import { normalizeQuoteAddress } from "@shared/quote-address";

/** Keys written only by the server (live-quote mirror). A client autosave can
 * never overwrite or remove them. */
export const SERVER_OWNED_ANSWER_PREFIX = "live_quote_";

const MAX_ANSWERS_BYTES = 64 * 1024;

/** Value columns an autosave may set on the user's own scenario row. */
const columnsSchema = z.object({
  annual_premium: z.number().finite().nonnegative().max(10_000_000).nullable().optional(),
  premium_source: z.enum(["manual", "quote", "default_0_75_percent", "property_value_sync"]).nullable().optional(),
  coverage_a: z.number().finite().nonnegative().max(50_000_000).nullable().optional(),
  coverage_a_source: z.enum(["manual", "property_value_sync", "default"]).nullable().optional(),
  coverage_type: z.string().max(120).nullable().optional(),
  policy_type: z.enum(["HO3", "HO6", "DP3"]).nullable().optional(),
  policy_type_source: z.enum(["manual", "default_rule"]).nullable().optional(),
  occupancy_type_source: z.enum(["manual", "default"]).nullable().optional(),
  property_type_source: z.enum(["manual", "default"]).nullable().optional(),
  aop_deductible_source: z.enum(["manual", "default"]).nullable().optional(),
  hurricane_deductible_source: z.enum(["manual", "default"]).nullable().optional(),
  flood_deductible_source: z.enum(["manual", "default"]).nullable().optional(),
  discounts_source: z.enum(["manual", "default"]).nullable().optional(),
}).strict();

export const answersMergeRequestSchema = z.object({
  id: z.string().trim().min(1).max(100),
  address: z.string().trim().min(5).max(300),
  normalizedPropertyKey: z.string().trim().max(300).optional(),
  savedAt: z.string().datetime().optional(),
  columns: columnsSchema.default({}),
  answers: z.record(z.string().regex(/^[A-Za-z0-9_]{1,80}$/), z.unknown())
    .refine(value => Object.keys(value).length <= 250, "Too many answers")
    .refine(value => JSON.stringify(value).length <= MAX_ANSWERS_BYTES, "Answers too large"),
});
export type AnswersMergeRequest = z.infer<typeof answersMergeRequestSchema>;

/** Shallow merge: incoming answers replace the same keys; every other key
 * (other sessions' fields, server-owned live_quote_* keys) is preserved. */
export function mergeAnswerSources(
  existing: unknown,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (key.startsWith(SERVER_OWNED_ANSWER_PREFIX)) continue;
    if (value === undefined) continue;
    base[key] = value;
  }
  return base;
}

export interface OwnScenarioRow {
  id: string;
  address: string | null;
  normalized_property_key: string | null;
  user_answer_sources: unknown;
}

/** Every operation is scoped to one user id. Implementations must add the
 * user_id filter to each query. */
export interface InsuranceScenarioAnswerStore {
  listOwn(userId: string): Promise<OwnScenarioRow[]>;
  updateOwn(userId: string, id: string, values: Record<string, unknown>): Promise<void>;
  insertOwn(userId: string, values: Record<string, unknown>): Promise<void>;
}

/** Picks the user's row for this property: same id, else same normalized
 * key, else same normalized address. */
export function findOwnScenario(rows: readonly OwnScenarioRow[], request: Pick<AnswersMergeRequest, "id" | "address" | "normalizedPropertyKey">) {
  const byId = rows.find(row => row.id === request.id);
  if (byId) return byId;
  const key = request.normalizedPropertyKey?.trim();
  if (key) {
    const byKey = rows.find(row => row.normalized_property_key === key);
    if (byKey) return byKey;
  }
  const address = normalizeQuoteAddress(request.address);
  return rows.find(row => typeof row.address === "string" && normalizeQuoteAddress(row.address) === address) ?? null;
}

export async function mergeOwnScenarioAnswers(
  store: InsuranceScenarioAnswerStore,
  userId: string,
  request: AnswersMergeRequest,
): Promise<{ id: string; userAnswerSources: Record<string, unknown>; created: boolean }> {
  const rows = await store.listOwn(userId);
  const match = findOwnScenario(rows, request);
  const savedAt = request.savedAt ?? new Date().toISOString();
  if (match) {
    const merged = mergeAnswerSources(match.user_answer_sources, request.answers);
    await store.updateOwn(userId, match.id, {
      ...request.columns,
      address: request.address,
      saved_at: savedAt,
      ...(request.normalizedPropertyKey ? { normalized_property_key: request.normalizedPropertyKey } : {}),
      user_answer_sources: merged,
    });
    return { id: match.id, userAnswerSources: merged, created: false };
  }
  const merged = mergeAnswerSources({}, request.answers);
  await store.insertOwn(userId, {
    id: request.id,
    address: request.address,
    saved_at: savedAt,
    normalized_property_key: request.normalizedPropertyKey || null,
    ...request.columns,
    user_answer_sources: merged,
  });
  return { id: request.id, userAnswerSources: merged, created: true };
}

const missingColumn = (message: string) =>
  /column "?([a-z_]+)"? (?:of relation "[^"]+" )?does not exist/i.exec(message)?.[1] ??
  /Could not find the '([a-z_]+)' column/i.exec(message)?.[1] ?? null;

/** Service-role store; every query is filtered by user_id. Drops optional
 * columns an older Supabase schema lacks rather than failing the save. */
export function createSupabaseScenarioAnswerStore(client: any): InsuranceScenarioAnswerStore {
  const write = async (run: (values: Record<string, unknown>) => Promise<{ error: any }>, values: Record<string, unknown>) => {
    const payload = { ...values };
    for (let attempt = 0; attempt < 12; attempt++) {
      const { error } = await run(payload);
      if (!error) return;
      const column = missingColumn(String(error.message ?? ""));
      if (column && column in payload && !["id", "user_id", "address", "user_answer_sources"].includes(column)) {
        delete payload[column];
        continue;
      }
      throw new Error("scenario write failed");
    }
    throw new Error("scenario write failed");
  };
  return {
    async listOwn(userId) {
      const { data, error } = await client.from("insurance_scenarios")
        .select("id,address,normalized_property_key,user_answer_sources")
        .eq("user_id", userId);
      if (error) throw new Error("scenario lookup failed");
      return (data ?? []) as OwnScenarioRow[];
    },
    async updateOwn(userId, id, values) {
      await write(payload => client.from("insurance_scenarios").update(payload)
        .eq("id", id).eq("user_id", userId), values);
    },
    async insertOwn(userId, values) {
      await write(payload => client.from("insurance_scenarios").insert({ ...payload, user_id: userId }), values);
    },
  };
}

export function registerInsuranceAnswerRoutes(app: Express, deps: {
  optionalUser: (req: any) => Promise<{ id: string } | null>;
  store?: InsuranceScenarioAnswerStore;
}) {
  const hits = new Map<string, number[]>();
  const rateLimited = (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= 240) { hits.set(key, recent); return true; }
    recent.push(now);
    hits.set(key, recent);
    return false;
  };

  /** Merge-saves the signed-in user's answers for one property. Never
   * deletes rows and never touches another user's row. */
  app.post("/api/insurance/scenario-answers", async (req, res) => {
    try {
      const user = await deps.optionalUser(req);
      if (!user) return res.status(401).json({ error: "Sign in required" });
      if (rateLimited(user.id)) return res.status(429).json({ error: "Too many requests" });
      const request = answersMergeRequestSchema.parse(req.body ?? {});
      let store = deps.store;
      if (!store) {
        const { supabaseAdmin } = await import("../supabase");
        if (!supabaseAdmin) return res.status(503).json({ error: "Saving is unavailable" });
        store = createSupabaseScenarioAnswerStore(supabaseAdmin);
      }
      const result = await mergeOwnScenarioAnswers(store, user.id, request);
      return res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid answers" });
      console.error("[scenario-answers] save failed");
      return res.status(500).json({ error: "Answers could not be saved" });
    }
  });
}
