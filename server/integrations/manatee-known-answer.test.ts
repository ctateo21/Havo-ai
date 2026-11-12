import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseManateeRates} from "./manatee-official-rates";
import {MANATEE_RATES_LABEL,manateeAdValoremCents} from "../../shared/manatee-property-tax";
import {isCountyEstimatorVerified} from "../../shared/county-estimator-policy";
import {isOfficialEstimatorCacheSource,isCacheRowValid,computeFromCache} from "./property-tax-cache";
const fixture=(hx:boolean)=>JSON.parse(readFileSync(`test/fixtures/estimators/manatee_2051711709_${hx?"hx":"nohx"}.json`,"utf8"));
test("Manatee captured widget and flat exemptions match both prices",()=>{
  const data=fixture(false),r=parseManateeRates(data,"2051711709",313498,false,2026);
  assert.equal(data.taxes[0].c_just_value,313498);
  assert.deepEqual([r.schoolMills,r.nonSchoolMills,r.adValoremCents,r.estimatorNavCents],[6.275,8.4403,461322,28236]);
  assert.equal(Math.round(fixture(true).taxes[0].v_est_taxes*100),403433);
  assert.equal(fixture(true).taxes[0].v_savings,578.89);
  for(const [price,hx,av,total] of [[313498,false,461322,489558],[313498,true,403433,431669],[400000,false,588612,616848],[400000,true,530723,558959]] as const){
    const result=manateeAdValoremCents(price,hx,r.schoolMills!,r.nonSchoolMills!);
    assert.equal(result,av);assert.equal(result+28236,total);
  }
  assert.equal(r.sourceLabel,MANATEE_RATES_LABEL);
  assert.equal(isCountyEstimatorVerified("manatee"),false);
  assert.equal(isOfficialEstimatorCacheSource("manatee-official-rates"),false);
});
test("Manatee missing or wrong-year rates fail closed",()=>{
  assert.throws(()=>parseManateeRates({cols:[],rows:[]},"2051711709",400000,true,2026),/unavailable/);
  assert.throws(()=>parseManateeRates(fixture(false),"2051711709",400000,true,2027),/unavailable/);
});
test("Manatee component cache accepts new prices but rejects linear percentages",()=>{
  const row={parcelId:"2051711709",folio:null,source:"manatee-official-rates",schoolMillage:6.275,nonSchoolMillage:8.4403,
    assessmentRatio:1,homesteadSchoolExemption:25000,homesteadNonSchoolExemption:50000,rateYear:2026,
    nonAdValoremAmtCents:28236,homesteadAdValoremPct:4034.33/313498,nonHomesteadAdValoremPct:4613.22/313498,
    samplePrice:313498,expiresAt:new Date("2027-11-01T04:00:00Z")};
  assert.equal(isCacheRowValid(row,800000,new Date("2026-11-13")),true);
  assert.equal(computeFromCache(row,400000,true).annualTax,5589.59);
  assert.equal(computeFromCache(row,400000,false).annualTax,6168.48);
  assert.equal(isCacheRowValid({...row,schoolMillage:null},400000,new Date("2026-11-13")),false);
  assert.throws(()=>computeFromCache({...row,schoolMillage:null},400000,true),/unavailable/);
  assert.equal(isCacheRowValid({...row,assessmentRatio:.85},400000,new Date("2026-11-13")),false);
});
