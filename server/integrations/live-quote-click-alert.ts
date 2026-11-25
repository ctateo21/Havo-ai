import type { Express } from "express";
import { z } from "zod";
/**
 * Team alert for a "Get a Live Quote" tap.
 *
 * The alert is internal: it must never block or fail the user's quote. Follow
 * Up Boss is attempted first (its own consent gate decides whether the person
 * may be enrolled). When it is skipped, unconfigured, or fails, the alert falls
 * back to the internal live insurance lead email so a licensed team member is
 * still notified. Logs carry outcomes only, never contact details.
 */

export type CrmResult = { ok: boolean; skipped?: boolean; error?: string | null };

export type LiveQuoteClickContact = {
  userId: string;
  address: string;
  normalizedAddress: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  phone: string;
};

export type LiveQuoteClickOutcome = {
  /** True when any team channel accepted the alert. */
  teamNotified: boolean;
  channel: "crm" | "email" | "none";
  deduped: boolean;
};

export type LiveQuoteClickDeps = {
  sendCrm: (contact: LiveQuoteClickContact) => Promise<CrmResult>;
  sendTeamEmail: (contact: LiveQuoteClickContact) => Promise<{ status: "sent" | "failed" | "skipped" }>;
  log?: (message: string) => void;
  now?: () => number;
  dedupeWindowMs?: number;
};

export const LIVE_QUOTE_ALERT_DEDUPE_MS = 60_000;

function crmOutcome(result: CrmResult): "delivered" | "consent_skip" | "retryable" {
  if (result.ok && !result.skipped) return "delivered";
  // ok + skipped is the consent gate: retrying cannot change it.
  if (result.ok && result.skipped) return "consent_skip";
  return "retryable";
}

async function attemptCrm(
  deps: LiveQuoteClickDeps,
  contact: LiveQuoteClickContact,
): Promise<"delivered" | "consent_skip" | "retryable"> {
  try {
    return crmOutcome(await deps.sendCrm(contact));
  } catch {
    return "retryable";
  }
}

async function deliver(deps: LiveQuoteClickDeps, contact: LiveQuoteClickContact): Promise<LiveQuoteClickOutcome> {
  const log = deps.log ?? (message => console.log(message));
  let crm = await attemptCrm(deps, contact);
  if (crm === "retryable") {
    log("[live-quote-alert] crm attempt 1 not delivered; retrying once");
    crm = await attemptCrm(deps, contact);
  }
  if (crm === "delivered") {
    log("[live-quote-alert] outcome=crm_delivered");
    return { teamNotified: true, channel: "crm", deduped: false };
  }
  log(`[live-quote-alert] crm ${crm === "consent_skip" ? "skipped_no_consent" : "not_delivered"}; sending team email`);
  let email: { status: "sent" | "failed" | "skipped" };
  try {
    email = await deps.sendTeamEmail(contact);
  } catch {
    email = { status: "failed" };
  }
  log(`[live-quote-alert] outcome=email_${email.status}`);
  return email.status === "sent"
    ? { teamNotified: true, channel: "email", deduped: false }
    : { teamNotified: false, channel: "none", deduped: false };
}

/**
 * Returns a handler that dedupes per user + property for a short window. A
 * failed delivery is not cached, so a later tap can try again.
 */
export function createLiveQuoteClickAlerter(deps: LiveQuoteClickDeps) {
  const windowMs = deps.dedupeWindowMs ?? LIVE_QUOTE_ALERT_DEDUPE_MS;
  const now = deps.now ?? Date.now;
  const inflight = new Map<string, { createdAt: number; delivery: Promise<LiveQuoteClickOutcome> }>();
  return async function alert(contact: LiveQuoteClickContact): Promise<LiveQuoteClickOutcome> {
    const key = `${contact.userId}:${contact.normalizedAddress}`;
    const at = now();
    for (const [k, v] of inflight) if (at - v.createdAt > windowMs) inflight.delete(k);
    const existing = inflight.get(key);
    if (existing) {
      const prior = await existing.delivery;
      if (prior.teamNotified) return { ...prior, deduped: true };
    }
    const delivery = deliver(deps, contact);
    inflight.set(key, { createdAt: at, delivery });
    const outcome = await delivery;
    if (!outcome.teamNotified) inflight.delete(key);
    return outcome;
  };
}


/**
 * POST /api/insurance/live-quote-click. Always answers 200 `{ ok: true }` for
 * a valid signed-in request, whatever happens to the team alert, so the
 * client never blocks or shows an error because of it.
 */
export function registerLiveQuoteClickRoute(app: Express, deps: {
  optionalUser: (req: any) => Promise<{ id: string } | null>;
  loadContact: (user: any, address: string) => Promise<LiveQuoteClickContact>;
  alert: (contact: LiveQuoteClickContact) => Promise<LiveQuoteClickOutcome>;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? (message => console.error(message));
  app.post("/api/insurance/live-quote-click", async (req, res) => {
    let user: { id: string } | null;
    let address: string;
    try {
      user = await deps.optionalUser(req);
      if (!user) return res.status(401).json({ error: "Sign in required" });
      address = z.object({ address: z.string().trim().min(1).max(500) }).parse(req.body ?? {}).address;
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid live-quote request" });
      log("[live-quote-alert] request handling failed");
      return res.json({ ok: true, teamNotified: false, deduped: false });
    }
    try {
      const outcome = await deps.alert(await deps.loadContact(user, address));
      return res.json({ ok: true, teamNotified: outcome.teamNotified, deduped: outcome.deduped });
    } catch {
      // Never block the quote on an internal alert problem.
      log("[live-quote-alert] alert pipeline failed");
      return res.json({ ok: true, teamNotified: false, deduped: false });
    }
  });
}
