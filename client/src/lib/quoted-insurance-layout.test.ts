import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  RANKED_QUOTE_CLASS,
  WINNER_QUOTE_HIGHLIGHT_CLASS,
  hasRealCarrierQuote,
  insuranceCardHighlightClass,
  insuranceCardSummary,
  rankedQuoteClass,
  savedQuotesLayout,
  type SavedQuoteResult,
} from "./saved-insurance-quotes";

function result(overrides: Partial<SavedQuoteResult> = {}): SavedQuoteResult {
  return {
    addressNormalized: "100 example st tampa fl 33607",
    policyType: "HO3",
    leadId: 1,
    completedAt: "2026-11-20T12:00:00.000Z",
    stale: false,
    bestCarrier: "Example Mutual",
    bestAnnual: 2182,
    quotes: [
      { siteName: "Example Mutual", annualPremium: 2182, monthlyPremium: 181.83, coverageA: 400000, hurricaneDeductible: "2%", aop: "$2,500", quoteUrl: null, quoteDate: "", rank: 1 },
      { siteName: "Sample Casualty", annualPremium: 2400, monthlyPremium: 200, coverageA: 400000, hurricaneDeductible: "2%", aop: "$2,500", quoteUrl: null, quoteDate: "", rank: 2 },
    ],
    ...overrides,
  };
}

test("dashboard card is highlighted only when real carrier quotes exist", () => {
  const quoted = insuranceCardSummary(2600, true, result());
  assert.equal(hasRealCarrierQuote(quoted), true);
  assert.equal(insuranceCardHighlightClass(quoted), WINNER_QUOTE_HIGHLIGHT_CLASS);

  const estimate = insuranceCardSummary(2600, true, null);
  assert.equal(hasRealCarrierQuote(estimate), false);
  assert.equal(insuranceCardHighlightClass(estimate), "");

  const notStarted = insuranceCardSummary(null, false, null);
  assert.equal(insuranceCardHighlightClass(notStarted), "");

  // A saved result with a zero premium is not a real quote.
  const zero = insuranceCardSummary(2600, true, result({
    quotes: [{ ...result().quotes[0], annualPremium: 0, monthlyPremium: 0 }],
  }));
  assert.equal(zero.status, "Estimate");
  assert.equal(insuranceCardHighlightClass(zero), "");
});

test("dashboard card names the winning (lowest) carrier with its premium", () => {
  const quoted = insuranceCardSummary(2600, true, result());
  assert.equal(quoted.carrier, "Example Mutual");
  assert.equal(quoted.annual, 2182);
  assert.equal(quoted.monthly, 181.83);
  assert.equal(insuranceCardSummary(2600, true, null).carrier, null);
});

test("card highlight reuses the #1 ranked quote tokens", () => {
  assert.equal(rankedQuoteClass(0), WINNER_QUOTE_HIGHLIGHT_CLASS);
  assert.equal(rankedQuoteClass(1), RANKED_QUOTE_CLASS);
  assert.equal(rankedQuoteClass(2), RANKED_QUOTE_CLASS);
});

test("returning with saved quotes: quotes on top, rating details collapsed by default", () => {
  assert.deepEqual(savedQuotesLayout(true, false), { savedQuotesOnTop: true, ratingDetailsCollapsed: true });
  // Opening the details restores the full editor; quotes stay on top.
  assert.deepEqual(savedQuotesLayout(true, true), { savedQuotesOnTop: true, ratingDetailsCollapsed: false });
});

test("no saved quotes (first visit or a run in progress): layout unchanged, details open", () => {
  assert.deepEqual(savedQuotesLayout(false, false), { savedQuotesOnTop: false, ratingDetailsCollapsed: false });
  assert.deepEqual(savedQuotesLayout(false, true), { savedQuotesOnTop: false, ratingDetailsCollapsed: false });
});

test("pages wire the shared highlight, toggle and disclosure", () => {
  const page = readFileSync(new URL("../pages/insurance.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../pages/dashboard.tsx", import.meta.url), "utf8");
  // Both ranked lists use the shared winner tokens; no hard-coded copies remain.
  assert.equal((page.match(/rankedQuoteClass\(i\)/g) ?? []).length, 2);
  assert.doesNotMatch(page, /"border-yellow-300 bg-yellow-50"/);
  assert.match(dashboard, /insuranceCardHighlightClass\(summary\)/);
  // Accessible expand control tied to the collapsible region.
  assert.match(page, /aria-expanded=\{!ratingDetailsCollapsed\}/);
  assert.match(page, /aria-controls="insurance-rating-details"/);
  assert.match(page, /id="insurance-rating-details"/);
  // The saved quotes keep the Tateo & Co. disclosure wherever they render.
  assert.match(page, /const savedQuotesBlock[\s\S]*Real-time carrier rates via Tateo &amp; Co[\s\S]*const liveQuotesCard/);
});
