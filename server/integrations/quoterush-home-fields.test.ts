import test from "node:test";
import assert from "node:assert/strict";
import {importerHomeExtras,parseHomeEstimates,homeFieldNotes,validateHomeValue} from "./quoterush-home-fields";
import {enrichQuoteRushHome} from "./quoterush-home-enrichment";
import {buildImporterPayload,importAndSubmit,type QuoteRushParams} from "./quoterush";
import {quoteAnswerIdentity} from "./quote-answer-identity";
// This test process mocks global fetch. Never inherit a workspace proxy.
delete process.env.QUOTERUSH_PROXY_URL;
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
test("workbook enums normalize historical evidence and omit unsupported options",()=>{
  for(const [old,value] of Object.entries({
    "Duplex (2 Family)":"Duplex","Triplex (3 Family)":"Triplex","Quadplex (4 Family)":"Quadplex",
    "Rowhouse (Townhouse Center)":"Townhouse (Center Unit)","Rowhouse (Townhouse End)":"Townhouse (End Unit)",
  }))assert.equal(validateHomeValue("StructureType",old),value);
  for(const value of ["Bi-Level","Tri-Level"]){
    assert.equal(validateHomeValue("StructureType",value),null);
    assert.equal(validateHomeValue("Stories",value),value);
  }
  for(const value of [1,1.5,2,2.5,3,4])assert.equal(validateHomeValue("Stories",value),String(value));
  for(const value of [5,6,7,8,9,10])assert.equal(validateHomeValue("Stories",value),null);
  for(const [old,value] of Object.entries({
    "Inground - small < 300 sq ft":"Inground - small < 300 sq. ft.",
    "Inground - med 300-600 sq ft":"Inground - 300 - 600 sq. ft.",
    "Inground - large > 600 sq ft":"Inground - large > 600 sq. ft.",
    "Above Ground":"Above Ground - Detached",None:"None",
  }))assert.equal(validateHomeValue("PoolType",old),value);
  assert.equal(validateHomeValue("PoolType","Indoor"),null);
  const {HO}=buildImporterPayload({...p,homeFields:parseHomeEstimates(JSON.stringify({
    Stories:{value:8,confidence:1},PoolType:{value:"Indoor",confidence:1},
  }))},"agent@example.test");
  for(const key of ["Stories","PoolType","Pool","Construction","PrimaryWaterHeaterLocation","Sprinklers"])
    assert.equal(key in HO,false,key);
});
test("pool workbook strings pass through and historical variants normalize at the outbound boundary",()=>{
  const cases = [
    ["Inground - small < 300 sq ft - Detached","Inground - small < 300 sq. ft. - Detached"],
    ["Inground - med 300-600 sq ft - Detached","Inground - 300 - 600 sq. ft. - Detached"],
    ["Inground - large > 600 sq ft - Detached","Inground - large > 600 sq. ft. - Detached"],
    ["Inground - small < 300 sq ft","Inground - small < 300 sq. ft."],
    ["Inground - med 300-600 sq ft","Inground - 300 - 600 sq. ft."],
    ["Inground - large > 600 sq ft","Inground - large > 600 sq. ft."],
    ["Above Ground","Above Ground - Detached"],
    ["None","None"],
  ];
  for(const [legacy,official] of cases){
    for(const value of [legacy,official]){
      assert.equal(validateHomeValue("PoolType",value),official);
      const evidence={value,confidence:1,source:"property data",estimated:false,fetchedAt:"2026-11-18T00:00:00Z"};
      // Exercise both the current and historical cache key without pre-normalizing.
      for(const key of ["PoolType","Pool"]){
        const {HO}=buildImporterPayload({...p,homeFields:{[key]:evidence} as any},"agent@example.test");
        assert.equal(HO.PoolType,official);
        assert.equal("Pool" in HO,false);
        assert.equal(HO.HaveWindMitForm,true);
      }
      const parsed=parseHomeEstimates(JSON.stringify({PoolType:{value,confidence:1}}));
      assert.equal(parsed.PoolType?.value,official);
    }
  }
  const {HO}=buildImporterPayload({...p,homeFields:{PoolType:{
    value:"Indoor",confidence:1,source:"property data",estimated:false,fetchedAt:"2026-11-18T00:00:00Z",
  }}},"agent@example.test");
  assert.equal("PoolType" in HO,false);
});
test("workbook wind values distinguish A/B, omit unknown SWR and unsupported deck D",()=>{
  for(const opening of ["A","B","X","N","Unknown"]){
    for(const swr of ["Yes","No","Unknown"]){
      const windEvidence:any={haveReport:false,notes:[],fields:{
        opening:{value:opening,source:"user answer",estimated:true},
        swr:{value:swr,source:"user answer",estimated:true},
        roofDeck:{value:"D",source:"report",estimated:false},
        roofToWall:{value:"Unknown",source:"unknown",estimated:true},
        shape:{value:"Gable",source:"user answer",estimated:false},
      }};
      const {HO,Client}=buildImporterPayload({...p,windEvidence},"agent@example.test");
      assert.equal(HO.OpeningProtection,opening==="A"?"Hurricane Protection":"Unknown or None");
      assert.equal(HO.SecondaryWaterResistance,swr==="Unknown"?undefined:swr);
      assert.equal(HO.RoofDeckAttachment,undefined);
      assert.equal(HO.RoofWallConnection,undefined);
      assert.equal(HO.HaveWindMitForm,true);
      assert.equal(HO.GatedCommunity,"No");
      assert.match(Client.OverviewNotes,/estimated/);
    }
  }
  for(const deck of ["A","B","C"]){
    const windEvidence:any={notes:[],fields:{roofDeck:{value:deck},roofToWall:{value:"Clips"},swr:{value:"Unknown"},opening:{value:"X"},shape:{value:"Hip"}}};
    assert.equal(buildImporterPayload({...p,windEvidence},"agent@example.test").HO.RoofDeckAttachment,`Level ${deck}`);
  }
});
test("official construction subtypes are allowlisted without an extra Construction key",()=>{
  for(const constructionType of ["Masonry","Frame","Mixed"]){
    const {HO}=buildImporterPayload({...p,constructionType,frameConstruction:"Vinyl Siding"},"agent@example.test");
    assert.equal(HO.ConstructionType,constructionType==="Mixed"?"Mixed Masonry-Frame":constructionType);
    assert.equal(HO.FrameConstruction,"Vinyl Siding");
    assert.equal(HO.MasonryConstruction,"Concrete Block");
    assert.equal("Construction" in HO,false);
  }
  const {HO}=buildImporterPayload({...p,masonryConstruction:"Brick",frameConstruction:"invented"},"agent@example.test");
  assert.equal(HO.MasonryConstruction,undefined);
  assert.equal(HO.FrameConstruction,undefined);
});
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
  assert.equal(payload.HO.HaveWindMitForm,true);
  assert.equal(payload.HO.OpeningProtection,"Unknown or None");
  assert.equal(payload.HO.SecondaryWaterResistance,undefined);
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
test("blank previous address uses quoted property with an assumption, never inventing mortgage",()=>{
  const out=buildImporterPayload(p,"agent@example.test");
  assert.deepEqual(out.PreviousAddress,{Address:p.streetAddress,City:p.city,State:p.state,Zip:p.zip});
  assert.match(out.Client.OverviewNotes,/Assumption for quoting only: PreviousAddress/);
  assert.equal(out.HO.Mortgage,undefined);
  const entered={Address:"200 Fictional Lane",City:"Example",State:"FL",Zip:"33000"};
  const confirmed=buildImporterPayload({...p,previousAddress:entered},"agent@example.test");
  assert.deepEqual(confirmed.PreviousAddress,entered);
  assert.doesNotMatch(confirmed.Client.OverviewNotes,/Assumption for quoting only: PreviousAddress/);
});
test("owned and refinance imports omit blank previous address and its assumption",()=>{
  const out=buildImporterPayload({...p,newPurchase:"No"},"agent@example.test");
  assert.equal("PreviousAddress" in out,false);
  assert.doesNotMatch(out.Client.OverviewNotes,/Assumption for quoting only: PreviousAddress/);
  assert.equal("Mortgage" in out.HO,false);
  const entered={Address:"200 Fictional Lane",City:"Example",State:"FL",Zip:"33000"};
  assert.deepEqual(buildImporterPayload({...p,newPurchase:"No",previousAddress:entered},"agent@example.test").PreviousAddress,entered);
});
test("Apply Defaults fields are explicit without fabricating report provenance",()=>{
  const out=buildImporterPayload({...p,windAnswers:{gated:false} as any},"agent@example.test");
  assert.equal(out.HO.GatedCommunity,"No");
  assert.equal(out.HO.HaveWindMitForm,true);
  assert.equal(out.HO.Terrain,"Exposure B");
  assert.equal(out.HO.SprinklerSystem,"None");
  assert.equal(out.HO.BusinessOnPremises,"No");
  assert.equal(out.HO.BurglarAlarm,"None");
  assert.equal(out.HO.FireAlarm,"None");
  assert.equal(out.HO.WaterHeaterLocation,"Garage");
  for(const key of ["PersonalInjuryCoverage","IdentityTheft","IncreaseReplacementCostOnDwelling"])
    assert.equal(out.HO[key],false);
  assert.match(out.Client.OverviewNotes,/NOT evidence of a real report/);
  assert.equal(out.HO.WindMitigationInspectionDate,undefined);
});
test("five previously blank Home fields use documented keys and Coverage A never comes from AI",()=>{
  const homeFields=parseHomeEstimates(JSON.stringify({
    StructureType:{value:"Single Family",confidence:.8},Stories:{value:"2",confidence:.8},
    Pool:{value:"Above Ground",confidence:.8},PoolScreenedEnclosure:{value:true,confidence:.8},
    ScreenedEnclosureSquareFeet:{value:400,confidence:.8},CoverageA:{value:1,confidence:1},
  }));
  const {HO}=buildImporterPayload({...p,homeFields},"agent@example.test");
  for(const key of ["StructureType","Stories","PoolType","CoverageA","PoolScreenedEnclosure"])
    assert.ok(HO[key]!==undefined && HO[key]!=="",key);
  assert.equal(HO.PoolScreenedEnclosure,true);
  assert.equal(HO.ScreenedEnclosureSquareFeet,"400");
  assert.equal(HO.CoverageA,"331000");
});
test("previous address and observed desktop enums map without changing protected fields",()=>{
  const previousAddress={Address:"200 Example Ave",City:"Tampa",State:"FL",Zip:"33607"};
  const fields=parseHomeEstimates(JSON.stringify({Pool:{value:"Above Ground",confidence:.8},
    StructureType:{value:"Duplex (2 Family)",confidence:.9}}));
  const out=buildImporterPayload({...p,previousAddress,homeFields:fields},"agent@example.test");
  assert.deepEqual(out.PreviousAddress,previousAddress);
  assert.equal(out.HO.PoolType,"Above Ground - Detached");
  assert.equal(out.HO.StructureType,"Duplex");
  assert.equal(out.HO.CoverageA,"331000");
  assert.notEqual(quoteAnswerIdentity({...p,previousAddress},"owner-one").answerHash,
    quoteAnswerIdentity({...p,previousAddress},"owner-two").answerHash);
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
