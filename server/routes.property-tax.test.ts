import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldUseHillsboroughPurchaseTaxRoute } from "./routes";

test("shared 33540 Zephyrhills route skips ZIP-only HCPA formula", () => {
  assert.equal(
    shouldUseHillsboroughPurchaseTaxRoute(
      "100 Main St, Zephyrhills, FL 33540",
    ),
    false,
  );
});

test("Hillsborough city still uses the Hillsborough purchase-tax route", () => {
  assert.equal(
    shouldUseHillsboroughPurchaseTaxRoute(
      "100 Main St, Tampa, FL 33602",
    ),
    true,
  );
});

test("non-Hillsborough ZIP never opts into the Hillsborough route", () => {
  assert.equal(
    shouldUseHillsboroughPurchaseTaxRoute(
      "100 Main St, Clearwater, FL 33755",
    ),
    false,
  );
});