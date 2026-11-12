import assert from "node:assert/strict";
import { test } from "node:test";
import { hcpaOfficialLowEndAdValorem } from "./hillsborough-estimator";

/**
 * Captured 11 Nov 2026 from the live HCPA TaxEstimator API for
 * 100 N Tampa St, Tampa (PIN 1829244ZI000091000010A, folio 1936620000,
 * district TA): school 6.334, non-school 13.4013.
 * Dollars are the low end of the official page (price × 0.85), not a
 * countywide formula.
 */
const SCHOOL = 6.334;
const NON_SCHOOL = 13.4013;

test("Hillsborough low end matches the official page at $1,000,000", () => {
  assert.equal(
    hcpaOfficialLowEndAdValorem({
      purchasePrice: 1_000_000,
      homestead: false,
      schoolMills: SCHOOL,
      nonSchoolMills: NON_SCHOOL,
    }),
    16775.01,
  );
  assert.equal(
    hcpaOfficialLowEndAdValorem({
      purchasePrice: 1_000_000,
      homestead: true,
      schoolMills: SCHOOL,
      nonSchoolMills: NON_SCHOOL,
    }),
    15946.59,
  );
});

test("Hillsborough applies 85% once and rejects a non-positive price", () => {
  const once = hcpaOfficialLowEndAdValorem({
    purchasePrice: 400_000,
    homestead: false,
    schoolMills: 6,
    nonSchoolMills: 10,
  });
  const doubled = hcpaOfficialLowEndAdValorem({
    purchasePrice: 400_000 * 0.85,
    homestead: false,
    schoolMills: 6,
    nonSchoolMills: 10,
  });
  assert.ok(once != null && doubled != null);
  assert.ok(once > doubled);
  assert.equal(
    hcpaOfficialLowEndAdValorem({
      purchasePrice: 0,
      homestead: true,
      schoolMills: 6,
      nonSchoolMills: 10,
    }),
    null,
  );
});
