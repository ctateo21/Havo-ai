/**
 * Opt-in, synthetic-only live benchmark. Never imports borrower data or writes DB.
 * Run: npx tsx scripts/benchmark-ai.ts anthropic/claude-sonnet-4.5
 * Each model must run in its own process (model environment is process-local).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { jsPDF } from "jspdf";
import { analyzeClosingDisclosure, analyzeMortgageStatement } from "../server/anthropic-analyze";
import { buildPrompt, callMarketAi } from "../server/integrations/listing-market-analysis";

const model = process.argv[2];
if (!["anthropic/claude-opus-4.5", "anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4.5"].includes(model)) {
  throw new Error("Supply an explicitly approved benchmark model.");
}
process.env.OPENROUTER_DOCUMENT_MODEL = model;
process.env.OPENROUTER_MARKET_MODEL = model;
const originalFetch = globalThis.fetch;
let metering: any[] = [];
// Observe actual billed usage without changing the production request or logging secrets.
globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://openrouter.ai/api/v1/chat/completions") {
    throw new Error("Benchmark blocked unexpected network destination.");
  }
  const start = performance.now();
  const response = await originalFetch(input, init);
  const data = await response.clone().json().catch(() => ({}));
  metering.push({
    status: response.status, latencyMs: Math.round(performance.now() - start),
    model: data.model, cost: data.usage?.cost ?? null,
    promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens,
  });
  return response;
};

function disclosure(type: string, invalid = false) {
  const pdf = new jsPDF();
  pdf.setFontSize(12);
  const lines = [
    "SYNTHETIC BENCHMARK ONLY - NOT A REAL BORROWER",
    "Closing Disclosure", "Closing Date: 01/15/2025",
    "Property: 123 Synthetic Test St, Tampa, FL 33602", "Lender: Synthetic Bank",
    "Sale Price: $320,000", `Loan Amount: $${invalid ? "0" : "300,000"}`,
    "Interest Rate: 6.5%", "Loan Term: 30 years",
    "Monthly Principal & Interest: $1,896.20", "Estimated Escrow: $400.00 / month",
    "Loan ID #: 0000123-045", "MIC #: 99999999", "File #: 88888888",
    "Loan Type:",
  ];
  lines.forEach((line, i) => pdf.text(line, 15, 20 + i * 10));
  ["Conventional", "FHA", "VA", "Other (USDA)"].forEach((label, i) => {
    const x = 15 + i * 46;
    pdf.rect(x, 155, 4, 4);
    if (label === type) {
      // Vector marks, deliberately not text: text extraction cannot identify the selection.
      pdf.line(x, 155, x + 4, 159);
      pdf.line(x + 4, 155, x, 159);
    }
    pdf.text(label, x + 6, 159);
  });
  pdf.addPage();
  pdf.text(["Prepaids", "Prepaid Interest: 01/15/2025 through 02/01/2025",
    "First Payment Due: 03/01/2025", "Initial Escrow Payment at Closing: $2,400.00"], 15, 25);
  return Buffer.from(pdf.output("arraybuffer"));
}

const results: any[] = [];
async function measure(name: string, expected: Record<string, unknown>, run: () => Promise<any>, reject = false) {
  metering = [];
  const start = performance.now();
  try {
    const actual = await run();
    const checks = Object.entries(expected).map(([field, value]) => ({
      field, expected: value, actual: actual[field] ?? null, pass: actual[field] === value,
    }));
    results.push({ name, passed: !reject && checks.every(c => c.pass), checks,
      actual, latencyMs: Math.round(performance.now() - start), metering });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown benchmark error";
    results.push({ name, passed: reject && /valid loan amount/.test(error),
      error, latencyMs: Math.round(performance.now() - start), metering });
  }
  console.log(JSON.stringify({ model, ...results.at(-1), actual: undefined }));
  await mkdir("generated-artifacts/ai-benchmark", { recursive: true });
  await writeFile(`generated-artifacts/ai-benchmark/${model.split("/")[1]}.json`,
    JSON.stringify({ model, timestamp: new Date().toISOString(), results }, null, 2), { mode: 0o600 });
  if (metering.some(m => [401, 402, 403, 429].includes(m.status))) {
    throw new Error("Benchmark stopped: billing, permissions, or rate-limit restriction.");
  }
}

for (let repeat = 1; repeat <= 2; repeat++) {
  for (const [label, loanType] of [["Conventional", "conventional"], ["FHA", "fha"], ["VA", "va"], ["Other (USDA)", null]] as const) {
    await measure(`cd-${label}-${repeat}`, {
      loanType, loanNumber: "0000123-045", closingDate: "2025-01-15",
      firstPaymentDate: "2025-03-01", prepaidInterestThroughDate: "2025-02-01",
      loanAmount: 300000, interestRate: 6.5, loanTermMonths: 360,
      purchasePrice: 320000, principalAndInterest: 1896.2, escrowAmount: 400,
    }, () => analyzeClosingDisclosure({ pdfBuffer: disclosure(label) }));
  }
  await measure(`invalid-cd-${repeat}`, {}, () =>
    analyzeClosingDisclosure({ pdfBuffer: disclosure("VA", true) }), true);
  for (const balance of [1234.56, null]) {
    await measure(`statement-${balance}-${repeat}`, {
      loanNumber: "0000076-001", loanBalance: 287654.32, interestRate: 6.5,
      monthlyPayment: 2296.2, principalAndInterest: 1896.2, escrowAmount: 400,
      currentEscrowBalance: balance,
    }, () => analyzeMortgageStatement([
      "SYNTHETIC STATEMENT ONLY. Synthetic Bank.",
      "Property: 123 Synthetic Test St, Tampa, FL 33602",
      "Loan Number: 0000076-001. Escrow Account: 998877. Confirmation: 555555.",
      "Unpaid Principal Balance: $287,654.32. Interest Rate: 6.5%.",
      "Monthly Payment: $2,296.20. Principal & Interest: $1,896.20.",
      "Monthly Escrow: $400. Escrow Shortage: $777. Disbursement: $999.",
      balance === null ? "Current escrow balance not supplied." : `Current Escrow Balance: $${balance}.`,
    ].join("\n")));
  }
  await measure(`market-${repeat}`, { citationsRetained: true, subjectDom: 42,
    views: 120, saves: 7, noInventedPrivateEngagement: true }, async () => {
    const response = await callMarketAi(buildPrompt({
      listingId: "synthetic", userId: "synthetic", address: "Synthetic property (not an actual listing)",
      city: "Tampa", state: "FL", zip: "33602", listPrice: 450000,
      beds: 3, baths: 2, sqft: 1800, daysOnMarket: 42, onlineViews: 120, onlineSaves: 7,
    }, "2026-10-09"));
    const parsed = JSON.parse(response.raw);
    return { citationsRetained: response.citations.length > 0,
      subjectDom: parsed.days_on_market_analysis?.subject_dom,
      views: parsed.platform_engagement?.zillow?.views,
      saves: parsed.platform_engagement?.zillow?.saves,
      noInventedPrivateEngagement: ["realtor", "redfin"].every(p =>
        parsed.platform_engagement?.[p]?.views === null && parsed.platform_engagement?.[p]?.saves === null),
      citations: response.citations, recap: parsed };
  });
}
