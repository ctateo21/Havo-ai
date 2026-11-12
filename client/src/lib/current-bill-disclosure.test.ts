import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrentBillDisclosure } from "../components/refi/current-bill-disclosure";
import {
  buildCurrentTaxLookupPatch, buildManualPropertyTaxPatch,
  currentBillEvidenceToRow, currentBillFetchedAt, savedCurrentBillBreakdown,
} from "./property-tax-refi";
import { parseOfficialTaxBreakdown } from "./official-property-tax";

const source = {
  name: "County Tax Collector", url: "https://county.example/bill/18-42-001",
  fetchedAt: "2026-02-12T18:34:00Z", taxYear: 2025, parcelId: "18-42-001",
  purchasePrice: 0, homestead: false,
};
const breakdown = {
  adValorem: { cents: 487652, source },
  nonAdValorem: { cents: 32109, source: { ...source, fetchedAt: "2026-02-13T18:34:00Z" },
    lines: [{ name: "Solid waste", amount: 32109 }, { name: "CDD assessment", amount: 0 }] },
  total: { cents: 519761 }, warnings: ["Review the county bill for payment discounts."],
};
const response = { state: "ready", annualTax: 9999, taxYear: 2025,
  source: "tax-collector-bill-scrape", breakdown };

test("current bill preserves cents, links, parcel, lines and actual county timestamps across JSON persistence", () => {
  const patch = buildCurrentTaxLookupPatch(response)!;
  assert.equal(patch.annualPropertyTax, 5197.61);
  assert.equal(patch.annualPropertyTaxQueriedAt, source.fetchedAt);
  const row = JSON.parse(JSON.stringify(currentBillEvidenceToRow(patch)));
  const restored = savedCurrentBillBreakdown(row.annual_property_tax_breakdown,
    patch.annualPropertyTaxSource, patch.annualPropertyTax);
  assert.deepEqual(restored, patch.annualPropertyTaxBreakdown);
  assert.equal(currentBillFetchedAt(restored), source.fetchedAt);
  const html = renderToStaticMarkup(createElement(CurrentBillDisclosure, { breakdown: restored }));
  for (const text of [source.url, source.parcelId, "Feb 12, 2026", "1:34:00 PM EST",
    "America/New_York", "Solid waste", "CDD assessment", "$321.09", "$0.00", breakdown.warnings[0]]) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  assert.doesNotMatch(html, /county estimator|Purchase price|Homestead/);
});

test("manual commit clears every stale tax detail and persists explicit null evidence", () => {
  const manual = { ...buildCurrentTaxLookupPatch(response)!, ...buildManualPropertyTaxPatch(4799.99)! };
  assert.equal(manual.annualPropertyTaxBreakdown, null);
  for (const key of ["annualPropertyTaxQueriedAt", "annualPropertyTaxSourceLabel",
    "annualPropertyTaxAdValorem", "annualPropertyTaxNonAdValorem", "annualPropertyTaxCounty"] as const) {
    assert.equal(manual[key], undefined);
  }
  assert.deepEqual(currentBillEvidenceToRow(manual), {
    annual_property_tax_breakdown: null, annual_property_tax_queried_at: null,
  });
  const html = renderToStaticMarkup(createElement(CurrentBillDisclosure, { manual: true, breakdown }));
  assert.match(html, /Manual amount in use/);
  assert.ok(!html.includes(source.url));
});

test("legacy values never acquire provenance or a fabricated fetch time", () => {
  const patch = buildCurrentTaxLookupPatch({ ...response, breakdown: undefined })!;
  assert.equal(patch.annualPropertyTaxQueriedAt, undefined);
  assert.equal(patch.annualPropertyTaxBreakdown, null);
  assert.deepEqual(currentBillEvidenceToRow({ annualPropertyTax: 4800 }), {});
  const html = renderToStaticMarkup(createElement(CurrentBillDisclosure));
  assert.match(html, /were not saved with this value/);
  assert.doesNotMatch(html, /href=|Fetched/);
});

test("unavailable partial evidence remains visible but cannot produce a lookup patch", () => {
  const partial = { ...breakdown, nonAdValorem: { cents: null, reason: "Collector timed out" } };
  assert.equal(buildCurrentTaxLookupPatch({ ...response, breakdown: partial }), null);
  const html = renderToStaticMarkup(createElement(CurrentBillDisclosure, {
    breakdown: parseOfficialTaxBreakdown(partial), partial: true,
  }));
  assert.match(html, /Collector timed out/);
  assert.match(html, /did not replace the annual amount/);
  assert.ok(html.includes(source.url));
});

test("malformed saved provenance is stripped, mismatched or manual evidence is rejected", () => {
  for (const value of ["javascript:alert(1)", "not a URL"]) {
    const parsed = savedCurrentBillBreakdown({
      ...breakdown, adValorem: { ...breakdown.adValorem, source: { ...source, url: value } },
    }, response.source, 5197.61);
    assert.equal(parsed?.adValorem.source, undefined);
  }
  const invalidDate = parseOfficialTaxBreakdown({
    ...breakdown, adValorem: { ...breakdown.adValorem, source: { ...source, fetchedAt: "bad" } },
  });
  assert.equal(invalidDate?.adValorem.source, undefined);
  assert.equal(savedCurrentBillBreakdown(breakdown, "manual", 5197.61), undefined);
  assert.equal(savedCurrentBillBreakdown(breakdown, response.source, 1), undefined);
  assert.deepEqual(currentBillEvidenceToRow({
    annualPropertyTax: 1, annualPropertyTaxSource: "tax-collector-bill-scrape",
    annualPropertyTaxBreakdown: breakdown,
  }), { annual_property_tax_breakdown: null, annual_property_tax_queried_at: null });
});
