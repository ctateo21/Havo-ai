import {test} from "node:test";
import assert from "node:assert/strict";
import raw from "./data/fl-millage-9-counties.json";
import {researchDistricts,researchParams,planningStatus,bundledQuickRates} from "./integrations/fl-millage-research";
import {calculateQuickTax,quickTaxableBases} from "../shared/quick-property-tax";
import {PUBLIC_APP_ROUTES} from "../shared/public-routes";
const rows=researchDistricts();
test("research preserves per-row years, source and school split",()=>{
 for(const row of rows){assert.ok([2025,2026].includes(row.tax_year));assert.ok(row.source_name);assert.match(row.source_url,/^https:/);assert.ok(row.non_school_mills>=0);}
 assert.equal(rows.find(r=>r.county==="pinellas"&&r.district_code==="SP")?.tax_year,2026);
 assert.equal(rows.find(r=>r.county==="sarasota"&&r.district_code==="M0600")?.tax_year,2025);
 assert.ok(rows.filter(r=>r.county==="collier").every(r=>r.tax_year===2025&&planningStatus(r,researchParams("collier")!,false)==="rough_estimate"));
 assert.equal(raw.d.polk.find(r=>r[0]==="90440")?.[2],18.8259);
 assert.equal(raw.d.lee.find(r=>r[0]==="104")?.[2],13.7683);
 assert.equal(raw.d.collier.find(r=>r[0]==="203")?.[2],9.5099);
});
test("research known-answer purchase calculations",()=>{
 const calculate=(county:string,code:string,price:number,ratio?:number)=>{
  const r=rows.find(r=>r.county===county&&r.district_code===code)!;
  const p=researchParams(county)!;if(ratio)p.just_value_ratio=ratio;
  return calculateQuickTax(price,true,r,p);
 };
 assert.equal(calculate("pinellas","SP",400000),5890);
 assert.equal(calculate("polk","91510",400000),5696);
 assert.equal(calculate("polk","91510",400000,1),6416.33);
 assert.equal(calculate("hillsborough","TA",719400),11239.52);
 assert.equal(calculate("lee","047",400000),4274.09);
 assert.equal(calculate("manatee","0119",313498),4034.33);
});
test("Manatee flat setting is preserved and explicit modes are adjustable",()=>{
 const p=researchParams("manatee")!;assert.equal(p.non_school_additional_hx,25000);assert.equal(p.exemption_mode,"county_estimator");
 assert.equal(quickTaxableBases(400000,true,p).nonSchool,350000);
 assert.equal(quickTaxableBases(400000,true,{...p,exemption_mode:"statutory_2026"}).nonSchool,348589);
});
test("Amendment 3 is off by default and changes only homestead non-school basis",()=>{
 const p=researchParams("pinellas")!;assert.equal(p.amendment3_2027,false);
 const b=quickTaxableBases(400000,true,{...p,amendment3_2027:true});assert.equal(b.nonSchool,190000);assert.equal(b.school,315000);
 assert.equal(quickTaxableBases(400000,false,{...p,amendment3_2027:true}).nonSchool,340000);
});
test("bundled rates work without new tables and grouped Collier IDs are not guessed",()=>{
 assert.ok(PUBLIC_APP_ROUTES.has("/admin/property-tax-rates"));
 assert.equal(bundledQuickRates("pinellas",2026,"SP")?.rate.tax_year,2026);
 assert.equal(bundledQuickRates("collier",2026,"1")?.rate.tax_year,2025);
 assert.equal(bundledQuickRates("collier",2026,"999999"),null);
 assert.equal(researchParams("sarasota")?.verified,false);
});
