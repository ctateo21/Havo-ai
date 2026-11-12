import {test} from "node:test";
import assert from "node:assert/strict";
import {queryFloodSources,FEMA_SOURCES} from "./fema-sources";
import {getFloodState,runFloodRecheck,floodRetryDelay} from "./flood-rechecks";
const answer=()=>Response.json({features:[{attributes:{FLD_ZONE:"X",ZONE_SUBTY:"AREA OF MINIMAL FLOOD HAZARD",SFHA_TF:"F",STATIC_BFE:-9999}}]});
test("FEMA retries twice with bounded backoff then returns a sourced zone",async()=>{
 let calls=0;const delays:number[]=[];
 const result=await queryFloodSources(27.80450,-82.74100,{wait:async ms=>{delays.push(ms);},fetchImpl:async()=>{
  if(++calls<3)throw Error("offline");return answer();
 }});
 assert.equal(calls,3);assert.deepEqual(delays,[1000,3000]);assert.equal(result.floodZone,"X");assert.equal(result.sfha,false);assert.equal(result.staticBfe,null);
 assert.equal(result.source,FEMA_SOURCES[0]);
});
test("FEMA source 2 answers when source 1 is down",async()=>{
 let calls=0;const result=await queryFloodSources(27.8,-82.7,{wait:async()=>{},fetchImpl:async url=>{
  calls++;if(String(url).startsWith(FEMA_SOURCES[0]+"/"))throw Error("offline");return answer();
 }});
 assert.equal(calls,4);assert.equal(result.source,FEMA_SOURCES[1]);
});
test("verified county adapter can answer after three federal services fail",async()=>{
 const county="https://county.example.test/effective/MapServer/1";let calls=0;
 const result=await queryFloodSources(27.8,-82.7,{countyLayer:county,wait:async()=>{},fetchImpl:async url=>{
  calls++;if(!String(url).startsWith(county))throw Error("offline");return answer();
 }});
 assert.equal(calls,10);assert.equal(result.sourceLabel,"Pinellas County (FEMA effective data)");
});
test("no polygon or all failed services never becomes a guessed zone",async()=>{
 await assert.rejects(queryFloodSources(27.8,-82.7,{wait:async()=>{},fetchImpl:async()=>Response.json({features:[]})}),/unavailable/);
});
function memoryDatabase(){
 const tables:Record<string,any[]>={property_characteristics_cache:[],insurance_flood_rechecks:[]};
 return {tables,from(table:string){
  let update:any,insert:any;const filters:Array<(r:any)=>boolean>=[];
  const run=()=>{
   if(insert&&!tables[table].some(r=>r.address_normalized===insert.address_normalized))tables[table].push({
    state:"checking",attempts:0,started_at:new Date().toISOString(),next_attempt_at:new Date().toISOString(),...insert,
   });
   const rows=tables[table].filter(r=>filters.every(f=>f(r)));
   if(update)rows.forEach(r=>Object.assign(r,update));
   return {data:rows[0]?{...rows[0]}:null,error:null};
  };
  const builder:any={select:()=>builder,update:(v:any)=>{update=v;return builder;},
   upsert:(v:any)=>{insert=v;return builder;},eq:(k:string,v:any)=>{filters.push(r=>r[k]===v);return builder;},
   lte:(k:string,v:any)=>{filters.push(r=>Date.parse(r[k])<=Date.parse(v));return builder;},
   maybeSingle:async()=>run(),single:async()=>run(),then:(resolve:any)=>Promise.resolve(run()).then(resolve)};
  return builder;
 },rpc:async(_name:string,p:any)=>{
   tables.property_characteristics_cache.push({address_normalized:p.p_key,flood_zone:p.p_result.floodZone,
    flood_zone_subtype:p.p_result.floodZoneSubtype,sfha:p.p_result.sfha,static_bfe:p.p_result.staticBfe,
    field_sources:{floodZone:{source:p.p_result.sourceLabel,sourceUrl:p.p_result.source,fetchedAt:p.p_result.queriedAt}}});
   return {error:null};
 }};
}
test("queued checking survives failed attempts, later success populates the address cache",async()=>{
 const db=memoryDatabase(),loc={lat:27.8,lng:-82.7,countyName:"Pinellas"},deps={db,run:()=>{}};
 assert.equal((await getFloodState("7400 36th Ave N",loc,deps)).status,"checking");
 assert.equal(db.tables.insurance_flood_rechecks.length,1);
 const job=db.tables.insurance_flood_rechecks[0];
 await runFloodRecheck(job.address_normalized,async()=>{throw Error("all down");},db);
 assert.equal(job.state,"checking");assert.equal(job.attempts,1);assert.equal(db.tables.property_characteristics_cache.length,0);
 job.next_attempt_at=new Date(0).toISOString();
 await runFloodRecheck(job.address_normalized,async()=>queryFloodSources(loc.lat,loc.lng,{fetchImpl:async()=>answer()}),db);
 assert.equal(job.state,"available");
 assert.equal((await getFloodState("7400 36th Ave N",loc,deps)).result?.floodZone,"X");
});
test("24-hour exhaustion is unavailable and backoff is 2, 10, 30 minutes then hourly",async()=>{
 assert.deepEqual([1,2,3,4].map(floodRetryDelay),[120000,600000,1800000,3600000]);
 const db=memoryDatabase(),loc={lat:27.8,lng:-82.7,countyName:"Pinellas"},deps={db,run:()=>{}};
 await getFloodState("7400 36th Ave N",loc,deps);
 const job=db.tables.insurance_flood_rechecks[0];job.started_at=new Date(Date.now()-86400001).toISOString();
 await runFloodRecheck(job.address_normalized,async()=>{throw Error("must not request after deadline");},db);
 assert.equal(job.state,"unavailable");assert.equal((await getFloodState("7400 36th Ave N",loc,deps)).status,"unavailable");
});
