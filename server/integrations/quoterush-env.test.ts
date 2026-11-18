import test from "node:test";
import assert from "node:assert/strict";
import {quoteRushEnv} from "./quoterush-env";
test("QuoteRush primary and legacy environment inputs are trimmed",()=>{
  const out=quoteRushEnv({QUOTERUSH_WEBID:" example ",QUOTERUSH_WEBID_PASSWORD:" example-password\n",
    QUOTERUSH_ENDPOINT_KEY:" example-key ",QUOTERUSH_AGENCY_ID:" example-agency ",
    QUOTERUSH_ASSIGNED_EMAIL:" agent@example.test "});
  assert.deepEqual(out,{webId:"example",webPassword:"example-password",endpointKey:"example-key",
    agency:"example-agency",assignedEmail:"agent@example.test"});
  const fallback=quoteRushEnv({QUOTERUSH_WEBID_PASSWORD:" ",QUOTERUSH_WEBPASSWORD:" legacy ",
    QUOTERUSH_AGENCY_ID:" ",QUOTERUSH_AGENCY:" legacy-agency "});
  assert.equal(fallback.webPassword,"legacy");assert.equal(fallback.agency,"legacy-agency");
});
