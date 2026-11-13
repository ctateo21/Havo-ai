import test from "node:test";
import assert from "node:assert/strict";
import {insuranceContact} from "./insurance-contact";
import {readFileSync} from "node:fs";
test("live insurance uses signup contact when profile columns are empty or name is email",()=>{
  const metadata={name:"Test Buyer",phone:"2025550123"};
  for(const name of ["","test@example.test"]){
    const contact=insuranceContact({name,phone:""},metadata,"test@example.test");
    assert.equal(contact.valid,true);assert.equal(contact.firstName,"Test");assert.equal(contact.lastName,"Buyer");assert.equal(contact.phone,"2025550123");
  }
});
test("missing contact is rejected rather than fabricated",()=>{
  for(const profile of [{},{name:"Test",phone:"2025550123"},{name:"Test Buyer",phone:""},{name:"buyer@example.test",phone:"2025550123"}])
    assert.equal(insuranceContact(profile,{}).valid,false);
});
test("unconfirmed imports and interrupted imports become terminal and notify the team",()=>{
  const source=readFileSync(new URL("./integrations/quoterush-import-jobs.ts",import.meta.url),"utf8");
  assert.match(source,/!result\.leadId\|\|!result\.submitted/);
  const failure=source.split("// Never retry an ambiguous paid import.")[1].split("let sweeper")[0];
  assert.match(failure,/status:"error"/);
  assert.match(failure,/await alertAgent/);
  assert.doesNotMatch(failure,/scheduleQuoteJob/);
  assert.match(source,/await alertAgent\(row,job.params\?\?\{\},"interrupted import/);
});
