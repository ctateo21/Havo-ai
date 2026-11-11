import { ReplitConnectors } from "@replit/connectors-sdk";
import { supabaseAdmin } from "../supabase";
import { roleLabels, tierLabels } from "../b2b-interest-schema";

const SOURCE = "havofl.com - AGENT FAKE DOOR";
const TAG = "Havo B2B Interest";
// Existing public brokerage address from Havo's legal disclosures.
export const MAILING_ADDRESS = "Horizons By the Sea, Inc., 661 S Collier Blvd, Marco Island, FL 34145";
const APP_ORIGIN = "https://havofl.com"; // Verified published domain; never use a request Host header.
const connectors = new ReplitConnectors();

export type InterestRow = {
  id: string; created_at: string; name: string; email: string; company: string; role: string; tier: string;
  buyers_per_year: string; utm_source: string; utm_medium: string; utm_campaign: string;
  unsubscribe_token: string; unsubscribed_at: string | null;
  email_status: string; fub_status: string; fub_person_id: number | null; fub_note_id: number | null;
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]!));

export function confirmationEmail(row: InterestRow) {
  const unsubscribe = `${APP_ORIGIN}/api/agents/unsubscribe?token=${encodeURIComponent(row.unsubscribe_token)}`;
  const text = `Hi ${row.name},\n\nThank you for your interest in Havo for agents. You're on the list for our first group in Tampa Bay and Naples.\n\nChristian will reach out personally. Havo for agents isn't open yet; no trial has started, no payment was collected, and you have not been charged.\n\nYou expressed interest in: ${tierLabels[row.tier]}.\n\nChristian Tateo\nHavo\n\n${MAILING_ADDRESS}\nUnsubscribe from Havo for agents updates: ${unsubscribe}`;
  return {
    from: process.env.ALERT_FROM_EMAIL || "Havo <alerts@updates.tateoco.com>",
    to: row.email,
    reply_to: "christian@tateoco.com",
    subject: "You're on the Havo for agents list",
    text,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.65;color:#13294b"><h1>You're on the list.</h1><p>Hi ${escapeHtml(row.name)},</p><p>Thank you for your interest in Havo for agents. You're on the list for our first group in Tampa Bay and Naples.</p><p><strong>Christian will reach out personally.</strong> Havo for agents isn't open yet; no trial has started, no payment was collected, and you have not been charged.</p><p>You expressed interest in: ${escapeHtml(tierLabels[row.tier])}.</p><p>Christian Tateo<br>Havo</p><hr><p style="font-size:12px">${MAILING_ADDRESS}<br><a href="${escapeHtml(unsubscribe)}">Unsubscribe from Havo for agents updates</a></p></div>`,
    headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: [{ name: "campaign", value: "havo_b2b_interest" }],
  };
}

async function fub(path: string, method = "GET", body?: unknown) {
  const key = process.env.FOLLOWUPBOSS_API_KEY;
  if (!key) throw new Error("Follow Up Boss is not configured.");
  const response = await fetch(`https://api.followupboss.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Follow Up Boss request failed (${response.status}).`);
  return response.json();
}

async function saveDelivery(id: string, values: Record<string, unknown>) {
  const { error } = await supabaseAdmin!.from("b2b_interest_signups").update(values).eq("id", id);
  if (error) throw new Error("Could not save notification status.");
}

async function deliverFub(row: InterestRow) {
  let personId = row.fub_person_id;
  if (!personId) {
    const found = await fub(`/people?email=${encodeURIComponent(row.email)}&limit=100`);
    const existing = (found.people ?? []).find((p: any) =>
      (p.emails ?? []).some((e: any) => e.value?.toLowerCase() === row.email));
    if (existing) {
      personId = existing.id;
    } else {
      const [firstName, ...last] = row.name.split(/\s+/);
      const created = await fub("/people", "POST", {
        firstName, lastName: last.join(" "), emails: [{ value: row.email, type: "work" }],
        source: SOURCE, tags: [TAG], assignedUserId: 1,
      });
      personId = created.id;
    }
    if (!personId) throw new Error("Follow Up Boss did not return a contact ID.");
    await saveDelivery(row.id, { fub_person_id: personId });
  }
  // Preserve existing tags and contact details; apply the requested lead-source attribution.
  const person = await fub(`/people/${personId}`);
  await fub(`/people/${personId}`, "PUT", {
    source: SOURCE, tags: [...new Set([...(person.tags ?? []), TAG])],
  });
  let noteId = row.fub_note_id;
  if (!noteId) {
    const subject = `${TAG} [${row.id}]`;
    // Recover a note after an interrupted/ambiguous send rather than adding it twice.
    const notes = await fub(`/notes?personId=${personId}&limit=100`);
    noteId = (notes.notes ?? []).find((n: any) => n.subject === subject)?.id;
    if (!noteId) {
      const result = await fub("/notes", "POST", {
        personId, subject, isHtml: false,
        body: [
          "Havo agents interest-only test. No trial, payment, or subscription.",
          `Lead source: ${SOURCE}`, `Role: ${roleLabels[row.role]}`,
          `Company: ${row.company}`, `Tier clicked: ${tierLabels[row.tier]}`,
          `Buyers per year: ${{ "1_10": "1 to 10", "11_25": "11 to 25", "26_plus": "26 or more" }[row.buyers_per_year]}`,
          `UTM source: ${row.utm_source || "(direct)"}`, `UTM medium: ${row.utm_medium || "(none)"}`,
          `UTM campaign: ${row.utm_campaign || "(none)"}`,
          `Interest reference: ${row.id}`, "Consented to Havo for agents confirmation and launch updates.",
        ].join("\n"),
      });
      noteId = result.id;
    }
    if (!noteId) throw new Error("Follow Up Boss did not return a note ID.");
  }
  await saveDelivery(row.id, { fub_person_id: personId, fub_note_id: noteId, fub_status: "sent", fub_error: null });
}

async function deliverEmail(row: InterestRow) {
  if (Date.now() - new Date(row.created_at).getTime() > 23 * 60 * 60 * 1000) {
    throw new Error("Resend retry window expired. Reconcile the provider delivery before sending again.");
  }
  const { count, error } = await supabaseAdmin!.from("b2b_interest_signups")
    .select("id", { count: "exact", head: true }).eq("email", row.email).not("unsubscribed_at", "is", null);
  if (error) throw new Error("Could not check email suppression.");
  if (count) {
    await saveDelivery(row.id, { email_status: "suppressed", email_error: null });
    return;
  }
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `b2b-interest/${row.id}` },
    body: JSON.stringify(confirmationEmail(row)),
  };
  // Prefer the user's explicitly configured server secret. Never fall back to
  // a different credential after an ambiguous send.
  const response = process.env.RESEND_API_KEY
    ? await fetch("https://api.resend.com/emails", {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        signal: AbortSignal.timeout(20_000),
      })
    : await connectors.proxy("resend", "/emails", options);
  if (!response.ok) throw new Error(`Resend request failed (${response.status}).`);
  const data = await response.json() as { id?: string };
  if (!data.id) throw new Error("Resend did not return an email ID.");
  await saveDelivery(row.id, { email_status: "sent", email_id: data.id, email_error: null });
}

/** DB claims prevent concurrent browser retries/admin requests from double sending.
 * A crash leaving 'sending' requires provider reconciliation, not a blind retry. */
export async function deliverInterest(id: string, retryFailed = false) {
  if (!supabaseAdmin) throw new Error("Interest database is unavailable.");
  await Promise.all((["email", "fub"] as const).map(async channel => {
    const { data, error } = await supabaseAdmin!.from("b2b_interest_signups")
      .update({ [`${channel}_status`]: "sending", [`${channel}_error`]: null })
      .eq("id", id).in(`${channel}_status`, retryFailed ? ["pending", "failed"] : ["pending"])
      .select("*").maybeSingle();
    if (error) throw new Error("Could not claim notification delivery.");
    if (!data) return;
    try {
      if (channel === "email") await deliverEmail(data);
      else await deliverFub(data);
    } catch (error) {
      if (error instanceof Error && error.message === "Could not save notification status.") {
        // Provider delivery may already have succeeded. Leave the claim in
        // 'sending' for manual reconciliation instead of risking a duplicate.
        throw error;
      }
      // Only predefined errors are retained; no provider response bodies or secrets.
      const message = error instanceof Error && /^(Follow Up Boss|Resend|Could not)/.test(error.message)
        ? error.message : "Notification connection failed. Check the provider before retrying.";
      await saveDelivery(id, { [`${channel}_status`]: "failed", [`${channel}_error`]: message });
    }
  }));
}
