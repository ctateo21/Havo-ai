import {test} from "node:test";
import assert from "node:assert/strict";
import {assumeWindAttachments,resolveWind,windAnswersSchema,type CoastalEvidence} from "../../shared/wind-mitigation";
import {buildImporterPayload,type QuoteRushParams} from "./quoterush";
import {reportRoofMaterial,ROOF_MATERIALS} from "../../shared/insurance-form-defaults";
const coastal:CoastalEvidence={status:"inside",distanceFeet:100,source:"Fictional geography fixture",sourceUrl:"https://example.test"};
const rows=[
  ["1985 inland","pinellas",1985,2000,undefined,"A","Toe Nails"],
  ["1990 coastal","collier",1990,2000,coastal,"A","Clips"],
  ["1996 Pinellas","pinellas",1996,2000,undefined,"B","Clips"],
  ["1996 Hillsborough","hillsborough",1996,2000,undefined,"B","Toe Nails"],
  ["1998 with 2015 roof","pinellas",1998,2015,undefined,"C","Clips"],
  ["2001 with 2005 roof","hillsborough",2001,2005,undefined,"B","Clips"],
  ["2005","polk",2005,2005,undefined,"C","Clips"],
  ["missing build","pinellas",0,2022,undefined,"A","Toe Nails"],
] as const;
for(const [name,county,yearBuilt,roofYear,zone,deck,wall] of rows)test(`wind assumption: ${name}`,()=>{
  const actual=assumeWindAttachments(county,yearBuilt,roofYear,zone);
  assert.equal(actual.roofDeck,deck);assert.equal(actual.roofToWall,wall);
  const result=resolveWind({county,yearBuilt,roofYear,coastal:zone});
  assert.equal(result.fields.roofDeck.value,deck);assert.equal(result.fields.roofToWall.value,wall);
  assert.ok(Object.values(result.fields).every(v=>v.estimated));
});
const base={county:"pinellas",yearBuilt:1998,roofYear:2015};
const p={coverageA:300000,policyType:"HO3",claimRecords:[],priorClaims:0,yearBuilt:1998,roofYear:2015,
  constructionType:"Masonry",masonryConstruction:"Concrete Block",sqFt:1800,streetAddress:"100 Example St",
  city:"Example City",state:"FL",zip:"00000",newPurchase:"Yes"} as QuoteRushParams;
test("assumptions send official values and retain protected defaults",()=>{
  for(const [roofToWall,roofDeck] of [["N/A","Concrete"],["Structural","A"],["Double Wraps","B"]] as const){
    const answers=windAnswersSchema.parse({roofToWall,roofDeck,allOpenings:"all",roofCovering:"Meets FBC 1994"});
    const result=buildImporterPayload({...p,windAnswers:answers,windEvidence:resolveWind({...base,answers})},"example@example.test");
    assert.equal(result.HO.RoofWallConnection,roofToWall);
    assert.equal(result.HO.RoofDeckAttachment,roofDeck==="Concrete"?"Reinforced Concrete Roof Deck":`Level ${roofDeck}`);
    assert.equal(result.HO.OpeningProtection,"Hurricane Protection");
    assert.equal(result.HO.RoofCovering,"Meets FBC 1994");
    assert.equal(result.HO.GatedCommunity,"No");assert.equal(result.HO.HaveWindMitForm,true);
    assert.equal(result.Client.CreditPermission,"No");assert.equal(result.Client.AssumedCreditScore,"Excellent");
    assert.match(result.Client.OverviewNotes,/estimated/);
  }
  const result=buildImporterPayload({...p,windEvidence:resolveWind(base)},"example@example.test");
  assert.equal(result.HO.RoofCovering,"Meets FBC 2001");assert.equal(result.HO.OpeningProtection,"Unknown or None");
});
test("six roof materials and report override map without inventing report evidence",()=>{
  for(const roofMaterial of ROOF_MATERIALS)
    assert.equal(buildImporterPayload({...p,roofMaterial},"example@example.test").HO.RoofMaterial,roofMaterial);
  assert.equal(reportRoofMaterial("Built Up"),"Tar and Gravel");assert.equal(reportRoofMaterial("Membrane"),"Rubber");
  const answers=windAnswersSchema.parse({reportAvailable:true,roofDeck:"C",roofCovering:"Meets FBC 2001",
    report:{inspectionDate:"2026-01-01",transcribedFromReport:true,roofDeck:"A",roofToWall:"Single Wraps",
      swr:"No",opening:"B",shape:"Flat",roofCovering:"Membrane",productApproval:"Non-FBC"}});
  const evidence=resolveWind({...base,answers});
  assert.equal(evidence.fields.roofDeck.value,"A");assert.equal(evidence.fields.roofDeck.estimated,false);
  const result=buildImporterPayload({...p,roofMaterial:"Metal",windAnswers:answers,windEvidence:evidence},"example@example.test");
  assert.equal(result.HO.RoofMaterial,"Rubber");assert.equal(result.HO.RoofCovering,"Non-FBC");
  assert.equal(result.HO.OpeningProtection,"Basic");
  const incomplete=windAnswersSchema.parse({...answers,report:{...answers.report,assumedFields:["roofDeck","opening","productApproval"]}});
  const partial=resolveWind({...base,answers:incomplete});
  assert.equal(partial.fields.roofDeck.estimated,true);
  assert.match(partial.fields.roofDeck.source,/not present/);
  const safe=buildImporterPayload({...p,windAnswers:incomplete,windEvidence:partial},"example@example.test");
  assert.equal(safe.HO.OpeningProtection,"Unknown or None");
  assert.match(safe.Client.OverviewNotes,/Roof product approval: Non-FBC — estimated/);
});
