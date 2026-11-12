import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {directEstimator,parseEstimatorPage} from "./county-estimator-direct";
import {amountAfter,pageText} from "./county-tax-http";
import {composeOfficialTax} from "../../shared/official-tax";
const fixtures=JSON.parse(readFileSync("test/fixtures/estimators/sarasota-2026-estimator.json","utf8"));
test("Sarasota captured TRIM results use AV plus bill NAV, not estimator NAV",()=>{
  assert.equal(fixtures.length,2);
  for(const f of fixtures){
    const result=parseEstimatorPage("sarasota",f.html);
    const text=pageText(f.html);
    assert.match(text,/2026 TRIM/);
    assert.equal(amountAfter(text,/Estimated Assessed Value\s*:/i),35600000);
    assert.equal(result.adValoremCents,f.homestead?460100:518000);
    assert.equal(result.estimatorNavCents,114100);
    assert.equal(amountAfter(text,/Total Estimated Taxes:\s*/i),f.homestead?574200:632100);
    assert.equal(composeOfficialTax({cents:result.adValoremCents},{cents:96366}).total.cents,f.homestead?556466:614366);
    assert.equal(composeOfficialTax({cents:result.adValoremCents},{cents:null,reason:"Bill unavailable"}).total.cents,null);
  }
});
test("Sarasota follows I Agree with a result GET, never an input-form POST",async()=>{
  const real=globalThis.fetch;const calls:{url:string;method:string}[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=String(input);calls.push({url,method:init?.method??"GET"});
    if(calls.length===1)return new Response(`<form id="form1"><input type="hidden" name="__VIEWSTATE" value="proof"><button onclick="__doPostBack('ctl00$ContentPlaceHolder1$ctl01','')">I Agree</button></form>`);
    if(calls.length===2){
      const body=new URLSearchParams(String(init?.body));
      assert.equal(body.get("__VIEWSTATE"),"proof");
      assert.equal(body.get("__EVENTTARGET"),"ctl00$ContentPlaceHolder1$ctl01");
      return new Response(null,{status:302,headers:{location:"/TaxEstimator/TaxEst.aspx"}});
    }
    if(calls.length===3)return new Response('<input name="PurchasePriceTb">');
    const query=new URL(url).searchParams;
    assert.equal(query.get("price"),"400000");assert.equal(query.get("will_homestead"),"True");
    return new Response(fixtures.find((f:any)=>f.homestead).html);
  };
  try{
    const r=await directEstimator({county:"sarasota",parcelId:"0980038501",address:"1182 S SALFORD BLVD",purchasePrice:400000,homestead:true,taxYear:2026});
    assert.equal(r.adValoremCents,460100);
    assert.deepEqual(calls.map(c=>c.method),["GET","POST","GET","GET"]);
    assert.match(calls[3].url,/TaxEstOut\.aspx/);
  }finally{globalThis.fetch=real;}
});
test("Sarasota rejects an input-form bounce with status and final URL",async()=>{
  const real=globalThis.fetch;let count=0;
  globalThis.fetch=async(input)=>{
    count++;
    if(count===1)return new Response(`<button onclick="__doPostBack('ctl00$ContentPlaceHolder1$ctl01','')">I Agree</button>`);
    if(String(input).includes("TaxEstOut.aspx"))return new Response(null,{status:302,headers:{location:"/TaxEstimator/TaxEst.aspx"}});
    return new Response('<input name="PurchasePriceTb">Tax Estimator Step 1');
  };
  try{
    await assert.rejects(directEstimator({county:"sarasota",parcelId:"0980038501",address:"1182 S SALFORD BLVD",purchasePrice:400000,homestead:false,taxYear:2026}),/HTTP 200, final URL .*TaxEst\.aspx, body TaxEst.aspx input form/);
  }finally{globalThis.fetch=real;}
});
