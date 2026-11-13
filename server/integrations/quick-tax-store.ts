import {supabaseAdmin} from "../supabase";
import type {DistrictRate,EstimateParams} from "../../shared/quick-property-tax";
import {load} from "cheerio";
import type {EstimatorInput,EstimatorOutput} from "./county-estimator-direct";
import {bundledQuickRates,researchParams} from "./fl-millage-research";
export function parseDistrictLevies(html:string){
 const $=load(html),result:DistrictRate["levies"]=[];
 $("table").each((_,table)=>{
  const rows=$(table).find("tr").toArray();
  const header=rows.find(r=>/millage|mills|tax rate/i.test($(r).text()));
  if(!header)return;
  const cells=$(header).find("th,td").toArray(),index=cells.findIndex(c=>/millage|mills|tax rate/i.test($(c).text()));
  if(index<0)return;
  for(const row of rows){if(row===header)continue;const td=$(row).find("td").toArray();
   const name=td[0]?$(td[0]).text().trim():"",raw=td[index]?$(td[index]).text().trim():"";
   if(!name||/total|estimated/i.test(name)||!/^\d+(?:\.\d+)?$/.test(raw))continue;
   const mills=Number(raw);if(mills>0&&mills<50)result.push({name,mills,school:/school/i.test(name)});
  }
 });return result;
}
export async function captureDistrictRates(input:EstimatorInput,out:EstimatorOutput){
 let district=input.taxDistrict;
 if(!district){try{district=JSON.parse(out.snapshot).taxDistrict;}catch{/* HTML source; district must come from identity. */}}
 if(!supabaseAdmin||!district)return;
 const levies=parseDistrictLevies(out.snapshot);
 const school=out.schoolMills??(levies.some(l=>l.school)?levies.filter(l=>l.school).reduce((s,l)=>s+l.mills,0):null);
 const non=out.nonSchoolMills??(levies.some(l=>!l.school)?levies.filter(l=>!l.school).reduce((s,l)=>s+l.mills,0):null);
 if(school===null||non===null)return;
 const {error}=await supabaseAdmin.from("county_tax_rate_districts").upsert({county:input.county,tax_year:out.rateYear??input.taxYear,district_code:district,district_name:district,school_mills:school,non_school_mills:non,levies,source_name:out.sourceLabel??`${input.county} County Property Appraiser`,source_url:out.url,fetched_at:out.fetchedAt,verified_against:`${input.parcelId}; ${input.purchasePrice}; HX ${input.homestead}; AV ${out.adValoremCents/100}`,updated_by:"official-estimator"},{onConflict:"county,tax_year,district_code"});
 if(error)console.warn("[property-tax-rates] Capture unavailable; migration may await approval");
}
export async function readQuickRates(...args:Parameters<typeof readStoredQuickRates>){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  return await Promise.race([readStoredQuickRates(...args),new Promise<Awaited<ReturnType<typeof readStoredQuickRates>>>(resolve=>{
   timer=setTimeout(()=>resolve(bundledQuickRates(...args)),600);
  })]);
 }catch{return bundledQuickRates(...args);}
 finally{if(timer)clearTimeout(timer);}
}
async function readStoredQuickRates(county:string,year:number,district?:string|null,city?:string|null){
 const bundled=bundledQuickRates(county,year,district,city);
 if(!supabaseAdmin)return bundled;
 const {data,error}=await supabaseAdmin.from("county_tax_rate_districts").select("*").eq("county",county).lte("tax_year",year).gte("tax_year",year-1).order("tax_year",{ascending:false});
 if(error)return bundled;
 const normalizeCity=(s:string)=>s.toUpperCase().replace(/\./g,"").replace(/\s+/g," ").trim();
 const rate=data?.find(r=>district&&r.district_code===district)??data?.find(r=>city&&normalizeCity(String(r.city_default))===normalizeCity(city));
 if(!rate)return bundled;
 const {data:params,error:paramsError}=await supabaseAdmin.from("county_tax_estimate_params").select("*").eq("county",county).eq("tax_year",year).maybeSingle();
 const settings=paramsError||!params?researchParams(county):params;
 if(!settings)return bundled;
 // Old bundled city seed rows must not beat the supplied prior-year research.
 if(county==="collier"&&rate.district_code.startsWith("city:")&&!rate.updated_by)return bundled;
 const selected=(!district||rate.district_code!==district)&&bundled&&!bundled.area?bundled.rate:rate;
 return {rate:{...selected,school_mills:Number(selected.school_mills),non_school_mills:Number(selected.non_school_mills)} as DistrictRate,
  params:{...settings,just_value_ratio:Number(settings.just_value_ratio),school_hx_exemption:Number(settings.school_hx_exemption),non_school_additional_hx:Number(settings.non_school_additional_hx)} as EstimateParams,
  area:selected.district_code!==district||selected.tax_year!==year};
}
