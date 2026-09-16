import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_CONSTRUCTION_SURCHARGE_PERCENT,
  getBaselineHomeownersInsuranceRate,
} from "./insurance-default";

test("general insurance baseline follows the six home-age bands", () => {
  const rate = (age: number) =>
    getBaselineHomeownersInsuranceRate({
      yearBuilt: 2026 - age,
      asOfYear: 2026,
    });

  assert.equal(rate(4), 0.0040);
  assert.equal(rate(5), 0.0050);
  assert.equal(rate(10), 0.0050);
  assert.equal(rate(11), 0.0055);
  assert.equal(rate(20), 0.0055);
  assert.equal(rate(21), 0.0060);
  assert.equal(rate(25), 0.0060);
  assert.equal(rate(26), 0.0075);
  assert.equal(rate(50), 0.0075);
  assert.equal(rate(51), 0.0090);
  assert.equal(Math.round(400_000 * rate(4)), 1_600);
});

test("frame construction adds exactly 0.15% to the age baseline", () => {
  const blockRate = getBaselineHomeownersInsuranceRate({
    yearBuilt: 1995,
    asOfYear: 2026,
  });
  const frameRate = getBaselineHomeownersInsuranceRate({
    yearBuilt: 1995,
    isFrameConstruction: true,
    asOfYear: 2026,
  });

  assert.ok(
    Math.abs((frameRate - blockRate) - FRAME_CONSTRUCTION_SURCHARGE_PERCENT) < Number.EPSILON,
  );
  assert.equal(Math.round(300_000 * frameRate) - Math.round(300_000 * blockRate), 450);
});