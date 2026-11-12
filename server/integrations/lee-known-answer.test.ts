import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseLeeTaxResponse} from "./county-estimator-direct";
import {parseCountyBill} from "./official-county-bills";
test("Lee captured estimator and collector answers compose without estimated NAV",()=>{
  const response=JSON.parse(readFileSync("test/fixtures/estimators/lee-2026-estimator.json","utf8"));
  assert.equal(Number(response.AssessedValue),360000);
  const bill=parseCountyBill(readFileSync("test/fixtures/estimators/lee-2026-bill-taxes.md","utf8"),2026);
  assert.equal(bill.navCents,37641);
  assert.equal(bill.combinedCents,265884);
  assert.equal(parseLeeTaxResponse(response,true),427409);
  assert.equal(parseLeeTaxResponse(response,false),481043);
  assert.equal(parseLeeTaxResponse(response,true)+bill.navCents,465050);
  assert.throws(()=>parseLeeTaxResponse({},true),/missing/);
});
