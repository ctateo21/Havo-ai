import { load } from "cheerio";
import { COUNTY_TAX_USER_AGENT } from "./county-tax-http";
const normalize = (s:string) => s.toUpperCase().replace(/\s+/g," ").trim();
const text = (s:unknown) => load(String(s??"")).text().trim();
export function selectPinellasQuicksearch(rows:unknown, street:string) {
  if(!Array.isArray(rows)) return null;
  const exact=rows.filter(r=>Array.isArray(r)&&normalize(text(r[5]))===normalize(street));
  if(exact.length!==1) return null;
  const row=exact[0], $=load(String(row[0]));
  const strap=$('input[name^="select_strap_"],input[id^="select_strap_"]').attr("value");
  const parcel=text(row[4]);
  if(!strap || !/^\d{18}$/.test(strap) || !/^\d{2}-\d{2}-\d{2}-\d{5}-\d{3}-\d{4}$/.test(parcel)) return null;
  const p=parcel.split("-");
  if([p[2],p[1],p[0],...p.slice(3)].join("")!==strap) return null;
  return {account:parcel,strap,situsAddress:text(row[5]),situsCity:"",justValue:null};
}
export async function lookupPinellasParcel(address:string,fetchImpl:typeof fetch=fetch) {
  const street=address.split(",")[0].trim(),zip=[...address.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].at(-1)?.[1];
  if(!street) return null;
  const quick=(async()=>{
    const r=await fetchImpl("https://www.pcpao.gov/dal/quicksearch/searchProperty",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":COUNTY_TAX_USER_AGENT,"X-Requested-With":"XMLHttpRequest",Referer:"https://www.pcpao.gov/"},
      body:new URLSearchParams({searchsort:"address",input:street,draw:"1",start:"0",length:"10"}),
      signal:AbortSignal.timeout(4000),
    });
    if(!r.ok)console.warn(`[parcel] Pinellas quicksearch HTTP ${r.status}`);
    if(r.ok) {
      const data=await r.json();
      // A truncated prefix result cannot establish uniqueness.
      if(Number(data.recordsFiltered??data.recordsTotal??data.data?.length)<=10) {
        const match=selectPinellasQuicksearch(data.data,street);
        // Quicksearch has no ZIP column. A ZIP-bearing request needs a
        // geographically verified GIS answer, not a street-only guess.
        if(match&&!zip) return {...match,taxDistrict:null as string|null};
      }
    }
    throw Error("No unique ZIP-verified quicksearch match");
  })();
  const gis=async(swfwmd:boolean)=>{
    const q=new URLSearchParams({where:swfwmd?`SITEADD LIKE '${normalize(street).replace(/'/g,"''")}%'`:`SITE_ADDRESS='${normalize(street).replace(/'/g,"''")}'${zip?` AND SITE_ZIP='${zip}'`:""}`,outFields:swfwmd?"PARNO,SITEADD,SZIP,TAX_AUTH_CD":"STRAP,PARCELID_DSP1,SITE_ADDRESS,SITE_CITY,SITE_ZIP,MILLAGE",returnGeometry:"false",f:"json"});
    const base=swfwmd?"https://www25.swfwmd.state.fl.us/arcgis12/rest/services/BaseVector/parcel_search/MapServer/13/query":"https://egis.pinellas.gov/gis/rest/services/PublicWebGIS/Parcels/MapServer/1/query";
    const r=await fetchImpl(base+"?"+q,{headers:{"User-Agent":COUNTY_TAX_USER_AGENT},signal:AbortSignal.timeout(4000)});
    if(!r.ok)throw Error(`HTTP ${r.status}`);
    const data=await r.json();
    const rows=(data.features??[]).map((f:any)=>f.attributes).filter((a:any)=>normalize(a.SITE_ADDRESS??a.SITEADD??"")===normalize(street)&&(!zip||String(a.SITE_ZIP??a.SZIP).slice(0,5)===zip));
    if(data.exceededTransferLimit || rows.length!==1)throw Error("No unique exact match");
    const a=rows[0],strap=String(a.STRAP??a.PARNO).replace(/[^0-9]/g,"");
    const parcel=a.PARCELID_DSP1??`${strap.slice(4,6)}-${strap.slice(2,4)}-${strap.slice(0,2)}-${strap.slice(6,11)}-${strap.slice(11,14)}-${strap.slice(14)}`;
    const match=selectPinellasQuicksearch([[`<input name="select_strap_1" value="${strap}">`,"","","",parcel,a.SITE_ADDRESS??a.SITEADD]],street);
    if(!match)throw Error("Inconsistent parcel identifiers");
    return {...match,situsCity:String(a.SITE_CITY??""),taxDistrict:String(a.MILLAGE??a.TAX_AUTH_CD??"")||null};
  };
  const tasks=[quick,gis(false),gis(true)].map((p,i)=>p.catch(e=>{console.warn("[parcel] Pinellas",["quicksearch","EGIS","SWFWMD"][i],e instanceof Error?e.name+": "+e.message:"lookup failed");throw e;}));
  try{return await Promise.any(tasks);}catch{return null;}
}
