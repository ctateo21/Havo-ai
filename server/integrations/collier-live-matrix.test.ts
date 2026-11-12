import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {calculateCollierPurchaseAdValorem} from "../../shared/collier-property-tax";
test("Collier recomputation matches all four captured browser answers",()=>{
  const rows=JSON.parse(readFileSync("test/fixtures/estimators/collier-2026-live-matrix.json","utf8"));
  assert.equal(rows.length,4);
  const expected=[671400,637000,358000,323600];
  rows.forEach((r:any,i:number)=>{
    assert.equal(r.adValoremCents,expected[i]);
    assert.equal(r.schoolMills,4.147);
    assert.equal(r.nonSchoolMills,4.8052);
    assert.equal(r.navCents,26977);
    assert.equal(calculateCollierPurchaseAdValorem(r.price,r.homestead,{school:r.schoolMills,county:r.nonSchoolMills,municipal:0,other:0})*100,r.adValoremCents);
  });
  assert.equal(rows[1].adValoremCents+26977,663977);
  assert.equal(rows[0].adValoremCents+26977,698377);
});
