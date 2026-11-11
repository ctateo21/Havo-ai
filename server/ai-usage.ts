import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Response } from "express";

const users = new AsyncLocalStorage<string>();
export const withAiUser = <T>(userId: string, fn: () => T): T => users.run(userId, fn);

export class AiLimitError extends Error {
  constructor(public code: string, message: string, public retryAfter = 60, public status = 429) {
    super(message);
  }
}

export function sendAiLimitError(res: Response, error: unknown): boolean {
  if (!(error instanceof AiLimitError)) return false;
  res.setHeader("Retry-After", String(error.retryAfter));
  res.status(error.status).json({ success: false, code: error.code, error: error.message, retryAfter: error.retryAfter });
  return true;
}

export type Usage = { promptTokens: number; completionTokens: number; cost: number | null };
export type Reservation = { id: string; userId: string; day: string };

// Deliberately fixed, conservative ceilings. Changes require an explicit code review.
export const AI_LIMITS = { userDaily: 20, globalDaily: 500, userConcurrent: 2, globalConcurrent: 10 };

export const aiUsageStore = {
  async reserve(userId: string, purpose: string): Promise<Reservation> {
    const { pool } = await import("./db");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize admission across processes without holding a connection during inference.
      await client.query("SELECT pg_advisory_xact_lock(740013)");
      const { rows: [clock] } = await client.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day, extract(epoch FROM (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day' - (now() AT TIME ZONE 'UTC')))::int AS retry");
      await client.query("DELETE FROM ai_usage_leases WHERE expires_at <= now()");
      const { rows: [counts] } = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE user_id=$1)::int AS own FROM ai_usage_leases", [userId]);
      if (counts.own >= AI_LIMITS.userConcurrent || counts.total >= AI_LIMITS.globalConcurrent) {
        throw new AiLimitError("AI_BUSY", "Too many AI analyses are running. Wait three minutes before trying again.", 180);
      }
      const { rows: [daily] } = await client.query(
        "SELECT coalesce(sum(attempts),0)::int AS total, coalesce(sum(attempts) FILTER (WHERE user_id=$1),0)::int AS own FROM ai_usage_daily WHERE day=$2", [userId, clock.day]);
      if (daily.own >= AI_LIMITS.userDaily || daily.total >= AI_LIMITS.globalDaily) {
        throw new AiLimitError("AI_DAILY_LIMIT", "The daily AI allowance has been reached. Try after midnight UTC; saved seller recaps remain available.", Math.max(1, clock.retry));
      }
      const id = randomUUID();
      await client.query("INSERT INTO ai_usage_daily (user_id,day,purpose,attempts,unknown_cost_attempts) VALUES ($1,$2,$3,1,1) ON CONFLICT (user_id,day,purpose) DO UPDATE SET attempts=ai_usage_daily.attempts+1, unknown_cost_attempts=ai_usage_daily.unknown_cost_attempts+1", [userId, clock.day, purpose]);
      await client.query("INSERT INTO ai_usage_leases (id,user_id,expires_at) VALUES ($1,$2,now()+interval '3 minutes')", [id, userId]);
      await client.query("COMMIT");
      return { id, userId, day: clock.day };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
  async finish(reservation: Reservation, purpose: string, usage: Usage | null, success: boolean) {
    const { pool } = await import("./db");
    // Keep the lease on accounting failure. It expires safely; attempts are never refunded.
    await pool.query(`UPDATE ai_usage_daily SET
      successes=successes+$4, prompt_tokens=prompt_tokens+$5,
      completion_tokens=completion_tokens+$6, reported_cost_usd=reported_cost_usd+$7,
      unknown_cost_attempts=unknown_cost_attempts+$8
      WHERE user_id=$1 AND day=$2 AND purpose=$3`,
    [reservation.userId, reservation.day, purpose, success ? 1 : 0,
      usage?.promptTokens ?? 0, usage?.completionTokens ?? 0, usage?.cost ?? 0,
      usage?.cost == null ? 0 : -1]);
    await pool.query("DELETE FROM ai_usage_leases WHERE id=$1", [reservation.id]);
  },
};

export async function reserveAi(purpose: string) {
  const userId = users.getStore();
  if (!userId) throw new AiLimitError("AI_AUTH_REQUIRED", "Sign in again before requesting an AI analysis.", 0, 401);
  try { return await aiUsageStore.reserve(userId, purpose); }
  catch (error) {
    if (error instanceof AiLimitError) throw error;
    throw new AiLimitError("AI_ACCOUNTING_UNAVAILABLE", "AI usage accounting is unavailable. Contact support or try again later; no AI request was sent.", 60, 503);
  }
}

export function parseUsage(value: any): Usage {
  const tokens = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  return {
    promptTokens: tokens(value?.prompt_tokens),
    completionTokens: tokens(value?.completion_tokens),
    cost: typeof value?.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : null,
  };
}
