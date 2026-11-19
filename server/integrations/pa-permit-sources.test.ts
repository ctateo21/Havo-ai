import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseManateePermits,parseLeePermits,parseCollierPermits,parseOtherPaPermits,
  lookupAdditionalPaPermits,renderCollierPermits,requirePaIdentity,PA_PERMIT_RESTRICTIONS} from "./pa-permit-sources";
import {validatePermitClassification} from "./permit-classification";
import {resolveWind,permitKinds} from "../../shared/wind-mitigation";
import type {ParcelIdentity} from "./parcel-resolver";
const fixture=(file:string)=>readFileSync(`test/fixtures/permits/${file}`,"utf8");
const identity:ParcelIdentity={status:"found",county:"manatee",parcelId:"2051711709",folio:null,taxDistrict:null,
  situsAddress:"7755 PINE TRACE DR",situsCity:"SARASOTA",source:"Manatee PA"};
test("Manatee observed JSON preserves permit evidence, excluding unrelated personal fields",()=>{
  const data=JSON.parse(fixture("manatee-pa.json")),p=parseManateePermits(data,"https://www.manateepao.gov/parcel/?parid=2051711709");
  assert.equal(p.length,2);assert.equal(p[0].number,"COBLD2408-1146");assert.equal(p[1].date,"2021-03-25");
  const c=validatePermitClassification(JSON.stringify({items:[{index:0,kind:"garage_door",quote:"REPLACE GARAGE DOOR SIZE FOR SIZE",swr:false},
    {index:1,kind:"reroof",quote:"REROOF/ROOFING MEMBRANE",swr:false}]}),p);
  assert.equal(permitKinds(c[0]).opening,false);assert.equal(permitKinds(c[1]).roof,true);
  assert.throws(()=>parseManateePermits({rows:[]},"https://example.test"));
});
test("Lee preserves received-date disclaimer; no reroof issue-date credit",()=>{
  const p=parseLeePermits(fixture("lee-pa.html"),"https://www.leepa.org/Display/DisplayParcel.aspx");
  assert.equal(p.length,2);assert.equal(p[1].number,"ROF2018-04591");assert.equal(p[1].dateBasis,"received");
  const wind=resolveWind({county:"lee",yearBuilt:1958,roofYear:2018,permits:[{...p[1],classification:{kind:"reroof",quote:"Roof",swr:false}}]});
  assert.equal(wind.fields.roofDeck.value,"C");
  assert.match(wind.fields.roofDeck.source,/roof year/);
  assert.doesNotMatch(wind.fields.roofDeck.source,/permit/);
  assert.throws(()=>parseLeePermits("<div id='PermitDetails'>collapsed</div>","https://example.test"));
});
test("Collier parses six dated permits and never substitutes completion date",()=>{
  const p=parseCollierPermits(fixture("collier-pa.html"),"https://www.collierappraiser.com/Main_Search/ParcelDetail.html?FolioID=57647440005");
  assert.equal(p.length,6);assert.equal(p[1].number,"WD-19-05189");assert.equal(p[1].date,"2019-08-08");
  assert.equal(p.some(x=>x.number==="71-1928"),false);
  assert.throws(()=>parseCollierPermits("<table></table>","https://example.test"));
});
for(const county of ["pasco","polk","hernando"]){
  test(`${county} verified absence of PA permit rows stays Unknown`,()=>{
    assert.throws(()=>parseOtherPaPermits(county,fixture(`${county}-pa.html`),"https://example.test"),/PA/);
  });
}
test("Sarasota robots restriction prevents all network or identity calls",async()=>{
  assert.match(PA_PERMIT_RESTRICTIONS.sarasota,/robots/);
  await assert.rejects(()=>lookupAdditionalPaPermits("sarasota","1182 S Salford Blvd",async()=>{throw Error("network forbidden");},
    async()=>{throw Error("identity forbidden");}),/robots/);
});
test("ambiguous or mismatched PA identity never fetches parcel data",async()=>{
  assert.throws(()=>requirePaIdentity({...identity,status:"not-found"},"7755 Pine Trace Dr"),/identity/);
  await assert.rejects(()=>lookupAdditionalPaPermits("manatee","OTHER PROPERTY",async()=>{throw Error("network forbidden");},
    async()=>identity),/mismatch/);
});
test("Manatee request uses only verified PA parcel page and same-parcel JSON",async()=>{
  const urls:string[]=[];
  const result=await lookupAdditionalPaPermits("manatee","7755 Pine Trace Dr, Sarasota, FL 34243",async input=>{
    const url=String(input);urls.push(url);assert.equal(new URL(url).searchParams.get("parid"),"2051711709");
    return new Response(url.includes("pao-model-permits")?fixture("manatee-pa.json"):'<a id="permits-nav">Permits</a>');
  },async()=>identity);
  assert.equal(result.length,2);assert.equal(urls.length,2);assert.ok(urls.every(u=>new URL(u).hostname==="www.manateepao.gov"));
});
test("PA CAPTCHA blocks without a renderer or alternate route",async()=>{
  await assert.rejects(()=>lookupAdditionalPaPermits("manatee","7755 Pine Trace Dr",async()=>new Response("CAPTCHA verify you are human"),
    async()=>({...identity,parcelId:"2051711710"})),/blocked/);
});
test("same verified parcel reuses records across address formatting with zero new page calls",async()=>{
  const result=await lookupAdditionalPaPermits("manatee","7755 PINE TRACE DRIVE, Sarasota, FL 34243",async()=>{throw Error("cache miss");},async()=>identity);
  assert.equal(result.length,2);
});
test("Collier rendered identity must equal independently resolved property",async()=>{
  await assert.rejects(()=>lookupAdditionalPaPermits("collier","7755 Pine Trace Dr",fetch,async()=>identity,
    async()=>({html:fixture("collier-pa.html"),url:"https://www.collierappraiser.com/Main_Search/ParcelDetail.html?FolioID=OTHER"})),/mismatch/);
});
test("Collier render abort still closes session; CAPTCHA never interacts",async()=>{
  const old=process.env.FIRECRAWL_API_KEY;process.env.FIRECRAWL_API_KEY="fixture-only";
  const calls:string[]=[];
  const mock:typeof fetch=async(input,init)=>{
    calls.push(init?.method??"GET");
    if(init?.method==="DELETE")return new Response('{"success":true}');
    return new Response(JSON.stringify({success:true,data:{markdown:"CAPTCHA verify you are human",metadata:{scrapeId:"fixture"}}}));
  };
  try{await assert.rejects(()=>renderCollierPermits("940 Montego Ct","57647440005",mock,mock),/blocked/);
    assert.deepEqual(calls,["POST","DELETE"]);
  }finally{if(old===undefined)delete process.env.FIRECRAWL_API_KEY;else process.env.FIRECRAWL_API_KEY=old;}
});
