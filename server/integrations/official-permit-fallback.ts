import {load} from "cheerio";
import {streetIdentity} from "./insurance-building-sources";
import type {ParcelIdentity} from "./parcel-resolver";
import type {PermitEvidence} from "../../shared/wind-mitigation";

export const FALLBACK_COUNTIES=new Set(["pasco","polk","hernando","sarasota"]);
/** Mailing city is not jurisdiction. Only the PA tax district authorizes routing. */
export function permitAgency(id:ParcelIdentity):string|null{
  const d=id.taxDistrict?.toUpperCase();
  if(id.county==="pasco"&&["U","UF"].includes(d||""))return "PASCO";
  if(id.county==="polk"&&["30","90","91","92","93"].includes(d||""))return "POLKCO";
  if(id.county==="sarasota"&&d==="M0500")return "NORTHPORT";
  return null;
}
export function assertPublicPermitPage(html:string,url:string){
  const $=load(html);
  if(/captcha|recaptcha|hcaptcha|verify you are human/i.test(html))
    throw Error("County permit portal CAPTCHA indicator detected — Unknown");
  if(/please log\s*in|please sign\s*in/i.test($("body").text())||/\/Login\.aspx/i.test(url))
    throw Error("County permit portal login required — Unknown");
  if(/access denied|request blocked/i.test($("body").text()))
    throw Error("County permit portal access blocked — Unknown");
}
export function hasExactPortalAddress(html:string,address:string){
  const $=load(html,{},false);
  // Require a whole address cell/line; never accept a substring (including units).
  return $("td,span,div").toArray().some(e=>{
    if($(e).children().length)return false;
    const value=$(e).text().trim();
    return value.length<180&&streetIdentity(value)===streetIdentity(address);
  });
}
/** Plain HTTP only: no browser, Firecrawl or CAPTCHA-solving service. */
export async function searchAccelaPermits(agency:string,address:string,http:typeof fetch):Promise<PermitEvidence[]>{
  if(!["PASCO","POLKCO","NORTHPORT"].includes(agency))throw Error("County portal not verified");
  const origin="https://aca-prod.accela.com";
  const url=`${origin}/${agency}/Cap/CapHome.aspx?module=Building`;
  const cookies=new Map<string,string>();
  let previous="";
  async function request(target:string,body?:URLSearchParams):Promise<string>{
    for(let n=0;n<5;n++){
      if(new URL(target).origin!==origin)throw Error("County portal redirected outside approved host");
      await new Promise(r=>setTimeout(r,1000));
      const r=await http(target,{method:body?"POST":"GET",redirect:"manual",
        headers:{"User-Agent":"Havo/1.0 (+https://havofl.com)",Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join("; "),
          ...(previous?{Referer:previous}:{}),...(body?{"Content-Type":"application/x-www-form-urlencoded"}:{})},
        ...(body?{body:body.toString()}: {})});
      for(const c of r.headers.getSetCookie?.()||[]){const [kv]=c.split(";"),i=kv.indexOf("=");cookies.set(kv.slice(0,i),kv.slice(i+1));}
      previous=target;
      if(r.status>=300&&r.status<400){target=new URL(r.headers.get("location")||"",target).href;body=undefined;continue;}
      if(!r.ok)throw Error("County permit portal unavailable");
      const html=await r.text();assertPublicPermitPage(html,target);return html;
    }
    throw Error("County permit redirect limit");
  }
  // Conservative robots handling: any disallow means do not scrape this portal.
  for(const path of ["/robots.txt",`/${agency}/robots.txt`]){
    const r=await http(origin+path,{redirect:"manual"});
    if(r.status!==404){
      if(!r.ok||/^\s*Disallow:\s*\S+/mi.test(await r.text()))throw Error("County portal robots policy unavailable or restricted");
    }
  }
  const html=await request(url),$=load(html),body=new URLSearchParams();
  $("input[name]").each((_,e)=>{const x=$(e);if(x.attr("type")==="hidden")body.set(x.attr("name")!,x.attr("value")||"");});
  const street=address.split(",")[0].trim(),m=/^(\d+[A-Z]?)\s+(.+)$/i.exec(street);
  if(!m)throw Error("County permit address unavailable");
  function field(suffix:string,value:string){
    const es=$("input[name]").toArray().filter(e=>$(e).attr("name")!.endsWith(suffix));
    if(es.length!==1)throw Error("County permit form changed");
    body.set($(es[0]).attr("name")!,value);
  }
  field("txtGSNumber$ChildControl0",m[1]);
  field("txtGSStreetName",m[2].replace(/\s+(DR|DRIVE|ST|STREET|AVE|AVENUE|RD|ROAD|CT|COURT|LN|LANE|BLVD)$/i,""));
  // Clear default date range; old permits matter too.
  for(const suffix of ["txtGSStartDate","txtGSEndDate"])field(suffix,"");
  body.set("__EVENTTARGET","ctl00$PlaceHolderMain$btnNewSearch");body.set("__EVENTARGUMENT","");
  const results=await request(url,body),r$=load(results);
  const links=r$("a[href]").toArray().filter(e=>/CapDetail\.aspx/i.test(r$(e).attr("href")||""));
  if(links.length>20)throw Error("County permit results exceed bounded lookup");
  const records:PermitEvidence[]=[];
  for(const e of links){
    // Never accept a search hit merely because the submitted search matched.
    if(!hasExactPortalAddress(r$(e).closest("tr").html()||"",address))continue;
    const detail=new URL(r$(e).attr("href")!,url).href;
    const page=await request(detail),p$=load(page);
    const text=p$("body").text().replace(/\s+/g," ").trim();
    if(!hasExactPortalAddress(page,address))throw Error("County permit identity mismatch");
    const issued=/Issued(?: Date)?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text);
    if(!issued)continue; // Application/final dates are not issue dates.
    const [month,day,year]=issued[1].split("/");
    records.push({number:r$(e).text().trim(),description:text.slice(0,12000),
      date:`${year}-${month.padStart(2,"0")}-${day.padStart(2,"0")}`,dateBasis:"issued",
      source:`${agency==="NORTHPORT"?"City of North Port":agency==="PASCO"?"Pasco County":"Polk County"} official permit portal (Accela)`,
      sourceUrl:detail});
  }
  return records;
}
export async function officialPermitFallback(id:ParcelIdentity,address:string,http:typeof fetch){
  if(!FALLBACK_COUNTIES.has(id.county)||id.status!=="found"||!id.parcelId||
    !id.situsAddress||streetIdentity(id.situsAddress)!==streetIdentity(address))
    throw Error("County permit fallback identity unavailable");
  const agency=permitAgency(id);
  if(!agency)throw Error("County jurisdiction portal not verified public — Unknown");
  return searchAccelaPermits(agency,address,http);
}
