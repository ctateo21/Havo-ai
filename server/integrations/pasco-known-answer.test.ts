import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseEstimatorPage} from "./county-estimator-direct";
import {composeOfficialTax,COUNTY_TAX_WARNINGS} from "../../shared/official-tax";
test("captured Pasco answers use bill NAV, not the estimator NAV",()=>{
  const fixtures=JSON.parse(readFileSync("test/fixtures/estimators/pasco-2026-estimator.json","utf8"));
  for(const f of fixtures) {
    const r=parseEstimatorPage("pasco",f.snapshot);
    assert.equal(r.adValoremCents,f.homestead?498848:672676);
    assert.equal(r.estimatorNavCents,374977);
    assert.equal(r.adValoremCents+435804,f.homestead?934652:1108480);
  }
  assert.match(COUNTY_TAX_WARNINGS.pasco,/\$150,000/);
  assert.match(COUNTY_TAX_WARNINGS.pasco,/\$51,411/);
});
