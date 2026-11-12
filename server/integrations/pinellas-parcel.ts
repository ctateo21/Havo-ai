import { load } from "cheerio";
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
export async function lookupPinellasParcel(address:string) {
  const street=address.split(",")[0].trim(),zip=address.match(/\b\d{5}(?:-\d{4})?\s*$/)?.[0].slice(0,5);
  if(!street) return null;
  try {
    const r=await fetch("https://www.pcpao.gov/dal/quicksearch/searchProperty",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({searchsort:"address",input:street,draw:"1",start:"0",length:"10"}),
      signal:AbortSignal.timeout(10000),
    });
    if(r.ok) {
      const data=await r.json();
      // A truncated prefix result cannot establish uniqueness.
      if(Number(data.recordsFiltered??data.recordsTotal??data.data?.length)<=10) {
        const match=selectPinellasQuicksearch(data.data,street);
        if(match) return match;
      }
    }
  } catch { /* Try the official GIS source, never a guessed identity. */ }
  if(!zip) return null;
  try {
    const q=new URLSearchParams({where:`SITE_ADDRESS='${normalize(street).replace(/'/g,"''")}' AND SITE_ZIP='${zip}'`,outFields:"STRAP,PARCELID_DSP1,SITE_ADDRESS,SITE_CITY,SITE_ZIP",returnGeometry:"false",f:"json"});
    const r=await fetch("https://egis.pinellas.gov/gis/rest/services/PublicWebGIS/Parcels/MapServer/1/query?"+q,{signal:AbortSignal.timeout(10000)});
    if(!r.ok) return null;
    const data=await r.json();
    const rows=(data.features??[]).map((f:any)=>f.attributes).filter((a:any)=>normalize(a.SITE_ADDRESS??"")===normalize(street)&&String(a.SITE_ZIP)===zip);
    if(data.exceededTransferLimit || rows.length!==1) return null;
    const a=rows[0],match=selectPinellasQuicksearch([[`<input name="select_strap_1" value="${String(a.STRAP).replace(/[^0-9]/g,"")}">`,"","","",a.PARCELID_DSP1,a.SITE_ADDRESS]],street);
    return match?{...match,situsCity:String(a.SITE_CITY??"")}:null;
  } catch { return null; }
}
