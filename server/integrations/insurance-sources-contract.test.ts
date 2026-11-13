import {test} from "node:test";
import assert from "node:assert/strict";
import {geocodeAddress} from "./geocode";
import {lookupFemaNfhl} from "./property-characteristics";
import {parseDorRows,parseHcpaBuilding,lookupDorBuilding} from "./insurance-building-sources";
import {quoteAnswerIdentity,canReuseAnsweredQuote} from "./quote-answer-identity";
import {callbackTokenMatches} from "./quoterush-import-jobs";
import {createHash} from "node:crypto";
import {prepareQuoteRushStartRequest} from "./quoterush-start-request";
import {quoteRushResultsContent} from "./property-alert-emails";
import {readFileSync} from "node:fs";
const dor={PHY_ADDR1:"7400 36TH AVE N",PHY_ZIPCD:"33710",PARCEL_ID:"16 31 06 92862 080 0010",ACT_YR_BLT:1958,EFF_YR_BLT:1988,TOT_LVG_AR:1166,ASMNT_YR:2026};
const request={address:"7400 36th Ave N, St. Petersburg, FL 33710",policyType:"HO3",coverageA:300000,yearBuilt:1958,roofYear:2020,sqFt:1166,sqFtConfirmed:true,hasClaims:false,claimRecords:[],constIdx:0,windIdx:1,hurrIdx:1,newPurchase:true,policyEffectiveDate:"2026-12-01",purchasePrice:289000,purchasePriceSource:"user-confirmed-contract",usageType:"primary",floodZone:"X"};
test("Census supplies county without Google; dedicated server key fallback only",async()=>{
  let calls=0;const census:any=async()=>{calls++;return Response.json({result:{addressMatches:[{coordinates:{x:-82.741,y:27.8045},matchedAddress:"7400 36TH AVE N",addressComponents:{zip:"33710"},geographies:{Counties:[{NAME:"Pinellas County",GEOID:"12103"}]}}]}});};
  assert.equal((await geocodeAddress(request.address,{fetchImpl:census,serverKey:"test-only"}))?.countyFips,"12103");assert.equal(calls,1);
  calls=0;const fallback:any=async(url:string)=>{calls++;if(calls===1)throw Error("offline");assert.equal(new URL(url).searchParams.get("key"),"test-only");return Response.json({results:[{geometry:{location:{lat:27.8,lng:-82.7}},address_components:[{types:["administrative_area_level_2"],long_name:"Pinellas County"}],formatted_address:"A"}]});};
  assert.equal((await geocodeAddress("A",{fetchImpl:fallback,serverKey:"test-only"}))?.source,"Google Geocoding");
  assert.equal(await geocodeAddress("A",{fetchImpl:async()=>{throw Error("offline");},serverKey:""}),null);
});
test("FEMA A/B minimal zone ignores sentinel elevation",async()=>{
  for(const point of [[27.8045,-82.741],[27.95344,-82.49337]]){
    const r=await lookupFemaNfhl(point[0],point[1],async()=>Response.json({features:[{attributes:{FLD_ZONE:"X",ZONE_SUBTY:"AREA OF MINIMAL FLOOD HAZARD",SFHA_TF:"F",STATIC_BFE:-9999,DFIRM_ID:"12103C"}}]}));
    assert.equal(r.floodZone,"X");assert.equal(r.sfha,false);assert.equal(r.staticBfe,null);
  }
});
test("DOR envelope and exact identity reject ambiguous rows and accept suffixless Pasco",async()=>{
  let calls=0;const r=await lookupDorBuilding(request.address,"33710",27.8,-82.7,undefined,async url=>{
    const u=new URL(String(url));assert.equal(u.searchParams.get("geometryType"),"esriGeometryEnvelope");assert.equal(u.searchParams.has("where"),false);calls++;
    return Response.json({features:[{attributes:dor}]});
  });
  assert.equal(calls,1);assert.equal(r?.values.squareFeetLiving,1166);assert.equal(r?.values.yearBuilt,1958);
  assert.equal(parseDorRows([dor,dor],request.address,"33710"),null);
  assert.equal(parseDorRows([dor],request.address,"33607"),null);
  assert.ok(parseDorRows([{...dor,PHY_ADDR1:"123 PALM",PHY_ZIPCD:"33543"}],"123 Palm Dr","33543"));
});
test("HCPA uses heated area and roof permits remain suggestions only",()=>{
  const r=parseHcpaBuilding({buildings:[{type:{description:"SINGLE FAMILY"},yearBuilt:1958,heatedArea:2105,stories:2,constructionInfo:[{element:{description:"Class"},constructionDetail:{description:"Concrete Block"}}]}],permitInfo:[{descr:"POOL",issueDate:"6/12/2020"},{descr:"REROOF",issueDate:"6/12/2019"}]});
  assert.equal(r?.values.squareFeetLiving,2105);assert.equal(r?.values.constructionLabel,"Concrete Block");assert.equal(r?.roofPermits?.length,1);assert.equal(r?.roofPermits?.[0].year,2019);assert.equal(r?.values.roofYear,undefined);
});
test("paid cache only reuses exact answers and never another user's claims",()=>{
  const a=quoteAnswerIdentity(request,"one");
  assert.ok(canReuseAnsweredQuote(a,a.answerHash,"one"));assert.ok(canReuseAnsweredQuote(a,a.answerHash,"two"));
  assert.equal(canReuseAnsweredQuote(a,quoteAnswerIdentity({...request,roofYear:2021},"two").answerHash,"two"),false);
  const claims=quoteAnswerIdentity({...request,hasClaims:true},"one");
  assert.equal(canReuseAnsweredQuote(claims,claims.answerHash,"two"),false);
  assert.ok(canReuseAnsweredQuote(claims,claims.answerHash,"one"));
  assert.equal(canReuseAnsweredQuote({},a.answerHash,"one"),false);
});
test("roof and confirmed area are mandatory and bounded",()=>{
  assert.doesNotThrow(()=>prepareQuoteRushStartRequest(request));
  for(const roofYear of [undefined,null,"2020",1999,2028,2020.5])assert.throws(()=>prepareQuoteRushStartRequest({...request,roofYear}));
  for(const roofYear of [2000,2027])assert.doesNotThrow(()=>prepareQuoteRushStartRequest({...request,roofYear}));
  assert.throws(()=>prepareQuoteRushStartRequest({...request,sqFtConfirmed:false}));
  assert.throws(()=>prepareQuoteRushStartRequest({...request,yearBuilt:undefined}));
});
test("callback token is compared against hash, not lead enumeration",()=>{
  const hash=createHash("sha256").update("test-token").digest("hex");
  assert.equal(callbackTokenMatches("wrong",hash),false);assert.equal(callbackTokenMatches("test-token",hash),true);
  assert.equal(callbackTokenMatches(undefined,hash),false);
});
test("transactional zero-quote content has agency disclosures and schedule link",()=>{
  const r=quoteRushResultsContent({propertyAddress:request.address,quotes:[],physicalAddress:"Tampa Bay, Florida",unsubscribeUrl:"https://example.test/preferences"});
  assert.match(r.subject,/finishing your insurance quotes/);
  assert.doesNotMatch(r.subject,/carrier quotes/);
  assert.doesNotMatch(r.html,/Your preliminary insurance carrier quotes/);
  assert.match(r.text,/finishing your quotes manually/);assert.match(r.text,/no credit check performed/);assert.match(r.text,/not a binder/);assert.match(r.text,/W142842/);assert.match(r.html,/Schedule a call/);
  const source=readFileSync(new URL("./property-alert-emails.ts",import.meta.url),"utf8").split("export async function sendQuoteRushResultsEmail")[1].split("export async function sendInternalAlert")[0];
  assert.doesNotMatch(source,/isUnsubscribed/);assert.match(source,/QUOTE_RESULTS_BCC/);
});
test("rebuild migration seeds exactly 67 counties without invented rates",()=>{
  const sql=readFileSync(new URL("../../supabase/migrations/2026_11_12_insurance_rebuild_rates.sql",import.meta.url),"utf8");
  assert.equal([...sql.matchAll(/\('\d{3}','[^']+'\)/g)].length,67);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/);assert.match(sql,/FOR EACH ROW/);
  assert.match(sql,/INSERT INTO public.rebuild_cost_rates\(county_slug,county_name,county_fips,supported\)/);
});
