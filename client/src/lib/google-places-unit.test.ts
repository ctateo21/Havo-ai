import assert from "node:assert/strict";
import test from "node:test";
import {
  addressWithUnit,
  componentsWithUnit,
  parsePlacesUnit,
} from "./google-places-unit";

test("ordinary addresses are unchanged", () => {
  assert.deepEqual(parsePlacesUnit("123 Main St, Tampa, FL 33602"), {
    buildingInput: "123 Main St, Tampa, FL 33602",
  });
});

test("parses supported unit designators before the city", () => {
  for (const input of [
    "123 Main St Unit 2, Tampa, FL 33602",
    "123 Main St apt. 2, Tampa, FL 33602",
    "123 Main St Apartment 2, Tampa, FL 33602",
    "123 Main St #2, Tampa, FL 33602",
  ]) {
    assert.deepEqual(parsePlacesUnit(input), {
      buildingInput: "123 Main St, Tampa, FL 33602",
      unit: "2",
    });
  }
});

test("parses an alphanumeric or hyphenated unit at the end", () => {
  assert.deepEqual(parsePlacesUnit("123 Main St, Tampa, FL 33602, UNIT A-12"), {
    buildingInput: "123 Main St, Tampa, FL 33602",
    unit: "A-12",
  });
});

test("an incomplete unit designator searches the building", () => {
  assert.deepEqual(parsePlacesUnit("123 Main St Unit"), {
    buildingInput: "123 Main St",
  });
});

test("puts the typed unit on the first street line without duplication", () => {
  assert.equal(
    addressWithUnit("123 Main St, Tampa, FL 33602", "2"),
    "123 Main St Unit 2, Tampa, FL 33602",
  );
  assert.equal(
    addressWithUnit("123 Main St Apt 2, Tampa, FL 33602", "2"),
    "123 Main St Unit 2, Tampa, FL 33602",
  );
  assert.equal(
    addressWithUnit("123 Main St Unit 9, Tampa, FL 33602", "2"),
    "123 Main St Unit 2, Tampa, FL 33602",
  );
});

test("typed unit replaces Google's subpremise component", () => {
  const components = [
    { long_name: "123", short_name: "123", types: ["street_number"] },
    { long_name: "Main Street", short_name: "Main St", types: ["route"] },
    { long_name: "9", short_name: "9", types: ["subpremise"] },
  ];
  const merged = componentsWithUnit(components, "2")!;
  assert.equal(merged.filter(component => component.types.includes("subpremise")).length, 1);
  assert.equal(merged.find(component => component.types.includes("subpremise"))?.long_name, "2");
  assert.equal(components[2].long_name, "9");
});