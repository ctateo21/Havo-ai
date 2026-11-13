/** Generates SQL only. Never connects to a database. */
import {writeFile} from "node:fs/promises";
import {researchDistricts,researchParams} from "../server/integrations/fl-millage-research";
const quote=(s:unknown)=>s===null||s===undefined?"NULL":typeof s==="boolean"?String(s):typeof s==="number"?String(s):"'"+String(s).replace(/'/g,"''")+"'";
const rows=researchDistricts(),counties=[...new Set(rows.map(r=>r.county))];
let sql=`-- GENERATED from server/data/fl-millage-9-counties.json. APPROVAL REQUIRED.
-- No shared or managed database application is authorized.
BEGIN;
ALTER TABLE public.county_tax_estimate_params
 ADD COLUMN exemption_mode text NOT NULL DEFAULT 'county_estimator' CHECK(exemption_mode IN('county_estimator','statutory_2026')),
 ADD COLUMN amendment3_2027 boolean NOT NULL DEFAULT false;
-- Retain old planning rows for audit, but retire their city-default mapping.
UPDATE public.county_tax_rate_districts SET city_default=NULL
 WHERE updated_by='legacy-preview-seed' AND district_code LIKE 'city:%';
`;
for(const r of rows){
 const record={...r,levies:JSON.stringify(r.levies),updated_by:"research-seed"};
 const keys=Object.keys(record);
 sql+=`INSERT INTO public.county_tax_rate_districts(${keys.join(",")}) VALUES(${Object.entries(record).map(([key,value])=>key==="fetched_at"?"now()":quote(value)).join(",")})
ON CONFLICT(county,tax_year,district_code) DO UPDATE SET ${keys.filter(k=>!["county","tax_year","district_code"].includes(k)).map(k=>`${k}=EXCLUDED.${k}`).join(",")}
WHERE county_tax_rate_districts.updated_by IN('legacy-preview-seed','research-seed');\n`;
}
for(const county of counties){
 const record={...researchParams(county)!,updated_by:"research-seed"},keys=Object.keys(record);
 sql+=`INSERT INTO public.county_tax_estimate_params(${keys.join(",")}) VALUES(${Object.values(record).map(quote).join(",")})
ON CONFLICT(county,tax_year) DO UPDATE SET ${keys.filter(k=>!["county","tax_year"].includes(k)).map(k=>`${k}=EXCLUDED.${k}`).join(",")}
WHERE county_tax_estimate_params.updated_by IN('legacy-preview-seed','research-seed');\n`;
}
sql+="COMMIT;\n";
const output=process.argv[2];if(!output)throw Error("Provide an output SQL path. This script does not execute SQL.");
await writeFile(output,sql);
console.log(`Prepared ${rows.length} district rows and ${counties.length} county settings. No database writes.`);
