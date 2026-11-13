export type EstimateStatus="estimate"|"area_estimate"|"rough_estimate";
export interface DistrictRate {
 county:string;tax_year:number;district_code:string;district_name:string;city_default?:string|null;
 school_mills:number;non_school_mills:number;levies:Array<{name:string;mills:number;school:boolean}>;
 source_name:string;source_url:string;fetched_at:string;verified_against?:string;
}
export interface EstimateParams {
 county:string;tax_year:number;just_value_ratio:number;uses_greater_of_current_just:boolean;
 school_hx_exemption:number;non_school_additional_hx:number;cpi_indexed:boolean;
 rounding:"cents"|"whole_dollar_per_levy";estimator_url:string;verified:boolean;verified_case?:string;notes?:string;
 exemption_mode?:"county_estimator"|"statutory_2026";
 amendment3_2027?:boolean;
}
export function calculateQuickTax(price:number,homestead:boolean,r:DistrictRate,p:EstimateParams,justValue?:number){
 if(!(price>0)||!Number.isFinite(price)||![r.school_mills,r.non_school_mills].every(n=>Number.isFinite(n)&&n>=0)||r.school_mills+r.non_school_mills<=0)throw Error("Verified district millage unavailable");
 const {school,nonSchool}=quickTaxableBases(price,homestead,p,justValue);
 const configured=p.verified||p.exemption_mode!==undefined;
 if(configured&&p.rounding==="whole_dollar_per_levy"){
  if(!r.levies?.length)throw Error("County levy breakdown unavailable");
  return r.levies.reduce((sum,l)=>sum+Math.round((l.school?school:nonSchool)*l.mills/1000),0);
 }
 return Math.round((school*r.school_mills+nonSchool*r.non_school_mills)/10)/100;
}
export function quickTaxableBases(price:number,homestead:boolean,p:EstimateParams,justValue?:number){
 const configured=p.verified||p.exemption_mode!==undefined;
 const base=configured?Math.max(price*p.just_value_ratio,p.uses_greater_of_current_just?justValue??0:0):price;
 const school= Math.max(0,base-(homestead&&configured?p.school_hx_exemption:0));
 const extra=p.exemption_mode==="statutory_2026"?26411:p.non_school_additional_hx;
 const nonSchool=Math.max(0,base-(homestead&&configured?(p.amendment3_2027?150000:p.school_hx_exemption+Math.min(extra,Math.max(base-50000,0))):0));
 return {base,school,nonSchool};
}
export const ROUGH_TAX_LABEL="Rough estimate — county assessment and exemption rules not verified";
