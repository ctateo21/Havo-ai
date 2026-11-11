import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AFFORDABILITY_ASSUMPTIONS,
  FHA_AFFORDABILITY_ASSUMPTIONS,
  VA_AFFORDABILITY_ASSUMPTIONS,
  calculateBuyerAffordability,
  monthlyAmortizationFactor,
  purchasePriceFromHousingBudget,
} from "./buyer-affordability";

test("defaults existing callers to Conventional 43%–49% total DTI", () => {
  const result = calculateBuyerAffordability(8_000, 500);
  assert.ok(result);
  assert.equal(result.monthlyHousingBudgetLow, 2_940);
  assert.equal(result.monthlyHousingBudgetHigh, 3_420);
  assert.equal(result.purchasePriceLow % 5_000, 0);
  assert.equal(result.purchasePriceHigh % 5_000, 0);
});

test("Conventional debt is deducted from both DTI bands and clamps at zero", () => {
  const result = calculateBuyerAffordability(1_000, 450);
  assert.ok(result);
  assert.equal(result.monthlyHousingBudgetLow, 0);
  assert.equal(result.monthlyHousingBudgetHigh, 40);
  const fullyClamped = calculateBuyerAffordability(1_000, 600);
  assert.ok(fullyClamped);
  assert.equal(fullyClamped.monthlyHousingBudgetLow, 0);
  assert.equal(fullyClamped.monthlyHousingBudgetHigh, 0);
});

test("FHA uses 45%–55% total DTI less nonhousing debt", () => {
  const result = calculateBuyerAffordability(8_000, 500, undefined, "fha");
  assert.ok(result);
  assert.equal(result.monthlyHousingBudgetLow, 3_100);
  assert.equal(result.monthlyHousingBudgetHigh, 3_900);

  const clamped = calculateBuyerAffordability(1_000, 600, undefined, "fha");
  assert.ok(clamped);
  assert.equal(clamped.monthlyHousingBudgetLow, 0);
  assert.equal(clamped.monthlyHousingBudgetHigh, 0);
});

test("VA uses entered budget bounds and never creates an income-based cap", () => {
  assert.equal(calculateBuyerAffordability(20_000, 0, undefined, "va"), null);
  const result = calculateBuyerAffordability(8_000, 500, undefined, {
    program: "va",
    monthlyHousingBudgetLow: 2_000,
    monthlyHousingBudgetHigh: 2_500,
  });
  assert.ok(result);
  assert.equal(result.monthlyHousingBudgetLow, 2_000);
  assert.equal(result.monthlyHousingBudgetHigh, 2_500);
  assert.equal(result.actualTotalDtiLow, 0.3125);
  assert.equal(result.actualTotalDtiHigh, 0.375);
  assert.equal(calculateBuyerAffordability(0, 0, undefined, {
    program: "va",
    monthlyHousingBudgetLow: 2_500,
    monthlyHousingBudgetHigh: 2_000,
  }), null);
});

test("program costs include no VA PMI and FHA financed upfront MIP", () => {
  assert.equal(VA_AFFORDABILITY_ASSUMPTIONS.annualPmiPercentOfLoan, 0);
  assert.equal(FHA_AFFORDABILITY_ASSUMPTIONS.financedUpfrontMortgageInsurancePercent, 1.75);

  const budget = 3_000;
  const priceWithFinancedMip = purchasePriceFromHousingBudget(
    budget,
    FHA_AFFORDABILITY_ASSUMPTIONS,
  );
  const priceWithoutFinancedMip = purchasePriceFromHousingBudget(budget, {
    ...FHA_AFFORDABILITY_ASSUMPTIONS,
    financedUpfrontMortgageInsurancePercent: 0,
  });
  assert.ok(priceWithFinancedMip < priceWithoutFinancedMip);

  const baseLoanFraction = 0.965;
  const expectedCostPerDollar =
    baseLoanFraction * 1.0175 * monthlyAmortizationFactor(6.6, 30) +
    0.015 / 12 +
    baseLoanFraction * 0.0055 / 12;
  assert.ok(Math.abs(priceWithFinancedMip - (budget - 200) / expectedCostPerDollar) < 0.001);
});

test("requires positive income for income-derived programs and rejects negative debt", () => {
  assert.equal(calculateBuyerAffordability(0, 0), null);
  assert.equal(calculateBuyerAffordability(Number.NaN, 0), null);
  assert.equal(calculateBuyerAffordability(8_000, -1), null);
});

test("blank-equivalent zero debt is supported", () => {
  assert.deepEqual(
    calculateBuyerAffordability(8_000),
    calculateBuyerAffordability(8_000, 0),
  );
});

test("zero-rate amortization spreads principal evenly", () => {
  assert.equal(monthlyAmortizationFactor(0, 30), 1 / 360);
});

test("a budget below fixed expenses cannot produce a positive price", () => {
  assert.equal(
    purchasePriceFromHousingBudget(
      DEFAULT_AFFORDABILITY_ASSUMPTIONS.monthlyHomeownersInsurance,
    ),
    0,
  );
});