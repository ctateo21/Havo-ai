import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  TYPED_ANSWER_DEBOUNCE_MS,
  autosaveDelay,
  autosaveReady,
  restoreSavedWindAnswers,
} from "./insurance-answer-persistence";

test("restores saved wind answers, including confirmed report values, and user-set flags", () => {
  const restored = restoreSavedWindAnswers({
    quote_wind_answers: {
      reportAvailable: true,
      report: {
        reference: "WM-TEST-1", inspectionDate: "2025-06-01", transcribedFromReport: true,
        roofToWall: "Clips", roofDeck: "B", swr: "Yes", opening: "A", shape: "Hip",
      },
      shape: "Hip", allOpenings: "all", peelAndStick: "yes",
    },
    roof_shape_user_set: true,
    roof_material_user_set: false,
    swr_user_selected: true,
  });
  assert.ok(restored);
  assert.equal(restored.windAnswers.reportAvailable, true);
  assert.equal(restored.windAnswers.report?.roofToWall, "Clips");
  assert.equal(restored.windAnswers.allOpenings, "all");
  assert.equal(restored.roofShapeUserSet, true);
  assert.equal(restored.roofMaterialUserSet, false);
  assert.equal(restored.swrUserSelected, true);
});

test("invalid or missing wind answers fall back to defaults", () => {
  assert.equal(restoreSavedWindAnswers(undefined), null);
  assert.equal(restoreSavedWindAnswers({}), null);
  assert.equal(restoreSavedWindAnswers({ quote_wind_answers: { reportAvailable: true } }), null);
  assert.equal(restoreSavedWindAnswers({ quote_wind_answers: { shape: "Dome" } }), null);
});

test("autosave is gated until auth and this property's answers are hydrated", () => {
  const base = { authHydrated: true, address: "100 Example St", addressParam: "100 Example St",
    answersHydratedFor: "100 Example St", windHydratedFor: "100 Example St" };
  assert.equal(autosaveReady(base), true);
  assert.equal(autosaveReady({ ...base, authHydrated: false }), false);
  assert.equal(autosaveReady({ ...base, answersHydratedFor: null }), false);
  assert.equal(autosaveReady({ ...base, answersHydratedFor: "200 Sample Ave" }), false, "previous property's hydration does not count");
  assert.equal(autosaveReady({ ...base, windHydratedFor: "200 Sample Ave" }), false);
  assert.equal(autosaveReady({ ...base, address: " " }), false);
});

test("discrete changes save immediately; typed fields debounce ≤500 ms", () => {
  assert.ok(TYPED_ANSWER_DEBOUNCE_MS <= 500);
  const typed = [300000, null, 2010];
  assert.equal(autosaveDelay(null, typed), 0);
  assert.equal(autosaveDelay(JSON.stringify(typed), typed), 0, "only discrete answers changed");
  assert.equal(autosaveDelay(JSON.stringify(typed), [300001, null, 2010]), TYPED_ANSWER_DEBOUNCE_MS);
});

test("insurance page persists and restores every quote answer and flushes on hide", () => {
  const source = readFileSync(new URL("../pages/insurance.tsx", import.meta.url), "utf8");
  for (const key of ["quote_wind_answers", "quote_current_home", "quote_home_mortgage", "sq_ft_confirmed",
    "flood_zone_unknown", "roof_shape_user_set", "roof_material_user_set", "quote_has_claims",
    "quote_currently_insured", "quote_current_carrier", "quote_purchase_price", "aop_deductible"]) {
    assert.match(source, new RegExp(key), `${key} is persisted`);
  }
  assert.match(source, /restoreSavedWindAnswers\(/);
  assert.match(source, /autosaveReady\(/);
  assert.match(source, /saveInsuranceScenarioAnswers\(updated, \{ flush \}\)/);
  assert.match(source, /"pagehide"/);
  assert.match(source, /visibilitychange/);
  assert.doesNotMatch(source, /saveInsuranceScenarios\(next\)\)\.catch/, "autosave no longer rewrites every row");
});
