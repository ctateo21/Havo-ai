import { composeOfficialTax, COUNTY_TAX_WARNINGS, type TaxPart, type TaxSource } from "../../shared/official-tax";
import { isCountyEstimatorVerified } from "../../shared/county-estimator-policy";
import { resolveParcel, writeIdentityCache, type CountySlug } from "./parcel-resolver";
import { directEstimator, type EstimatorInput, type EstimatorOutput } from "./county-estimator-direct";
import { browserEstimator } from "./county-estimator-browser";
import { fetchOfficialBill, type OfficialBill } from "./official-county-bills";
import { readOfficialCache, writeOfficialCache, currentBillYear } from "./official-tax-cache";
import { calculateCollierPurchaseAdValorem } from "../../shared/collier-property-tax";
import { MANATEE_RATES_SOURCE, manateeAdValoremCents } from "../../shared/manatee-property-tax";
import { purchaseTaxVariantKey } from "../../shared/purchase-homestead";

const title = (county: string) => county[0].toUpperCase()+county.slice(1);
const countyTaxDependencies={readOfficialCache,writeOfficialCache,fetchOfficialBill,directEstimator,browserEstimator};
export async function officialParcelTax(input: EstimatorInput, refinance = false, dependencies=countyTaxDependencies) {
  const {readOfficialCache,writeOfficialCache,fetchOfficialBill,directEstimator,browserEstimator}=dependencies;
  if(!refinance && typeof input.homestead!=="boolean") return composeOfficialTax(
    {cents:null,reason:"Select Property Use to calculate property tax."},
    {cents:null,reason:"Select Property Use to calculate property tax."});
  let bill: OfficialBill | undefined, estimator: EstimatorOutput | undefined;
  let billError = "", estimatorError = "";
  const warnings: string[] = COUNTY_TAX_WARNINGS[input.county] ? [COUNTY_TAX_WARNINGS[input.county]] : [];
  let cached: Awaited<ReturnType<typeof readOfficialCache>> = null;
  try { cached = await readOfficialCache(input.county,input.parcelId,input.taxYear); }
  catch { warnings.push("The official tax cache is unavailable; fresh county data is required."); }
  const purchaseResults={...cached?.purchaseResults};
  const resultKey=(hx:boolean)=>purchaseTaxVariantKey(input.purchasePrice,hx);
  await Promise.all([
    (async()=>{
      try { bill=cached?.bill || await fetchOfficialBill(input.county,input.parcelId,input.taxYear,undefined,input.address); }
      catch(e) { billError = e instanceof Error ? e.message : "Collector bill unavailable"; }
    })(),
    (async()=>{
      if (refinance) return;
      try {
        if(input.county==="manatee") {
          const e=cached?.estimator;
          estimator=e ? {...e,adValoremCents:manateeAdValoremCents(input.purchasePrice,input.homestead,e.schoolMills!,e.nonSchoolMills!)} : await directEstimator(input);
          return;
        }
        if(!isCountyEstimatorVerified(input.county)) throw new Error(`${title(input.county)} official estimator has not passed verification`);
        if(["collier","hernando"].includes(input.county) && process.env[input.county==="collier"?"COLLIER_BROWSER_ESTIMATOR":"HERNANDO_BROWSER_ESTIMATOR"]!=="on")
          throw new Error(`${title(input.county)} estimator requires browser automation (disabled)`);
        const saved=purchaseResults[resultKey(input.homestead)];
        if(saved && Number.isSafeInteger(saved.adValoremCents) && saved.adValoremCents>=0) {estimator=saved;return;}
        if(["collier","hernando"].includes(input.county)) {
          if(process.env[input.county==="collier"?"COLLIER_BROWSER_ESTIMATOR":"HERNANDO_BROWSER_ESTIMATOR"]!=="on")
            throw new Error(`${title(input.county)} estimator requires browser automation (disabled)`);
          const e = cached?.estimator;
          if(input.county==="collier" && e && e.schoolMills!=null && e.nonSchoolMills!=null && e.assessmentRatio===1 && e.exemptionSchedule?.homestead_non_school===50000 && e.exemptionSchedule?.homestead_school===25000) {
            estimator = {...e,adValoremCents:100*calculateCollierPurchaseAdValorem(input.purchasePrice,input.homestead,{school:e.schoolMills,county:e.nonSchoolMills,municipal:0,other:0})};
          } else estimator=await browserEstimator(input);
        } else estimator=await directEstimator(input);
        if(estimator) {
          purchaseResults[resultKey(input.homestead)]={...estimator,snapshot:""};
          // Capture both official answers, not a guessed linear rate. Once warm,
          // occupancy switches reuse the exact price/homestead-specific result.
          if(!["collier","manatee"].includes(input.county) && !purchaseResults[resultKey(!input.homestead)]) {
            try {
              const other=await (input.county==="hernando"?browserEstimator:directEstimator)({...input,homestead:!input.homestead});
              purchaseResults[resultKey(!input.homestead)]={...other,snapshot:""};
            } catch { warnings.push("The other homestead option could not be cached; selecting it will retry the official county lookup."); }
          }
        }
      } catch(e) { estimatorError=e instanceof Error?e.message:"Official estimator unavailable"; }
    })(),
  ]);
  const billSource: TaxSource | undefined = bill ? {name:`${title(input.county)} County Tax Collector ${bill.taxYear} Annual Bill`,url:bill.url,fetchedAt:bill.fetchedAt,taxYear:bill.taxYear,parcelId:input.parcelId} : undefined;
  const estimatorSource: TaxSource | undefined = estimator ? {name:estimator.sourceLabel ?? `${title(input.county)} County Property Appraiser Tax Estimator`,url:estimator.url,fetchedAt:estimator.fetchedAt,taxYear:input.taxYear,parcelId:input.parcelId,purchasePrice:input.purchasePrice,homestead:input.homestead} : undefined;
  const adValorem: TaxPart = refinance ? {cents:bill?.adValoremCents??null,reason:billError||undefined,source:billSource} : {cents:estimator?.adValoremCents??null,reason:estimatorError||undefined,source:estimatorSource};
  const nav: TaxPart = {cents:bill?.navCents??null,reason:billError||undefined,source:billSource,lines:bill?.lines};
  if(bill && estimator?.estimatorNavCents!=null && bill.navCents!==estimator.estimatorNavCents)
    warnings.push(`The estimator shows $${(estimator.estimatorNavCents/100).toFixed(2)} non-ad valorem; the current bill shows $${(bill.navCents/100).toFixed(2)}. The bill amount is used.`);
  if(bill || estimator) {
    try { await writeOfficialCache({county:input.county,parcelId:input.parcelId,taxYear:input.taxYear,bill,estimator:estimator ?? (input.county==="manatee"?cached?.estimator:undefined),purchaseResults}); }
    catch { warnings.push("Official data was fetched, but could not be saved in the cache."); }
  }
  const breakdown=composeOfficialTax(adValorem,nav,warnings);
  if(refinance && bill) breakdown.total.source=billSource;
  return breakdown;
}
export async function officialPurchaseTax(params: {county:CountySlug;address:string;purchasePrice:number;isPrimaryResidence:boolean}) {
  if (params.county !== "manatee" && !isCountyEstimatorVerified(params.county)) {
    const reason=`${title(params.county)} official estimator has not passed verification`;
    const breakdown=composeOfficialTax({cents:null,reason},{cents:null,reason:"Collector bill not loaded for this unverified purchase estimate"});
    return {adValoremTax:null,nonAdValoremTax:null,annualTax:null,monthlyTax:null,source:`${params.county}-county-estimator-unavailable`,fromGeneralCache:false,breakdown,operationalError:reason,nonAdValoremPending:false,nonAdValoremLines:[]};
  }
  let identity=await resolveParcel(params.county,params.address);
  let identityError="County parcel identity could not be verified";
  if(params.county==="collier" && identity.status!=="found" && process.env.COLLIER_BROWSER_ESTIMATOR==="on"){
    try{
      const result=await browserEstimator({county:"collier",parcelId:"",address:params.address,purchasePrice:params.purchasePrice,homestead:params.isPrimaryResidence,taxYear:currentBillYear()});
      if(!result.parcelId || !result.situsAddress) throw new Error("Collier browser parcel identity missing");
      identity={status:"found",county:"collier",parcelId:result.parcelId,folio:result.parcelId,situsAddress:result.situsAddress,situsCity:null,taxDistrict:null,source:"collier-official-estimator-page"};
      await writeIdentityCache(params.address,identity,new Date());
      await writeOfficialCache({county:"collier",parcelId:result.parcelId,taxYear:currentBillYear(),estimator:result});
    }catch(e){identityError=e instanceof Error?e.message:identityError;}
  }
  const parcelId=["hillsborough","hernando"].includes(params.county) ? identity.folio : identity.parcelId;
  const breakdown=identity.status==="found" && parcelId
    ? await officialParcelTax({county:params.county,parcelId,address:params.address,purchasePrice:params.purchasePrice,homestead:params.isPrimaryResidence,taxYear:currentBillYear(),taxDistrict:identity.taxDistrict||undefined,folioId:params.county==="lee"?identity.folio||undefined:undefined})
    : composeOfficialTax({cents:null,reason:identityError},{cents:null,reason:"Collector parcel identity could not be verified"});
  return {
    adValoremTax:breakdown.adValorem.cents===null?null:breakdown.adValorem.cents/100,
    nonAdValoremTax:breakdown.nonAdValorem.cents===null?null:breakdown.nonAdValorem.cents/100,
    annualTax:breakdown.total.cents===null?null:breakdown.total.cents/100,
    monthlyTax:breakdown.total.cents===null?null:Math.round(breakdown.total.cents/12)/100,
    source:`${params.county==="manatee"?MANATEE_RATES_SOURCE:`${params.county}-county-estimator`}${breakdown.total.cents===null?"-unavailable":""}`,
    fromGeneralCache:false,parcelId:parcelId||undefined,breakdown,
    nonAdValoremLines:breakdown.nonAdValorem.lines?.map(l=>({authority:l.name,amount:l.amount})),
    nonAdValoremPending:false,operationalError:breakdown.total.reason,
    sourceLabel:breakdown.adValorem.source?.name,
  };
}
