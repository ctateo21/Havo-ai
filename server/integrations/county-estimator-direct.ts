import { load } from "cheerio";
import { CountySession, webForm, pageText, amountAfter, moneyCents } from "./county-tax-http";
import { hcpaOfficialLowEndAdValorem, HCPA_ESTIMATOR_PAGE } from "./hillsborough-estimator";
import { fetchHcpaRatesForPin } from "./hillsborough-tax";
import type { CountySlug } from "./parcel-resolver";
export interface EstimatorInput {
  county: CountySlug; parcelId: string; address: string; purchasePrice: number; homestead: boolean; taxYear: number; folioId?: string; taxDistrict?: string;
}
export interface EstimatorOutput {
  adValoremCents: number;
  estimatorNavCents: number | null;
  url: string;
  fetchedAt: string;
  snapshot: string;
  schoolMills?: number;
  nonSchoolMills?: number;
  assessmentRatio?: number;
  exemptionSchedule?: Record<string, number>;
}
const now = () => new Date().toISOString();
export function pinellasEstimatorStrap(parcel: string): string {
  const parts = parcel.split("-");
  if (parts.length !== 6) throw new Error("Pinellas parcel format unavailable");
  [parts[0],parts[2]] = [parts[2],parts[0]];
  return parts.join("") + "--0";
}
/** Caller must specify whether the identifier came from the PA or collector; never swap twice. */
export function pascoCollectorParcel(appraiserParcel: string): string {
  const parts = appraiserParcel.split("-");
  if (parts.length !== 6) throw new Error("Pasco parcel format unavailable");
  [parts[0],parts[2]] = [parts[2],parts[0]];
  return parts.join("-");
}
export function parseEstimatorPage(county: CountySlug, html: string): Pick<EstimatorOutput,"adValoremCents"|"estimatorNavCents"|"snapshot"> {
  const text = pageText(html);
  let adValoremCents: number, estimatorNavCents: number | null = null;
  if (county === "polk") {
    const range = /Unofficial Estimated Tax Range\s*\$?([\d,]+(?:\.\d{2})?)\s*to\s*\$?([\d,]+(?:\.\d{2})?)/i.exec(text);
    const $ = load(html);
    const letter = $("a[href]").toArray().map(e=>$(e).attr("href")!).find(h=>/NonAvAssmnt=/i.test(h));
    if (!range || !letter) throw new Error("Polk estimator range or assessment letter missing");
    const params = new URL(letter,"https://www.polkflpa.gov/").searchParams;
    const nav = params.get("NonAvAssmnt");
    if (nav === null) throw new Error("Polk estimator assessment amount missing");
    estimatorNavCents = moneyCents(nav);
    adValoremCents = moneyCents(range[1]) - estimatorNavCents;
    if (adValoremCents < 0) throw new Error("Polk estimator assessment exceeds total");
  } else {
    adValoremCents = amountAfter(text, /(?:Total\s+Estimated\s+Ad\s+Valorem(?:\s+Tax(?:es)?)?|Total\s+Ad\s+Valorem(?:\s+Tax(?:es)?)?)\s*[:]?/i);
    try { estimatorNavCents = amountAfter(text, /Total\s+(?:Estimated\s+)?Non[- ]Ad\s+Valorem(?:\s+(?:Taxes|Assessments))?\s*[:]?/i); }
    catch { /* Some estimators explicitly exclude NAV; the bill remains mandatory. */ }
  }
  return {adValoremCents,estimatorNavCents,snapshot:text.slice(0,12000)};
}
async function agree(session: CountySession, url: string, suffix: string): Promise<string> {
  const html = await session.request(url);
  return session.request(url,webForm(html,{[suffix]:"I Agree"}));
}
export async function resolveLeeFolio(strap: string, session = new CountySession()): Promise<string> {
  const url = "https://www.leepa.org/Search/PropertySearch.aspx";
  const html = await session.request(url), $ = load(html);
  const field = $("[name]").filter((_,e)=>/tmpl0_STRAPTextBox$/.test($(e).attr("name")||"")).first().attr("name");
  if (!field) throw new Error("Lee STRAP search control unavailable");
  const form = webForm(html,{SubmitPropertySearch:"Search"});
  form.set(field,strap);
  const result = await session.request(url,form), parsed = load(result);
  const links = parsed('a[href*="FolioID="],a[href*="FolioId="]').toArray()
    .filter(e=>parsed(e).closest("tr").text().replace(/[^0-9]/g,"").includes(strap.replace(/\D/g,"")))
    .map(e=>new URL(parsed(e).attr("href")!,url).searchParams);
  const folios = [...new Set(links.map(p=>p.get("FolioID")||p.get("FolioId")).filter(Boolean))];
  if (folios.length!==1) throw new Error("Lee FolioId could not be resolved from STRAP");
  return folios[0]!;
}
export async function directEstimator(input: EstimatorInput): Promise<EstimatorOutput> {
  const {county,parcelId,purchasePrice:price,homestead:hx,taxYear:year,address} = input;
  const s = new CountySession();
  let url: string, html: string;
  if (county === "hillsborough") {
    const folio = parcelId.replace(/^A/i,"").replace(/\D/g,"");
    const records = JSON.parse(await s.request("https://gis.hcpafl.org/CommonServices/property/search/BasicSearch?folio="+folio));
    const rows = Array.isArray(records) ? records : records.parcels ?? records.results ?? [];
    const row = rows.find((p:any)=>String(p.folio??p.FOLIO??"").replace(/\D/g,"")===folio);
    const pin = row?.pin ?? row?.PIN;
    if (!pin) throw new Error("Hillsborough folio could not be matched to PIN");
    const rates = await fetchHcpaRatesForPin(pin);
    if (!rates) throw new Error("Hillsborough estimator rates unavailable");
    const av = hcpaOfficialLowEndAdValorem({purchasePrice:price,homestead:hx,schoolMills:rates.schoolTaxRate,nonSchoolMills:rates.nonschoolTaxRate});
    if (av === null) throw new Error("Hillsborough estimator calculation unavailable");
    return {adValoremCents:Math.round(av*100),estimatorNavCents:null,url:HCPA_ESTIMATOR_PAGE+"?pin="+pin,fetchedAt:now(),snapshot:JSON.stringify(rates),schoolMills:rates.schoolTaxRate,nonSchoolMills:rates.nonschoolTaxRate,assessmentRatio:.85,exemptionSchedule:{homestead_school:25000,homestead_non_school:50000}};
  }
  if (county === "pinellas") {
    url = "https://www.pcpao.gov/tax_estimatorout";
    html = await s.request(url,new URLSearchParams({Addressname:pinellasEstimatorStrap(parcelId),year:String(year),taxDistSel:"",taxprice:String(price),Portability:"No",Addressname2:"",year2:String(year),taxDistportability:"",selectedTaxDistportability:"",market_value:"",assessed_value:"",propertytax:hx?"Yes":"No"}));
  } else if (county === "pasco") {
    // parcelId here is already the collector Geo number, normalized at resolution.
    url = "https://search.pascopa.com/estimate-taxes.aspx?parcel="+encodeURIComponent(parcelId);
    html = await s.request(url);
    html = await s.request(url,webForm(html,{chkSold:"on",txtSalePrice:String(price),chkHomestead:hx?"on":null,hxResident:"rdoResidentYes",btnMyCalc:"Calculate"}));
  } else if (county === "polk") {
    await agree(s,"https://www.polkflpa.gov/TaxEstimatorIntro.aspx","btnTaxEstimator");
    url = "https://www.polkflpa.gov/taxEstimator.aspx?account=&MrktVal=&PrtVal=";
    html = await s.request(url);
    html = await s.request(url,webForm(html,{txtMarketValue:String(price),txtStrap:parcelId.replace(/\D/g,""),rblHomestead:hx?"Yes":"No",btnCalcTaxes:"Calculate"}));
  } else if (county === "sarasota") {
    const start = "https://www.sarasotapropertyappraiser.gov/TaxEstimator/";
    html = await s.request(start);
    const $ = load(html);
    // The public wrapper may embed the actual WebForms agreement page.
    const iframe = $("iframe[src]").first().attr("src");
    const agreement = iframe ? new URL(iframe,start).href : start;
    if (iframe) html = await s.request(agreement);
    const agreementPage = load(html);
    const button = agreementPage("input[type=submit]").filter((_,e)=>/agree/i.test(agreementPage(e).attr("value")||"")).first().attr("name");
    const form = webForm(html,{});
    if (button) form.set(button,"I Agree");
    else {
      const agreeControl = agreementPage("button,a").filter((_,e)=>/^I Agree$/i.test(agreementPage(e).text().trim())).first();
      const postback = /__doPostBack\(['"]([^'"]+)['"],['"]([^'"]*)['"]\)/.exec(agreeControl.attr("onclick")||agreeControl.attr("href")||"");
      if (!postback) throw new Error("Sarasota agreement control unavailable");
      form.set("__EVENTTARGET",postback[1]); form.set("__EVENTARGUMENT",postback[2]);
    }
    await s.request(agreement,form);
    url = "https://www.sarasotapropertyappraiser.gov/TaxEstimator/TaxEstOut.aspx?"+new URLSearchParams({input_address:"",address_from_strap:address,year_acquired:String(year),strap_from_address:"",input_strap:parcelId,address_street:address,mill_code:"",jurisdiction:"",price:String(price),transfer_port:"False",will_homestead:hx?"True":"False",port_address:"",year_sold:String(year),port_strap:"",port_address_street:"",just:"0",assessed:"0"});
    html = await s.request(url);
  } else if (county === "lee") {
    const folio = input.folioId || await resolveLeeFolio(parcelId,s);
    url = "https://www.leepa.org/taxestimator/default.aspx?FolioId="+encodeURIComponent(folio);
    html = await s.request(url);
    const variable = /serverVars\s*=\s*(\{[\s\S]*?\})/.exec(html)?.[1];
    if (!variable) throw new Error("Lee estimator variables unavailable");
    const read = (key:string) => {
      const m = new RegExp(`["']?${key}["']?\\s*:\\s*["']?([\\d.]+)`).exec(variable);
      if (!m) throw new Error("Lee estimator variable missing: "+key);
      return Number(m[1]);
    };
    const actual = read("actualMillage"), school = read("schoolMillage");
    if (price < read("minSalePrice") || price > read("maxSalePrice")) throw new Error("Purchase price outside Lee estimator range");
    const result = JSON.parse(await s.request("https://www.leepa.org/taxestimator/TaxEstimationService.asmx/CalculateTaxes",JSON.stringify({salePrice:String(price),oldAssessed:"0",oldMarket:"0",actualMillage:String(actual),schoolMillage:String(school)}),true)).d;
    const data = typeof result==="string" ? JSON.parse(result) : result;
    const value = data?.[hx?"TaxesWithHomestead":"EstimatedTaxes"];
    if (value===null || value===undefined) throw new Error("Lee estimator tax missing");
    return {adValoremCents:moneyCents(String(value)),estimatorNavCents:null,url,fetchedAt:now(),snapshot:JSON.stringify(data),schoolMills:school,nonSchoolMills:actual-school,assessmentRatio:.9,exemptionSchedule:{homestead_school:25000,homestead_non_school:50000}};
  } else throw new Error("Manatee PAO estimator has no purchase-price input (current-roll only)");
  return {...parseEstimatorPage(county,html),url,fetchedAt:now()};
}
