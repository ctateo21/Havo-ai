import { completeWithOpenRouter, type OpenRouterContent } from "./openrouter";

function parseDocumentJson<T>(raw: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error("AI returned invalid document data. Please try again."); }
}

export interface MortgageAnalysis {
  loanBalance: number;
  interestRate: number;
  monthlyPayment: number;
  principalAndInterest: number;
  escrowAmount: number;
  /** Current balance held in the borrower's existing escrow account.
   *  This is distinct from the monthly escrow portion of the payment. */
  currentEscrowBalance: number | null;
  propertyAddress: string;
  lender: string;
  estimatedRemainingYears: number;
  estimatedHomeValue: number;
  /** Servicer loan/account number as printed on the statement.
   *  Stored as text to preserve leading zeros and any dashes.
   *  `null` when the statement does not show one (or it could not be
   *  reliably distinguished from a phone number, zip, escrow account,
   *  confirmation number, etc.). */
  loanNumber: string | null;
  confidence: "high" | "medium" | "low";
  recommendation: string;
  potentialSavings: number;
  rawExtractedData: Record<string, string | number>;
}

// Trim, collapse internal whitespace, preserve leading zeros and any
// dashes. Returns null for empty / placeholder values so callers can
// safely fall back to an existing saved loan number.
function normalizeLoanNumber(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^(n\/?a|none|null|unknown|not\s*found|--+)$/i.test(s)) return null;
  return s;
}

export async function analyzeMortgageStatement(documentText: string): Promise<MortgageAnalysis> {
  const systemPrompt = `You are a mortgage document analyzer. Extract key information from mortgage statements and provide refinancing recommendations.

You must respond with a valid JSON object containing the following fields:
- loanBalance: number (the unpaid principal balance - extract exactly from document)
- interestRate: number (the current interest rate as a decimal, e.g., 4.875 for 4.875%)
- monthlyPayment: number (total monthly payment including escrow)
- principalAndInterest: number (just the P&I portion without escrow)
- escrowAmount: number (taxes and insurance portion)
- currentEscrowBalance: number | null (the CURRENT balance held in the borrower's escrow account, from labels such as "Escrow Balance" or "Current Escrow Balance"; do not use the monthly escrow payment, escrow shortage, or escrow disbursement. Return null if no current balance is printed.)
- propertyAddress: string (full property address as shown in document)
- lender: string (the mortgage servicer/lender name)
- estimatedRemainingYears: number (estimate based on loan balance, rate, and P&I payment)
- estimatedHomeValue: number (estimate the current market value of the property)
- loanNumber: string | null (the servicer's loan/account identifier as printed
  on the statement — look for labels such as "Loan Number", "Loan No.",
  "Loan #", "Account Number", "Account No.", "Mortgage Account Number",
  "Servicer Loan Number", or a "Reference Number" that is clearly the
  mortgage loan ID. Return it as a STRING exactly as printed so leading
  zeros and dashes are preserved. Do NOT use phone numbers, payment
  amounts, zip codes, property tax IDs, escrow account numbers, or
  confirmation numbers. Return null if no loan number is clearly present.)
- confidence: "high" | "medium" | "low"
- recommendation: string (compare extracted rate to current market rates of 6.5-7% for 30-year fixed)
- potentialSavings: number (monthly savings if refinancing is recommended, else 0)
- rawExtractedData: object with any other relevant fields

Respond with a JSON object only, no additional text.`;

  const response = await completeWithOpenRouter({
    purpose: "document",
    maxTokens: 2048,
    system: systemPrompt,
    content: `Analyze this mortgage statement:\n\n${documentText}`,
  });

  const raw = response.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = parseDocumentJson<MortgageAnalysis>(raw);
  // Normalize defensively — the model occasionally returns numbers or
  // empty strings even when the spec says string|null.
  parsed.loanNumber = normalizeLoanNumber((parsed as any).loanNumber);
  {
    const rawEscrowBalance = (parsed as any).currentEscrowBalance;
    const n = rawEscrowBalance === null || rawEscrowBalance === undefined || rawEscrowBalance === ""
      ? NaN
      : Number(rawEscrowBalance);
    parsed.currentEscrowBalance = Number.isFinite(n) && n >= 0 ? n : null;
  }
  return parsed;
}

// ── Final Closing Disclosure ────────────────────────────────────────
// Extracts origination details from a Final CD (TRID form). The client
// derives today's balance from these via an amortization schedule.
export interface ClosingDisclosureAnalysis {
  propertyAddress: string;
  lender: string;
  closingDate: string | null;      // ISO yyyy-mm-dd
  firstPaymentDate: string | null; // explicit or inferred from prepaid interest
  prepaidInterestThroughDate: string | null;
  purchasePrice: number;           // "Sale Price" on page 1
  loanAmount: number;              // original note amount
  interestRate: number;            // note rate %, e.g. 6.625
  loanTermMonths: number;          // e.g. 360
  principalAndInterest: number;    // monthly P&I from Projected Payments
  escrowAmount: number;            // monthly escrow (taxes+insurance), 0 if none
  loanNumber: string | null;
  /** Loan program from the CD page-1 "Loan Type" checkbox.
   *  null when the checkbox is absent/unreadable — the client then
   *  defaults to conventional. */
  loanType: "conventional" | "fha" | "va" | null;
  confidence: "high" | "medium" | "low";
  rawExtractedData: Record<string, string | number>;
}

/**
 * @param input Either the raw PDF buffer (preferred — sent through OpenRouter
 *   as a native document so checkbox marks like the page-1 Loan Type
 *   boxes are visible; plain text extraction drops them) or already-
 *   extracted document text.
 */
export async function analyzeClosingDisclosure(input: { pdfBuffer: Buffer } | { documentText: string }): Promise<ClosingDisclosureAnalysis> {
  const systemPrompt = `You are a mortgage document analyzer. Extract key information from a Final Closing Disclosure (the 5-page TRID form given at closing).

You must respond with a valid JSON object containing the following fields:
- propertyAddress: string (the Property address on page 1, full address)
- lender: string (the Lender name on page 1)
- closingDate: string | null (the Closing Date on page 1 in ISO format "YYYY-MM-DD"; null if not found)
- firstPaymentDate: string | null (the first scheduled mortgage-payment due date in ISO format. If not printed directly, infer it from the Prepaid Interest date range: the first payment is generally one month after the prepaid-interest through/end date. Example: prepaid interest through 2026-09-01 means first payment 2026-10-01.)
- prepaidInterestThroughDate: string | null (the end date shown on the page-2 Prepaid Interest line, ISO "YYYY-MM-DD"; null if absent)
- purchasePrice: number (the Sale Price on page 1; 0 if this is a refinance CD with no sale price)
- loanAmount: number (the Loan Amount in Loan Terms — the original note amount)
- interestRate: number (the note Interest Rate as printed, e.g. 6.625 for 6.625%)
- loanTermMonths: number (Loan Term converted to months, e.g. 30 years = 360)
- principalAndInterest: number (Monthly Principal & Interest from Loan Terms / Projected Payments, years 1)
- escrowAmount: number (monthly Estimated Escrow from Projected Payments; 0 if escrow is waived)
- loanNumber: string | null (the Loan ID # / loan number on page 1 as a STRING preserving leading zeros and dashes; null if absent. Do NOT use the MIC #, file number, or phone numbers.)
- loanType: "conventional" | "fha" | "va" | null (page 1 has a "Loan Type" line with checkboxes: Conventional, FHA, VA, and sometimes a blank/other option. Return the CHECKED option in lowercase. If the checked box is a write-in/other program (e.g. USDA), or the checkbox is missing or unreadable, return null.)
- confidence: "high" | "medium" | "low"
- rawExtractedData: object with any other relevant fields

Respond with a JSON object only, no additional text.`;

  const userContent: OpenRouterContent =
    "pdfBuffer" in input
      ? [
          {
            type: "file",
            file: {
              filename: "closing-disclosure.pdf",
              file_data: `data:application/pdf;base64,${input.pdfBuffer.toString("base64")}`,
            },
          },
          { type: "text" as const, text: "Analyze this Closing Disclosure. Pay special attention to which Loan Type checkbox on page 1 is visually checked/marked." },
        ]
      : `Analyze this Closing Disclosure:\n\n${input.documentText}`;

  const response = await completeWithOpenRouter({
    purpose: "document",
    maxTokens: 2048,
    pdf: "pdfBuffer" in input,
    system: systemPrompt,
    content: userContent,
  });

  const raw = response.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = parseDocumentJson<ClosingDisclosureAnalysis>(raw);
  parsed.loanNumber = normalizeLoanNumber((parsed as any).loanNumber);
  // Normalize loan type — anything other than an exact match becomes null
  // (the client defaults to conventional).
  {
    const lt = String((parsed as any).loanType ?? "").trim().toLowerCase();
    parsed.loanType = lt === "conventional" || lt === "fha" || lt === "va" ? lt : null;
  }
  // Defensive normalization — the model occasionally returns strings.
  for (const k of ["purchasePrice", "loanAmount", "interestRate", "loanTermMonths", "principalAndInterest", "escrowAmount"] as const) {
    const n = Number((parsed as any)[k]);
    (parsed as any)[k] = Number.isFinite(n) ? n : 0;
  }
  // Strict validation — reject incomplete or implausible extractions so
  // a zero-balance / unknown-address loan can never enter the tracking
  // flow. The client surfaces this message to the user.
  if (typeof parsed.propertyAddress !== "string" || parsed.propertyAddress.trim().length < 5) {
    throw new Error("Couldn't find the property address on this document. Please upload the Final Closing Disclosure from your closing package.");
  }
  if (!(parsed.loanAmount > 10_000 && parsed.loanAmount < 20_000_000)) {
    throw new Error("Couldn't extract a valid loan amount from this document. Please upload the Final Closing Disclosure (page 1 shows the Loan Amount).");
  }
  if (!(parsed.interestRate > 0.5 && parsed.interestRate <= 15)) {
    throw new Error("Couldn't extract a valid interest rate from this document. Please check that this is the Final Closing Disclosure.");
  }
  if (!(parsed.loanTermMonths >= 12 && parsed.loanTermMonths <= 480)) {
    throw new Error("Couldn't extract a valid loan term from this document. Please check that this is the Final Closing Disclosure.");
  }
  if (parsed.closingDate) {
    const d = new Date(parsed.closingDate);
    if (isNaN(d.getTime()) || d.getTime() > Date.now()) parsed.closingDate = null;
  }
  const normalizeIsoDate = (value: unknown): string | null => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const d = new Date(`${text}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : text;
  };
  parsed.prepaidInterestThroughDate = normalizeIsoDate(
    (parsed as any).prepaidInterestThroughDate,
  );
  parsed.firstPaymentDate = normalizeIsoDate((parsed as any).firstPaymentDate);
  if (!parsed.firstPaymentDate && parsed.prepaidInterestThroughDate) {
    const through = new Date(`${parsed.prepaidInterestThroughDate}T00:00:00Z`);
    through.setUTCMonth(through.getUTCMonth() + 1);
    parsed.firstPaymentDate = through.toISOString().slice(0, 10);
  }
  if (!parsed.closingDate) {
    throw new Error("Couldn't find the closing date on this document — it's needed to estimate today's balance. Please upload the Final Closing Disclosure.");
  }
  return parsed;
}
