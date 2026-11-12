import { MANATEE_RATES_LABEL, manateeAdValoremCents } from "../../shared/manatee-property-tax";
import type { EstimatorOutput } from "./county-estimator-direct";
export const MANATEE_RATES_URL = "https://www.manateepao.gov/wp-content/themes/frontier-child/models/pao-model-tax-estimate.php";
export function parseManateeRates(data: any, parcel: string, price: number, homestead: boolean, year: number): EstimatorOutput {
  const r = data?.taxes?.[0];
  const number = (key: string) => r?.[key] !== null && r?.[key] !== undefined && r[key] !== "" ? Number(r[key]) : NaN;
  const school = number("c_sch_rate"), nonSchool = number("c_cty_rate") + number("c_isd_rate") + number("c_mun_rate");
  if (year !== 2026 || number("c_tax_year") !== year || !Number.isFinite(number("c_tot_rate")) ||
      Math.abs(school + nonSchool - number("c_tot_rate")) > .00001)
    throw new Error("Manatee official 2026 parcel rates unavailable");
  const nav = number("c_nav_taxes");
  return {adValoremCents:manateeAdValoremCents(price,homestead,school,nonSchool),
    estimatorNavCents:Number.isFinite(nav) && nav >= 0 ? Math.round(nav*100) : null,
    schoolMills:school,nonSchoolMills:nonSchool,assessmentRatio:1,
    exemptionSchedule:{homestead_school:25000,homestead_non_school:50000},
    sourceLabel:MANATEE_RATES_LABEL,rateYear:year,url:`${MANATEE_RATES_URL}?parid=${parcel}`,
    fetchedAt:new Date().toISOString(),snapshot:JSON.stringify(data)};
}
