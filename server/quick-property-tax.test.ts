import {test} from "node:test";
import assert from "node:assert/strict";
import {calculateQuickTax,type DistrictRate,type EstimateParams} from "../shared/quick-property-tax";
import {within} from "./fast-property-tax-routes";
import {registerFastPropertyTaxRoutes} from "./fast-property-tax-routes";
import express from "express";
import {parsePinellasTacd} from "./integrations/dor-tacd";
import {parseOfficialPropertyTaxResponse} from "../client/src/lib/official-property-tax";
import {lookupPinellasParcel} from "./integrations/pinellas-parcel";
const rate=(school:number,non:number,levies:DistrictRate["levies"]=[])=>({county:"fixture",tax_year:2026,district_code:"sample",district_name:"sample",school_mills:school,non_school_mills:non,levies,source_name:"Fixture",source_url:"https://example.test",fetched_at:"2026-11-12T00:00:00Z"});
const params=(ratio:number,extra=25000,rounding:EstimateParams["rounding"]="cents")=>({county:"fixture",tax_year:2026,just_value_ratio:ratio,uses_greater_of_current_just:false,school_hx_exemption:25000,non_school_additional_hx:extra,cpi_indexed:false,rounding,estimator_url:"https://example.test",verified:true});
test("quick formula matches supplied county AV fixtures",()=>{
 assert.equal(calculateQuickTax(719400,true,rate(6.334,13.4013),params(.85)),11239.52);
 const levies=[3.025,3.248,4.4989,.0713,.0171,.805,6.4525,.1831,.8168,.7168].map((mills,i)=>({name:String(i),mills,school:i<2}));
 assert.equal(calculateQuickTax(400000,true,rate(6.273,13.5615,levies),params(.85,26411,"whole_dollar_per_levy")),5890);
 assert.equal(calculateQuickTax(400000,true,rate(6.131,8.4246,[{name:"s1",mills:2.883,school:true},{name:"s2",mills:3.248,school:true},{name:"n",mills:8.4246,school:false}]),params(.89,25722,"whole_dollar_per_levy")),4601);
 assert.equal(calculateQuickTax(400000,true,rate(5.271,8.0913),params(.9)),4274.09);
 assert.equal(calculateQuickTax(400000,false,rate(5.271,8.0913),params(.9)),4810.43);
 assert.equal(calculateQuickTax(313498,true,rate(6.275,8.4403),params(1)),4034.33);
 assert.equal(calculateQuickTax(400000,true,rate(6.274,10.5429),params(1,125000)),4988.48);
 assert.equal(calculateQuickTax(400000,false,rate(6.274,10.5429),params(1,125000)),6726.76);
});
test("approved rough formula ignores unverified ratios and exemptions",()=>{
 assert.equal(calculateQuickTax(400000,true,rate(5,10),{...params(.85,150000),verified:false}),6000);
 assert.equal(calculateQuickTax(400000,false,rate(5,10),{...params(.85),verified:false}),6000);
});
test("provisional status cannot enter the official response contract",()=>{
 for(const status of ["estimate","area_estimate","rough_estimate"])assert.equal(parseOfficialPropertyTaxResponse({status,annualTax:1000,source:"county-estimator",breakdown:{adValorem:{cents:100000},nonAdValorem:{cents:0},total:{cents:100000},warnings:[]}}).status,"unavailable");
});
test("captured DOR 2025 Pinellas SP remains labeled prior-year and within 1%",()=>{
 const text="\nSP\nSt Petersburg, City\n6.45256.20836.45254.54230.07130.01756.29300.80506.4525N/AN/AN/AN/AN/A0.1831N/A0.82500.730019.919718.3847\nSP\n";
 const [row]=parsePinellasTacd(text,"https://floridarevenue.com/property/dataportal/","2026-11-13T00:00:00Z");
 assert.equal(row.tax_year,2025);assert.equal(row.source_name,"FL DOR 2025 TACD");
 const estimate=calculateQuickTax(400000,true,row,params(.85,26411,"whole_dollar_per_levy"));
 assert.ok(Math.abs(estimate-5890)/5890<=.01);
});
test("network budget returns without awaiting a slow provider",async()=>{
 const start=Date.now();await assert.rejects(within(new Promise(()=>{}),25),/budget/);assert.ok(Date.now()-start<250);
});
test("Pinellas USA ZIP survives quicksearch 403 and district is retained",async()=>{
 const fetchImpl:typeof fetch=async(url,options)=>{
  if(String(url).includes("quicksearch")){assert.match(String((options?.headers as any)["User-Agent"]),/HavoPropertyTax/);return new Response("",{status:403});}
  if(String(url).includes("swfwmd"))return Response.json({features:[]});
  const q=new URL(String(url));assert.match(q.searchParams.get("where")!,/SITE_ZIP='33710'/);
  return Response.json({features:[{attributes:{STRAP:"163106928620800010",PARCELID_DSP1:"06-31-16-92862-080-0010",SITE_ADDRESS:"7400 36TH AVE N",SITE_CITY:"ST PETERSBURG",SITE_ZIP:"33710",MILLAGE:"SP"}}]});
 };
 const p=await lookupPinellasParcel("7400 36th Ave N, St. Petersburg, FL 33710, USA",fetchImpl);
 assert.equal(p?.account,"06-31-16-92862-080-0010");assert.equal(p?.taxDistrict,"SP");
});
test("quick HTTP returns an estimate under two seconds while official work is pending",async(t)=>{
 const app=express();app.use(express.json());
 let finish!:(v:any)=>void;
 const official=new Promise<any>(r=>finish=r);
 registerFastPropertyTaxRoutes(app,{
  resolveParcel:async()=>({status:"found",county:"lee",parcelId:"fixture",folio:"fixture",taxDistrict:"fixture",situsAddress:"100 Fixture St",situsCity:"FORT MYERS",source:"fixture"}) as any,
  geocodeAddress:async()=>null,
  readOfficialCache:async()=>null,
  readQuickRates:async()=>({rate:rate(5.271,8.0913),params:params(.9),area:false}),
  officialParcelTax:async()=>official,
 });
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 t.after(()=>server.close());const address=server.address() as any;
 const started=Date.now(),response=await fetch(`http://127.0.0.1:${address.port}/api/property-tax/quick`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({county:"lee",address:"100 Fixture St, FL 33901",purchasePrice:400000,isPrimaryResidence:true})});
 const body=await response.json();assert.ok(Date.now()-started<2000);assert.equal(body.status,"estimate");assert.equal(body.adValorem,4274.09);assert.equal(body.navPending,true);assert.equal(body.officialState,"pending");
 finish({adValorem:{cents:null},nonAdValorem:{cents:null},total:{cents:null,reason:"Mock official unavailable"},warnings:[]});
 await new Promise(r=>setTimeout(r,20));
 const final=await (await fetch(`http://127.0.0.1:${address.port}/api/property-tax/official-status?key=${body.key}`)).json();
 assert.equal(final.annualTax,4274.09);assert.equal(final.status,"estimate");assert.equal(final.officialState,"failed");
});
test("official current-roll refresh never relabels a 2027 scenario as official",async(t)=>{
 const app=express();app.use(express.json());
 registerFastPropertyTaxRoutes(app,{
  resolveParcel:async()=>({status:"found",county:"pinellas",parcelId:"scenario",taxDistrict:"SP",situsAddress:"1 Scenario St",situsCity:"ST PETERSBURG",source:"fixture"}) as any,
  geocodeAddress:async()=>null,readOfficialCache:async()=>null,
  readQuickRates:async()=>({rate:rate(6.273,13.5615),params:{...params(.85,26411),amendment3_2027:true},area:false}),
  officialParcelTax:async()=>({adValorem:{cents:589000},nonAdValorem:{cents:10000},total:{cents:599000},warnings:[]}),
 });
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));t.after(()=>server.close());
 const a=server.address() as any;
 const result=await(await fetch(`http://127.0.0.1:${a.port}/api/property-tax/quick`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({county:"pinellas",address:"1 Scenario St, FL 33710",purchasePrice:400000,isPrimaryResidence:true})})).json();
 assert.equal(result.status,"rough_estimate");assert.equal(result.officialState,"complete");assert.equal(result.nav,100);
 assert.equal(result.annualTax,calculateQuickTax(400000,true,rate(6.273,13.5615),{...params(.85,26411),amendment3_2027:true})+100);
});
