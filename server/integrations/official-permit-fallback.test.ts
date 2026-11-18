import {test} from "node:test";
import assert from "node:assert/strict";
import {FALLBACK_COUNTIES,permitAgency,assertPublicPermitPage,hasExactPortalAddress,officialPermitFallback} from "./official-permit-fallback";
import {lookupAdditionalPaPermits} from "./pa-permit-sources";
import type {ParcelIdentity} from "./parcel-resolver";
function identity(county:ParcelIdentity["county"],district:string):ParcelIdentity{
  return {county,status:"found",parcelId:"1234567890",folio:null,taxDistrict:district,
    situsAddress:"100 EXAMPLE ST",situsCity:"EXAMPLE",source:"fixture"};
}
test("portal override is restricted to exactly four counties",()=>{
  assert.deepEqual([...FALLBACK_COUNTIES].sort(),["hernando","pasco","polk","sarasota"]);
  for(const c of ["hillsborough","pinellas","lee","manatee","collier"] as const)
    assert.equal(permitAgency(identity(c,"U")),null);
});
test("jurisdiction requires PA district, not mailing city",()=>{
  assert.equal(permitAgency(identity("pasco","UF")),"PASCO");
  assert.equal(permitAgency(identity("pasco","NP")),null);
  assert.equal(permitAgency(identity("polk","90")),"POLKCO");
  assert.equal(permitAgency(identity("polk","91510")),null);
  assert.equal(permitAgency(identity("sarasota","M0500")),"NORTHPORT");
  assert.equal(permitAgency(identity("sarasota","M0100")),null);
  assert.equal(permitAgency(identity("hernando","CWES")),null);
});
test("CAPTCHA, login and block indicators fail closed",()=>{
  for(const html of ['<div class="g-recaptcha"></div>',"<p>Please Login</p>","<p>Access denied</p>"])
    assert.throws(()=>assertPublicPermitPage(html,"https://example.test/search"));
  assert.throws(()=>assertPublicPermitPage("<p>Continue</p>","https://example.test/Login.aspx"));
});
test("exact address rejects another street, unit and substring",()=>{
  assert.equal(hasExactPortalAddress("<td>100 EXAMPLE ST</td>","100 Example Street, Example, FL 33000"),true);
  for(const x of ["100 EXAMPLE ST UNIT 5","100 EXAMPLE ST EXT","101 EXAMPLE ST"])
    assert.equal(hasExactPortalAddress(`<td>${x}</td>`,"100 EXAMPLE ST"),false);
});
test("mismatch and non-approved counties never issue portal requests",async()=>{
  let calls=0;
  const http=(async()=>{calls++;throw Error("must not call");}) as typeof fetch;
  await assert.rejects(officialPermitFallback(identity("pasco","UF"),"200 OTHER ST",http));
  await assert.rejects(officialPermitFallback(identity("hillsborough","U"),"100 EXAMPLE ST",http));
  assert.equal(calls,0);
});
test("existing Manatee PA permits do not trigger portal fallback",async()=>{
  const urls:string[]=[];
  const http=(async(u:RequestInfo|URL)=>{
    urls.push(String(u));
    return new Response(urls.length===1?'<div id="permits-nav"></div>':JSON.stringify({
      cols:["permit","issued","purpose","description"].map(title=>({title})),
      rows:[["TEST-001","01/02/2026","Re-roof","self-adhered underlayment"]]}));
  }) as typeof fetch;
  const records=await lookupAdditionalPaPermits("manatee","100 EXAMPLE ST",http,async()=>identity("manatee","0001"));
  assert.equal(records.length,1);
  assert.equal(urls.length,2);
  assert.ok(urls.every(u=>new URL(u).hostname==="www.manateepao.gov"));
});
