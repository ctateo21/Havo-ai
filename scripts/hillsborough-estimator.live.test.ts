/**
 * Live check that 100 N Tampa St still resolves on the Hillsborough
 * Property Appraiser API and that our low-end figure is the page formula
 * applied to the mills that API returns right now.
 *
 * Run with the other county contract checks:
 *   npm run test:live:county-tax
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupPIN, fetchHcpaRatesForPin } from "../server/integrations/hillsborough-tax";
import { hcpaOfficialLowEndAdValorem } from "../server/integrations/hillsborough-estimator";

const ADDRESS = "100 N Tampa St, Tampa, FL 33602";
const PIN = "1829244ZI000091000010A";

test("Hillsborough live estimator identity and page formula", async () => {
  const found = await lookupPIN(ADDRESS);
  assert.ok(found, "HCPA did not resolve 100 N Tampa St");
  assert.equal(found.pin, PIN);
  assert.equal(found.folio, "1936620000");

  const rates = await fetchHcpaRatesForPin(found.pin);
  assert.ok(rates, "HCPA TaxEstimator returned no rates");
  assert.equal(rates.taxDistrict, "TA");
  assert.ok(Math.abs(rates.schoolTaxRate + rates.nonschoolTaxRate - rates.totalTaxRate) < 0.0001);

  const price = 1_000_000;
  const taxable = price * 0.85;
  const school = rates.schoolTaxRate * 0.001;
  const nonSchool = rates.nonschoolTaxRate * 0.001;
  const expectedNonHomestead = Number((taxable * (school + nonSchool)).toFixed(2));
  const expectedHomestead = Number((
    (taxable - 25_000) * school + (taxable - 50_000) * nonSchool
  ).toFixed(2));

  assert.equal(
    hcpaOfficialLowEndAdValorem({
      purchasePrice: price,
      homestead: false,
      schoolMills: rates.schoolTaxRate,
      nonSchoolMills: rates.nonschoolTaxRate,
    }),
    expectedNonHomestead,
  );
  assert.equal(
    hcpaOfficialLowEndAdValorem({
      purchasePrice: price,
      homestead: true,
      schoolMills: rates.schoolTaxRate,
      nonSchoolMills: rates.nonschoolTaxRate,
    }),
    expectedHomestead,
  );
  assert.ok(expectedHomestead < expectedNonHomestead);
});
