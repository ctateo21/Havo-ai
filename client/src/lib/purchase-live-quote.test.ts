import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_QUOTE_REUSE_MAX_AGE_MS } from "@shared/live-quote-reuse";
import { normalizeQuoteAddress } from "@shared/quote-address";
import {
  RUNNING_QUOTES_DETAIL,
  selectReusableLiveQuote,
  type SavedQuoteResult,
  type SharedLiveQuoteEstimate,
} from "./saved-insurance-quotes";
import { applyPurchaseQuotePrefill, type QuotePropertyAnswers } from "./purchase-insurance-prefill";
import { mergeOwnScenarioAnswers, type InsuranceScenarioAnswerStore, type OwnScenarioRow } from "../../../server/integrations/insurance-answers-routes";
import { SHARED_ESTIMATE_MAX_AGE_MS } from "../../../server/integrations/shared-live-quote-estimate";

const ADDRESS = "100 Example St, Tampa, FL 33602";
const NOW = new Date("2026-11-25T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function own(overrides: Partial<SavedQuoteResult> = {}, annual = 2400): SavedQuoteResult {
  return {
    addressNormalized: normalizeQuoteAddress(ADDRESS), policyType: "HO3", leadId: 1,
    completedAt: daysAgo(10), stale: false, bestCarrier: "Carrier A", bestAnnual: annual, occupancy: "primary",
    quotes: [{ siteName: "Carrier A", annualPremium: annual, monthlyPremium: annual / 12, coverageA: 300000,
      hurricaneDeductible: "2%", aop: "$1,000", quoteUrl: null, quoteDate: daysAgo(10), rank: 1 }],
    ...overrides,
  };
}
const shared = (d: number, annual = 2100): SharedLiveQuoteEstimate =>
  ({ annual, monthly: annual / 12, quotedDate: daysAgo(d), source: "recent_live_quote" });

test("one shared 90-day reuse window", () => {
  assert.equal(LIVE_QUOTE_REUSE_MAX_AGE_MS, 90 * 24 * 60 * 60 * 1000);
  assert.equal(SHARED_ESTIMATE_MAX_AGE_MS, LIVE_QUOTE_REUSE_MAX_AGE_MS);
});

test("a matching own quote from the last 90 days is reused with its date", () => {
  const pick = selectReusableLiveQuote({ address: ADDRESS, policyType: "HO3", occupancy: "primary", own: [own()], shared: shared(5), now: NOW });
  assert.equal(pick?.kind, "own");
  assert.equal(pick?.annual, 2400);
  assert.equal(pick?.quotedDate, daysAgo(10));
});

test("without an own match, the shared lowest estimate is shown as number + date only", () => {
  const pick = selectReusableLiveQuote({ address: ADDRESS, policyType: "HO3", occupancy: "primary", own: [], shared: shared(30), now: NOW });
  assert.deepEqual(pick, { kind: "shared", annual: 2100, monthly: 175, quotedDate: daysAgo(30) });
});

test("older or non-matching quotes fall back", () => {
  const base = { address: ADDRESS, policyType: "HO3", occupancy: "primary", now: NOW } as const;
  assert.equal(selectReusableLiveQuote({ ...base, own: [own({ completedAt: daysAgo(91) })], shared: shared(91) }), null, "older than 90 days");
  assert.equal(selectReusableLiveQuote({ ...base, own: [own({ policyType: "HO6" })], shared: null }), null, "other policy form");
  assert.equal(selectReusableLiveQuote({ ...base, own: [own({ occupancy: "investment" })], shared: null }), null, "other occupancy");
  assert.equal(selectReusableLiveQuote({ ...base, own: [own({ addressNormalized: normalizeQuoteAddress("200 Sample Ave, Tampa, FL 33602") })], shared: null }), null, "other address");
  assert.equal(selectReusableLiveQuote({ ...base, own: [own({ occupancy: null })], shared: null }), null, "unknown occupancy");
  // An older own quote falls back to a fresh shared one.
  assert.equal(selectReusableLiveQuote({ ...base, own: [own({ completedAt: daysAgo(120) })], shared: shared(3) })?.kind, "shared");
});

test("purchase inputs prefill only the transaction answers", () => {
  const saved: QuotePropertyAnswers = {
    newPurchase: false, purchaseDate: "2020-01-01", ho6ResidenceUse: "", ho6RentalTerm: "annual",
    purchasePrice: 250000, purchasePriceSource: "prior-sale", currentlyInsured: true, currentCarrier: "Old Carrier",
  };
  const next = applyPurchaseQuotePrefill(saved, { price: 425000, priceSource: "user", occupancy: "primary", closeDate: "2026-12-20" });
  assert.equal(next.newPurchase, true);
  assert.equal(next.purchaseDate, "2026-12-20");
  assert.equal(next.purchasePrice, 425000);
  assert.equal(next.purchasePriceSource, "user-confirmed-contract");
  assert.equal(next.ho6ResidenceUse, "primary");
  assert.equal(next.ho6RentalTerm, "", "rental term cleared for owner-occupied");
  assert.equal(next.currentlyInsured, null);
  const rental = applyPurchaseQuotePrefill(saved, { price: 0, priceSource: "estimate", occupancy: "investment" });
  assert.equal(rental.ho6RentalTerm, "annual");
  assert.equal(rental.purchasePrice, 250000, "a missing purchase price keeps the saved one");
  assert.equal(rental.purchaseDate, "2020-01-01");
});

const pagesDir = fileURLToPath(new URL("../pages/", import.meta.url));
const estimateSrc = readFileSync(join(pagesDir, "estimate.tsx"), "utf8");
const insuranceSrc = readFileSync(join(pagesDir, "insurance.tsx"), "utf8");

test("purchase page embeds the Insurance tab's questionnaire instead of a copy", () => {
  assert.match(estimateSrc, /import \{ InsuranceQuoteWorkspace \} from "@\/pages\/insurance"/);
  assert.match(estimateSrc, /<InsuranceQuoteWorkspace embedded=\{\{ address, purchase: inlineInsurancePurchase \}\} \/>/);
  assert.doesNotMatch(estimateSrc, /qr-start/, "qr-start is only built by the shared workspace");
  assert.doesNotMatch(estimateSrc, /setLocation\(`\/insurance\?address/, "Get a Live Quote no longer navigates away");
  // One qr-start request builder, used by both the tab and the embedded view.
  assert.equal(insuranceSrc.match(/"\/api\/insurance\/qr-start"/g)?.length ?? 0, 1);
  const embeddedBranch = insuranceSrc.slice(insuranceSrc.indexOf("if (embedded) {\n    return ("));
  assert.match(embeddedBranch.slice(0, 600), /\{estimateCard\}[\s\S]*\{liveQuotesCard\}[\s\S]*\{dialogs\}/);
  assert.match(insuranceSrc, /export default function InsuranceDashboard\(\) \{\n  return <InsuranceQuoteWorkspace \/>;/);
});

test("the click alert never blocks or shows an error on the purchase page", () => {
  const handler = estimateSrc.slice(estimateSrc.indexOf("const notifyLiveQuoteClick"), estimateSrc.indexOf("const handleGetLiveInsuranceQuote"));
  assert.match(handler, /void authedFetch\("\/api\/insurance\/live-quote-click"/);
  assert.doesNotMatch(estimateSrc, /Live quote request not sent|team alert could not be confirmed/);
  assert.doesNotMatch(estimateSrc + insuranceSrc, /FUB click|\bFUB\b[^"]*"\)/);
});

test("embedded view never reads guest drafts for a signed-in user", () => {
  const hook = readFileSync(fileURLToPath(new URL("../hooks/use-anonymous-draft.ts", import.meta.url)), "utf8");
  assert.match(hook, /const disabled = useContext\(AnonymousDraftsDisabledContext\)/);
  assert.match(hook, /useRef\(!disabled && \(!getSession\(\) \|\| hasPendingAnonymousAccountDraft\(\)\)\)/);
  assert.match(insuranceSrc, /<AnonymousDraftsDisabledContext.Provider value=\{true\}>/);
  assert.match(insuranceSrc, /useRef\(!embedded && \(!user \|\| hasPendingAnonymousAccountDraft\(\)\)/);
  assert.match(estimateSrc, /showInlineInsuranceQuote && authUser/);
});

function memoryStore() {
  const rows: Array<OwnScenarioRow & { user_id: string } & Record<string, unknown>> = [];
  const store: InsuranceScenarioAnswerStore = {
    async listOwn(userId) { return rows.filter(r => r.user_id === userId).map(r => ({ ...r })); },
    async updateOwn(userId, id, values) { Object.assign(rows.find(r => r.id === id && r.user_id === userId)!, values); },
    async insertOwn(userId, values) { rows.push({ ...(values as any), user_id: userId }); },
  };
  return { rows, store };
}

test("one insurance scenario per property: purchase-page runs reuse the Insurance-tab row", async () => {
  const { rows, store } = memoryStore();
  // First save from the purchase page creates the card.
  const created = await mergeOwnScenarioAnswers(store, "user-1", {
    id: "from-purchase", address: ADDRESS, normalizedPropertyKey: "100-example-st-tampa-fl-33602",
    columns: {}, answers: { quote_purchase_price: 425000, quote_new_purchase: true },
  });
  assert.equal(created.created, true);
  // The Insurance tab (no local id yet, differently formatted address) reuses it.
  const reused = await mergeOwnScenarioAnswers(store, "user-1", {
    id: "from-tab", address: "100 EXAMPLE ST,  TAMPA, FL 33602", columns: {}, answers: { roof_year: 2018 },
  });
  assert.equal(reused.created, false);
  assert.equal(reused.id, "from-purchase");
  assert.equal(rows.filter(r => r.user_id === "user-1").length, 1);
  // Answers persist server-side and are restored for the same user on a fresh load.
  const [fresh] = await store.listOwn("user-1");
  assert.deepEqual(fresh.user_answer_sources, { quote_purchase_price: 425000, quote_new_purchase: true, roof_year: 2018 });
  assert.deepEqual(await store.listOwn("user-2"), [], "not visible to another user");
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|html)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

test("no quote timing promises remain", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files = [...walk(join(root, "client/src")), ...walk(join(root, "server")), ...walk(join(root, "shared"))];
  const banned = [/Usually 2[–-]5 minutes/i, /This takes a few minutes/i, /within 60 seconds/i, /\belapsed\b[^"`]*(Usually|minutes)/i, /\} elapsed/];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const re of banned) assert.doesNotMatch(text, re, `${file} still contains ${re}`);
  }
  assert.equal(RUNNING_QUOTES_DETAIL, "We'll email you when your quotes are ready, and they'll be here when you come back.");
});
