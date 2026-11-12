import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "./supabase";
import { interestEventSchema, interestSignupSchema, signupRecord } from "./b2b-interest-schema";
import { deliverInterest } from "./integrations/b2b-interest-delivery";
import { LEADERBOARD_TEAM } from "./integrations/fub-leaderboard";

export async function requireInterestAdmin(req: Request, res: Response): Promise<boolean> {
  res.setHeader("Cache-Control", "no-store");
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!token) { res.status(401).json({ error: "Sign in to view results." }); return false; }
  if (!supabaseAdmin) { res.status(503).json({ error: "Database unavailable." }); return false; }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user?.email) { res.status(401).json({ error: "Your session expired. Sign in again." }); return false; }
  const admins = new Set([
    ...LEADERBOARD_TEAM.filter(p => p.isAdmin).map(p => p.email),
    ...(process.env.MARKET_ANALYSIS_ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  ]);
  if (!admins.has(data.user.email.toLowerCase())) { res.status(403).json({ error: "Admin access only." }); return false; }
  return true;
}

function dbFailure(res: Response) { return res.status(503).json({ error: "We couldn't save this right now. Please try again." }); }

export function registerInterestRoutes(app: Express) {
  app.post("/api/agents/events", async (req, res) => {
    const parsed = interestEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid tracking event." });
    if (!supabaseAdmin) return dbFailure(res);
    const v = parsed.data;
    try {
      const { error } = await supabaseAdmin.rpc("record_b2b_interest_event", { p: {
        id: v.id, session_id: v.sessionId, event_type: v.eventType, tier: v.tier,
        utm_source: v.utmSource, utm_medium: v.utmMedium, utm_campaign: v.utmCampaign,
      } });
      if (error?.code === "P0001") return res.status(429).json({ error: "Too many events. Please try again later." });
      if (error) return dbFailure(res);
      return res.status(201).json({ ok: true });
    } catch { return dbFailure(res); }
  });

  app.post("/api/agents/interest", async (req, res) => {
    const parsed = interestSignupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Please complete all fields, use a valid email, and confirm your consent." });
    if (!supabaseAdmin) return dbFailure(res);
    try {
      const { data: id, error } = await supabaseAdmin.rpc("submit_b2b_interest", { p: signupRecord(parsed.data) });
      if (error?.code === "P0001") return res.status(429).json({ error: "You've submitted several requests recently. Please try again in an hour." });
      if (error || !id) return dbFailure(res);
      // Registration is durable even if a provider fails. Never pretend mail was sent.
      try { await deliverInterest(id); }
      catch { console.warn("[agents-interest] notification state needs admin review"); }
      const { data: status } = await supabaseAdmin.from("b2b_interest_signups")
        .select("email_status").eq("id", id).single();
      return res.status(201).json({ ok: true, emailStatus: status?.email_status ?? "pending" });
    } catch { return dbFailure(res); }
  });

  app.get("/api/admin/agents/results", async (req, res) => {
    try {
      if (!await requireInterestAdmin(req, res)) return;
      const filter = req.query.utm_source;
      if (filter !== undefined && (typeof filter !== "string" || filter.length > 200)) {
        return res.status(400).json({ error: "Invalid source filter." });
      }
      let query = supabaseAdmin!.from("b2b_interest_signups")
        .select("id,created_at,name,email,company,role,buyers_per_year,tier,utm_source,utm_medium,utm_campaign,email_status,fub_status,email_error,fub_error,unsubscribed_at")
        .eq("is_test", false).order("created_at", { ascending: false }).limit(100);
      if (typeof filter === "string") query = query.eq("utm_source", filter);
      const [summary, rows] = await Promise.all([
        supabaseAdmin!.rpc("b2b_interest_results", { source_filter: filter ?? null }), query,
      ]);
      if (summary.error || rows.error) return dbFailure(res);
      return res.json({ summary: summary.data, signups: rows.data });
    } catch { return dbFailure(res); }
  });

  app.post("/api/admin/agents/signups/:id/retry", async (req, res) => {
    try {
      if (!await requireInterestAdmin(req, res)) return;
      if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "Invalid signup." });
      await deliverInterest(req.params.id, true);
      return res.json({ ok: true });
    } catch { return dbFailure(res); }
  });

  // GET shows a confirmation; link scanners must not unsubscribe recipients.
  app.get("/api/agents/unsubscribe", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex");
    const parsed = z.string().uuid().safeParse(req.query.token);
    if (!parsed.success) return res.status(400).send("Invalid unsubscribe link.");
    if (!supabaseAdmin) return res.status(503).send("Please try again later.");
    const { data, error } = await supabaseAdmin.from("b2b_interest_signups").select("id").eq("unsubscribe_token", parsed.data).maybeSingle();
    if (error) return res.status(503).send("Please try again later.");
    if (!data) return res.status(404).send("Unsubscribe link not found.");
    return res.type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Havo email preferences</title><body style="font-family:system-ui;max-width:560px;margin:64px auto;padding:24px;color:#13294b"><h1>Havo for agents email preferences</h1><p>Stop confirmation and launch-update emails for this interest list. This will not change your other Havo services.</p><form method="post"><button style="padding:14px 22px;background:#00b6a9;border:0;border-radius:8px;font-size:16px">Unsubscribe</button></form></body></html>`);
  });
  // RFC 8058 one-click POST and the browser confirmation use the same token.
  app.post("/api/agents/unsubscribe", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const token = z.string().uuid().safeParse(req.query.token);
    if (!token.success) return res.status(400).send("Invalid unsubscribe link.");
    if (!supabaseAdmin) return res.status(503).send("Please try again later.");
    try {
      const { data, error } = await supabaseAdmin.from("b2b_interest_signups").select("email").eq("unsubscribe_token", token.data).maybeSingle();
      if (error) return res.status(503).send("Please try again later.");
      if (!data) return res.status(404).send("Unsubscribe link not found.");
      const updated = await supabaseAdmin.from("b2b_interest_signups")
        .update({ unsubscribed_at: new Date().toISOString() }).eq("email", data.email);
      if (updated.error) return res.status(503).send("Please try again later.");
      return res.type("html").send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Havo</title><body style="font-family:system-ui;max-width:560px;margin:64px auto;padding:24px"><h1>You’re unsubscribed.</h1><p>You will no longer receive Havo for agents confirmation or launch-update emails.</p></body></html>');
    } catch { return res.status(503).send("Please try again later."); }
  });
}
