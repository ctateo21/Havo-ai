import {load} from "cheerio";
import {resolveParcel,type CountySlug,type ParcelIdentity} from "./parcel-resolver";
import {streetIdentity} from "./insurance-building-sources";
import type {PermitEvidence} from "../../shared/wind-mitigation";

const names:Record<string,string>={lee:"Lee",manatee:"Manatee",pasco:"Pasco",polk:"Polk",hernando:"Hernando",collier:"Collier"};
export const PA_PERMIT_RESTRICTIONS:Record<string,string>={
  sarasota:"Sarasota PA robots.txt disallows propertysearch parcel/detail access; not scraped",
};
const date=(value:string)=>{
  // PA dates are calendar dates, not UTC instants. Never substitute completion dates.
  const iso=/^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const us=/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value.trim());
  if(iso)return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if(!us)return null;
  const year=us[3].length===2?Number(us[3])+(Number(us[3])>50?1900:2000):Number(us[3]);
  if(+us[1]>12||+us[2]>31||+us[1]<1||+us[2]<1)return null;
  return `${year}-${us[1].padStart(2,"0")}-${us[2].padStart(2,"0")}`;
};
function record(county:string,url:string,number:string,description:string,issued:string,received=false):PermitEvidence[]{
  const d=date(issued);
  if(!number?.trim()||!description?.trim()||!d)return [];
  return [{number:number.trim(),description:description.trim(),date:d,source:`${names[county]} County Property Appraiser${received?" (date received, not verified issue date)":""}`,sourceUrl:url,
    ...(received?{dateBasis:"received" as const}:{dateBasis:"issued" as const})}];
}
export function parseManateePermits(data:any,url:string):PermitEvidence[]{
  if(!Array.isArray(data?.cols)||!Array.isArray(data?.rows))throw Error("Manatee PA permit data unavailable");
  const labels=data.cols.map((c:any)=>String(c.title).toLowerCase());
  const columns=["permit","issued","purpose","description"].map(x=>labels.indexOf(x));
  if(columns.some(x=>x<0))throw Error("Manatee PA permit columns changed");
  return data.rows.flatMap((r:unknown)=>{
    if(!Array.isArray(r))return [];
    const [n,d,p,t]=columns.map(i=>typeof r[i]==="string"?r[i]:"");
    return record("manatee",url,n,[p,t].filter(Boolean).join(" — "),d);
  });
}
export function parseLeePermits(html:string,url:string):PermitEvidence[]{
  const $=load(html),box=$("#PermitDetails");
  if(!box.length||!/Permit Number/.test(box.text()))throw Error("Lee PA permit rows unavailable");
  return box.find("tr").toArray().flatMap(tr=>{
    const c=$(tr).find("td").toArray().map(e=>$(e).text().trim());
    // Never follow embedded Accela links. They are not PA sources.
    return c.length===3?record("lee",url,c[0],c[1],c[2],true):[];
  });
}
export function parseCollierPermits(html:string,url:string):PermitEvidence[]{
  const $=load(html);
  const tables=$("table").toArray().filter(t=>!$(t).find("table").length&&/Issued Date/.test($(t).text())&&/Permit #/.test($(t).text()));
  if(tables.length!==1)throw Error("Collier PA permit table unavailable or ambiguous");
  return $(tables[0]).find("tr").toArray().flatMap(tr=>{
    const c=$(tr).find("td").toArray().map(e=>$(e).text().trim());
    return c.length===5?record("collier",url,c[2],c[4],c[0]):[];
  });
}
export function parseOtherPaPermits(county:string,html:string,url:string):PermitEvidence[]{
  const $=load(html);$("script,style").remove();
  if(county==="polk"&&$("#parcelPermits").length&&/appropriate permit issuing agency/i.test($("#parcelPermits").text()))
    throw Error("Polk PA permits section directs users to issuing agency; no PA permit rows");
  if(county==="pasco"&&/Pasco County Permitting/.test($.text()))
    throw Error("Pasco PA detail has an external permitting link, not PA permit records");
  if(county==="hernando"&&!/permit/i.test($.text()))
    throw Error("Hernando PA detail has no permit section");
  throw Error(`${names[county]} PA permit schema unverified — Unknown`);
}
export type IdentityLookup=(county:CountySlug,address:string,http:typeof fetch)=>Promise<ParcelIdentity>;
const identityLookup:IdentityLookup=(county,address,http)=>resolveParcel(county,address,{fetchImpl:http});
const parcelCache=new Map<string,{expires:number;records:PermitEvidence[]}>();
const parcelPending=new Map<string,Promise<PermitEvidence[]>>();
export function requirePaIdentity(id:ParcelIdentity,address:string){
  if(id.status!=="found"||!id.parcelId||!id.situsAddress||streetIdentity(id.situsAddress)!==streetIdentity(address))
    throw Error("PA permit identity unavailable or property mismatch");
}
export async function lookupAdditionalPaPermits(
  county:CountySlug,address:string,http:typeof fetch,
  identity:IdentityLookup=identityLookup,
  render:(address:string,parcel:string,http:typeof fetch)=>Promise<{html:string;url:string}>=renderCollierPermits,
):Promise<PermitEvidence[]>{
  if(PA_PERMIT_RESTRICTIONS[county])throw Error(PA_PERMIT_RESTRICTIONS[county]);
  const id=await identity(county,address,http);requirePaIdentity(id,address);
  const key=`${county}:${id.parcelId}`,saved=parcelCache.get(key);
  if(saved&&saved.expires>Date.now())return saved.records;
  if(parcelPending.has(key))return parcelPending.get(key)!;
  const task=loadPaRecords(county,address,id,http,render).then(records=>{
    parcelCache.set(key,{records,expires:Date.now()+30*86400000});
    if(parcelCache.size>2000)parcelCache.delete(parcelCache.keys().next().value!);
    return records;
  });
  parcelPending.set(key,task);
  try{return await task;}finally{parcelPending.delete(key);}
}
async function loadPaRecords(county:CountySlug,address:string,id:ParcelIdentity,http:typeof fetch,
  render:(address:string,parcel:string,http:typeof fetch)=>Promise<{html:string;url:string}>){
  const parcel=id.parcelId!;
  if(county==="collier"){
    const page=await render(address,parcel,http);
    if(new URL(page.url).hostname!=="www.collierappraiser.com"||new URL(page.url).searchParams.get("FolioID")!==parcel)
      throw Error("Collier PA parcel mismatch");
    return parseCollierPermits(page.html,page.url);
  }
  let url:string;
  if(county==="manatee"){
    if(!/^\d{10}$/.test(parcel))throw Error("Manatee PA parcel format unavailable");
    url=`https://www.manateepao.gov/parcel/?parid=${parcel}`;
  }else if(county==="lee"){
    if(!id.folio||!/^\d+$/.test(id.folio))throw Error("Lee PA FolioID unavailable");
    url=`https://www.leepa.org/Display/DisplayParcel.aspx?FolioID=${id.folio}&PermitDetails=True`;
  }else if(county==="polk"){
    const strap=parcel.replace(/\D/g,"");if(strap.length!==18)throw Error("Polk PA parcel format unavailable");
    url=`https://www.polkflpa.gov/CamaDisplay.aspx?OutputMode=Display&SearchType=RealEstate&ParcelID=${strap}`;
  }else if(county==="hernando"){
    if(!/^\d+$/.test(parcel))throw Error("Hernando PA parcel key unavailable");
    url=`https://propsearch.hernandocountypa-florida.us/parcel/${parcel}`;
  }else if(county==="pasco"){
    const p=parcel.split("-");if(p.length!==6)throw Error("Pasco PA parcel format unavailable");
    url="https://search.pascopa.com/parcel.aspx?"+new URLSearchParams({sec:p[0],twn:p[1],rng:p[2],sbb:p[3],blk:p[4],lot:p[5],action:"Submit"});
  }else throw Error("County PA permit source unsupported");
  const response=await http(url);
  if(!response.ok)throw Error(`${names[county]} PA blocked or unavailable (${response.status})`);
  const html=await response.text();
  if(/captcha|verify you are human|access denied|request blocked/i.test(load(html)("body").text()))
    throw Error(`${names[county]} PA blocked — not bypassed`);
  if(county==="manatee"){
    const $=load(html);
    if(!$("#permits-nav").length)throw Error("Manatee PA permits tab unavailable");
    const r=await http(`https://www.manateepao.gov/wp-content/themes/frontier-child/models/pao-model-permits.php?parid=${parcel}`);
    if(!r.ok)throw Error("Manatee PA permit JSON unavailable");
    return parseManateePermits(await r.json(),url);
  }
  if(county==="lee")return parseLeePermits(html,url);
  return parseOtherPaPermits(county,html,url);
}

// PA pages only, never data endpoints or city portals. Firecrawl renders the
// documented Collier framed search; it must stop at any bot challenge.
let nextCollier=0;
let collierActive=0;
export async function renderCollierPermits(address:string,parcel:string,http:typeof fetch,cleanupHttp:typeof fetch=fetch){
  if(!process.env.FIRECRAWL_API_KEY)throw Error("FIRECRAWL_API_KEY not set");
  if(collierActive>=2)throw Error("Collier PA permit queue busy");
  const wait=Math.max(0,nextCollier-Date.now());
  if(wait>10000)throw Error("Collier PA permit queue busy");
  nextCollier=Math.max(Date.now(),nextCollier)+10000;
  collierActive++;
  try{
  await new Promise(r=>setTimeout(r,wait));
  const api=async(path:string,method:string,body?:unknown,cleanup=false)=>{
    const r=await (cleanup?cleanupHttp:http)(`https://api.firecrawl.dev/v2${path}`,{
      method,headers:{Authorization:`Bearer ${process.env.FIRECRAWL_API_KEY}`,"Content-Type":"application/json"},
      ...(body?{body:JSON.stringify(body)}:{}),...(cleanup?{signal:AbortSignal.timeout(4000)}:{})});
    if(!r.ok)throw Error(`PA rendering unavailable (${r.status})`);
    const j=await r.json();if(j.success===false)throw Error("PA rendering failed");return j;
  };
  const start=await api("/scrape","POST",{url:"https://www.collierappraiser.com/Main_Search/search_rp.html",formats:["markdown"],waitFor:1000,onlyMainContent:true});
  const session=start.data?.metadata?.scrapeId;
  if(!session)throw Error("PA render session unavailable");
  try{
    if(/captcha|verify you are human|access denied/i.test(start.data?.markdown||""))throw Error("Collier PA blocked — not bypassed");
    const code=`
      let f=page.frame({name:'rbottom'});if(!f)throw Error('PA frame unavailable');
      if(await f.getByText('I Agree',{exact:true}).isVisible())await f.getByText('I Agree',{exact:true}).click();
      await page.waitForTimeout(1500);f=page.frame({name:'rbottom'});
      if(/captcha|verify you are human|access denied/i.test(await f.locator('body').innerText()))throw Error('PA blocked');
      await f.getByText('Site Address',{exact:true}).click();
      await f.locator('#SiteStreetAddress').fill(${JSON.stringify(address.split(",")[0])});
      await f.locator('#SearchFullAddress').click();
      await f.waitForURL('**/ParcelDetail.html?**',{timeout:15000});
      if(new URL(f.url()).searchParams.get('FolioID')!==${JSON.stringify(parcel)})throw Error('PA parcel mismatch');
      await f.getByText('Detail',{exact:true}).click();await page.waitForTimeout(1500);
      const html=await f.locator('table').evaluateAll(es=>es.filter(e=>!e.querySelector('table')&&/Issued Date/.test(e.textContent||'')&&/Permit #/.test(e.textContent||'')).map(e=>e.outerHTML).join(''));
      console.log(JSON.stringify({url:f.url(),html}));
    `;
    const result=await api(`/scrape/${encodeURIComponent(session)}/interact`,"POST",{code,language:"node",timeout:35});
    // Shared decoder handles Firecrawl's supported stdout envelope, without logs.
    const {browserOutput}=await import("./official-county-bills");
    const page=browserOutput(result);
    if(typeof page.html!=="string"||typeof page.url!=="string")throw Error("PA render output unavailable");
    return {html:page.html,url:page.url};
  }finally{
    await api(`/scrape/${encodeURIComponent(session)}/interact`,"DELETE",undefined,true);
  }
  }finally{collierActive--;}
}
