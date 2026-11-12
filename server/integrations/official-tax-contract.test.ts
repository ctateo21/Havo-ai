import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { composeOfficialTax } from "../../shared/official-tax";
import { officialTaxExpiry } from "./official-tax-cache";
import { calculateCollierPurchaseAdValorem } from "../../shared/collier-property-tax";
import { hcpaOfficialLowEndAdValorem } from "./hillsborough-estimator";
import { parseCountyBill, assertRealEstateAccount } from "./official-county-bills";
import { moneyCents } from "./county-tax-http";

test("county composition uses estimator AV plus collector NAV, in integer cents", () => {
  for(const [av,nav,total] of [[923659,28477,952136],[498848,435804,934652],[460100,96366,556466],[427409,37641,465050],[637000,26977,663977],[671400,26977,698377]]) {
    assert.equal(composeOfficialTax({cents:av},{cents:nav}).total.cents,total);
  }
  assert.equal(composeOfficialTax({cents:100},{cents:null,reason:"Bill missing"}).total.cents,null);
  assert.equal(composeOfficialTax({cents:null,reason:"Estimator unavailable"},{cents:0}).total.cents,null);
  assert.equal(composeOfficialTax({cents:100},{cents:0}).total.cents,100);
});
test("Collier supplied four known answers match its flat exemptions and floor", () => {
  const rates = {county:4.8052,school:4.147,municipal:0,other:0};
  for(const [price,hx,expected] of [[750000,false,6714],[750000,true,6370],[400000,false,3580],[400000,true,3236]] as const)
    assert.equal(calculateCollierPurchaseAdValorem(price,hx,rates),expected);
});
test("Hillsborough supplied low-end known answer", () => {
  assert.equal(hcpaOfficialLowEndAdValorem({purchasePrice:600000,homestead:true,schoolMills:6.334,nonSchoolMills:13.4013}),9236.59);
});
test("official cache expiry is strictly the next November 1 midnight Eastern", () => {
  assert.equal(officialTaxExpiry(new Date("2026-11-01T03:59:59Z")).toISOString(),"2026-11-01T04:00:00.000Z");
  assert.equal(officialTaxExpiry(new Date("2026-11-01T04:00:00Z")).toISOString(),"2027-11-01T04:00:00.000Z");
  assert.equal(officialTaxExpiry(new Date("2027-03-14T07:00:00Z")).toISOString(),"2027-11-01T04:00:00.000Z");
});
test("county money rejects missing values and retains cents", () => {
  assert.equal(moneyCents("$1,234.56"),123456);
  for(const bad of ["","Unavailable","-1","NaN"]) assert.throws(()=>moneyCents(bad));
});
test("captured Collier bill uses gross taxes, not November amount due", () => {
  const md = readFileSync("test/fixtures/estimators/collier-2026-bill-taxes.md","utf8");
  const bill = parseCountyBill(md,2026);
  assert.deepEqual([bill.adValoremCents,bill.navCents,bill.combinedCents],[472908,26977,499885]);
  assert.throws(()=>parseCountyBill(md.replace("Combined taxes and assessments: $4,998.85","Combined taxes and assessments: $4,798.90"),2026));
  assert.throws(()=>parseCountyBill(md,2027));
});
test("tangible accounts cannot become real-estate bills", () => {
  const root="https://county-taxes.net/fl-lee/property-tax/";
  assert.throws(()=>assertRealEstateAccount(root+Buffer.from("lee:tangible:123").toString("base64"),"lee"));
  assert.throws(()=>assertRealEstateAccount(root+Buffer.from("collier:real_estate:123").toString("base64"),"lee"));
  assert.doesNotThrow(()=>assertRealEstateAccount(root+Buffer.from("lee:real_estate:123").toString("base64"),"lee"));
});
