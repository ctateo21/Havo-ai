import {test} from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {installSecurity} from "./security-middleware";
test("API security rejects foreign origins, applies headers and limits callers",async()=>{
  const app=express();installSecurity(app);
  app.post("/api/leads/send-code",(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/leads/send-code`;
  try{
    const bad=await fetch(url,{method:"POST",headers:{Origin:"https://attacker.example"}});
    assert.equal(bad.status,403);
    const good=await fetch(url,{method:"POST",headers:{Origin:"https://havofl.com"}});
    assert.equal(good.status,200);assert.equal(good.headers.get("x-content-type-options"),"nosniff");
    assert.equal(good.headers.get("referrer-policy"),"strict-origin-when-cross-origin");
    assert.equal(good.headers.get("access-control-allow-origin"),"https://havofl.com");
    let status=200;for(let i=0;i<30;i++)status=(await fetch(url,{method:"POST"})).status;
    assert.equal(status,429);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
