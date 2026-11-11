import type { RequestHandler } from "express";
import { supabaseAdmin } from "./supabase";

export function createAiAuthentication(verify?: (token: string) => Promise<string | null>): RequestHandler {
 return async (req, res, next) => {
  if (!verify) {
    res.status(503).json({ success: false, error: "Sign-in service unavailable. Try again later." });
    return;
  }
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) {
    res.status(401).json({ success: false, error: "Sign in before analyzing a document." });
    return;
  }
  try {
    const userId = await verify(match[1]);
    if (!userId) {
      res.status(401).json({ success: false, error: "Your session expired. Sign in again." });
      return;
    }
    // Stream middleware may invoke next from a different async context.
    res.locals.aiUserId = userId;
    next();
  } catch {
    res.status(503).json({ success: false, error: "Sign-in service unavailable. Try again later." });
  }
 };
}

export const authenticateAi = createAiAuthentication(supabaseAdmin ? async token => {
  const { data, error } = await supabaseAdmin!.auth.getUser(token);
  return error ? null : data.user?.id ?? null;
} : undefined);
