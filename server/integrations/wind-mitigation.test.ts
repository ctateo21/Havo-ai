import {test} from "node:test";
import assert from "node:assert/strict";
import {CLIP_YEAR,resolveWind,windAnswersSchema,permitKinds,type PermitEvidence} from "../../shared/wind-mitigation";
import {completePreviousAddress} from "../../shared/optional-previous-address";
import {classifyCoastal,nearestLineFeet,checkCoastalZone} from "./wind-coastal-zone";
import {parseHcpaPermits,parsePinellasPermits,lookupWindPermits} from "./wind-permits";
import {boundedOptional,jobHeartbeat} from "./quote-job-safety";
import {parseHomeEstimates} from "./quoterush-home-fields";
import {buildImporterPayload,type QuoteRushParams} from "./quoterush";
const answers=windAnswersSchema.parse({});
const base={county:"hillsborough",yearBuilt:1958,roofYear:2018,answers};
const permit:PermitEvidence={number:"EXAMPLE-1",description:"REROOF",date:"2018-02-01",source:"County permit",sourceUrl:"https://example.test/"};
test("partial optional addresses are omitted; complete addresses retained",()=>{
  for(const x of [undefined,{}, {Address:"100 Example St"},{Address:"100 Example St",City:"Tampa",State:"FL",Zip:""}])assert.equal(completePreviousAddress(x),undefined);
  assert.equal(completePreviousAddress({Address:"100 Example St",City:"Tampa",State:"fl",Zip:"33607"})?.State,"FL");
});
for(const [county,year] of Object.entries(CLIP_YEAR))test(`${county} clips cutoff, older/coastal and never wraps`,()=>{
  assert.equal(resolveWind({...base,county,yearBuilt:year}).fields.roofToWall.value,"Clips");
  assert.equal(resolveWind({...base,county,yearBuilt:year-1}).fields.roofToWall.value,"Unknown");
  assert.equal(resolveWind({...base,county,yearBuilt:2003}).fields.roofToWall.value,"Clips");
  assert.equal(resolveWind({...base,county,yearBuilt:1989,coastal:classifyCoastal(100,{barrierIsland:true,landward:true})}).fields.roofToWall.value,"Clips");
  assert.equal(resolveWind({...base,county,yearBuilt:1989,coastal:classifyCoastal(100)}).fields.roofToWall.value,"Unknown");
});
test("coastal thresholds require verified geography; errors remain unknown",async()=>{
  assert.equal(classifyCoastal(1400,{landward:true,barrierIsland:false}).status,"inside");
  assert.equal(classifyCoastal(1600,{landward:true,barrierIsland:false}).status,"outside");
  assert.equal(classifyCoastal(4900,{landward:true,barrierIsland:true}).status,"inside");
  assert.equal(classifyCoastal(5100,{landward:true,barrierIsland:true}).status,"outside");
  assert.equal(classifyCoastal(100,{landward:false,barrierIsland:true}).status,"outside");
  assert.equal(classifyCoastal(100).status,"unknown");
  assert.equal(classifyCoastal(null).status,"unknown");
  assert.equal((await checkCoastalZone("collier",25.9,-81.7,async()=>{throw Error("down");})).status,"unknown");
  assert.ok(nearestLineFeet(27,-82,[[[-82,26.99],[-82,27.01]]])!<1);
});
test("permit opening protection requires explicit all confirmation and roof dates control deck",()=>{
  const opening={...permit,description:"Impact windows and hurricane shutters"};
  assert.equal(permitKinds(opening).opening,true);
  assert.equal(resolveWind({...base,permits:[opening]}).fields.opening.value,"X");
  assert.equal(resolveWind({...base,answers:{...answers,allOpenings:"all",openingsConfirmed:true}}).fields.opening.value,"N");
  assert.equal(resolveWind({...base,permits:[opening],answers:{...answers,allOpenings:"all"}}).fields.opening.value,"X");
  assert.equal(resolveWind({...base,permits:[opening],answers:{...answers,allOpenings:"all",openingsConfirmed:true}}).fields.opening.value,"B");
  assert.equal(resolveWind({...base,permits:[permit]}).fields.roofDeck.value,"C");
  assert.equal(resolveWind(base).fields.roofDeck.value,"B");
  assert.equal(resolveWind({...base,yearBuilt:2000,roofYear:2000}).fields.roofDeck.value,"Unknown");
});
test("SWR cutoffs and explicit answers; roof shape distinguishes default from confirmed",()=>{
  assert.equal(resolveWind({...base,roofYear:2021}).fields.swr.value,"Yes");
  assert.equal(resolveWind(base).fields.swr.value,"Unknown");
  assert.equal(resolveWind({...base,answers:{...answers,peelAndStick:"yes"}}).fields.swr.value,"Yes");
  assert.equal(resolveWind({...base,roofYear:2007,answers:{...answers,peelAndStick:"yes"}}).fields.swr.value,"Unknown");
  assert.equal(resolveWind(base).fields.shape.estimated,true);
  assert.equal(resolveWind({...base,answers:{...answers,shape:"Gable"}}).fields.shape.estimated,false);
  assert.equal(resolveWind({...base,answers:{...answers,shape:"Hip"}}).fields.shape.value,"Hip");
});
test("report values override every estimate and require attested report details",()=>{
  assert.equal(windAnswersSchema.safeParse({reportAvailable:true}).success,false);
  const a=windAnswersSchema.parse({...answers,reportAvailable:true,report:{reference:"Report EXAMPLE",inspectionDate:"2026-01-01",transcribedFromReport:true,
    roofToWall:"Double Wraps",roofDeck:"A",swr:"No",opening:"X",shape:"Flat"}});
  const result=resolveWind({...base,answers:a,permits:[permit],yearBuilt:2022});
  assert.equal(result.haveReport,true);assert.equal(result.fields.roofToWall.value,"Double Wraps");
  assert.equal(result.fields.roofDeck.value,"A");assert.equal(result.fields.swr.value,"No");
  assert.equal(result.fields.roofDeck.estimated,false);
});
test("two permit parsers preserve identifiers, dates and source, Collier skipped",async()=>{
  assert.equal(parseHcpaPermits({permitInfo:[{permitNum:"EXAMPLE",descr:"IMPACT WINDOWS",issueDate:"1/2/2020"}]})[0].date,"2020-01-02");
  const html='<table id="tblPermit"><tbody><tr><td>EXAMPLE</td><td>ROOF</td><td>02/01/2018</td><td>0</td></tr></tbody></table>';
  assert.equal(parsePinellasPermits(html,"https://example.test")[0].date,"2018-02-01");
  assert.throws(()=>parsePinellasPermits("CAPTCHA","https://example.test"));
  assert.equal((await lookupWindPermits("collier","100 Example St",async()=>{throw Error("must not fetch");})).status,"unsupported");
});
test("AI deadline aborts and continues, heartbeat refreshes and detects lost ownership",async()=>{
  let aborted=false,beats=0,owned=true;
  assert.deepEqual(await boundedOptional(signal=>new Promise(r=>{
    signal.addEventListener("abort",()=>{aborted=true;r({late:true});});
  }),{},10),{});
  assert.equal(aborted,true);
  const lease=jobHeartbeat(async()=>{beats++;return owned;},5);
  await new Promise(r=>setTimeout(r,20));assert.ok(beats>0);lease.assertOwned();
  owned=false;await new Promise(r=>setTimeout(r,15));assert.throws(()=>lease.assertOwned());
  lease.stop();const n=beats;await new Promise(r=>setTimeout(r,15));assert.equal(beats,n);
});
test("AI cannot supply jurisdiction ratings, Coverage A or flood",()=>{
  assert.deepEqual(parseHomeEstimates(JSON.stringify(Object.fromEntries(["ProtectionClass","BCEG","CoverageA","FloodZone"].map(k=>[k,{value:"1",confidence:1}])))),{});
});
test("payload sends evidence-based credits and user-gated community, never credit permission",()=>{
  const p={...base,streetAddress:"100 Example St",city:"Tampa",state:"FL",zip:"33607",coverageA:300000,policyType:"HO3",sqFt:1200,
    constructionType:"Masonry",masonryConstruction:"Concrete Block",frameConstruction:"",priorClaims:0,claimRecords:[],
    firstName:"Example",lastName:"Applicant",dateOfBirth:"1980-01-01",phone:"5555550101",email:"example@example.test",
    hurrDeductible:"2%",aopDeductible:"$2,500",newPurchase:"Yes",purchasePrice:300000,policyEffectiveDate:"12/09/2026",
    usageType:"Primary",rentalTerm:"",monthsOccupied:"9 months or more",floodZone:"X",windMitForm:true,
    openingProtection:"None",secondaryWaterResistance:"No",roofShape:"Gable",creditPermissionGranted:false,
    windAnswers:{...answers,gated:true},windEvidence:resolveWind({...base,yearBuilt:2003,roofYear:2022,permits:[permit]})} as QuoteRushParams;
  const payload=buildImporterPayload(p,"agent@example.test");
  assert.equal(payload.HO.HaveWindMitForm,false);assert.equal(payload.HO.RoofDeckAttachment,"Level C");
  assert.equal(payload.HO.RoofWallConnection,"Clips");assert.equal(payload.HO.SecondaryWaterResistance,"Yes");
  assert.equal(payload.HO.GatedCommunity,"Single Entry");assert.equal(payload.Client.CreditPermission,"No");
  assert.equal(payload.Client.AssumedCreditScore,"Excellent");assert.match(payload.Client.OverviewNotes,/estimated/);
  assert.equal(buildImporterPayload({...p,windAnswers:answers},"agent@example.test").HO.GatedCommunity,undefined);
  const reportAnswers=windAnswersSchema.parse({...answers,reportAvailable:true,report:{reference:"Example Report",
    inspectionDate:"2026-01-01",transcribedFromReport:true,roofToWall:"Single Wraps",roofDeck:"A",swr:"No",opening:"B",shape:"Hip"}});
  const reportPayload=buildImporterPayload({...p,windAnswers:reportAnswers,windEvidence:resolveWind({...base,answers:reportAnswers})},"agent@example.test");
  assert.equal(reportPayload.HO.HaveWindMitForm,true);
  assert.equal(reportPayload.HO.WindMitigationInspectionDate,"01/01/2026");
  assert.equal(reportPayload.HO.RoofWallConnection,"Single Wraps");
  assert.equal(reportPayload.HO.OpeningProtection,"Hurricane Protection");
  assert.equal(reportPayload.HO.RoofShape,"Hip");
  assert.equal(reportPayload.HO.SecondaryWaterResistance,"No");
});
