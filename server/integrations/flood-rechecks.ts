import {randomUUID} from "node:crypto";
import {supabaseAdmin} from "../supabase";
import {normalizeParcelAddress} from "./parcel-resolver";
import {queryFloodSources,type FloodResult} from "./fema-sources";
type Location={lat:number;lng:number;countyName:string};
export const floodRetryDelay=(attempt:number)=>[2,10,30][attempt-1]*60000||3600000;
export async function runFloodRecheck(key:string,lookup=queryFloodSources,db:any=supabaseAdmin){
 if(!db)return;
 const now=new Date(),token=randomUUID();
 const {data:job,error}=await db.from("insurance_flood_rechecks").update({
  lease_token:token,next_attempt_at:new Date(now.getTime()+5*60000).toISOString(),
 }).eq("address_normalized",key).eq("state","checking").lte("next_attempt_at",now.toISOString()).select("*").maybeSingle();
 if(error||!job)return;
 const deadline=new Date(job.started_at).getTime()+86400000;
 let result:FloodResult|null=null;
 if(now.getTime()<deadline){
  try{
   result=await lookup(job.latitude,job.longitude);
   const saved=await db.rpc("record_insurance_flood_result",{p_key:key,p_display:job.address_display,p_county:job.county,p_lat:job.latitude,p_lng:job.longitude,p_result:result});
   if(saved.error)throw Error("Flood cache unavailable");
  }catch{result=null;}
 }
 const attempts=job.attempts+1;
 const {error:writeError}=await db.from("insurance_flood_rechecks").update({
  state:result?"available":Date.now()>=deadline?"unavailable":"checking",result,attempts,lease_token:null,
  next_attempt_at:new Date(Math.min(deadline,Date.now()+floodRetryDelay(attempts))).toISOString(),updated_at:new Date().toISOString(),
 }).eq("address_normalized",key).eq("lease_token",token);
 if(writeError)console.warn("[flood] Durable recheck completion deferred");
}
export async function getFloodState(address:string,location:Location,dependencies?:{db:any;run:(key:string)=>void}){
 const db=dependencies?.db??supabaseAdmin;
 const schedule=dependencies?.run??((key:string)=>void runFloodRecheck(key).catch(()=>console.warn("[flood] Recheck retained for recovery")));
 if(!db)throw Error("Flood cache unavailable");
 const key=normalizeParcelAddress(address);
 const {data:cache,error:cacheError}=await db.from("property_characteristics_cache")
  .select("flood_zone,flood_zone_subtype,sfha,static_bfe,flood_data_source,field_sources,queried_at").eq("address_normalized",key).maybeSingle();
 if(cacheError)throw Error("Flood cache unavailable");
 const evidence=cache?.field_sources?.floodZone;
 if(cache?.flood_zone&&evidence?.fetchedAt&&Date.now()-Date.parse(evidence.fetchedAt)<365*86400000){
  return {status:"available" as const,result:{floodZone:cache.flood_zone,floodZoneSubtype:cache.flood_zone_subtype,sfha:cache.sfha,
   staticBfe:cache.static_bfe,source:evidence.sourceUrl,sourceLabel:evidence.source,queriedAt:evidence.fetchedAt,dfirmId:null} as FloodResult};
 }
 const {error}=await db.from("insurance_flood_rechecks").upsert({
  address_normalized:key,address_display:address,county:location.countyName.toLowerCase().replace(/ county$/,""),latitude:location.lat,longitude:location.lng,
 },{onConflict:"address_normalized",ignoreDuplicates:true});
 if(error)throw Error("Durable flood queue unavailable");
 const {data:job,error:readError}=await db.from("insurance_flood_rechecks").select("state,started_at").eq("address_normalized",key).single();
 if(readError)throw Error("Durable flood queue unavailable");
 if(job.state==="available"){
  const reset=await db.from("insurance_flood_rechecks").update({state:"checking",started_at:new Date().toISOString(),next_attempt_at:new Date().toISOString(),attempts:0,result:null})
   .eq("address_normalized",key).eq("state","available");
  if(reset.error)throw Error("Flood cache refresh unavailable");
  schedule(key);
  return {status:"checking" as const,result:null};
 }
 if(Date.now()-Date.parse(job.started_at)>=86400000||job.state==="unavailable")return {status:"unavailable" as const,result:null};
 schedule(key);
 return {status:"checking" as const,result:null};
}
let timer:ReturnType<typeof setInterval>|undefined;
export function startFloodRechecks(){
 if(timer)return;
 const sweep=async()=>{
  if(!supabaseAdmin)return;
  const {data,error}=await supabaseAdmin.from("insurance_flood_rechecks").select("address_normalized").eq("state","checking").lte("next_attempt_at",new Date().toISOString()).limit(2);
  if(error)return;
  await Promise.all((data??[]).map(j=>runFloodRecheck(j.address_normalized)));
 };
 timer=setInterval(()=>void sweep().catch(()=>console.warn("[flood] Queue recovery deferred")),30000);timer.unref();
 void sweep().catch(()=>console.warn("[flood] Queue recovery deferred"));
}
