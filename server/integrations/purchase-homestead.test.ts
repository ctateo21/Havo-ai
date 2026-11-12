import {test} from "node:test";
import assert from "node:assert/strict";
import {purchaseHomestead,purchaseTaxVariantKey} from "../../shared/purchase-homestead";
import {officialParcelTax} from "./official-tax-pipeline";
import type {OfficialCache} from "./official-tax-cache";
const cases=[
  ["hillsborough",600000,923659,null],
  ["pinellas",289000,401800,487300],["pasco",400000,498848,672676],
  ["polk",400000,569600,648300],["sarasota",400000,460100,518000],
  ["lee",400000,427409,481043],["collier",750000,637000,671400],
  ["hernando",400000,511014,566116],["manatee",400000,530723,588612],
] as const;
for(const [county,price,hx,noHx] of cases) test(`${county} purchase occupancy never defaults or crosses homestead cache keys`,async()=>{
  const captured = {[purchaseTaxVariantKey(price,true)]:hx,[purchaseTaxVariantKey(price,false)]:noHx};
  for(const [use,expected] of [["primary",hx],["secondary",noHx],["investment",noHx]] as const){
    const flag=purchaseHomestead(use);
    assert.equal(flag,use==="primary");
    assert.equal(captured[purchaseTaxVariantKey(price,flag!)],expected);
  }
  assert.equal(purchaseHomestead(""),null);
  const unavailable=await officialParcelTax({county,parcelId:"sample",address:"sample",purchasePrice:price,taxYear:2026,homestead:undefined as any});
  assert.equal(unavailable.total.cents,null);
  assert.match(unavailable.total.reason!,/Select Property Use/);
});
for(const [county,price,hx,noHx] of cases.filter(c=>c[0]!=="hillsborough")) test(`${county} occupancy change reuses complete parcel cache without county calls`,async()=>{
  let cache:OfficialCache|null=null, calls=0;
  const env=county==="collier"?"COLLIER_BROWSER_ESTIMATOR":"HERNANDO_BROWSER_ESTIMATOR";
  const previous=process.env[env];process.env[env]="on";
  const provider=async(input:any)=>{
    calls++;
    return {adValoremCents:input.homestead?hx:noHx!,estimatorNavCents:0,
      url:"https://county.example/official",fetchedAt:"2026-11-12T00:00:00Z",snapshot:"",
      schoolMills:county==="manatee"?6.275:4.147,nonSchoolMills:county==="manatee"?8.4403:4.8052,
      assessmentRatio:1,exemptionSchedule:{homestead_school:25000,homestead_non_school:50000}};
  };
  const deps={
    readOfficialCache:async()=>cache,
    writeOfficialCache:async(value:OfficialCache)=>{cache=value;},
    directEstimator:provider,browserEstimator:provider,
    fetchOfficialBill:async()=>{calls++;return {adValoremCents:100,navCents:0,combinedCents:100,lines:[],taxYear:2026,url:"https://county.example/bill",fetchedAt:"2026-11-12T00:00:00Z",snapshot:""};},
  };
  const input={county,parcelId:"sample",address:"sample",purchasePrice:price,taxYear:2026,homestead:true};
  try{
    assert.equal((await officialParcelTax(input,false,deps)).adValorem.cents,hx);
    const warmCalls=calls;
    for(const use of ["investment","secondary","primary"]){
      assert.equal((await officialParcelTax({...input,homestead:purchaseHomestead(use)!},false,deps)).adValorem.cents,use==="primary"?hx:noHx);
      assert.equal(calls,warmCalls);
    }
  }finally{if(previous===undefined)delete process.env[env];else process.env[env]=previous;}
});
