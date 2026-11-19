import {test} from "node:test";
import assert from "node:assert/strict";
import {estimateRoofFromSatellite,parseRoofVision} from "./roof-vision";
import {insuranceEffectiveDate} from "../../shared/insurance-form-defaults";

test("satellite roof inference sends image bytes, never the key-bearing URL",async()=>{
  let calls=0;
  const result=await estimateRoofFromSatellite(28,-82,{
    mapsKey:"fictional-test-only",enabled:true,
    fetch:async()=>{calls++;return new Response(new Uint8Array([1,2,3]),{headers:{"content-type":"image/png"}});},
    complete:async request=>{
      const prompt=JSON.stringify(request);
      assert.ok(!prompt.includes("fictional-test-only"));assert.ok(!prompt.includes("key="));
      assert.ok(prompt.includes("data:image/png;base64,"));
      return {text:JSON.stringify({shape:"Hip",material:"Metal",confidence:.91}),citations:[]};
    },
  });
  assert.equal(calls,1);assert.equal(result?.shape,"Hip");assert.equal(result?.material,"Metal");
  assert.equal(result?.estimated,true);
});
test("missing configuration and unavailable images do not invent a roof",async()=>{
  const fail=async()=>{throw Error("should not call");};
  assert.equal(await estimateRoofFromSatellite(28,-82,{mapsKey:undefined,enabled:true,fetch:fail,complete:fail}),null);
  assert.equal(await estimateRoofFromSatellite(28,-82,{mapsKey:"test",enabled:true,fetch:async()=>new Response("blocked",{status:403}),complete:fail}),null);
  assert.equal(parseRoofVision('{"shape":"Hip","confidence":0.2}'),null);
  assert.equal(parseRoofVision('{"shape":"Imaginary","confidence":1}'),null);
});
test("fourteen-day effective date handles month/year rollover",()=>{
  assert.equal(insuranceEffectiveDate(new Date(2026,11,25)),"2027-01-08");
});
