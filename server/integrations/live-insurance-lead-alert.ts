import { Resend } from "resend";
import { ReplitConnectors } from "@replit/connectors-sdk";

export interface LiveInsuranceLead {
  address: string;
  name: string;
  phone: string;
  email: string;
  requestId: string;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));
const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export function liveInsuranceLeadContent(lead: LiveInsuranceLead) {
  const fields = [
    ["Property", singleLine(lead.address)],
    ["Name", singleLine(lead.name) || "Not provided"],
    ["Phone", singleLine(lead.phone) || "Not provided"],
    ["Email", singleLine(lead.email) || "Not provided"],
  ];
  return {
    subject: `LIVE INSURANCE LEAD: ${singleLine(lead.address)}`,
    text: fields.map(([label, value]) => `${label}: ${value}`).join("\n"),
    html: `<div style="font-family:Arial,sans-serif;font-size:14px">${fields
      .map(([label, value]) => `<p><strong>${label}:</strong> ${escapeHtml(value)}</p>`)
      .join("")}</div>`,
  };
}

type EmailPayload = ReturnType<typeof liveInsuranceLeadContent> & {
  from: string;
  to: string;
};
type Deliver = (payload: EmailPayload, idempotencyKey: string) => Promise<void>;

async function deliver(payload: EmailPayload, idempotencyKey: string) {
  // Preserve the existing API-key setup where configured; otherwise use the
  // attached Resend connection without handling its credentials ourselves.
  if (process.env.RESEND_API_KEY) {
    const response = await new Resend(process.env.RESEND_API_KEY).emails.send(
      payload, { idempotencyKey },
    );
    if (response.error) throw new Error("Resend rejected the lead alert");
    return;
  }
  const response = await new ReplitConnectors().proxy("resend", "/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Resend rejected the lead alert (${response.status})`);
}

/** Send directly to the team inbox: routing this through FUB's parser would
 * let FUB replace the requested subject. Other scenario alerts are unchanged. */
export async function sendLiveInsuranceLeadAlert(
  lead: LiveInsuranceLead,
  send: Deliver = deliver,
): Promise<{ status: "sent" | "failed" | "skipped" }> {
  const to = process.env.INTERNAL_ALERT_EMAIL;
  const from = process.env.ALERT_FROM_EMAIL;
  if (!to || !from) {
    console.error("[insurance-lead-alert] INTERNAL_ALERT_EMAIL and ALERT_FROM_EMAIL are required");
    return { status: "skipped" };
  }
  try {
    await send({ from, to, ...liveInsuranceLeadContent(lead) },
      `live-insurance-lead:${lead.requestId}`);
    return { status: "sent" };
  } catch {
    // Do not log contact details, provider payloads, or credentials.
    console.error("[insurance-lead-alert] delivery failed");
    return { status: "failed" };
  }
}