import {test} from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {once} from "node:events";
import {validatePermitClassification} from "./permit-classification";
import {parsePortalPermits,allowedPortalUrl,PERMIT_PORTALS,lookupPortalPermits,browserPermitSearch} from "./permit-portals";
import {classifyPublishedZone,CBZ_URL,checkCoastalZone} from "./wind-coastal-zone";
import {reportMime,reportPath,registerWindReports,extractedWindReportSchema,MAX_WIND_REPORT_BYTES} from "./wind-report-upload";
import {resolveWind,windAnswersSchema} from "../../shared/wind-mitigation";

test("AI permit classifications require source quotes and cannot invent record identity",()=>{
  const records=[{number:"PERMIT-001",date:"2018-01-01",description:"Replace roof; self-adhered underlayment",source:"County",sourceUrl:"https://example.test"}];
  const result=validatePermitClassification(JSON.stringify({items:[{index:0,kind:"reroof",quote:"Replace roof",swr:true}]}),records);
  assert.equal(result[0].number,"PERMIT-001");assert.equal(result[0].classification?.kind,"reroof");
  assert.deepEqual(validatePermitClassification('{"items":[{"index":0,"kind":"reroof","quote":"invented","swr":false}]}',records),[]);
  assert.deepEqual(validatePermitClassification('{"items":[{"index":5,"kind":"reroof","quote":"Replace roof","swr":false}]}',records),[]);
});
test("portal records require exact property, number, date and verbatim work; URLs cannot escape portal",()=>{
  const md="100 Example St, Tampa, FL 33607 PERMIT-001 01/02/2020 Replace impact windows";
  const record={number:"PERMIT-001",date:"2020-01-02",address:"100 Example St, Tampa, FL 33607",quote:"Replace impact windows"};
  const parse=(r:any)=>parsePortalPermits(JSON.stringify({permits:[r]}),md,"https://aca.tampagov.net/record","100 Example St, Tampa, FL 33607");
  assert.equal(parse(record).length,1);
  for(const patch of [{number:"fake"},{date:"2020-01-03"},{address:"101 Example St"},{quote:"invented"}])assert.equal(parse({...record,...patch}).length,0);
  assert.equal(allowedPortalUrl("https://aca-prod.accela.com/hcfl/record","https://aca-prod.accela.com/hcfl/"),true);
  for(const url of ["https://aca-prod.accela.com.evil.test/hcfl/","https://aca-prod.accela.com/PASCO/","http://aca-prod.accela.com/hcfl/","https://user:pass@aca-prod.accela.com/hcfl/"])
    assert.equal(allowedPortalUrl(url,"https://aca-prod.accela.com/hcfl/"),false);
  assert.ok(!JSON.stringify(PERMIT_PORTALS).toLowerCase().includes("cityview"));
});
test("missing provider config degrades without network or guessed permits",async()=>{
  const previous=process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  try{
    const result=await lookupPortalPermits("collier","100 Example St",new AbortController().signal,async()=>{throw Error("network forbidden");});
    assert.equal(result.permits.length,0);assert.equal(result.checks[0].status,"not_configured");
  }finally{if(previous!==undefined)process.env.FIRECRAWL_API_KEY=previous;}
});
test("browser permit fallback always stops its session and never bypasses a CAPTCHA",async()=>{
  const methods:string[]=[];
  const http:typeof fetch=async(_url,init)=>{
    methods.push(init?.method??"GET");
    if(methods.length===1)return new Response(JSON.stringify({success:true,data:{markdown:"Search public records",metadata:{scrapeId:"session-test"}}}));
    if(init?.method==="DELETE")return new Response(JSON.stringify({success:true}));
    return new Response(JSON.stringify({success:true,result:{url:"https://aca.tampagov.net/",text:"",blocked:true}}));
  };
  const result=await browserPermitSearch("https://aca.tampagov.net/","100 Example St",new AbortController().signal,http);
  assert.equal(result?.blocked,true);assert.deepEqual(methods,["POST","POST","DELETE"]);
  let calls=0;
  assert.equal((await browserPermitSearch("https://aca.tampagov.net/","100 Example St",new AbortController().signal,async()=>{
    calls++;return new Response(JSON.stringify({success:true,data:{markdown:"CAPTCHA verify you are human"}}));
  }))?.blocked,true);assert.equal(calls,1);
});
test("Marco Gulf-side barrier fixture inside, inland Naples outside, bad data unknown",()=>{
  const marco={features:[{attributes:{COUNTY:"Collier",DEFINITION_SOURCE_TYPE:"Barrier Island",COASTAL_BARRIER_ISLAND_NAME:"Marco Island"}}]};
  const inside=classifyPublishedZone(marco,"collier",700);
  assert.equal(inside.status,"inside");assert.equal(inside.sourceUrl,CBZ_URL);
  assert.equal(classifyPublishedZone({features:[]},"collier",20000).status,"outside");
  for(const data of [{error:{}},{},{features:[],exceededTransferLimit:true},{features:[{attributes:{COUNTY:"Lee",DEFINITION_SOURCE_TYPE:"Standard"}}]}])
    assert.equal(classifyPublishedZone(data,"collier",100).status,"unknown");
  assert.equal(resolveWind({county:"collier",yearBuilt:1989,roofYear:2018,coastal:inside}).fields.roofToWall.value,"Clips");
});
test("coastal HTTP path queries both CCCL and real mapped landward zone",async()=>{
  const urls:string[]=[];
  const result=await checkCoastalZone("collier",25.92712,-81.72891,async(input)=>{
    urls.push(String(input));
    return new Response(JSON.stringify(String(input).includes("Florida_Coastal_Building_Zone")
      ?{features:[{attributes:{COUNTY:"Collier",DEFINITION_SOURCE_TYPE:"Barrier Island"}}]}
      :{features:[{geometry:{paths:[[[-81.73,25.92],[-81.73,25.94]]]}}]}));
  });
  assert.equal(result.status,"inside");assert.equal(urls.length,2);assert.ok(result.distanceFeet!>0);
});
test("private report type/size validation and owner-qualified object paths",()=>{
  assert.equal(reportMime(Buffer.from("%PDF-1.7"),"application/pdf"),"application/pdf");
  assert.equal(reportMime(Buffer.from("<script>"),"application/pdf"),null);
  assert.equal(reportMime(Buffer.from("%PDF-1.7"),"image/png"),null);
  assert.equal(reportMime(Buffer.alloc(MAX_WIND_REPORT_BYTES+1),"application/pdf"),null);
  assert.equal(reportMime(Buffer.from([255,216,255,0]),"image/jpeg"),"image/jpeg");
  assert.throws(()=>reportPath("user","../../other-user"));
});
test("uploaded extraction remains draft, supports D, and never overrides until attested",()=>{
  const extracted=extractedWindReportSchema.parse({inspectionDate:"2026-01-01",inspector:"Example Inspector",yearBuilt:1989,
    roofCovering:"Tile",roofToWall:"Double Wraps",roofDeck:"D",shape:"Hip",swr:"Yes",opening:"A"});
  assert.equal(windAnswersSchema.safeParse({reportAvailable:true,report:{...extracted,reference:"REPORT",transcribedFromReport:false}}).success,false);
  const answers=windAnswersSchema.parse({reportAvailable:true,report:{...extracted,reference:"REPORT",transcribedFromReport:true}});
  assert.equal(resolveWind({county:"collier",yearBuilt:1989,roofYear:2018,answers}).fields.roofDeck.value,"D");
});
test("report HTTP access rejects guests and never reads another user's object",async()=>{
  const owner="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222",id="33333333-3333-4333-8333-333333333333";
  const paths:string[]=[];
  const store={storage:{from:()=>({download:async(path:string)=>{
    paths.push(path);return path===`${owner}/${id}`?{data:new Blob(["%PDF-test"],{type:"application/pdf"})}:{error:true};}})}};
  const app=express();registerWindReports(app,async req=>req.headers.authorization==="owner"?{id:owner}:req.headers.authorization==="other"?{id:other}:null,store as any);
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  try{
    assert.equal((await fetch(`${base}/api/insurance/wind-report`,{method:"POST"})).status,401);
    assert.equal((await fetch(`${base}/api/insurance/wind-report/${id}`)).status,401);
    const own=await fetch(`${base}/api/insurance/wind-report/${id}`,{headers:{authorization:"owner"}});
    assert.equal(own.status,200);assert.equal(own.headers.get("cache-control"),"private, no-store");
    assert.equal((await fetch(`${base}/api/insurance/wind-report/${id}`,{headers:{authorization:"other"}})).status,404);
    assert.deepEqual(paths,[`${owner}/${id}`,`${other}/${id}`]);
  }finally{server.close();server.closeAllConnections();}
});
