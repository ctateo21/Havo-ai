import type {Express} from "express";
import {z} from "zod";
import {supabaseAdmin} from "./supabase";
import {invalidateQuickTaxJobs} from "./fast-property-tax-routes";
import {requireInterestAdmin} from "./b2b-interest-routes";
const source=z.string().url().refine(s=>s.startsWith("https://"),"HTTPS source required");
export const districtSchema=z.object({county:z.string().min(2),tax_year:z.number().int().min(2020).max(2100),district_code:z.string().min(1),district_name:z.string().min(1),city_default:z.string().nullable().optional(),school_mills:z.number().finite().nonnegative(),non_school_mills:z.number().finite().nonnegative(),levies:z.array(z.object({name:z.string(),mills:z.number().finite().nonnegative(),school:z.boolean()})),source_name:z.string().min(1),source_url:source,fetched_at:z.string().datetime().optional(),verified_against:z.string().optional()});
export const paramsSchema=z.object({county:z.string().min(2),tax_year:z.number().int().min(2020).max(2100),just_value_ratio:z.number().positive().max(1),uses_greater_of_current_just:z.boolean(),school_hx_exemption:z.number().nonnegative(),non_school_additional_hx:z.number().nonnegative(),cpi_indexed:z.boolean(),rounding:z.enum(["cents","whole_dollar_per_levy"]),estimator_url:source,verified:z.boolean(),verified_case:z.string().optional(),notes:z.string().optional(),exemption_mode:z.enum(["county_estimator","statutory_2026"]).optional(),amendment3_2027:z.boolean().optional()}).refine(x=>!x.verified||!!x.verified_case?.trim(),"Verification evidence required");
export function parseCsv(text:string):Record<string,string>[]{
 const rows:string[][]=[];let row:string[]=[],cell="",quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===","&&!quoted){row.push(cell);cell="";}else if(c==="\n"&&!quoted){row.push(cell.replace(/\r$/,""));rows.push(row);row=[];cell="";}else cell+=c;}
 if(quoted)throw Error("Unclosed CSV quote");if(cell||row.length){row.push(cell.replace(/\r$/,""));rows.push(row);}
 const headers=rows.shift()?.map(h=>h.replace(/^\uFEFF/,"").trim().toUpperCase())??[];
 if(!headers.length||new Set(headers).size!==headers.length)throw Error("Invalid CSV headers");
 return rows.filter(r=>r.some(Boolean)).map(r=>{if(r.length!==headers.length)throw Error("CSV column count mismatch");return Object.fromEntries(headers.map((h,i)=>[h,r[i].trim()]));});
}
export function registerPropertyTaxRatesAdmin(app:Express){
 app.get("/api/admin/property-tax-rates",async(req,res)=>{
  if(!await requireInterestAdmin(req,res))return;
  try{const [d,p]=await Promise.all([supabaseAdmin!.from("county_tax_rate_districts").select("*").order("county"),supabaseAdmin!.from("county_tax_estimate_params").select("*").order("county")]);if(d.error||p.error)throw Error();res.json({districts:d.data,params:p.data});}catch{res.status(503).json({error:"Rates migration awaiting approval or database unavailable"});}
 });
 app.put("/api/admin/property-tax-rates",async(req,res)=>{
  if(!await requireInterestAdmin(req,res))return;
  const kind=req.body?.kind,parsed=(kind==="district"?districtSchema:paramsSchema).safeParse(req.body?.row);
  if(!["district","params"].includes(kind)||!parsed.success)return res.status(400).json({error:"Invalid rates or verification evidence"});
  try{
   const token=/^Bearer\s+(.+)$/i.exec(req.headers.authorization??"")?.[1];
   const auth=await supabaseAdmin!.auth.getUser(token);if(!auth.data.user)return res.sendStatus(403);
   const {data,error}=await supabaseAdmin!.from(kind==="district"?"county_tax_rate_districts":"county_tax_estimate_params").upsert({...parsed.data,updated_by:auth.data.user.id}).select().single();
   if(error)throw error;invalidateQuickTaxJobs();res.json({row:data});
  }catch{res.status(503).json({error:"No successful rates update was confirmed"});}
 });
 app.post("/api/admin/property-tax-rates/collier-import",async(req,res)=>{
  if(!await requireInterestAdmin(req,res))return;
  try{
   const p=z.object({taxYear:z.number().int().min(2020).max(2100),parcelsCsv:z.string().max(20000000),ratesCsv:z.string().max(5000000),sourceUrl:source}).parse(req.body);
   const parcels=parseCsv(p.parcelsCsv),rates=parseCsv(p.ratesCsv);
   const mapped=parcels.map(r=>({parcel_id:r.FOLIO??r.PARCELID??r.PARCEL_ID,tax_year:p.taxYear,millage_area:r.MILLAGEAREA,source_url:p.sourceUrl}));
   if(mapped.some(r=>!r.parcel_id||!r.millage_area))throw Error("Parcel CSV requires FOLIO or PARCELID and MILLAGEAREA");
   const districts=rates.map(r=>districtSchema.parse({county:"collier",tax_year:p.taxYear,district_code:r.MILLAGEAREA,district_name:r.DISTRICT_NAME??r.MILLAGEAREA,school_mills:Number(r.SCHOOL_MILLS),non_school_mills:Number(r.NON_SCHOOL_MILLS),levies:[],source_name:"Collier County Property Appraiser annual millage CSV",source_url:p.sourceUrl}));
   if(!mapped.length||!districts.length)throw Error("Both CSVs must contain rows");
   const token=/^Bearer\s+(.+)$/i.exec(req.headers.authorization??"")?.[1],auth=await supabaseAdmin!.auth.getUser(token);
   if(!auth.data.user)return res.sendStatus(403);
   const {data,error}=await supabaseAdmin!.rpc("import_collier_tax_rates",{p_parcels:mapped,p_rates:districts,p_actor:auth.data.user.id});
   if(error)throw Error("Import migration awaiting approval or import failed; no completed import confirmed");
   invalidateQuickTaxJobs();res.json({imported:data});
  }catch(e){res.status(400).json({error:e instanceof Error?e.message:"CSV import failed"});}
 });
}
