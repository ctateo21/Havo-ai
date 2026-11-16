import test from "node:test";
import assert from "node:assert/strict";
import {importerHomeExtras,parseHomeEstimates,homeFieldNotes} from "./quoterush-home-fields";
import {enrichQuoteRushHome} from "./quoterush-home-enrichment";
import {buildImporterPayload,importAndSubmit,type QuoteRushParams} from "./quoterush";
const p = {
  streetAddress:"100 Example St",city:"Tampa",zip:"33607",state:"FL",county:"Hillsborough",
  coverageA:331000,policyType:"HO3",yearBuilt:1958,roofYear:2018,sqFt:1166,
  priorClaims:0,claimRecords:[],constructionType:"Masonry",masonryConstruction:"Concrete Block",
  frameConstruction:"",hurrDeductible:"2%",aopDeductible:"$2,500",newPurchase:"Yes",
  purchasePrice:289000,policyEffectiveDate:"2026-12-09",purchaseDate:"2026-12-09",
  usageType:"Secondary",monthsOccupied:"9 months or more",rentalTerm:"",
  firstName:"Example",lastName:"Applicant",dateOfBirth:"1980-01-01",phone:"5555550101",
  email:"example@example.test",floodZone:"X",windMitForm:false,openingProtection:"None",
  secondaryWaterResistance:"No",roofShape:"Hip",creditPermissionGranted:false,
} satisfies QuoteRushParams;
test("documented home defaults preserve consumer coverage, occupancy, dates, credit and FEMA",()=>{
  const payload=buildImporterPayload(p,"agent@example.test");
  assert.equal(payload.Client.CreditPermission,"No");
  assert.equal(payload.Client.AssumedCreditScore,"Excellent");
  assert.equal(payload.HO.CoverageA,"331000");
  assert.equal(payload.HO.CoverageB,"6620");
  assert.equal(payload.HO.CoverageC,"82750");
  assert.equal(payload.HO.CoverageD,"33100");
  assert.equal(payload.HO.UsageType,"Secondary");
  assert.equal(payload.HO.PolicyEffectiveDate,"12/09/2026");
  assert.equal(payload.HO.FloodZone,"X");
  assert.equal(payload.HO.HaveWindMitForm,false);
  assert.equal(payload.HO.OpeningProtection,undefined);
  assert.equal(payload.HO.RoofMaterial,"Architectural Shingles");
  assert.equal(payload.HO.UpdatePlumbingYear,undefined);
  assert.equal(payload.HO.ConstructionType,"Masonry");
  assert.equal(payload.HO.ElectricalType,"Circuit Breakers");
  assert.equal(payload.HO.PrimaryHeatSource,"Electric");
  assert.equal(payload.HO.PlumbingType,"PVC");
  assert.equal(payload.HO.Families,"1");
  assert.equal(payload.HO.LossAssessment,"$1,000");
  assert.equal(payload.HO.underwriting.FireExtinguisher,true);
  assert.match(payload.Client.OverviewNotes,/Agency defaults/);
});
test("previous address and observed desktop enums map without changing protected fields",()=>{
  const previousAddress={Address:"200 Example Ave",City:"Tampa",State:"FL",Zip:"33607"};
  const fields=parseHomeEstimates(JSON.stringify({Pool:{value:"Above Ground",confidence:.8},
    StructureType:{value:"Duplex (2 Family)",confidence:.9}}));
  const out=buildImporterPayload({...p,previousAddress,homeFields:fields},"agent@example.test");
  assert.deepEqual(out.PreviousAddress,previousAddress);
  assert.equal(out.HO.Pool,"Above Ground");
  assert.equal(out.HO.StructureType,"Duplex (2 Family)");
  assert.equal(out.HO.CoverageA,"331000");
});
test("AI is structured, allowlisted, estimated; cannot override Coverage A or flood",()=>{
  const fields=parseHomeEstimates(JSON.stringify({
    Stories:{value:"2",confidence:.7},StructureType:{value:"Unknown",confidence:.99},
    CoverageA:{value:"100",confidence:1},FloodZone:{value:"X",confidence:1},
    Pool:{value:"invented",confidence:.8},BCEG:{value:"04",confidence:2},
  }));
  assert.deepEqual(Object.keys(fields),["Stories"]);
  assert.equal(importerHomeExtras({...p,homeFields:fields}).Stories,"2");
  assert.match(homeFieldNotes(fields)[0],/estimated, OpenRouter; confidence 70%/);
});
test("county facts beat AI and estimates are reused from property cache",async()=>{
  let profile:any={stories:2,hasPool:false,queriedAt:new Date(),fieldSources:{}};
  let calls=0;
  const deps={enabled:true,cache:{read:async()=>profile,write:async(v:any)=>{profile=v;}},
    complete:async()=>{calls++;return {text:JSON.stringify({
      Stories:{value:"1",confidence:.8},StructureType:{value:"Single Family",confidence:.7},
      ProtectionClass:{value:"4",confidence:.6},BCEG:{value:"04",confidence:.6},
    }),citations:[]};}};
  const facts={yearBuilt:1958,sqFt:1166,constructionType:"Masonry",policyType:"HO3"};
  const first=await enrichQuoteRushHome("100 Example St",facts,deps);
  assert.equal(first.Stories?.value,"2");
  assert.equal(first.Stories?.estimated,false);
  assert.equal(first.StructureType?.estimated,true);
  await enrichQuoteRushHome("100 Example St",facts,deps);
  assert.equal(calls,1);
});
test("mocked carrier flow sends all discovered names; 403 safely retained; discovery failure does not submit",async()=>{
  const oldFetch=globalThis.fetch;
  const keys=["QUOTERUSH_WEBID","QUOTERUSH_WEBID_PASSWORD","QUOTERUSH_ENDPOINT_KEY","QUOTERUSH_AGENCY_ID","QUOTERUSH_PAUSED"];
  const old=keys.map(k=>process.env[k]);
  keys.forEach(k=>process.env[k]=k==="QUOTERUSH_PAUSED"?"false":"test-sensitive-value");
  const logs:unknown[]=[]; const warn=console.warn;
  console.warn=(...args)=>{logs.push(args);};
  let discoverOk=true,submits=0;
  globalThis.fetch=(async(url,init)=>{
    if(String(url).includes("GetPropertyData"))return Response.json({});
    if(String(url).includes("importer."))return new Response("Success - Lead #987 added");
    if(String(url).includes("GetQuotableSites"))return discoverOk?Response.json({Sites:["Carrier One","Carrier Two"]}):new Response("Forbidden",{status:403});
    assert.ok(String(url).includes("SubmitQuoteRequest"));
    submits++;
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body.Carriers,["Carrier One","Carrier Two"]);
    assert.equal(body.LOB,"Home");
    return new Response("Forbidden agency test-sensitive-value LeadId 987 example@example.test",{status:403});
  }) as typeof fetch;
  try{
    const result=await importAndSubmit(p);
    assert.equal(result.leadId,987);assert.equal(result.submitted,false);
    assert.match(result.error!,/403/);
    assert.doesNotMatch(JSON.stringify(logs),/test-sensitive-value|987|example@example.test/);
    discoverOk=false;
    assert.equal((await importAndSubmit(p)).submitted,false);
    assert.equal(submits,1);
  }finally{globalThis.fetch=oldFetch;console.warn=warn;keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});
