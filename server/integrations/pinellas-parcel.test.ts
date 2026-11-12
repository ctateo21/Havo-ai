import {test} from "node:test";
import assert from "node:assert/strict";
import {selectPinellasQuicksearch} from "./pinellas-parcel";
import {pinellasEstimatorStrap} from "./county-estimator-direct";
import {parseEstimatorPage} from "./county-estimator-direct";
import {readFileSync} from "node:fs";
const row=['<input name="select_strap_1" value="163106928620800010">',"","","","06-31-16-92862-080-0010","7400 36TH AVE N"];
test("captured Pinellas county answers match both homestead settings",()=>{
  const fixtures=JSON.parse(readFileSync("test/fixtures/estimators/pinellas-2026-estimator.json","utf8"));
  for(const f of fixtures) {
    const r=parseEstimatorPage("pinellas",f.snapshot);
    assert.equal(r.adValoremCents,f.homestead?401800:487300);
    assert.equal(r.estimatorNavCents,0);
  }
});
test("Pinellas keeps the dashed collector parcel distinct from the estimator strap",()=>{
  const result=selectPinellasQuicksearch([row],"7400 36th Ave N")!;
  assert.equal(result.account,"06-31-16-92862-080-0010");
  assert.equal(result.strap,"163106928620800010");
  assert.equal(pinellasEstimatorStrap(result.account),result.strap+"--0");
});
test("Pinellas rejects prefix, duplicate and inconsistent identity matches",()=>{
  assert.equal(selectPinellasQuicksearch([row],"7400 36th"),null);
  assert.equal(selectPinellasQuicksearch([row,row],"7400 36th Ave N"),null);
  assert.equal(selectPinellasQuicksearch([[...row.slice(0,4),"06-31-16-92862-080-0020",row[5]]],"7400 36th Ave N"),null);
});
