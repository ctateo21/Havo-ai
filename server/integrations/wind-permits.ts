import {load} from "cheerio";
import {streetIdentity} from "./insurance-building-sources";
import {lookupPinellasParcel} from "./pinellas-parcel";
import type {PermitEvidence} from "../../shared/wind-mitigation";
export const PERMIT_UA="Mozilla/5.0 (compatible; HavoPropertyTax/1.0; +https://havofl.com)";
export type PermitResult={status:"available"|"unavailable"|"unsupported";permits:PermitEvidence[];source:string;queriedAt:string};
export interface PermitAdapter {id:string; county:string; lookup:(address:string,http:typeof fetch)=>Promise<PermitEvidence[]>}
const HCPA="https://gis.hcpafl.org/CommonServices/property/search/";
export function parseHcpaPermits(data:any):PermitEvidence[]{
  return (Array.isArray(data?.permitInfo)?data.permitInfo:[]).flatMap((p:any)=>{
    const date=new Date(p.issueDate);
    return typeof p.descr==="string"&&p.permitNum&&Number.isFinite(date.getTime())?[{
      number:String(p.permitNum),description:p.descr,date:date.toISOString().slice(0,10),
      source:"Hillsborough County Property Appraiser",sourceUrl:"https://www.hcpafl.org/"}]:[];
  });
}
export function parsePinellasPermits(html:string,url:string):PermitEvidence[]{
  const $=load(html);if(!$("#tblPermit").length)throw Error("Permit table unavailable");
  return $("#tblPermit tbody tr").toArray().flatMap(row=>{
    const cells=$(row).find("td").toArray().map(x=>$(x).text().trim()),date=new Date(cells[2]);
    return cells[0]&&cells[1]&&Number.isFinite(date.getTime())?[{number:cells[0],description:cells[1],
      date:date.toISOString().slice(0,10),source:"Pinellas County Property Appraiser",sourceUrl:url}]:[];
  });
}
export const permitAdapters:PermitAdapter[]=[
  {id:"hcpa-parcel-permits",county:"hillsborough",async lookup(address,http){
    const parts=address.split(",").map(x=>x.trim()),city=parts[1]?.toUpperCase();
    const r=await http(`${HCPA}BasicSearch?${new URLSearchParams({address:parts[0],pagesize:"5",page:"1"})}`);
    if(!r.ok)throw Error("Permit identity unavailable");
    const rows=await r.json();if(!Array.isArray(rows))throw Error("Permit identity unavailable");
    const match=rows.filter(x=>streetIdentity(x.address)===streetIdentity(parts[0])&&x.address.split(",")[1]?.trim().toUpperCase()===city);
    if(match.length!==1||!match[0].pin)throw Error("Permit identity ambiguous");
    const p=await http(`${HCPA}ParcelData?pin=${encodeURIComponent(match[0].pin)}`);
    if(!p.ok)throw Error("Permit data unavailable");return parseHcpaPermits(await p.json());
  }},
  {id:"pcpao-parcel-permits",county:"pinellas",async lookup(address,http){
    const id=await lookupPinellasParcel(address,http);
    if(!id)throw Error("Permit identity unavailable");
    const url=`https://www.pcpao.gov/property-details?s=${encodeURIComponent(id.strap)}`;
    const r=await http(url);if(!r.ok)throw Error("Permit data unavailable");
    const html=await r.text(),$=load(html);
    const site=$('input[name="addr"]').attr("value");
    if(!site||streetIdentity(site)!==streetIdentity(address))throw Error("Permit property mismatch");
    return parsePinellasPermits(html,url);
  }},
];
const cache=new Map<string,{expires:number;value:PermitResult}>(),pending=new Map<string,Promise<PermitResult>>();
let nextSlot=0;
export async function lookupWindPermits(county:string,address:string,http:typeof fetch=fetch):Promise<PermitResult>{
  const key=`${county}:${address.toUpperCase().trim()}`,hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.value;
  if(pending.has(key))return pending.get(key)!;
  const adapter=permitAdapters.find(x=>x.county===county);
  if(!adapter)return {status:"unsupported",permits:[],source:county==="collier"?"Collier CityView skipped — CAPTCHA":"No verified permit adapter",queriedAt:new Date().toISOString()};
  const task=(async()=>{
    const now=Date.now(),wait=Math.max(0,nextSlot-now);nextSlot=Math.max(now,nextSlot)+1000;
    // Do not accumulate a long queue in the quote path.
    if(wait>3000)return {status:"unavailable" as const,permits:[],source:adapter.id,queriedAt:new Date().toISOString()};
    await new Promise(r=>setTimeout(r,wait));
    const signal=AbortSignal.timeout(6000);
    const polite:typeof fetch=(url,options)=>http(url,{...options,signal,headers:{...options?.headers,
      "User-Agent":PERMIT_UA,Referer:county==="pinellas"?"https://www.pcpao.gov/":"https://www.hcpafl.org/"}});
    let value:PermitResult;
    try{value={status:"available",permits:await adapter.lookup(address,polite),source:adapter.id,queriedAt:new Date().toISOString()};}
    catch{value={status:"unavailable",permits:[],source:adapter.id,queriedAt:new Date().toISOString()};}
    cache.set(key,{expires:Date.now()+(value.status==="available"?86400000*30:300000),value});
    if(cache.size>2000)cache.delete(cache.keys().next().value!);return value;
  })();
  pending.set(key,task);try{return await task;}finally{pending.delete(key);}
}
