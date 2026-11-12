import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OfficialTaxDisclosure } from "../components/official-tax-disclosure";
import {
  officialTaxRequestKey,
  parseOfficialTaxBreakdown,
  parseOfficialPropertyTaxResponse,
  resolvePurchasePropertyTaxSource,
} from "./official-property-tax";

const source = {
  name: "County estimator",
  url: "https://county.example/estimator",
  fetchedAt: "2026-02-12T18:34:00Z",
  taxYear: 2026,
  parcelId: "18-42-001",
  purchasePrice: 387500,
  homestead: true,
};
const full = () => ({
  adValorem: { cents: 487652, source },
  nonAdValorem: {
    cents: 32109,
    lines: [{ name: "Solid waste", amount: 32109 }],
    source: { ...source, name: "County tax collector", url: "https://county.example/bill" },
  },
  total: { cents: 519761 },
  warnings: ["County estimator excludes special assessments."],
});

test("breakdown integer cents are authoritative over a stale legacy annual total", () => {
  const parsed = parseOfficialPropertyTaxResponse({ annualTax: 9999, breakdown: full() });
  assert.equal(parsed.status, "available");
  if (parsed.status === "available") assert.equal(parsed.annualTax, 5197.61);
});

test("each missing component makes the entire total unavailable despite numeric legacy fields", () => {
  for (const key of ["adValorem", "nonAdValorem"] as const) {
    const breakdown = { ...full(), [key]: { cents: null, reason: `${key} lookup failed` } };
    const parsed = parseOfficialPropertyTaxResponse({
      annualTax: 5197.61, source: "county-estimator", breakdown,
    });
    assert.equal(parsed.status, "unavailable");
    assert.equal(parsed.breakdown?.[key].cents, null);
    assert.equal(parsed.breakdown?.total.cents, null);
    assert.match(parsed.breakdown?.total.reason ?? "", /lookup failed/);
  }
});

test("zero is valid only when explicitly supplied; missing, unsafe and mismatched cents fail closed", () => {
  const zero = { adValorem: { cents: 0 }, nonAdValorem: { cents: 0 }, total: { cents: 0 } };
  assert.equal(parseOfficialTaxBreakdown(zero)?.total.cents, 0);
  for (const invalid of [null, undefined, "0", -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseOfficialTaxBreakdown({ ...zero, nonAdValorem: { cents: invalid } })?.total.cents, null);
  }
  assert.equal(parseOfficialTaxBreakdown({ ...full(), total: { cents: 1 } })?.total.cents, null);
  assert.equal(parseOfficialTaxBreakdown({ adValorem: { cents: 2 }, nonAdValorem: { cents: 3 } })?.total.cents, null);
});

test("explicit unavailable response retains partial components, provenance and supplied warnings", () => {
  const breakdown = { ...full(), nonAdValorem: { cents: null, reason: "Collector timed out" } };
  const parsed = parseOfficialPropertyTaxResponse({ status: "unavailable", breakdown });
  assert.equal(parsed.status, "unavailable");
  assert.equal(parsed.breakdown?.adValorem.cents, 487652);
  assert.deepEqual(parsed.breakdown?.warnings, full().warnings);
});

test("request identity changes for each race-sensitive field and scenario", () => {
  const key = officialTaxRequestKey("sc1", "118 Florida Ave", 387500, true);
  assert.notEqual(key, officialTaxRequestKey("sc2", "118 Florida Ave", 387500, true));
  assert.notEqual(key, officialTaxRequestKey("sc1", "120 Florida Ave", 387500, true));
  assert.notEqual(key, officialTaxRequestKey("sc1", "118 Florida Ave", 387501, true));
  assert.notEqual(key, officialTaxRequestKey("sc1", "118 Florida Ave", 387500, false));
  assert.equal(key, officialTaxRequestKey("sc1", "118 Florida Ave", 387500, true));
});

test("official purchase gating rejects stale tuples, partial bills, legacy values and unsynced amounts", () => {
  const key = officialTaxRequestKey("sc1", "118 Florida Ave", 387500, true);
  const result = { key, breakdown: parseOfficialTaxBreakdown(full()) };
  assert.equal(resolvePurchasePropertyTaxSource(5197.61, "official", key, result), "official");
  assert.equal(resolvePurchasePropertyTaxSource(5197.61, undefined, key, result), "unavailable");
  assert.equal(resolvePurchasePropertyTaxSource(5197.61, "unavailable", key, result), "unavailable");
  assert.equal(resolvePurchasePropertyTaxSource(5197.60, "official", key, result), "unavailable");
  assert.equal(resolvePurchasePropertyTaxSource(0, "official", key, result), "unavailable");
  for (const stale of [
    officialTaxRequestKey("sc2", "118 Florida Ave", 387500, true),
    officialTaxRequestKey("sc1", "120 Florida Ave", 387500, true),
    officialTaxRequestKey("sc1", "118 Florida Ave", 387501, true),
    officialTaxRequestKey("sc1", "118 Florida Ave", 387500, false),
  ]) {
    assert.equal(resolvePurchasePropertyTaxSource(5197.61, "official", stale, result), "unavailable");
  }
  const partial = parseOfficialTaxBreakdown({ ...full(), nonAdValorem: { cents: null } });
  assert.equal(resolvePurchasePropertyTaxSource(5197.61, "official", key, { key, breakdown: partial }), "unavailable");
  assert.equal(resolvePurchasePropertyTaxSource(5197.61, "official", key, null), "unavailable");
});

test("manual bills including explicit zero stay manual regardless of price/address/homestead requests", () => {
  for (const annual of [0, 4821.17]) {
    assert.equal(resolvePurchasePropertyTaxSource(annual, "manual", "changed-request", null), "manual");
    assert.equal(resolvePurchasePropertyTaxSource(annual, "manual", "changed-request", {
      key: "old-request", breakdown: parseOfficialTaxBreakdown(full()),
    }), "manual");
  }
  assert.equal(resolvePurchasePropertyTaxSource(NaN, "manual", "request", null), "unavailable");
  assert.equal(resolvePurchasePropertyTaxSource(-1, "manual", "request", null), "unavailable");
});

test("disclosures render collector lines, separate links, Eastern fetched time, context and yellow warnings", () => {
  const html = renderToStaticMarkup(createElement(OfficialTaxDisclosure, {
    breakdown: parseOfficialTaxBreakdown(full()), loading: false,
  }));
  for (const text of ["$4,876.52", "$321.09", "$5,197.61", "Solid waste",
    "https://county.example/estimator", "https://county.example/bill",
    "America/New_York", "1:34:00 PM", "$387,500.00", "Homestead: yes", "bg-amber-50"]) {
    assert.ok(html.includes(text), text);
  }
});

test("partial disclosures show unavailable reason, no zero total, and spinner during requests", () => {
  const breakdown = parseOfficialTaxBreakdown({
    ...full(), nonAdValorem: { cents: null, reason: "Collector timed out" },
  });
  const html = renderToStaticMarkup(createElement(OfficialTaxDisclosure, { breakdown, loading: true }));
  assert.match(html, /Unavailable — Collector timed out/);
  assert.match(html, /text-muted-foreground/);
  assert.match(html, /role="status"/);
  assert.match(html, /animate-spin/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.doesNotMatch(html, /\$5,197\.61/);
});

test("invalid provenance URLs cannot become executable disclosure links", () => {
  const breakdown = parseOfficialTaxBreakdown({
    ...full(), adValorem: { cents: 487652, source: { ...source, url: "javascript:alert(1)" } },
  });
  assert.equal(breakdown?.adValorem.source, undefined);
});
