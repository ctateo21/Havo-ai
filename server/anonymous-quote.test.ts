import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {registerAnonymousQuoteRoutes,signGuestClaim,verifyGuestClaim,normalizeGuestAddress} from "./anonymous-quote";

test("anonymous claim is signed, expiring, and address-normalized",()=>{
  const claim={id:"test",quoteType:"purchase",address:normalizeGuestAddress("3102 W Nassau St, Tampa, FL 33607, USA"),expires:2000};
  const token=signGuestClaim(claim,"test-signing-key");
  assert.deepEqual(verifyGuestClaim(token,"test-signing-key",1000),claim);
  assert.equal(verifyGuestClaim(token+"x","test-signing-key",1000),null);
  assert.equal(verifyGuestClaim(token,"other-key",1000),null);
  assert.equal(verifyGuestClaim(token,"test-signing-key",2001),null);
  assert.equal(claim.address,"3102 w nassau st tampa fl 33607");
});

test("each quote type gets one address-bound run; signed-in requests bypass the quota",async()=>{
  const previous=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET="anonymous-route-test-secret";
  const app=express();app.use(express.json());
  registerAnonymousQuoteRoutes(app,async req=>req.get("Authorization")==="Bearer valid-test-session");
  app.post("/api/property-tax/quick",(_req,res)=>res.json({ok:true}));
  app.post("/api/leads/notify-new-scenario",(_req,res)=>res.json({sent:true}));
  const server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    for(const quoteType of ["purchase","cash","refinance","insurance","seller","rent"]){
      const headers:Record<string,string>={"Content-Type":"application/json","User-Agent":`test-${quoteType}`};
      const body={quoteType,address:"3102 W Nassau St, Tampa, FL 33607"};
      const start=await fetch(base+"/api/anonymous-quote/start",{method:"POST",headers,body:JSON.stringify(body)});
      assert.equal(start.status,200);
      headers.Cookie=start.headers.get("set-cookie")!.split(";")[0];
      assert.match(start.headers.get("set-cookie")!,/HttpOnly/i);
      const post=(path:string,data:unknown)=>fetch(base+path,{method:"POST",headers,body:JSON.stringify(data)});
      assert.equal((await post("/api/anonymous-quote/start",body)).status,200);
      assert.equal((await post("/api/anonymous-quote/start",{...body,address:"7400 36th Ave N, St Petersburg FL 33710"})).status,401);
      assert.equal((await post("/api/anonymous-quote/start",{...body,quoteType:quoteType==="cash"?"purchase":"cash"})).status,401);
      assert.equal((await post("/api/property-tax/quick",{address:body.address})).status,200);
      assert.equal((await post("/api/property-tax/quick",{address:"different address"})).status,401);
      assert.equal((await post("/api/leads/notify-new-scenario",{})).status,401);
      delete headers.Cookie;
      assert.equal((await post("/api/anonymous-quote/start",{...body,address:"different address"})).status,401,"cookie deletion cannot immediately reset coarse device quota");
      headers.Authorization="Bearer valid-test-session";
      assert.equal((await post("/api/anonymous-quote/start",{...body,address:"different address"})).status,200);
    }
  }finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous;
  }
});
