import {randomBytes,createHash,timingSafeEqual} from "node:crypto";
import type {Express} from "express";
import {supabaseAdmin} from "../supabase";
import {readQuoteCache,updateQuoteCache,type QuoteCacheRow} from "../managed-quote-cache";
import {readPrivateProfile} from "../managed-account-records";
import {importAndSubmit,parseQuoteRushResponse,type QuoteRushParams} from "./quoterush";
import {scheduleQuoteJob,topThreePositiveQuotes} from "./quoterush-background";
import {sendLiveInsuranceLeadAlert} from "./live-insurance-lead-alert";
let crmAlert:((row:QuoteCacheRow,params:Partial<QuoteRushParams>,reason:string)=>Promise<unknown>)|undefined;
export async function notifyInsuranceCrm(row:QuoteCacheRow,params:Partial<QuoteRushParams>,reason:string){
  try{await crmAlert?.(row,params,reason);}catch{console.warn("[insurance] CRM operational alert needs retry");}
}

export function callbackTokenMatches(token:unknown,stored:string|null):boolean{
  if(typeof token!=="string"||token.length>200||!stored)return false;
  const actual=createHash("sha256").update(token).digest(),expected=Buffer.from(stored,"hex");
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export async function enqueueInsuranceImport(row:QuoteCacheRow,params:QuoteRushParams){
  if(!supabaseAdmin||!row.ownerUserId)throw Error("Durable insurance queue unavailable");
  const token=randomBytes(32).toString("hex"), hash=createHash("sha256").update(token).digest("hex");
  const {dateOfBirth,...privateParams}=params;
  const updated=await updateQuoteCache(row.id,{callbackTokenHash:hash},{triggeredAt:row.triggeredAt,leadId:null,expectedStatus:"pending"});
  if(!updated)throw Error("Quote run was superseded");
  const {error}=await supabaseAdmin.from("insurance_quote_import_jobs").upsert({
    cache_id:row.id,generation:row.triggeredAt.toISOString(),owner_user_id:row.ownerUserId,
    params:privateParams,callback_token:token,status:"queued",claimed_at:null,
  });
  if(error)throw Error("Durable insurance queue unavailable; approved migration required");
  setImmediate(()=>void runInsuranceImport(row.id).catch(()=>console.warn("[insurance] Import queue deferred; durable recovery retained")));
}
async function alertAgent(row:QuoteCacheRow,params:Partial<QuoteRushParams>,reason:string){
  await notifyInsuranceCrm(row,params,reason);
  await sendLiveInsuranceLeadAlert({address:row.addressDisplay,name:`${params.firstName??""} ${params.lastName??""}`.trim(),
    email:row.emailRecipient??"",phone:params.phone??"",requestId:`${row.id} ${reason}`});
}
export async function runInsuranceImport(id:number){
  if(!supabaseAdmin)return;
  const {data:job,error}=await supabaseAdmin.from("insurance_quote_import_jobs").update({status:"running",claimed_at:new Date().toISOString()}).eq("cache_id",id).eq("status","queued").select("*").maybeSingle();
  if(error||!job)return;
  const [row]=await readQuoteCache({id},1);
  if(!row||row.triggeredAt.toISOString()!==new Date(job.generation).toISOString()||row.status!=="pending"||row.leadId)return;
  try{
    const profile=await readPrivateProfile(job.owner_user_id);
    if(!profile?.dateOfBirth)throw Error("Private applicant profile unavailable");
    const result=await importAndSubmit({...job.params,dateOfBirth:profile.dateOfBirth},{
      callbackUrl:`https://havofl.com/api/insurance/qr-callback?token=${encodeURIComponent(job.callback_token)}`,
      onLeadCreated:async leadId=>{
        const updated=await updateQuoteCache(id,{leadId},{triggeredAt:row.triggeredAt,leadId:null,expectedStatus:"pending"});
        if(!updated)throw Error("Cannot persist imported lead safely");
      },
      onCarriers:async(count,warning)=>{
        const [current]=await readQuoteCache({id},1);if(!current)return;
        await updateQuoteCache(id,{agencyDefaultSnapshot:{...current.agencyDefaultSnapshot,expectedCarriers:count},
          assumptions:[...(current.assumptions??[]),...(warning?[warning]:[])]},{triggeredAt:row.triggeredAt,leadId:current.leadId,expectedStatus:"pending"});
      },
    });
    if(!result.leadId||!result.submitted){
      console.warn("[quoterush] Agent review required",{phase:result.leadId?"submission":"import",hasVerifiedLeadId:!!result.leadId});
      throw Error("QuoteRush import or submission unconfirmed");
    }
    if(result.rawPropertyData){
      const fetched=new Date(),expires=new Date(fetched);expires.setFullYear(expires.getFullYear()+1);
      await updateQuoteCache(id,{rawQuoterushPropertyData:result.rawPropertyData,rawQuoterushPropertyDataSource:"quoterush",
        rawQuoterushPropertyDataFetchedAt:fetched,rawQuoterushPropertyDataExpiresAt:expires},{triggeredAt:row.triggeredAt,leadId:result.leadId,expectedStatus:"pending"});
    }
    await supabaseAdmin.from("insurance_quote_import_jobs").update({status:result.submitted?"submitted":"manual-review",params:{},callback_token:""}).eq("cache_id",id).eq("generation",job.generation);
    scheduleQuoteJob(id,0);
    await alertAgent(row,job.params,result.submitted?"quote requested":"submit status requires reconciliation");
  }catch{
    // Never retry an ambiguous paid import. An agent reconciles this generation.
    await supabaseAdmin.from("insurance_quote_import_jobs").update({status:"manual-review",params:{},callback_token:""}).eq("cache_id",id).eq("generation",job.generation);
    const [current]=await readQuoteCache({id},1);
    if(current&&current.triggeredAt.getTime()===row.triggeredAt.getTime()){
      await updateQuoteCache(id,{status:"error",assumptions:[...(current.assumptions??[]),"Agent review required: import or submission could not be confirmed."]},{triggeredAt:row.triggeredAt,leadId:current.leadId,expectedStatus:"pending"});
      // No carrier-results email for an unconfirmed import. alertAgent below
      // informs the team; the browser sees a terminal state immediately.
    }
    await alertAgent(row,job.params,"import requires manual reconciliation");
  }
}
let sweeper:ReturnType<typeof setInterval>|undefined;
export function registerQuoteCallbackAndImports(app:Express,notify?:typeof crmAlert){
  crmAlert=notify;
  app.post("/api/insurance/qr-callback",async(req,res)=>{
    try{
      const leadId=Number(req.body?.LeadId??req.body?.leadId);
      if(!Number.isSafeInteger(leadId)||leadId<=0)return res.sendStatus(403);
      const rows=await readQuoteCache({leadId});
      const row=rows.find(r=>callbackTokenMatches(req.query.token,r.callbackTokenHash));
      if(!row)return res.sendStatus(403);
      if(row.status!=="pending")return res.sendStatus(200);
      const parsed=parseQuoteRushResponse(req.body,leadId);
      const quotes=topThreePositiveQuotes([...parsed.quotes,...(row.quotes??[])].filter((q,i,a)=>a.findIndex(x=>x.siteName===q.siteName&&x.annualPremium===q.annualPremium)===i).map(q=>({...q,quoteMessage:""})));
      const updated=await updateQuoteCache(row.id,{quotes,quoteCounter:Math.max(parsed.quoteCounter,row.quoteCounter??0)},{triggeredAt:row.triggeredAt,leadId,expectedStatus:"pending"});
      if(!updated)return res.sendStatus(409);
      scheduleQuoteJob(row.id,20000);res.sendStatus(200);
    }catch{res.sendStatus(503);}
  });
  if(sweeper)return;
  const resume=async()=>{
    if(!supabaseAdmin)return;
    try{
      const {data,error}=await supabaseAdmin.from("insurance_quote_import_jobs").select("cache_id,status,claimed_at,generation,params").in("status",["queued","running"]).limit(100);
      if(error)return; // Migration not approved/applied yet; no work can be queued.
      for(const job of data??[]){
        if(job.status==="queued")void runInsuranceImport(job.cache_id).catch(()=>{});
        else if(Date.parse(job.claimed_at)<Date.now()-180000){
          await supabaseAdmin.from("insurance_quote_import_jobs").update({status:"manual-review",params:{},callback_token:""}).eq("cache_id",job.cache_id).eq("generation",job.generation).eq("status","running");
          const [row]=await readQuoteCache({id:job.cache_id},1);
          if(row&&row.triggeredAt.toISOString()===new Date(job.generation).toISOString()){
            await updateQuoteCache(row.id,{status:"error",assumptions:[...(row.assumptions??[]),"Agent review required: interrupted import must be reconciled."]},{triggeredAt:row.triggeredAt,leadId:row.leadId,expectedStatus:"pending"});
            await alertAgent(row,job.params??{},"interrupted import requires manual reconciliation");
          }
        }
      }
    }catch{/* Retry the queue read later, never re-import an ambiguous run. */}
  };
  void resume();sweeper=setInterval(()=>void resume(),30000);sweeper.unref();
}
