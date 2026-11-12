import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseEstimatorPage} from "./county-estimator-direct";
test("Polk uses the captured low end and subtracts letter assessments",()=>{
  const fixtures=JSON.parse(readFileSync("test/fixtures/estimators/polk-2026-estimator.json","utf8"));
  for(const f of fixtures) {
    const r=parseEstimatorPage("polk",f.html);
    assert.equal(r.adValoremCents,f.homestead?569600:648300);
    assert.equal(r.estimatorNavCents,0);
    assert.match(f.html,f.homestead?/\$6,416/:/\$7,203/);
    assert.match(f.html,/NonAvAssmnt=0/);
  }
});
