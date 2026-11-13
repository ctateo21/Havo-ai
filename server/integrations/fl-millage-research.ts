import data from "../data/fl-millage-9-counties.json";
import type {DistrictRate,EstimateParams} from "../../shared/quick-property-tax";
import {ROUGH_TAX_LABEL} from "../../shared/quick-property-tax";
export type ResearchCounty=keyof typeof data.c;
const sources:Record<ResearchCounty,[string,string]>={
 hillsborough:["HCPA 2026 Final Millage","https://www.hcpafl.org/Portals/HCPAFL/pdfs/2026FinalMillage.pdf"],
 pinellas:["PCPAO 2026 estimator","https://www.pcpao.gov/tax_estimatorout"],
 pasco:["Pasco PA 2026 millage","https://search.pascopa.com/millage.aspx?taxyear=2026"],
 polk:["Polk PA 2026 Final Millage","https://www.polkflpa.gov/Downloads/Files/finalmillage.pdf"],
 sarasota:["Sarasota Tax Collector 2026 millage","https://www.sarasotataxcollector.gov/files/docs/2026millages.pdf"],
 lee:["Lee PA 2026 Taxing District Millage Book","https://www.leepa.org/"],
 manatee:["Manatee PA 2026 Final Adopted Millage Rates","https://www.manateepao.gov/"],
 hernando:["Hernando PA 2026 Millage Rate Breakdown","https://www.hernandocountypa-florida.us/"],
 collier:["FL DOR 2025 TACD","https://floridarevenue.com/property/dataportal/Pages/default.aspx"],
};
const cityDefaults:Record<string,string>={"hillsborough:TA":"TAMPA","pinellas:SP":"ST PETERSBURG","sarasota:M0500":"NORTH PORT","collier:27":"MARCO ISLAND"};
export function planningStatus(rate:DistrictRate,params:EstimateParams,area:boolean){
 return rate.tax_year===2025||!params.verified?"rough_estimate":area?"area_estimate":"estimate";
}
export function planningLabel(rate:DistrictRate,params:EstimateParams){
 if(params.amendment3_2027)return `2027 rules (Amendment 3), ${rate.tax_year} mills${rate.tax_year===2025?" — rough estimate":""}`;
 if(rate.tax_year===2025)return "Rough estimate · 2025 millage";
 if(!params.verified)return ROUGH_TAX_LABEL;
 return `Estimated from ${rate.tax_year} ${rate.county} millage, district ${rate.district_code} — source: ${rate.source_name}`;
}
export function researchParams(county:string):EstimateParams|null{
 if(!(county in data.c))return null;
 const c=data.c[county as ResearchCounty];
 return {county,tax_year:2026,just_value_ratio:c.ratio,uses_greater_of_current_just:c.greaterJV,
  school_hx_exemption:25000,non_school_additional_hx:c.estAdd??26411,cpi_indexed:!["hillsborough","lee","collier","hernando","manatee"].includes(county),
  rounding:county==="pinellas"?"whole_dollar_per_levy":"cents",estimator_url:sources[county as ResearchCounty][1],
  verified:!["sarasota","pasco","hernando"].includes(county),verified_case:"Christian-supplied official-source research, 2026-11-12",
  notes:county==="manatee"?"Saved flat $50,000 total; published sheet uses $51,411. Christian has not changed the saved choice.":county==="sarasota"?"Unverified: collector sheet differs from preserved estimator fixture.":county==="pasco"?"2026 additional exemption 26411; county tool currently uses 2027 rules.":undefined,
  exemption_mode:"county_estimator",amendment3_2027:false};
}
export function researchDistricts():DistrictRate[]{
 return (Object.keys(data.c) as ResearchCounty[]).flatMap(county=>{
  const c=data.c[county];
  return (data.d[county] as Array<[string,string,number]>).map(([raw,name,total])=>{
   const year=(c.otherYear as string[]).includes(raw)?(c.dy===2026?2025:2026):c.dy;
   const school=year===2026?c.sch6:c.sch5,code=raw.split(" +")[0];
   const source=year===2025?["FL DOR 2025 TACD",`https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/TACD%20History/2025%20Taxing%20Authority%20Code%20Descriptions/2025%20${county[0].toUpperCase()+county.slice(1)}%20TACD.pdf`]:sources[county];
   const non=Number((total-school).toFixed(4));
   const levies=county==="pinellas"&&code==="SP"&&year===2026?
    [3.025,3.248,4.4989,.0713,.0171,.805,6.4525,.1831,.8168,.7168].map((mills,i)=>({name:`Supplied ${i<2?"school":"non-school"} levy ${i+1}`,mills,school:i<2})):
    [{name:"School aggregate",mills:school,school:true},{name:"Non-school aggregate",mills:non,school:false}];
   return {county,tax_year:year,district_code:code,district_name:name,city_default:cityDefaults[`${county}:${code}`]??null,school_mills:school,non_school_mills:non,levies,source_name:source[0],source_url:source[1],
    fetched_at:"2026-11-12",verified_against:`Supplied research dated 2026-11-12; code label ${raw}; not a live estimator result`};
  });
 });
}
export function bundledQuickRates(county:string,year:number,district?:string|null,city?:string|null){
 const rows=researchDistricts().filter(r=>r.county===county&&r.tax_year<=year&&r.tax_year>=year-1);
 const normal=(s:string)=>s.toUpperCase().replace(/\./g,"").replace(/\s+/g," ").trim();
 const code=district?.trim();
 const row=rows.find(r=>r.district_code===code)??rows.find(r=>city&&r.city_default&&normal(r.city_default)===normal(city));
 const params=researchParams(county);
 return row&&params?{rate:row,params,area:row.district_code!==code||row.tax_year!==year}:null;
}
