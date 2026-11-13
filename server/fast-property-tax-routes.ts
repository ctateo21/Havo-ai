import type {Express} from "express";
import {authenticatedQuoteUser,hasAnonymousQuoteFor} from "./anonymous-quote";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {geocodeAddress} from "./integrations/geocode";
import {resolveParcel,identifyCountyCandidatesFromAddress,SUPPORTED_COUNTY_SLUGS,type CountySlug} from "./integrations/parcel-resolver";
import {officialParcelTax,countyTaxDependencies} from "./integrations/official-tax-pipeline";
import {directEstimator,type EstimatorOutput} from "./integrations/county-estimator-direct";
import type {EstimateParams,DistrictRate} from "../shared/quick-property-tax";
import {readOfficialCache,currentBillYear} from "./integrations/official-tax-cache";
import {readQuickRates} from "./integrations/quick-tax-store";
import {calculateQuickTax,ROUGH_TAX_LABEL} from "../shared/quick-property-tax";
import {supabaseAdmin} from "./supabase";
import {COUNTY_TAX_WARNINGS} from "../shared/official-tax";
import {researchParams,planningLabel,planningStatus} from "./integrations/fl-millage-research";

const jobs=new Map<string,{signature:string;address:string;value:any;expires:number}>();
export function invalidateQuickTaxJobs(){jobs.clear();}
const dependencies={resolveParcel,geocodeAddress,readOfficialCache,readQuickRates,officialParcelTax};
export function within<T>(work:Promise<T>,ms:number):Promise<T>{
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("County lookup time budget exceeded")),ms);work.then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});
}
export function registerFastPropertyTaxRoutes(app:Express,deps=dependencies){
 const {resolveParcel,geocodeAddress,readOfficialCache,readQuickRates,officialParcelTax}=deps;
 app.post("/api/property-tax/quick",async(req,res)=>{
  if(typeof req.body?.isPrimaryResidence!=="boolean")return res.json({status:"unavailable",annualTax:null,reason:"Select Property Use to calculate property tax.",officialState:"failed"});
  const parsed=z.object({address:z.string().min(5).max(500),purchasePrice:z.number().positive(),isPrimaryResidence:z.boolean(),county:z.enum(SUPPORTED_COUNTY_SLUGS).optional(),scenarioId:z.string().max(200).optional(),refinance:z.boolean().optional(),refresh:z.boolean().optional()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Invalid property-tax inputs"});
  const input=parsed.data,signature=JSON.stringify([input.address.toLowerCase(),input.purchasePrice,input.isPrimaryResidence,input.scenarioId,input.refinance]);
  for(const [key,j] of jobs)if(j.expires<Date.now())jobs.delete(key);
  if(!input.refresh){for(const j of jobs.values())if(j.signature===signature&&j.value.officialState!=="failed")return res.json(j.value);}
  if(jobs.size>=2000)return res.status(503).json({error:"Property-tax queue busy"});
  const key=randomUUID(),entry={signature,address:input.address,created:Date.now(),expires:Date.now()+3600000,value:{key,status:"unavailable",annualTax:null,reason:"Checking county…",officialState:"pending"} as any};
  jobs.set(key,entry);
  const work=(async()=>{
   try{
    const candidates=identifyCountyCandidatesFromAddress(input.address);
    const inferred=input.county??(candidates.length===1?candidates[0]:undefined);
    const geo=inferred?null:await geocodeAddress(input.address);
    const county=(inferred??geo?.countyName.toLowerCase().replace(/\s+county$/,"")) as CountySlug;
    if(!SUPPORTED_COUNTY_SLUGS.includes(county))throw Error("County could not be verified");
    const year=currentBillYear();let identityResolved=false;
    // A clearly marked city-area estimate can be ready while the parcel
    // service is still working. It must never replace a more specific answer.
    if(!input.refinance)void readQuickRates(county,year,null,input.address.split(",")[1]?.trim()).then(rates=>{
     if(!rates||identityResolved||entry.value.officialState!=="pending")return;
     const amount=calculateQuickTax(input.purchasePrice,input.isPrimaryResidence,rates.rate,rates.params);
     entry.value={key,status:planningStatus(rates.rate,rates.params,true),annualTax:amount,monthlyTax:amount/12,adValorem:amount,nav:null,navPending:true,taxYear:year,ratesYear:rates.rate.tax_year,district:rates.rate.district_code,sourceName:rates.rate.source_name,sourceUrl:rates.rate.source_url,label:planningLabel(rates.rate,rates.params),officialState:"pending"};
     entry.value.fetchedAt=rates.rate.fetched_at;entry.value.purchasePrice=input.purchasePrice;entry.value.homestead=input.isPrimaryResidence;
    }).catch(()=>{/* The parcel path reports setup failures without guessing. */});
    const start=Date.now(),identity=await within(resolveParcel(county,input.address),4000);
    identityResolved=true;
    console.info("[property-tax-timing]",JSON.stringify({county,step:"identity",source:identity.source,ms:Date.now()-start}));
    if(identity.status!=="found")throw Error("Parcel identity could not be verified");
    const parcelId=["hillsborough","hernando"].includes(county)?identity.folio:identity.parcelId;
    if(!parcelId)throw Error("Parcel identifier missing");
    const cache=await readOfficialCache(county,parcelId,year).catch(()=>null);
    let district=identity.taxDistrict;
    if(county==="collier"&&supabaseAdmin){const {data}=await supabaseAdmin.from("collier_parcel_millage").select("millage_area").eq("parcel_id",parcelId).eq("tax_year",year).maybeSingle();district=data?.millage_area??district;}
    let rates=await readQuickRates(county,year,district,identity.situsCity).catch(e=>{entry.value.reason=e instanceof Error?e.message:"Rates unavailable";return null;});
    let fastEstimator:EstimatorOutput|undefined;
    let freshEstimator:EstimatorOutput|undefined;
    // These county adapters expose parcel-specific rates over free HTTP.
    // Never wait on a collector scrape before making those rates useful.
    if(!input.refinance&&(!rates||rates.area||cache?.estimator)&&(["hillsborough","lee","manatee"].includes(county)||(county==="collier"&&cache?.estimator))&&supabaseAdmin){
     const {data:storedParams}=await supabaseAdmin.from("county_tax_estimate_params").select("*").eq("county",county).eq("tax_year",year).maybeSingle();
     const p=storedParams??researchParams(county);
     if(p){
      try{
       fastEstimator=cache?.estimator??await within(directEstimator({county,parcelId,address:input.address,purchasePrice:input.purchasePrice,homestead:input.isPrimaryResidence,taxYear:year,folioId:county==="lee"?identity.folio??undefined:undefined}),4000);
       if(!cache?.estimator)freshEstimator=fastEstimator;
       if(fastEstimator.schoolMills!=null&&fastEstimator.nonSchoolMills!=null)rates={area:false,
        params:{...p,just_value_ratio:Number(p.just_value_ratio),school_hx_exemption:Number(p.school_hx_exemption),non_school_additional_hx:Number(p.non_school_additional_hx)} as EstimateParams,
        rate:{county,tax_year:fastEstimator.rateYear??year,district_code:district??"parcel-specific",district_name:"Parcel-specific county rates",school_mills:fastEstimator.schoolMills,non_school_mills:fastEstimator.nonSchoolMills,levies:[],source_name:fastEstimator.sourceLabel??`${county} County Property Appraiser parcel rates`,source_url:fastEstimator.url,fetched_at:fastEstimator.fetchedAt} as DistrictRate};
      }catch{/* Keep the documented area estimate; official job reports failure. */}
     }
    }
    if(rates&&(!input.refinance||identity.assessedValue!=null)){
     const amount=calculateQuickTax(input.refinance?identity.assessedValue!:input.purchasePrice,input.refinance?false:input.isPrimaryResidence,rates.rate,input.refinance?{...rates.params,just_value_ratio:1,uses_greater_of_current_just:false}:rates.params,identity.justValue);
     const nav=cache?.bill?cache.bill.navCents/100:null,status=planningStatus(rates.rate,rates.params,rates.area);
     entry.value={key,status,annualTax:amount+(nav??0),monthlyTax:(amount+(nav??0))/12,adValorem:amount,nav,navPending:nav===null,taxYear:year,ratesYear:rates.rate.tax_year,district:rates.rate.district_code,sourceName:rates.rate.source_name,sourceUrl:rates.rate.source_url,parcelId,purchasePrice:input.purchasePrice,homestead:input.isPrimaryResidence,label:county==="manatee"&&fastEstimator?.sourceLabel?fastEstimator.sourceLabel:planningLabel(rates.rate,rates.params),officialState:"pending"};
     entry.value.breakdown={
      adValorem:{cents:Math.round(amount*100),source:{name:rates.rate.source_name,url:rates.rate.source_url,fetchedAt:rates.rate.fetched_at,taxYear:rates.rate.tax_year,parcelId,purchasePrice:input.purchasePrice,homestead:input.isPrimaryResidence}},
      nonAdValorem:cache?.bill?{cents:cache.bill.navCents,lines:cache.bill.lines,source:{name:`${county} County Tax Collector ${year} Annual Bill`,url:cache.bill.url,fetchedAt:cache.bill.fetchedAt,taxYear:year,parcelId}}:{cents:null,reason:"NAV/CDD pending"},
      total:{cents:nav===null?null:Math.round((amount+nav)*100)},warnings:[...(COUNTY_TAX_WARNINGS[county]?[COUNTY_TAX_WARNINGS[county]]:[]),...(!rates.params.verified&&!rates.params.exemption_mode?["Rough calculation uses full price without homestead deductions."]:[]),...(rates.params.notes?[rates.params.notes]:[])],
     };
     entry.value.fetchedAt=rates.rate.fetched_at;
    }
    const began=Date.now();
    const breakdown=await within(officialParcelTax({county,parcelId,address:input.address,purchasePrice:input.purchasePrice,homestead:input.isPrimaryResidence,taxYear:year,taxDistrict:identity.taxDistrict??undefined,folioId:county==="lee"?identity.folio??undefined:undefined},input.refinance,
     freshEstimator?{...countyTaxDependencies,directEstimator:async i=>i.homestead===input.isPrimaryResidence?freshEstimator!:directEstimator(i)}:undefined),["collier","hernando"].includes(county)?180000:Math.max(1,25000-(Date.now()-entry.created)));
    console.info("[property-tax-timing]",JSON.stringify({county,step:"official",ms:Date.now()-began}));
    if(breakdown.total.cents===null)throw Error(breakdown.total.reason||"Official county data unavailable");
    if(!input.refinance&&rates?.params.amendment3_2027&&entry.value.adValorem!=null){
     // A current-roll official result cannot turn a future-year scenario into
     // an official figure. Only replace its pending NAV with the real bill NAV.
     const nav=breakdown.nonAdValorem.cents!/100,annualTax=entry.value.adValorem+nav;
     entry.value={...entry.value,status:"rough_estimate",annualTax,monthlyTax:annualTax/12,nav,navPending:false,officialState:"complete",reason:undefined,
      breakdown:{...entry.value.breakdown,nonAdValorem:breakdown.nonAdValorem,total:{cents:Math.round(annualTax*100)},warnings:[...breakdown.warnings,"2027 scenario only; residency eligibility is not determined. Current-roll verification does not make this scenario official."]}};
     return;
    }
    entry.value={...entry.value,key,status:county==="manatee"&&!input.refinance?"estimate":"official",annualTax:breakdown.total.cents/100,monthlyTax:breakdown.total.cents/1200,adValorem:breakdown.adValorem.cents!/100,nav:breakdown.nonAdValorem.cents!/100,navPending:false,taxYear:year,ratesYear:year,sourceName:breakdown.adValorem.source?.name,sourceUrl:breakdown.adValorem.source?.url,label:breakdown.adValorem.source?.name,breakdown,officialState:"complete",reason:undefined};
   }catch(e){entry.value={...entry.value,officialState:"failed",reason:e instanceof Error?e.message:"Official county data unavailable"};}
  })();
  await Promise.race([work,new Promise(resolve=>setTimeout(resolve,1400))]);
  return res.json(entry.value);
 });
 app.get("/api/property-tax/official-status",async(req,res)=>{
  const job=jobs.get(String(req.query.key??""));
  if(!await authenticatedQuoteUser(req)&&(!job||!hasAnonymousQuoteFor(req,job.address)))return res.status(401).json({code:"SIGN_UP_REQUIRED"});
  if(!job||job.expires<Date.now())return res.status(404).json({status:"unavailable",reason:"Lookup expired; refresh county data",officialState:"failed",annualTax:null});
  res.json(job.value);
 });
}
