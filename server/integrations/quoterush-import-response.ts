// Provider text is untrusted and may echo arbitrary applicant/credential data.
// Preserve diagnostic vocabulary only; redact every other token, not just emails.
const vocabulary = new Set(("error errors message status validation invalid missing required failed failure rejected unauthorized forbidden authentication agency not found unable to process lead success successful created added client namefirst namelast dateofbirth dob phonenumber phone emailaddress creditpermission assumedcreditscore excellent yes no webid password webpassword endpointkey token address city state zip county ho data result id leadid must be a valid value format please provide cannot empty null false true").split(" "));
// Names only, never values. Keep this covered by a builder-key contract test.
for (const word of `redacted is for could verified verify date use duplicate exists errorcode success ok validationerrors
PhoneCell PhoneOther EntityType Gender MaritalStatus Industry Occupation EPolicy International Assigned LeadSource LeadStatus Lob_Home Lob_Auto Lob_Flood
FormType NewPurchase PurchaseDate PurchasePrice UsageType MonthsOccupied MonthsOwnerOccupied RentalTerm YearBuilt PolicyEffectiveDate SquareFeet ConstructionType Construction MasonryConstruction FoundationType RoofShape RoofMaterial UpdateRoofYear UpdateRoofType
CoverageA CoverageB CoverageBPercent CoverageC CoverageCPercent CoverageD CoverageDPercent CoverageE CoverageF AllOtherPerilsDeductible HurricaneDeductible WindHailDeductible FloodZone MilesToCoast FloodPolicy CurrentlyInsured CurrentCarrier CurrentPolicyNumber AnyLapses Claims HaveWindMitForm OpeningProtection SecondaryWaterResistance Terrain BurglarAlarm FireAlarm FireHydrant FireStation Mortgage WaterBackup WaterBackupAmount RoofLossSettlement PersonalInjuryCoverage IdentityTheft IncreaseReplacementCostOnDwelling ClaimDetail Amount PriorResidence Paid`.split(/\s+/)) vocabulary.add(word.toLowerCase());
export function redactImporterText(value: string): string {
  return value.replace(/https?:\/\/\S+|\S+@\S+/gi, "[redacted]")
    .replace(/[\p{L}\p{M}\p{N}_+./@%-]+/gu, word => {
      const core = word.replace(/[.]+$/, "");
      const suffix = word.slice(core.length);
      return (vocabulary.has(core.toLowerCase()) ? core : "[redacted]") + suffix;
    })
    .replace(/[\r\n\t]+/g, " ").slice(0, 600);
}
function positiveId(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9]\d*$/.test(String(value))) return null;
  const n = Number(value); return Number.isSafeInteger(n) ? n : null;
}
function findId(value: unknown): number | null {
  const scalar = positiveId(value); if (scalar) return scalar;
  const pending = [value];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    for (const [key, child] of Object.entries(node)) {
      if (!Array.isArray(node) && /^leadid$/i.test(key)) {
        const id = positiveId(child); if (id) return id;
      }
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return null;
}
export function inspectImporterResponse(text: string, contentType: string | null, sensitiveValues: string[] = []) {
  const stripSensitive = (raw: string) => {
    for (const value of sensitiveValues.filter(Boolean).sort((a,b)=>b.length-a.length)) {
      raw = raw.split(value).join("[redacted]");
    }
    return raw;
  };
  const safeText = (raw: string) => redactImporterText(stripSensitive(raw));
  const failure = (raw: string) => /\b(error|invalid|missing|failed|failure|rejected|denied|unsuccessful|unauthorized|forbidden|unable|cannot|not found)\b/i.test(stripSensitive(raw).replace(/\bno errors?\b/gi,""));
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* Documented plain-text responses. */ }
  const messages: string[] = [];
  let rejected = false;
  const pending = [json];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (/error|validation/i.test(key) && child != null && child !== 0 && child !== "0" && child !== false && child !== "" &&
        !(Array.isArray(child) && child.length === 0) &&
        !(typeof child === "object" && Object.keys(child).length === 0)) rejected = true;
      if (/^(success|ok)$/i.test(key) && child === false) rejected = true;
      if (/error|message|status|validation/i.test(key)) {
        const raw = typeof child === "string" ? child : JSON.stringify(child);
        messages.push(safeText(raw ?? ""));
        if (typeof child === "string" && failure(child)) rejected = true;
      }
      if (child && typeof child === "object") pending.push(child);
    }
  }
  if (typeof json === "string" || json === undefined) {
    const raw = typeof json === "string" ? json : text;
    if (failure(raw)) {
      rejected = true; messages.push(safeText(raw));
    }
    // Even unfamiliar provider rejection wording must be diagnosable. A
    // non-ID text response is never success; retain only sanitized vocabulary.
    if (!rejected && !positiveId(raw.trim()) && !/\bLead\s*#\s*[1-9]\d*\b/i.test(raw) && raw.trim()) {
      rejected = true; messages.push(safeText(raw));
    }
  }
  const leadId = findId(json) ?? positiveId(text.trim()) ??
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
  const result = inspectImporterResponse(text, null);
  return result.rejected ? null : result.leadId;
}
