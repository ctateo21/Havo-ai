import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCashBuyFormulaTax,
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

test("cash-buy formula estimates remain usable and honor a request tuple when present", () => {
  const estimated = cashScenario({
    propertyTaxesSource: "estimated",
  });
  assert.equal(hasValidatedCashBuyPropertyTax(estimated), false);
  const withTuple = {
    ...estimated,
    propertyTaxesRequest: {
      address: estimated.address,
      purchasePrice: estimated.purchasePrice!,
      occupancyType: estimated.occupancyType!,
    },
  };
  assert.equal(hasValidatedCashBuyPropertyTax(withTuple), true);
  assert.equal(
    hasValidatedCashBuyPropertyTax({
      ...withTuple,
      purchasePrice: 510_000,
    }),
    false,
  );
  assert.equal(
    clearUnvalidatedCashBuyPropertyTax({
      ...withTuple,
      purchasePrice: 510_000,
    }).propertyTaxes,
    undefined,
  );
});

test("cash-buy formula population produces a positive non-homestead estimate", () => {
  const estimated = applyCashBuyFormulaTax(cashScenario({
    purchasePrice: 525_000,
    occupancyType: "investment",
    propertyTaxes: undefined,
    propertyTaxesSource: undefined,
    propertyTaxesRequest: undefined,
  }));
  assert.equal(estimated.propertyTaxes, 4_930);
  assert.equal(estimated.propertyTaxesSource, "estimated");
  assert.deepEqual(estimated.propertyTaxesRequest, {
    address: estimated.address,
    purchasePrice: 525_000,
    occupancyType: "investment",
  });
  assert.equal(hasValidatedCashBuyPropertyTax(estimated), true);
});

test("cash-buy formula population never overwrites an explicit manual zero", () => {
  const manual = cashScenario({
    purchasePrice: 525_000,
    propertyTaxes: 0,
    propertyTaxesSource: "manual",
  });
  assert.equal(applyCashBuyFormulaTax(manual), manual);
  assert.equal(hasValidatedCashBuyPropertyTax(manual), true);
});

test("verified county gate blocks formula population without explicit unavailable provenance", () => {
  const fresh = cashScenario({
    purchasePrice: 525_000,
    propertyTaxes: undefined,
    propertyTaxesSource: undefined,
    propertyTaxesRequest: undefined,
  });
  const unavailable = applyCashBuyFormulaTax(fresh, {
    isCountyEstimatorVerified: county => county === "collier",
  });
  assert.equal(unavailable.propertyTaxes, undefined);
  assert.equal(unavailable.propertyTaxesSource, "unavailable");
  assert.equal(unavailable.propertyTaxesRequest, undefined);
  assert.equal(hasValidatedCashBuyPropertyTax(unavailable), false);

  const manual = applyCashBuyFormulaTax({
    ...fresh,
    propertyTaxes: 0,
    propertyTaxesSource: "manual",
  }, {
    isCountyEstimatorVerified: () => true,
  });
  assert.equal(manual.propertyTaxes, 0);
  assert.equal(manual.propertyTaxesSource, "manual");
});

test("cash-buy formula population preserves an explicit unavailable result", () => {
  const unavailable = cashScenario({
    purchasePrice: 525_000,
    propertyTaxes: undefined,
    propertyTaxesSource: "unavailable",
  });
  assert.equal(applyCashBuyFormulaTax(unavailable), unavailable);
  assert.equal(hasValidatedCashBuyPropertyTax(unavailable), false);
});

test("cash-buy formula population does not replace a matching official result", () => {
  const official = cashScenario({
    purchasePrice: 525_000,
    propertyTaxes: 6_100,
    propertyTaxesSource: "official",
    propertyTaxesRequest: {
      address: "123 Main St, Naples, FL 34102",
      purchasePrice: 525_000,
      occupancyType: "primary",
    },
  });
  assert.equal(applyCashBuyFormulaTax(official, {
    isCountyEstimatorVerified: () => true,
  }), official);
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

test("purchase totals require explicit tax provenance", () => {
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
    true,
  );
});