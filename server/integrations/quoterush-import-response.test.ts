import test from "node:test";
import assert from "node:assert/strict";
import {inspectImporterResponse,parseLeadId} from "./quoterush-import-response";
import {readFileSync} from "node:fs";
import {liveInsuranceLeadContent} from "./live-insurance-lead-alert";

test("documented plain integer, quoted integer and text lead responses",()=>{
  for(const body of ["12345",'"12345"',"Success - Lead #12345 for Test Buyer added to QuoteRUSH."])
    assert.equal(parseLeadId(body),12345);
});
test("case insensitive lead keys and Data/Result wrappers",()=>{
  for(const key of ["LeadId","LeadID","leadId","leadID","Id","ID","lead_id"])
    for(const wrapper of [null,"Data","Result","data","result"]) {
      const value = {[key]:"12345"};
      assert.equal(parseLeadId(JSON.stringify(wrapper?{[wrapper]:value}:value)),12345);
    }
  assert.equal(parseLeadId('{"Data":{"Result":{"LeadID":12345}}}'),12345);
});
test("HTTP 200 errors override even a plausible lead ID",()=>{
  for(const body of [
    '{"LeadId":12345,"Error":"Invalid DateOfBirth"}',
    '{"Result":{"LeadID":12345,"ValidationErrors":["PhoneNumber required"]}}',
    '{"Success":false,"Id":12345}',"Error 401: agency not found",
    '{"Status":"Unable to process lead","Id":12345}',"Agency could not be found",
  ]) {
    const result=inspectImporterResponse(body,"application/json");
    assert.equal(result.rejected,true);assert.equal(parseLeadId(body),null);
  }
});
test("zero error fields and informational not-required messages allow verified IDs",()=>{
  for(const value of [0,"0",false,"",null,[],{}])
    assert.equal(parseLeadId(JSON.stringify({LeadId:55,ErrorCode:value})),55);
  assert.equal(parseLeadId('{"Success":true,"LeadId":55,"Message":"PhoneNumber is not required"}'),55);
});
test("applicant values are stripped before failure detection, even vocabulary words",()=>{
  const r=inspectImporterResponse("Success - Lead #55 for Missing Required added to QuoteRUSH.","text/plain",["Missing","Required"]);
  assert.equal(r.rejected,false);assert.equal(r.leadId,55);
  assert.ok(!JSON.stringify(r.diagnostics).includes("Missing"));
});
test("arrays and arbitrary deep wrappers yield only explicitly named IDs",()=>{
  let value:any=[{LeadId:5}];
  for(let i=0;i<30;i++) value={wrapper:[value]};
  assert.equal(parseLeadId(JSON.stringify(value)),5);
  assert.equal(parseLeadId('[500,{"count":5}]'),null);
});
test("readable date validation retains rejected ID for reconciliation",()=>{
  const r=inspectImporterResponse('{"LeadId":55,"Error":"PurchaseDate is not a valid date for Jane"}',"application/json",["Jane"]);
  assert.equal(r.rejected,true);assert.equal(r.leadId,55);
  assert.match(r.error,/PurchaseDate is not a valid date for \[redacted\]/);
});
test("reject unrelated integers and invalid IDs without reviving GetNewLeads fallback",()=>{
  for(const body of ["Error 500","version 12345","0","-2","12.3",'{"Id":"123foo"}','{"Id":9007199254740992}'])
    assert.equal(parseLeadId(body),null);
});
test("diagnostics preserve field/rejection vocabulary but not PII or credentials",()=>{
  const body=JSON.stringify({Error:"Invalid PhoneNumber for Jane Example jane@example.test 2025550123; password secret-abc-123 José 王小明", "Jane Example":"hidden"});
  const result=inspectImporterResponse(body,"application/json; charset=utf-8",["Jane","Example","secret-abc-123"]);
  const output=JSON.stringify(result.diagnostics)+result.error;
  assert.match(output,/Invalid PhoneNumber/);
  for(const forbidden of ["Jane","Example","jane@","2025550123","secret-abc-123","hidden","José","王小明"]) assert.ok(!output.includes(forbidden));
  assert.equal(result.diagnostics.length,Buffer.byteLength(body));
  assert.equal(inspectImporterResponse("12345","text/plain").diagnostics.onlyDigits,true);
});
test("enrichment is persisted before import failure; agent receives sanitized reason",()=>{
  const source=readFileSync(new URL("./quoterush-import-jobs.ts",import.meta.url),"utf8");
  assert.ok(source.indexOf("if(result.rawPropertyData)")<source.indexOf("if(!result.leadId||!result.submitted)"));
  assert.match(source,/leadId:result.leadId \|\| null/);
  assert.match(source,/await alertAgent\(row,job.params,reviewReason\)/);
});
test("sales-team alert includes redacted provider rejection in its body",()=>{
  const {error}=inspectImporterResponse('{"Error":"Invalid PhoneNumber for Jane Example"}',"application/json",["Jane","Example"]);
  const content=liveInsuranceLeadContent({address:"Test property",name:"Test",email:"",phone:"",requestId:"test",reviewReason:error});
  assert.match(content.text,/Agent review: Importer rejected request: Invalid PhoneNumber/);
  assert.ok(!content.text.includes("Jane"));
});
