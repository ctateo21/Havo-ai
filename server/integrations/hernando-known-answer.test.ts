import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseBrowserEstimatorPage} from "./county-estimator-browser";
import {COUNTY_TAX_WARNINGS} from "../../shared/official-tax";
test("Hernando retains published totals instead of recomposing inconsistent county lines",()=>{
  const rows=JSON.parse(readFileSync("test/fixtures/estimators/hernando-2026-estimator.json","utf8"));
  for(const r of rows){
    const result=parseBrowserEstimatorPage("hernando",r,"https://taxestimator.hernandocountypa-florida.us/taxestimator");
    assert.equal(result.adValoremCents,r.homestead?511014:566116);
  }
  assert.match(rows[0].text,/\$2,343\.95/);
  assert.match(rows[0].text,/\$2,579\.15/);
  assert.match(COUNTY_TAX_WARNINGS.hernando,/not recomputed/);
});
