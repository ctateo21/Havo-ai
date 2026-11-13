// Provider text is untrusted and may echo arbitrary applicant/credential data.
// Preserve diagnostic vocabulary only; redact every other token, not just emails.
const vocabulary = new Set(("error errors message status validation invalid missing required failed failure rejected unauthorized forbidden authentication agency not found unable to process lead success successful created added client namefirst namelast dateofbirth dob phonenumber phone emailaddress creditpermission assumedcreditscore excellent yes no webid password webpassword endpointkey token address city state zip county ho data result id leadid must be a valid value format please provide cannot empty null false true").split(" "));
export function redactImporterText(value: string): string {
  return value.replace(/https?:\/\/\S+|\S+@\S+/gi, "[redacted]")
    .replace(/[\p{L}\p{M}\p{N}_+./@%-]+/gu, word => vocabulary.has(word.toLowerCase()) ? word : "[redacted]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 600);
}
function positiveId(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9]\d*$/.test(String(value))) return null;
  const n = Number(value); return Number.isSafeInteger(n) ? n : null;
}
function findId(value: unknown, depth = 0): number | null {
  const scalar = positiveId(value); if (scalar) return scalar;
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return null;
  for (const [key, child] of Object.entries(value)) {
    if (/^(lead_?id|id)$/i.test(key)) { const id = positiveId(child); if (id) return id; }
  }
  for (const [key, child] of Object.entries(value)) if (/^(data|result)$/i.test(key)) {
    const id = findId(child, depth + 1); if (id) return id;
  }
  return null;
}
export function inspectImporterResponse(text: string, contentType: string | null, sensitiveValues: string[] = []) {
  const safeText = (raw: string) => {
    for (const value of sensitiveValues.filter(Boolean).sort((a,b)=>b.length-a.length)) {
      raw = raw.split(value).join("[redacted]");
    }
    return redactImporterText(raw);
  };
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* Documented plain-text responses. */ }
  const messages: string[] = [];
  let rejected = false;
  function visit(value: unknown, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6) return;
    for (const [key, child] of Object.entries(value)) {
      if (/error|validation/i.test(key) && child != null && child !== false && child !== "" &&
        !(Array.isArray(child) && child.length === 0) &&
        !(typeof child === "object" && Object.keys(child).length === 0)) rejected = true;
      if (/^(success|ok)$/i.test(key) && child === false) rejected = true;
      if (/error|message|status|validation/i.test(key)) {
        const raw = typeof child === "string" ? child : JSON.stringify(child);
        messages.push(safeText(raw ?? ""));
        if (/\b(error|invalid|missing|required|failed|failure|rejected|denied|unsuccessful|unauthorized|forbidden|unable|cannot|not found)\b/i.test(raw ?? "")) rejected = true;
      }
      visit(child, depth + 1);
    }
  }
  visit(json);
  if (typeof json === "string" || json === undefined) {
    const raw = typeof json === "string" ? json : text;
    if (/\b(error|invalid|missing|required|failed|failure|rejected|denied|unsuccessful|unauthorized|forbidden|unable|cannot|not found)\b/i.test(raw)) {
      rejected = true; messages.push(safeText(raw));
    }
    // Even unfamiliar provider rejection wording must be diagnosable. A
    // non-ID text response is never success; retain only sanitized vocabulary.
    if (!rejected && !positiveId(raw.trim()) && !/\bLead\s*#\s*[1-9]\d*\b/i.test(raw) && raw.trim()) {
      rejected = true; messages.push(safeText(raw));
    }
  }
  const leadId = rejected ? null : findId(json) ?? positiveId(text.trim()) ??
    positiveId(text.match(/\bLead\s*#\s*([1-9]\d*)\b/i)?.[1]);
  return {
    leadId, rejected,
    diagnostics: {
      contentType: /^(application\/json|text\/plain|text\/html)\b/i.exec(contentType ?? "")?.[1] ?? "other",
      length: Buffer.byteLength(text), onlyDigits: /^\d+$/.test(text.trim()),
      topLevelKeys: json && typeof json === "object" && !Array.isArray(json)
        ? Object.keys(json).slice(0, 30).map(safeText) : [],
      messages: messages.slice(0, 8),
    },
    error: rejected ? `Importer rejected request: ${messages.join("; ").slice(0, 600) || "validation failure"}` : "Importer returned no verified LeadId",
  };
}
export function parseLeadId(text: string): number | null {
  return inspectImporterResponse(text, null).leadId;
}
