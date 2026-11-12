import { composeOfficialTax, COUNTY_TAX_WARNINGS, type TaxPart, type TaxSource } from "../../shared/official-tax";
import { isCountyEstimatorVerified } from "../../shared/county-estimator-policy";
import { resolveParcel, type CountySlug } from "./parcel-resolver";
import { directEstimator, type EstimatorInput, type EstimatorOutput } from "./county-estimator-direct";
import { browserEstimator } from "./county-estimator-browser";
import { fetchOfficialBill, type OfficialBill } from "./official-county-bills";
import { readOfficialCache, writeOfficialCache, currentBillYear } from "./official-tax-cache";
import { calculateCollierPurchaseAdValorem } from "../../shared/collier-property-tax";

const title = (county: string) => county[0].toUpperCase()+county.slice(1);
export async function officialParcelTax(input: EstimatorInput, refinance = false) {
  let bill: OfficialBill | undefined, estimator: EstimatorOutput | undefined;
  let billError = "", estimatorError = "";
  const warnings: string[] = COUNTY_TAX_WARNINGS[input.county] ? [COUNTY_TAX_WARNINGS[input.county]] : [];
  let cached: Awaited<ReturnType<typeof readOfficialCache>> = null;
  try { cached = await readOfficialCache(input.county,input.parcelId,input.taxYear); }
  catch { warnings.push("The official tax cache is unavailable; fresh county data is required."); }
  await Promise.all([
    (async()=>{
      try { bill=cached?.bill || await fetchOfficialBill(input.county,input.parcelId,input.taxYear); }
      catch(e) { billError = e instanceof Error ? e.message : "Collector bill unavailable"; }
    })(),
    (async()=>{
      if (refinance) return;
      try {
        if(input.county==="manatee") throw new Error("Manatee PAO estimator has no purchase-price input (current-roll only)");
        if(!isCountyEstimatorVerified(input.county)) throw new Error(`${title(input.county)} official estimator has not passed verification`);
        if(["collier","hernando"].includes(input.county)) {
          if(process.env[input.county==="collier"?"COLLIER_BROWSER_ESTIMATOR":"HERNANDO_BROWSER_ESTIMATOR"]!=="on")
            throw new Error(`${title(input.county)} estimator requires browser automation (disabled)`);
          const e = cached?.estimator;
          if(input.county==="collier" && e && e.schoolMills!=null && e.nonSchoolMills!=null && e.assessmentRatio===1 && e.exemptionSchedule?.homestead_non_school===50000 && e.exemptionSchedule?.homestead_school===25000) {
            estimator = {...e,adValoremCents:100*calculateCollierPurchaseAdValorem(input.purchasePrice,input.homestead,{school:e.schoolMills,county:e.nonSchoolMills,municipal:0,other:0})};
          } else estimator=await browserEstimator(input);
        } else estimator=await directEstimator(input);
      } catch(e) { estimatorError=e instanceof Error?e.message:"Official estimator unavailable"; }
    })(),
  ]);
  const billSource: TaxSource | undefined = bill ? {name:`${title(input.county)} County Tax Collector ${bill.taxYear} Annual Bill`,url:bill.url,fetchedAt:bill.fetchedAt,taxYear:bill.taxYear,parcelId:input.parcelId} : undefined;
  const estimatorSource: TaxSource | undefined = estimator ? {name:`${title(input.county)} County Property Appraiser Tax Estimator`,url:estimator.url,fetchedAt:estimator.fetchedAt,taxYear:input.taxYear,parcelId:input.parcelId,purchasePrice:input.purchasePrice,homestead:input.homestead} : undefined;
  const adValorem: TaxPart = refinance ? {cents:bill?.adValoremCents??null,reason:billError||undefined,source:billSource} : {cents:estimator?.adValoremCents??null,reason:estimatorError||undefined,source:estimatorSource};
  const nav: TaxPart = {cents:bill?.navCents??null,reason:billError||undefined,source:billSource,lines:bill?.lines};
  if(bill && estimator?.estimatorNavCents!=null && bill.navCents!==estimator.estimatorNavCents)
    warnings.push(`The estimator shows $${(estimator.estimatorNavCents/100).toFixed(2)} non-ad valorem; the current bill shows $${(bill.navCents/100).toFixed(2)}. The bill amount is used.`);
  if(bill || estimator) {
    try { await writeOfficialCache({county:input.county,parcelId:input.parcelId,taxYear:input.taxYear,bill,estimator}); }
    catch { warnings.push("Official data was fetched, but could not be saved in the cache."); }
  }
  const breakdown=composeOfficialTax(adValorem,nav,warnings);
  if(refinance && bill) breakdown.total.source=billSource;
  return breakdown;
}
export async function officialPurchaseTax(params: {county:CountySlug;address:string;purchasePrice:number;isPrimaryResidence:boolean}) {
  if (!isCountyEstimatorVerified(params.county)) {
    const reason=params.county==="manatee" ? "Manatee PAO estimator has no purchase-price input (current-roll only)" : `${title(params.county)} official estimator has not passed verification`;
    const breakdown=composeOfficialTax({cents:null,reason},{cents:null,reason:"Collector bill not loaded for this unverified purchase estimate"});
    return {adValoremTax:null,nonAdValoremTax:null,annualTax:null,monthlyTax:null,source:`${params.county}-county-estimator-unavailable`,fromGeneralCache:false,breakdown,operationalError:reason,nonAdValoremPending:false,nonAdValoremLines:[]};
  }
  const identity=await resolveParcel(params.county,params.address);
  const parcelId=params.county==="hillsborough" ? identity.folio : identity.parcelId;
  const breakdown=identity.status==="found" && parcelId
    ? await officialParcelTax({county:params.county,parcelId,address:params.address,purchasePrice:params.purchasePrice,homestead:params.isPrimaryResidence,taxYear:currentBillYear(),taxDistrict:identity.taxDistrict||undefined,folioId:params.county==="lee"?identity.folio||undefined:undefined})
    : composeOfficialTax({cents:null,reason:"County parcel identity could not be verified"},{cents:null,reason:"Collector parcel identity could not be verified"});
  return {
    adValoremTax:breakdown.adValorem.cents===null?null:breakdown.adValorem.cents/100,
    nonAdValoremTax:breakdown.nonAdValorem.cents===null?null:breakdown.nonAdValorem.cents/100,
    annualTax:breakdown.total.cents===null?null:breakdown.total.cents/100,
    monthlyTax:breakdown.total.cents===null?null:Math.round(breakdown.total.cents/12)/100,
    source:`${params.county}-county-estimator${breakdown.total.cents===null?"-unavailable":""}`,
    fromGeneralCache:false,parcelId:parcelId||undefined,breakdown,
    nonAdValoremLines:breakdown.nonAdValorem.lines?.map(l=>({authority:l.name,amount:l.amount})),
    nonAdValoremPending:false,operationalError:breakdown.total.reason,
    sourceLabel:breakdown.adValorem.source?.name,
  };
}
