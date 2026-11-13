export interface FieldEvidence { value:unknown; source:string; sourceUrl:string; fetchedAt:string }
export interface RoofPermit { description:string; issuedAt:string; year:number; source:string }
export interface BuildingEvidence {
  values:Record<string,any>; fieldSources:Record<string,FieldEvidence>; source:string;
  parcelId?:string; roofPermits?:RoofPermit[];
}
export const DOR_LAYER="https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query";
const HCPA="https://gis.hcpafl.org/CommonServices/property/search/";
const positive=(v:unknown)=>Number.isFinite(Number(v))&&Number(v)>0?Number(v):null;
export function streetIdentity(value:string, omitSuffix=false):string {
  const aliases:Record<string,string>={NORTH:"N",SOUTH:"S",WEST:"W",EAST:"E",NORTHEAST:"NE",NORTHWEST:"NW",SOUTHEAST:"SE",SOUTHWEST:"SW",STREET:"ST",AVENUE:"AVE",BOULEVARD:"BLVD",ROAD:"RD",DRIVE:"DR",COURT:"CT",LANE:"LN",PLACE:"PL",TERRACE:"TER",CIRCLE:"CIR",PARKWAY:"PKWY"};
  const parts=value.split(",")[0].toUpperCase().replace(/[.]/g,"").trim().split(/\s+/).map(x=>aliases[x]??x);
  return parts.filter(x=>!omitSuffix||!["ST","AVE","BLVD","RD","DR","CT","LN","PL","TER","CIR","PKWY"].includes(x)).join(" ");
}
function evidence(values:Record<string,unknown>, source:string, sourceUrl:string, now:Date){
  return Object.fromEntries(Object.entries(values).filter(([,v])=>v!=null).map(([k,value])=>[k,{value,source,sourceUrl,fetchedAt:now.toISOString()}]));
}
export function parseDorRows(rows:any[],address:string,zip:string,parcelId?:string,now=new Date()):BuildingEvidence|null{
  const parcelKey=(v:string)=>v.replace(/[^A-Z0-9]/gi,"").toUpperCase();
  let matches=rows.filter(r=>String(r.PHY_ZIPCD).slice(0,5)===zip&&streetIdentity(String(r.PHY_ADDR1),true)===streetIdentity(address,true));
  if(parcelId){const exact=matches.filter(r=>parcelKey(String(r.PARCEL_ID))===parcelKey(parcelId));if(exact.length)matches=exact;}
  if(matches.length!==1)return null;
  const r=matches[0],year=positive(r.ASMNT_YR);
  if(!year)return null;
  const source=`Florida Dept. of Revenue ${year} tax roll`;
  const values={yearBuilt:positive(r.ACT_YR_BLT),yearBuiltEffective:positive(r.EFF_YR_BLT),squareFeetLiving:positive(r.TOT_LVG_AR),buildingCount:positive(r.NO_BULDNG),livingUnits:positive(r.NO_RES_UNT)};
  const fields=evidence(values,source,DOR_LAYER,now);
  if(fields.squareFeetLiving)fields.squareFeetLiving.source+=" (total living/adjusted area — may differ from heated area; please confirm)";
  return {values,source,fieldSources:fields,parcelId:String(r.PARCEL_ID)};
}
export async function lookupDorBuilding(address:string,zip:string,lat:number,lng:number,parcelId?:string,http:typeof fetch=fetch):Promise<BuildingEvidence|null>{
  if(!/^\d{5}$/.test(zip))return null;
  for(const d of [.0015,.004]){
    const params=new URLSearchParams({geometry:`${lng-d},${lat-d},${lng+d},${lat+d}`,geometryType:"esriGeometryEnvelope",inSR:"4326",spatialRel:"esriSpatialRelIntersects",returnGeometry:"false",f:"json",outFields:"CO_NO,PARCEL_ID,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,ACT_YR_BLT,EFF_YR_BLT,TOT_LVG_AR,NO_BULDNG,NO_RES_UNT,DOR_UC,ASMNT_YR"});
    const r=await http(`${DOR_LAYER}?${params}`,{signal:AbortSignal.timeout(15000)});
    if(!r.ok)continue;const j=await r.json();if(j.error)continue;
    const rows=(j.features??[]).map((f:any)=>f.attributes);
    const result=parseDorRows(rows,address,zip,parcelId);
    if(result)return result;
    if(rows.filter((r:any)=>String(r.PHY_ZIPCD).slice(0,5)===zip&&streetIdentity(String(r.PHY_ADDR1),true)===streetIdentity(address,true)).length>1)return null;
  }
  return null;
}
export function parseHcpaBuilding(data:any,now=new Date()):BuildingEvidence|null{
  const cards=(data.buildings??[]).filter((b:any)=>!b.noData&&positive(b.heatedArea)&&/SINGLE|RESIDENT|MULTI|CONDO|TOWN|DUPLEX|APARTMENT/i.test(b.type?.description??""));
  if(!cards.length)return null;
  const card=cards[0], construction=(name:string)=>card.constructionInfo?.find((x:any)=>x.element?.description===name)?.constructionDetail?.description??null;
  const values={yearBuilt:positive(card.yearBuilt),squareFeetLiving:cards.reduce((n:number,b:any)=>n+Number(b.heatedArea),0),stories:positive(card.stories),constructionLabel:construction("Class"),exteriorWallLabel:construction("Exterior Wall"),roofStructure:construction("Roof Structure")};
  const source="Hillsborough County Property Appraiser";
  const roofPermits=(data.permitInfo??[]).filter((p:any)=>/ROOF|REROOF/i.test(p.descr??"")).flatMap((p:any)=>{
    const date=new Date(p.issueDate);if(!Number.isFinite(date.getTime()))return [];
    return [{description:p.descr,issuedAt:date.toISOString().slice(0,10),year:date.getUTCFullYear(),source}];
  });
  return {values,source,fieldSources:evidence(values,source,"https://www.hcpafl.org/",now),roofPermits};
}
export async function lookupHcpaBuilding(address:string,http:typeof fetch=fetch):Promise<BuildingEvidence|null>{
  const parts=address.split(",").map(s=>s.trim()),city=parts[1]?.toUpperCase();
  if(!city)return null;
  const response=await http(`${HCPA}BasicSearch?${new URLSearchParams({address:parts[0],pagesize:"5",page:"1"})}`,{signal:AbortSignal.timeout(8000)});
  if(!response.ok)return null;const rows=await response.json();
  if(!Array.isArray(rows))return null;
  const exact=rows.filter(r=>streetIdentity(r.address)===streetIdentity(parts[0])&&r.address.split(",")[1]?.trim().toUpperCase()===city);
  if(exact.length!==1||!exact[0].pin)return null;
  const r=await http(`${HCPA}ParcelData?pin=${encodeURIComponent(exact[0].pin)}`,{signal:AbortSignal.timeout(8000)});
  return r.ok?parseHcpaBuilding(await r.json()):null;
}
