import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearUnvalidatedCashBuyPropertyTax,
  hasValidatedCashBuyPropertyTax,
  hasValidatedPurchasePropertyTax,
  type CashBuyTaxScenario,
} from "./cash-buy-tax";
import type { PurchaseScenario } from "./auth";

function cashScenario(
  overrides: Partial<CashBuyTaxScenario> = {},
): CashBuyTaxScenario {
  return {
    id: "cash-tax-test",
    address: "123 Main St, Naples, FL 34102",
    savedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    purchasePrice: 500_000,
    occupancyType: "primary",
    propertyTaxes: 4_800,
    propertyTaxesSource: "manual",
    ...overrides,
  };
}

test("cash-buy manual tax values remain visible, including explicit zero", () => {
  const zero = cashScenario({ propertyTaxes: 0 });
  assert.equal(hasValidatedCashBuyPropertyTax(zero), true);
  assert.equal(clearUnvalidatedCashBuyPropertyTax(zero).propertyTaxes, 0);
  assert.equal(
    hasValidatedCashBuyPropertyTax(cashScenario({ propertyTaxes: 4_800 })),
    true,
  );
});

test("legacy cash-buy official values without a matching request tuple are cleared", () => {
  const legacy = cashScenario({ propertyTaxesSource: "official" });
  assert.equal(hasValidatedCashBuyPropertyTax(legacy), false);
  assert.equal(clearUnvalidatedCashBuyPropertyTax(legacy).propertyTaxes, undefined);
  assert.equal(
    clearUnvalidatedCashBuyPropertyTax(legacy).propertyTaxesSource,
    "default",
  );
});

test("cash-buy official tax is valid only for the exact lookup tuple", () => {
  const official = cashScenario({
    propertyTaxesSource: "official",
    propertyTaxesRequest: {
      address: "123 Main St, Naples, FL 34102",
      purchasePrice: 500_000,
      occupancyType: "primary",
    },
  });
  assert.equal(hasValidatedCashBuyPropertyTax(official), true);
  assert.equal(
    hasValidatedCashBuyPropertyTax({
      ...official,
      purchasePrice: 510_000,
    }),
    false,
  );
  assert.equal(
    hasValidatedCashBuyPropertyTax({
      ...official,
      occupancyType: "investment",
    }),
    false,
  );
});

function purchaseScenario(
  overrides: Partial<PurchaseScenario> = {},
): PurchaseScenario {
  return {
    id: "purchase-tax-test",
    address: "123 Main St, Naples, FL 34102",
    savedAt: "2026-01-01T00:00:00.000Z",
    annualTaxes: 0,
    ...overrides,
  };
}

test("purchase totals require manual or validated official tax provenance", () => {
  assert.equal(
    hasValidatedPurchasePropertyTax(purchaseScenario()),
    false,
  );
  assert.equal(
    hasValidatedPurchasePropertyTax(purchaseScenario({
      annualTaxes: 0,
      userAnswerSources: { annual_taxes: "manual" },
    })),
    true,
  );
  assert.equal(
    hasValidatedPurchasePropertyTax(purchaseScenario({
      annualTaxes: 4_800,
      userAnswerSources: { annual_taxes: "official" },
    })),
    true,
  );
  assert.equal(
    hasValidatedPurchasePropertyTax(purchaseScenario({
      annualTaxes: 4_800,
      userAnswerSources: { annual_taxes: "formula" },
    })),
    false,
  );
});