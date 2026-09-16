import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateAnnualTax } from "./county-tax-estimator";

test("supported county fallbacks expose one already-calibrated low-end estimate", () => {
  const purchasePrice = 333_333;
  const cases = [
    ["Hillsborough County, FL", 0.015498, 0.0189],
    ["Pinellas County, FL", 0.01517, 0.0185],
    ["Pasco County, FL", 0.0141, 0.0172],
    ["Manatee County, FL", 0.01197, 0.0146],
    ["Sarasota County, FL", 0.0105, 0.0128],
    ["Hernando County, FL", 0.01197, 0.0146],
    ["Lee County, FL", 0.01148, 0.014],
    ["Collier County, FL", 0.00825, 0.00939],
    ["Polk County, FL", 0.01263, 0.0154],
  ] as const;

  for (const [address, homesteadRate, nonHomesteadRate] of cases) {
    assert.equal(
      estimateAnnualTax(address, purchasePrice, true),
      Math.round(purchasePrice * homesteadRate),
      address,
    );
    assert.equal(
      estimateAnnualTax(address, purchasePrice, false),
      Math.round(purchasePrice * nonHomesteadRate),
      address,
    );
  }
});
