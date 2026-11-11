import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveAnnualFloodInsurance,
  FLOOD_HOA_ASSUMPTION_NOTE,
  sanitizeSavedPurchaseFloodSnapshot,
  suppressSeparateFloodInsurance,
} from "../../../shared/flood-insurance-policy";

test("separate flood insurance is suppressed for excluded canonical property types", () => {
  for (const propertyType of ["Condominium", "Townhouse", "Villa", "Land"]) {
    assert.equal(suppressSeparateFloodInsurance(propertyType), true, propertyType);
  }
});

test("excluded property type aliases are recognized", () => {
  for (const propertyType of [
    "condo",
    "Condo Unit",
    "attached condominium",
    "townhome",
    "town house",
    "TOWN_HOME",
    "attached villa",
    "vacant land",
    "residential lot",
    "LOT",
  ]) {
    assert.equal(suppressSeparateFloodInsurance(propertyType), true, propertyType);
  }
});

test("nonexcluded and unknown property types retain separate flood insurance", () => {
  for (const propertyType of [
    "Single Family Residence",
    "Manufactured Home",
    "Multi-Family",
    "Duplex",
    "Other",
    "",
    null,
    undefined,
  ]) {
    assert.equal(suppressSeparateFloodInsurance(propertyType), false, String(propertyType));
  }
});

test("effective annual amount sanitizes saved amounts for excluded types", () => {
  assert.equal(effectiveAnnualFloodInsurance("Condo", 2_000), 0);
  assert.equal(effectiveAnnualFloodInsurance("town-home", 875), 0);
  assert.equal(effectiveAnnualFloodInsurance("Villa", undefined), 0);
  assert.equal(effectiveAnnualFloodInsurance("Land", null), 0);
  assert.equal(effectiveAnnualFloodInsurance("Single Family Residence", 2_000), 2_000);
  assert.equal(effectiveAnnualFloodInsurance("Single Family Residence", null), 0);
});

test("HOA assumption note tells borrowers to verify the master policy", () => {
  assert.match(FLOOD_HOA_ASSUMPTION_NOTE, /assumed.*HOA/i);
  assert.match(FLOOD_HOA_ASSUMPTION_NOTE, /verify.*master policy/i);
});

test("purchase hydration removes a legacy excluded flood component exactly once", () => {
  const hydrated = sanitizeSavedPurchaseFloodSnapshot("Condo", 2_400, 3_000);
  assert.deepEqual(hydrated, {
    annualFloodIns: 0,
    monthlyPayment: 2_800,
  });

  assert.deepEqual(
    sanitizeSavedPurchaseFloodSnapshot(
      "Condo",
      hydrated.annualFloodIns,
      hydrated.monthlyPayment,
    ),
    hydrated,
  );
});

test("direct purchase serialization is coherent and leaves valid snapshots alone", () => {
  assert.deepEqual(
    sanitizeSavedPurchaseFloodSnapshot("Villa", 2_400, 3_000),
    { annualFloodIns: 0, monthlyPayment: 2_800 },
  );
  assert.deepEqual(
    sanitizeSavedPurchaseFloodSnapshot("Single Family Residence", 2_400, 3_000),
    { annualFloodIns: 2_400, monthlyPayment: 3_000 },
  );
  assert.deepEqual(
    sanitizeSavedPurchaseFloodSnapshot("Condo", 0, 2_800),
    { annualFloodIns: 0, monthlyPayment: 2_800 },
  );
});