// ============================================================================
// Property alert emails — sends rate/price-drop notifications to (a) the
// subscribed user and (b) my Follow Up Boss inbound-email address so a
// new lead/activity is created in FUB the moment the alert fires.
// ============================================================================
// Provider: Resend (https://resend.com). Pick because the user already has
// FOLLOWUPBOSS_API_KEY but nothing for email; Resend has the smallest setup.
//
// Required env vars (server-side only):
//   RESEND_API_KEY     — Resend API key
//   ALERT_FROM_EMAIL   — "from" address (must be on a Resend-verified domain)
//   FUB_ALERT_EMAIL    — Follow Up Boss inbound/lead-parsing email address
//
// Each helper is best-effort: failures are caught, logged on the event row,
// and *never* throw — the calling check job must keep processing.
// ============================================================================

import { Resend } from "resend";
import { supabaseAdmin } from "../supabase";
import { isUnsubscribed, unsubscribeUrlFor } from "./onboarding-emails";

type SendStatus = "sent" | "failed" | "skipped";

interface SubscriptionLike {
  id: string;
  user_id: string;
  scenario_id: string;
  scenario_type: string;
  alert_type: "rate_drop" | "price_drop";
  property_address: string | null;
  target_rate: number | null;
  loan_type: string | null;
  occupancy_type: string | null;
  credit_score: number | null;
}

interface AlertEventLike {
  id: string;
  event_type: "rate_drop" | "price_drop";
  property_address: string | null;
  old_value: number | null;
  new_value: number | null;
}

interface UserContact {
  email: string | null;
  name: string | null;
  phone: string | null;
}

let _resend: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

/** Fetch the user's name/email/phone for personalizing the alert. Falls
 *  back to auth.users.email when there's no profile row yet. */
export async function loadUserContact(userId: string): Promise<UserContact> {
  if (!supabaseAdmin) return { email: null, name: null, phone: null };
  let email: string | null = null;
  let name: string | null = null;
  let phone: string | null = null;

  try {
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("name, email, phone")
      .eq("id", userId)
      .maybeSingle();
    if (prof) {
      email = prof.email ?? null;
      name = prof.name ?? null;
      phone = prof.phone ?? null;
    }
  } catch (e: any) {
    console.warn("[alert-emails] profile lookup failed:", e?.message);
  }

  if (!email) {
    try {
      const { data: au } = await supabaseAdmin.auth.admin.getUserById(userId);
      email = au?.user?.email ?? null;
    } catch (e: any) {
      console.warn("[alert-emails] auth.admin lookup failed:", e?.message);
    }
  }
  return { email, name, phone };
}

const SCENARIO_LABEL: Record<string, string> = {
  purchase: "Purchase",
  refinance: "Refinance",
  cash_buy: "Cash Buy",
  seller: "For Sale",
};

function esc(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtRate(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(3)}%`;
}

function buildUserEmail(
  evt: AlertEventLike, sub: SubscriptionLike, user: UserContact,
): { subject: string; html: string; text: string } {
  const address = evt.property_address ?? sub.property_address ?? "your saved property";
  const greeting = user.name ? `Hi ${user.name.split(" ")[0]},` : "Hi there,";

  if (evt.event_type === "rate_drop") {
    const subject = `Rate Alert: ${address} hit ${fmtRate(evt.new_value)}`;
    const reason =
      sub.target_rate != null
        ? `the market rate dropped to ${fmtRate(evt.new_value)}, at or below your ${fmtRate(sub.target_rate)} target.`
        : `the market rate moved to ${fmtRate(evt.new_value)}.`;
    const text =
      `${greeting}\n\n` +
      `Good news on ${address} — ${reason}\n\n` +
      `Open your saved estimate to see how this changes your monthly payment, ` +
      `then chat with our team if you'd like to lock or refinance.\n\n` +
      `— Havo\n\n` +
      `Note: live rates change throughout the day and depend on credit, loan ` +
      `program, and property details. Please verify the final rate before locking.`;
    const html =
      `<p>${esc(greeting)}</p>` +
      `<p>Good news on <strong>${esc(address)}</strong> — ${esc(reason)}</p>` +
      `<p>Open your saved estimate to see how this changes your monthly payment, ` +
      `then chat with our team if you'd like to lock or refinance.</p>` +
      `<p>— Havo</p>` +
      `<p style="color:#666;font-size:12px">Live rates change throughout the day ` +
      `and depend on credit, loan program, and property details. Please verify the ` +
      `final rate before locking.</p>`;
    return { subject, html, text };
  }

  // price_drop
  const subject = `Price Drop Alert: ${address} dropped to ${fmtMoney(evt.new_value)}`;
  const reason =
    evt.old_value != null && evt.new_value != null
      ? `the listing price dropped from ${fmtMoney(evt.old_value)} to ${fmtMoney(evt.new_value)}.`
      : `the listing price changed.`;
  const text =
    `${greeting}\n\n` +
    `Heads up on ${address} — ${reason}\n\n` +
    `Open your saved property to revisit your numbers or run a fresh estimate.\n\n` +
    `— Havo\n\n` +
    `Note: listing prices change frequently and our cache may lag the MLS by up ` +
    `to a day. Please verify the current asking price before acting.`;
  const html =
    `<p>${esc(greeting)}</p>` +
    `<p>Heads up on <strong>${esc(address)}</strong> — ${esc(reason)}</p>` +
    `<p>Open your saved property to revisit your numbers or run a fresh estimate.</p>` +
    `<p>— Havo</p>` +
    `<p style="color:#666;font-size:12px">Listing prices change frequently and our ` +
    `cache may lag the MLS by up to a day. Please verify the current asking price ` +
    `before acting.</p>`;
  return { subject, html, text };
}

function buildFubEmail(
  evt: AlertEventLike, sub: SubscriptionLike, user: UserContact,
): { subject: string; html: string; text: string } {
  const address = evt.property_address ?? sub.property_address ?? "(no address)";
  const who = user.name || user.email || "Unknown user";
  const scenarioLabel = SCENARIO_LABEL[sub.scenario_type] ?? sub.scenario_type;
  const alertTypeLabel = evt.event_type === "rate_drop" ? "Rate Drop" : "Price Drop";

  const subject =
    evt.event_type === "rate_drop"
      ? `Rate Alert from ${who} / ${address}`
      : `Price Drop Alert from ${who} / ${address}`;

  const lines: Array<[string, string]> = [
    ["User name", user.name || ""],
    ["User email", user.email || ""],
    ["User phone", user.phone || ""],
    ["Property address", address],
    ["Scenario type", scenarioLabel],
    ["Alert type", alertTypeLabel],
  ];
  if (evt.event_type === "rate_drop") {
    lines.push(["Target rate", fmtRate(sub.target_rate)]);
    lines.push(["Current rate", fmtRate(evt.new_value)]);
  } else {
    lines.push(["Prior price", fmtMoney(evt.old_value)]);
    lines.push(["New price", fmtMoney(evt.new_value)]);
  }
  lines.push(["Loan type", sub.loan_type || ""]);
  lines.push(["Credit score", sub.credit_score != null ? String(sub.credit_score) : ""]);
  lines.push(["Occupancy / use", sub.occupancy_type || ""]);
  lines.push(["Time triggered", new Date().toISOString()]);

  const text = lines.map(([k, v]) => `${k}: ${v || "(n/a)"}`).join("\n");
  const html =
    `<h3>${esc(alertTypeLabel)} — ${esc(address)}</h3>` +
    `<table cellpadding="4" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">` +
    lines
      .map(
        ([k, v]) =>
          `<tr><td style="color:#666;padding-right:12px;vertical-align:top"><strong>${esc(k)}</strong></td>` +
          `<td>${esc(v || "(n/a)")}</td></tr>`,
      )
      .join("") +
    `</table>`;
  return { subject, html, text };
}

// Verified Resend sending identity. ALERT_FROM_EMAIL should be set to this, but
// we also default to it so emails never fall back to an unverified domain.
const DEFAULT_FROM = "Havo Showing Alerts <alerts@updates.tateoco.com>";

async function sendOne(args: {
  to: string;
  bcc?: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<{ status: SendStatus; error: string | null; to: string; from: string }> {
  const from = process.env.ALERT_FROM_EMAIL || DEFAULT_FROM;
  const resend = getResend();
  if (!resend) return { status: "skipped", error: "RESEND_API_KEY not set", to: args.to, from };
  try {
    const payload: Record<string, unknown> = {
      from, to: args.to, subject: args.subject, html: args.html, text: args.text,
    };
    if (args.replyTo) payload.reply_to = args.replyTo;
    if (args.bcc) payload.bcc = args.bcc;
    if (args.headers) payload.headers = args.headers;
    const { error } = await resend.emails.send(
      payload as any,
      args.idempotencyKey
        ? { idempotencyKey: args.idempotencyKey }
        : undefined,
    );
    if (error) return { status: "failed", error: error.message || String(error), to: args.to, from };
    return { status: "sent", error: null, to: args.to, from };
  } catch (e: any) {
    return { status: "failed", error: e?.message ?? String(e), to: args.to, from };
  }
}

// ── Unsubscribe footer (marketing-style emails only) ────────────────────────
// FUB / internal-team emails are operational and never carry this.

function unsubFooterHtml(unsubUrl: string): string {
  return (
    `<p style="font-size:12px;color:#888;margin:16px 0 0">` +
    `Havo · Every Step Home · Tateo Insurance Corp · License #L132640<br/>` +
    `Tampa Bay, Florida · <a href="${esc(unsubUrl)}" style="color:#888">Unsubscribe</a></p>`
  );
}

function unsubFooterText(unsubUrl: string): string {
  return `\n\nHavo · Every Step Home\nUnsubscribe: ${unsubUrl}`;
}

function listUnsubHeaders(unsubUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** Send user + FUB alert emails and update the event row with the outcome.
 *  Never throws — failures are recorded on the event so a future retry
 *  worker can pick them up. */
export async function sendPropertyAlertEmails(
  event: AlertEventLike,
  subscription: SubscriptionLike,
  user: UserContact,
): Promise<{ userStatus: SendStatus; fubStatus: SendStatus }> {
  if (!supabaseAdmin) return { userStatus: "skipped", fubStatus: "skipped" };
  const fubAddress = process.env.FUB_ALERT_EMAIL || null;

  // --- User email -----------------------------------------------------------
  let userResult: { status: SendStatus; error: string | null } =
    { status: "skipped", error: "no user email on file" };
  if (user.email) {
    // Suppression check: skip users who unsubscribed via /api/email/unsubscribe.
    // A failed check (null) is treated as "can't verify" → do NOT send.
    const unsub = await isUnsubscribed(subscription.user_id);
    if (unsub !== false) {
      userResult = {
        status: "skipped",
        error: unsub === true ? "user unsubscribed" : "unsubscribe check failed",
      };
      console.log(`[alert-emails] ${user.email}: ${userResult.error} — skipping user email`);
    } else {
      const unsubUrl = unsubscribeUrlFor(subscription.user_id);
      const u = buildUserEmail(event, subscription, user);
      userResult = await sendOne({
        to: user.email,
        subject: u.subject,
        html: u.html + unsubFooterHtml(unsubUrl),
        text: u.text + unsubFooterText(unsubUrl),
        headers: listUnsubHeaders(unsubUrl),
      });
    }
  }

  // --- FUB email ------------------------------------------------------------
  let fubResult: { status: SendStatus; error: string | null } =
    { status: "skipped", error: "FUB_ALERT_EMAIL not set" };
  if (fubAddress) {
    const f = buildFubEmail(event, subscription, user);
    fubResult = await sendOne({
      to: fubAddress,
      replyTo: user.email || undefined,
      subject: f.subject, html: f.html, text: f.text,
    });
  }

  const nowIso = new Date().toISOString();
  const overallStatus: "sent" | "failed" | "pending" =
    userResult.status === "sent" || fubResult.status === "sent"
      ? "sent"
      : userResult.status === "failed" || fubResult.status === "failed"
        ? "failed"
        : "pending"; // both skipped

  try {
    await supabaseAdmin
      .from("property_alert_events")
      .update({
        user_email: user.email,
        fub_email: fubAddress,
        user_email_status: userResult.status,
        fub_email_status: fubResult.status,
        user_email_sent_at: userResult.status === "sent" ? nowIso : null,
        fub_email_sent_at: fubResult.status === "sent" ? nowIso : null,
        email_error_message: userResult.error,
        fub_error_message: fubResult.error,
        status: overallStatus,
        sent_at: overallStatus === "sent" ? nowIso : null,
      })
      .eq("id", event.id);
  } catch (e: any) {
    console.warn("[alert-emails] event status update failed:", e?.message);
  }

  return { userStatus: userResult.status, fubStatus: fubResult.status };
}

// ============================================================================
// Transactional emails — account welcome + internal new-scenario alert.
// Both reuse the same Resend pattern (getResend + sendOne) and are best-effort:
// they return a SendStatus and never throw, so callers can fire-and-forget
// with .catch() without ever crashing the main request flow.
// ============================================================================

const HAVO_NAVY = "#13294b";

/** Best-effort lookup of the Supabase user id for an email address (profiles
 *  first, then auth.users). Returns null when unknown / no account yet. */
async function resolveUserIdByEmail(email: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (prof?.id) return prof.id as string;
  } catch { /* fall through */ }
  try {
    const { data } = await (supabaseAdmin.auth.admin as any).listUsers({ page: 1, perPage: 200 });
    const match = data?.users?.find(
      (u: any) => (u.email || "").toLowerCase() === email.toLowerCase(),
    );
    return match?.id ?? null;
  } catch {
    return null;
  }
}

/** Sent when a new account is created. Best-effort — never throws.
 *  Marketing-style: checks the unsubscribe suppression list and carries an
 *  unsubscribe footer + List-Unsubscribe header when we know the user id. */
export async function sendWelcomeEmail(args: {
  to: string;
  firstName?: string;
  userId?: string;
}): Promise<{ status: SendStatus; error: string | null }> {
  if (!args.to) return { status: "skipped", error: "no recipient" };

  // Resolve the account (if any) so we can honor unsubscribes and link the
  // unsubscribe endpoint. No account found → send without the unsub block.
  const userId = args.userId ?? (await resolveUserIdByEmail(args.to));
  if (userId) {
    const unsub = await isUnsubscribed(userId);
    if (unsub === true) {
      console.log(`[welcome-email] ${args.to} unsubscribed — skipping`);
      return { status: "skipped", error: "user unsubscribed" };
    }
    if (unsub === null) {
      console.log(`[welcome-email] ${args.to} unsubscribe check failed — skipping`);
      return { status: "skipped", error: "unsubscribe check failed" };
    }
  }
  const unsubUrl = userId ? unsubscribeUrlFor(userId) : null;

  const dashboardUrl = `${process.env.APP_URL ?? ""}/dashboard`;
  const name = args.firstName?.trim();
  const heading = name ? `Welcome, ${name}!` : "Welcome!";
  const subject = "Welcome to Havo — you're all set";

  const text =
    `${heading}\n\n` +
    `Your account is ready. Any scenario you saved is waiting in your dashboard.\n\n` +
    `Go to My Dashboard: ${dashboardUrl}\n\n` +
    `Havo · Every Step Home · Tateo Insurance Corp · License #L132640` +
    (unsubUrl ? `\nUnsubscribe: ${unsubUrl}` : "");

  const html =
    `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">` +
    `<p style="font-size:22px;font-weight:bold;color:${HAVO_NAVY};margin:0 0 16px">Havo</p>` +
    `<h1 style="font-size:20px;color:${HAVO_NAVY};margin:0 0 12px">${esc(heading)}</h1>` +
    `<p style="font-size:15px;color:#333;line-height:1.5;margin:0 0 24px">` +
    `Your account is ready. Any scenario you saved is waiting in your dashboard.</p>` +
    `<p style="margin:0 0 28px">` +
    `<a href="${esc(dashboardUrl)}" style="display:inline-block;background:${HAVO_NAVY};` +
    `color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;` +
    `padding:12px 24px;border-radius:6px">Go to My Dashboard</a></p>` +
    `<p style="font-size:12px;color:#888;margin:0">Havo · Every Step Home · ` +
    `Tateo Insurance Corp · License #L132640` +
    (unsubUrl ? ` · <a href="${esc(unsubUrl)}" style="color:#888">Unsubscribe</a>` : "") +
    `</p>` +
    `</div>`;

  return sendOne({
    to: args.to, subject, html, text,
    headers: unsubUrl ? listUnsubHeaders(unsubUrl) : undefined,
  });
}

export interface QuoteRushEmailQuote {
  siteName: string;
  annualPremium: number;
  monthlyPremium: number;
  coverageA: number;
  hurricaneDeductible: string;
  aop: string;
}

export const WIND_MITIGATION_DISCLOSURE =
  "This estimate assumes wind mitigation credits based on the home's age. " +
  "A wind mitigation inspection is required to confirm them — without one, " +
  "your premium may be higher.";

function quoteRushMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function quoteRushResultsContent(args: {
  propertyAddress: string;
  quotes: QuoteRushEmailQuote[];
  windMitigationReportConfirmed?: boolean;
  unsubscribeUrl: string;
  physicalAddress: string;
  assumptions?: string[];
}): { subject: string; html: string; text: string } {
  const quotes = args.quotes.filter(q=>q.annualPremium>0).sort((a,b)=>a.annualPremium-b.annualPremium).slice(0, 3);
  const license="Quotes provided by Tateo Insurance Corp (License #L132640) · Agent Paul Christian Tateo (W142842) · Real-time carrier rates via Tateo & Co.";
  const binder="These are preliminary quotes, not a binder or proof of insurance. Coverage is not in force until a carrier accepts an application and issues a binder or policy. Premiums can change after underwriting and inspections.";
  const assumptions=[`Assumed credit: ${process.env.QUOTERUSH_ASSUMED_CREDIT_SCORE||"Excellent"} (no credit check performed)`,...(args.assumptions??[])];
  const rawSchedule=process.env.SCHEDULE_CALL_URL??"https://calendar.app.google/bGd2q1fVCsmzPgPb6";
  let schedule="";try{const u=new URL(rawSchedule);if(u.protocol==="https:")schedule=u.toString();}catch{/* No unsafe link. */}
  const noQuotes="Our agents are finishing your quotes manually and will contact you.";
  const rows = quotes.map((quote, index) => ({
    ...quote,
    rank: index + 1,
  }));
  const textRows = rows.map(quote =>
    `${quote.rank}. ${quote.siteName}\n` +
    `Annual premium: ${quoteRushMoney(quote.annualPremium)}\n` +
    `Monthly equivalent: ${quoteRushMoney(quote.monthlyPremium)}\n` +
    `Coverage A: ${quote.coverageA>0?quoteRushMoney(quote.coverageA):"Unavailable"}\n` +
    `Hurricane deductible: ${quote.hurricaneDeductible || "—"}\n` +
    `AOP deductible: ${quote.aop || "—"}`
  );
  const disclosure = args.windMitigationReportConfirmed === true
    ? ""
    : `\n\n${WIND_MITIGATION_DISCLOSURE}`;
  const subject = args.quotes.length
    ? `Your insurance carrier quotes for ${args.propertyAddress}`
    : `We're finishing your insurance quotes for ${args.propertyAddress}`;
  const text =
    (rows.length ? `Your preliminary insurance carrier quotes\n\n` : `We're finishing your insurance quotes\n\n`) +
    `Property: ${args.propertyAddress}\n\n` +
    textRows.join("\n\n") +
    (rows.length?"":noQuotes)+
    disclosure +
    `\n\n${assumptions.join("\n")}\n${schedule?`Schedule a call: ${schedule}`:"Contact your agent to schedule a call."}\n\n${license}\n${binder}\n` +
    `${args.physicalAddress}\n` +
    `Unsubscribe: ${args.unsubscribeUrl}`;
  const htmlRows = rows.map(quote =>
    `<tr>` +
    `<td style="padding:8px 10px;vertical-align:top"><strong>${quote.rank}. ${esc(quote.siteName)}</strong></td>` +
    `<td style="padding:8px 10px;vertical-align:top">` +
    `Annual premium: ${esc(quoteRushMoney(quote.annualPremium))}<br/>` +
    `Monthly equivalent: ${esc(quoteRushMoney(quote.monthlyPremium))}<br/>` +
    `Coverage A: ${quote.coverageA>0?esc(quoteRushMoney(quote.coverageA)):"Unavailable"}<br/>` +
    `Hurricane deductible: ${esc(quote.hurricaneDeductible || "—")}<br/>` +
    `AOP deductible: ${esc(quote.aop || "—")}` +
    `</td></tr>`
  ).join("");
  const htmlDisclosure = args.windMitigationReportConfirmed === true
    ? ""
    : `<p style="color:#6b4e00;background:#fff8e1;padding:10px;border-radius:6px">${esc(WIND_MITIGATION_DISCLOSURE)}</p>`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">` +
    `<p style="font-size:22px;font-weight:bold;color:${HAVO_NAVY}">Havo</p>` +
    `<h1 style="font-size:20px;color:${HAVO_NAVY}">${rows.length?"Your preliminary insurance carrier quotes":"We're finishing your insurance quotes"}</h1>` +
    `<p>Property: <strong>${esc(args.propertyAddress)}</strong></p>` +
    `<table cellpadding="0" style="border-collapse:collapse;width:100%;font-size:14px">${htmlRows}</table>` +
    htmlDisclosure +
    (rows.length?"":`<p>${esc(noQuotes)}</p>`)+
    `<ul>${assumptions.map(a=>`<li>${esc(a)}</li>`).join("")}</ul>`+
    (schedule?`<p><a href="${esc(schedule)}" style="display:inline-block;padding:12px;background:#007f77;color:white">Schedule a call</a></p>`:"<p>Contact your agent to schedule a call.</p>")+
    `<p style="font-size:12px;color:#888;margin-top:20px">` +
    `${esc(license)}<br/>${esc(binder)}<br/>` +
    `${esc(args.physicalAddress)}<br/>` +
    `<a href="${esc(args.unsubscribeUrl)}" style="color:#888">Unsubscribe</a></p>` +
    `</div>`;
  return { subject, html, text };
}

/** Best-effort operational result email. The caller owns the durable atomic
 * claim; this function only performs suppression, rendering, and the provider
 * call. The stable idempotency key prevents a retry after a crash from
 * creating a second Resend message. */
export async function sendQuoteRushResultsEmail(args: {
  to: string;
  userId: string;
  propertyAddress: string;
  quotes: QuoteRushEmailQuote[];
  windMitigationReportConfirmed?: boolean;
  idempotencyKey: string;
  assumptions?: string[];
}): Promise<{ status: SendStatus; error: string | null }> {
  if (!args.to || !args.userId) {
    return { status: "skipped", error: "missing recipient identity" };
  }
  // Requested quote results are transactional, independent of marketing consent.
  const physicalAddress = process.env.AGENCY_PHYSICAL_ADDRESS?.trim() || "Tampa Bay, Florida";
  if(!process.env.AGENCY_PHYSICAL_ADDRESS?.trim())console.warn("[quote-email] AGENCY_PHYSICAL_ADDRESS missing; using regional fallback");
  const unsubscribeUrl = unsubscribeUrlFor(args.userId);
  const content = quoteRushResultsContent({
    propertyAddress: args.propertyAddress,
    quotes: args.quotes,
    windMitigationReportConfirmed: args.windMitigationReportConfirmed,
    unsubscribeUrl,
    physicalAddress,
    assumptions:args.assumptions,
  });
  const result = await sendOne({
    to: args.to,
    bcc:process.env.QUOTE_RESULTS_BCC?.trim()||"sales@havofl.com",
    subject: content.subject,
    html: content.html,
    text: content.text,
    headers: listUnsubHeaders(unsubscribeUrl),
    idempotencyKey: args.idempotencyKey,
  });
  return { status: result.status, error: result.error };
}

/** Sent to the internal team whenever any scenario is saved. Best-effort.
 *  When `contact` is provided (e.g. showing requests) a Name/Email/Phone block
 *  is rendered near the top so the team always has full contact details. */
export async function sendInternalAlert(args: {
  scenarioType: string;
  userEmail: string;
  address: string;
  summary: string;
  contact?: { name?: string; email?: string; phone?: string };
}): Promise<{ status: SendStatus; error: string | null; to: string; from: string }> {
  // Recipient for internal team alerts. Prefer a dedicated INTERNAL_ALERT_EMAIL,
  // then the Follow Up Boss lead inbox, then fall back to the verified sender
  // address (always set when email is configured) so these alerts are never
  // silently dropped just because the dedicated var was never set.
  const to =
    process.env.INTERNAL_ALERT_EMAIL ||
    process.env.FUB_ALERT_EMAIL ||
    process.env.ALERT_FROM_EMAIL;
  if (!to) {
    return {
      status: "skipped",
      error: "Missing internal alert recipient email",
      to: "",
      from: process.env.ALERT_FROM_EMAIL || DEFAULT_FROM,
    };
  }

  const subject = `New ${args.scenarioType} — ${args.address}`;
  const fubSearchUrl =
    `https://app.followupboss.com/2/people?q=${encodeURIComponent(args.contact?.email || args.userEmail)}`;

  // Contact block (Name/Email/Phone) — only when caller supplies contact info,
  // so existing scenario-save alerts keep their original layout.
  const c = args.contact;
  const contactText = c
    ? `Contact:\n` +
      `Name: ${c.name?.trim() || "Not provided"}\n` +
      `Email: ${c.email?.trim() || args.userEmail || "Not provided"}\n` +
      `Phone: ${c.phone?.trim() || "Not provided"}\n\n`
    : "";
  const contactHtml = c
    ? `<p style="margin:0 0 4px"><strong>Contact:</strong></p>` +
      `<p style="margin:0 0 2px">Name: ${esc(c.name?.trim() || "Not provided")}</p>` +
      `<p style="margin:0 0 2px">Email: ${esc(c.email?.trim() || args.userEmail || "Not provided")}</p>` +
      `<p style="margin:0 0 12px">Phone: ${esc(c.phone?.trim() || "Not provided")}</p>`
    : "";

  const text =
    contactText +
    `User: ${args.userEmail}\n` +
    `Type: ${args.scenarioType}\n` +
    `Property: ${args.address}\n` +
    `Summary: ${args.summary}\n\n` +
    `Find contact in Follow Up Boss: ${fubSearchUrl}`;

  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">` +
    contactHtml +
    `<p><strong>User:</strong> ${esc(args.userEmail)}</p>` +
    `<p><strong>Type:</strong> ${esc(args.scenarioType)}</p>` +
    `<p><strong>Property:</strong> ${esc(args.address)}</p>` +
    `<p><strong>Summary:</strong> ${esc(args.summary)}</p>` +
    `<p><a href="${esc(fubSearchUrl)}">Find this contact in Follow Up Boss</a></p>` +
    `</div>`;

  return sendOne({ to, subject, html, text });
}
