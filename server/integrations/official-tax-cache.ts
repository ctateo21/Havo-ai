import { supabaseAdmin } from "../supabase";
import type { CountySlug } from "./parcel-resolver";
import type { OfficialBill } from "./official-county-bills";
import type { EstimatorOutput } from "./county-estimator-direct";
import { pinellasEstimatorStrap } from "./county-estimator-direct";
import { MANATEE_RATES_SOURCE, MANATEE_RATES_LABEL } from "../../shared/manatee-property-tax";
/** Nov 1 is still EDT unless it is Sunday (the first Sunday ends DST at 2am).
 * Midnight Nov 1 is therefore always UTC-04:00 under US rules. */
export function officialTaxExpiry(now = new Date()): Date {
  const year = Number(new Intl.DateTimeFormat("en-US",{year:"numeric",timeZone:"America/New_York"}).format(now));
  const boundary = new Date(Date.UTC(year,10,1,4));
  return now < boundary ? boundary : new Date(Date.UTC(year+1,10,1,4));
}
export function currentBillYear(now = new Date()): number {
  const year = Number(new Intl.DateTimeFormat("en-US",{year:"numeric",timeZone:"America/New_York"}).format(now));
  return now < new Date(Date.UTC(year,10,1,4)) ? year-1 : year;
}
export interface OfficialCache {
  county: CountySlug; parcelId: string; taxYear: number;
  bill?: OfficialBill;
  estimator?: EstimatorOutput;
}
export async function readOfficialCache(county: CountySlug, parcelId: string, taxYear: number, now = new Date()): Promise<OfficialCache | null> {
  if (!supabaseAdmin) return null;
  const {data:r,error} = await supabaseAdmin.from("property_tax_cache").select("*").eq("county",county).eq("parcel_id",parcelId).eq("tax_year",taxYear).maybeSingle();
  if (error) throw new Error("Official tax cache unavailable; verify the database migration");
  if (!r || new Date(r.expires_at)<=now) return null;
  const value: OfficialCache = {county,parcelId,taxYear};
  let metadata:any;
  try {metadata=JSON.parse(r.raw_snapshot??"{}");} catch {metadata={};}
  const cents = (v:unknown) => v!==null && v!==undefined && Number.isFinite(Number(v)) && Number(v)>=0 ? Math.round(Number(v)*100) : null;
  const av=cents(r.bill_ad_valorem_total),nav=cents(r.nav_total),total=cents(r.bill_combined_total);
  if (av!==null && nav!==null && total===av+nav && r.bill_url && r.bill_queried_at && Array.isArray(r.nav_lines) && (county!=="pinellas" || metadata.situsAddress)) {
    value.bill={adValoremCents:av,navCents:nav,combinedCents:total,lines:r.nav_lines,url:r.bill_url,fetchedAt:r.bill_queried_at,taxYear,snapshot:typeof metadata.bill==="string"?metadata.bill:"",situsAddress:metadata.situsAddress};
  }
  if (r.estimator_source==="collier-official-page-verified-recompute" && r.mills_school!=null && r.mills_non_school!=null && r.estimator_url && r.estimator_queried_at) {
    value.estimator={adValoremCents:0,estimatorNavCents:null,schoolMills:Number(r.mills_school),nonSchoolMills:Number(r.mills_non_school),assessmentRatio:Number(r.assessment_ratio),exemptionSchedule:r.exemption_schedule,url:r.estimator_url,fetchedAt:r.estimator_queried_at,snapshot:typeof metadata.estimator==="string"?metadata.estimator:""};
  }
  if (county==="manatee" && taxYear===2026 && r.estimator_source===MANATEE_RATES_SOURCE &&
      Number(r.mills_school)>0 && Number(r.mills_non_school)>0 && Number(r.assessment_ratio)===1 &&
      r.exemption_schedule?.homestead_school===25000 && r.exemption_schedule?.homestead_non_school===50000 &&
      metadata.rateYear===2026 && r.estimator_url && r.estimator_queried_at) {
    value.estimator={adValoremCents:0,estimatorNavCents:metadata.estimatorNavCents??null,
      schoolMills:Number(r.mills_school),nonSchoolMills:Number(r.mills_non_school),assessmentRatio:1,
      exemptionSchedule:r.exemption_schedule,rateYear:2026,sourceLabel:MANATEE_RATES_LABEL,
      url:r.estimator_url,fetchedAt:r.estimator_queried_at,snapshot:metadata.estimator??""};
  }
  return value;
}
export async function writeOfficialCache(value: OfficialCache): Promise<void> {
  if (!supabaseAdmin) throw new Error("Official tax cache database unavailable");
  const now = new Date(), b=value.bill, e=value.estimator;
  const row: Record<string,unknown> = {
    county:value.county,parcel_id:value.parcelId,tax_year:value.taxYear,
    source:"official-county-tax-v1",queried_at:now.toISOString(),expires_at:officialTaxExpiry(now).toISOString(),
    ...(b ? {nav_lines:b.lines,nav_total:b.navCents/100,bill_ad_valorem_total:b.adValoremCents/100,bill_combined_total:b.combinedCents/100,bill_url:b.url,bill_source:`${value.county} County Tax Collector ${value.taxYear} Annual Bill`,bill_queried_at:b.fetchedAt} : {}),
    ...(e ? {mills_school:e.schoolMills??null,mills_non_school:e.nonSchoolMills??null,mills_total:e.schoolMills!=null&&e.nonSchoolMills!=null?e.schoolMills+e.nonSchoolMills:null,exemption_schedule:e.exemptionSchedule??null,assessment_ratio:e.assessmentRatio??null,estimator_url:e.url,estimator_queried_at:e.fetchedAt,estimator_source:value.county==="collier"?"collier-official-page-verified-recompute":`${value.county}-official-estimator`} : {}),
    raw_snapshot:JSON.stringify({identifiers:value.county==="pinellas"?{parcel:value.parcelId,estimatorStrap:pinellasEstimatorStrap(value.parcelId).replace("--0",""),billAccount:b?new URL(b.url).searchParams.get("p"):null}:undefined,situsAddress:b?.situsAddress,bill:b?.snapshot.slice(0,9000),estimator:e?.snapshot.slice(0,9000)}),
  };
  if (value.county==="manatee" && e) {
    row.source=MANATEE_RATES_SOURCE;
    row.estimator_source=MANATEE_RATES_SOURCE;
    row.raw_snapshot=JSON.stringify({bill:b?.snapshot.slice(0,9000),estimator:e.snapshot.slice(0,9000),rateYear:e.rateYear,sourceLabel:e.sourceLabel,estimatorNavCents:e.estimatorNavCents});
  }
  const {error}=await supabaseAdmin.from("property_tax_cache").upsert(row,{onConflict:"county,parcel_id,tax_year"});
  if(error) throw new Error("Official tax cache write failed");
}
