import type {CoastalEvidence} from "../../shared/wind-mitigation";
export const CCCL_URL="https://ca.dep.state.fl.us/arcgis/rest/services/OpenData/COASTAL_ENV_PERM/MapServer/2";
export const CBZ_URL="https://services1.arcgis.com/nRHtyn3uE1kyzoYc/ArcGIS/rest/services/Florida_Coastal_Building_Zone/FeatureServer/0";
/** FDEP's polygon already encodes the landward side and island-width clipping.
 * Its published methodology uses 1500ft mainland / 5000ft barrier islands.
 * It is approximate, NOT a survey or a historical parcel-level determination. */
export function classifyPublishedZone(data:any,county:string,distanceFeet:number|null):CoastalEvidence{
  const base={distanceFeet,source:"FDEP Florida Coastal Building Zone (approximate statutory boundary)",sourceUrl:CBZ_URL};
  if(data?.error||!Array.isArray(data?.features)||data.exceededTransferLimit)
    return {...base,status:"unknown",reason:"Coastal polygon data unavailable"};
  if(data.features.length===0)return {...base,status:"outside",reason:"Outside FDEP mapped coastal building zone; approximate, not a survey"};
  const valid=data.features.filter((f:any)=>String(f.attributes?.COUNTY??"").toLowerCase().replace(/ county$/,"")===county.toLowerCase()
    &&["Barrier Island","Standard"].includes(f.attributes?.DEFINITION_SOURCE_TYPE));
  if(valid.length!==data.features.length||!valid.length)return {...base,status:"unknown",reason:"Unrecognized or conflicting coastal polygon classification"};
  return {...base,status:"inside",reason:`Estimated from FDEP ${valid[0].attributes.DEFINITION_SOURCE_TYPE} polygon; landward buffer and island clipping supplied by FDEP. Not proof of the parcel's 1986 regulatory boundary.`};
}
export function classifyCoastal(distanceFeet:number|null,geography?:{landward:boolean;barrierIsland:boolean;wholeNarrowIsland?:boolean}):CoastalEvidence{
  const base={distanceFeet,source:"FDEP Coastal Construction Control Lines",sourceUrl:CCCL_URL};
  if(distanceFeet===null||!Number.isFinite(distanceFeet)||distanceFeet<0)return {...base,status:"unknown",reason:"CCCL distance unavailable"};
  if(!geography)return {...base,status:"unknown",reason:"Barrier-island and landward classification unverified; distance alone does not establish the 1986 zone"};
  if(!geography.landward)return {...base,status:"outside"};
  return {...base,status:distanceFeet<=(geography.barrierIsland?5000:1500)||geography.barrierIsland&&geography.wholeNarrowIsland?"inside":"outside"};
}
/** Local tangent-plane distance, metres -> feet; inputs are a small WGS84 envelope. */
export function nearestLineFeet(lat:number,lng:number,paths:number[][][]):number|null{
  let best=Infinity;const sx=111320*Math.cos(lat*Math.PI/180),sy=111320;
  for(const path of paths)for(let i=1;i<path.length;i++){
    const a=path[i-1],b=path[i];if(!a||!b)continue;
    const ax=(a[0]-lng)*sx,ay=(a[1]-lat)*sy,bx=(b[0]-lng)*sx,by=(b[1]-lat)*sy;
    const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
    best=Math.min(best,Math.hypot(ax+t*dx,ay+t*dy)*3.28084);
  }
  return Number.isFinite(best)?best:null;
}
const cache=new Map<string,{expires:number;value:CoastalEvidence}>();
export async function checkCoastalZone(county:string,lat:number|null,lng:number|null,http:typeof fetch=fetch):Promise<CoastalEvidence>{
  if(["hillsborough","pasco","hernando","polk"].includes(county.toLowerCase()))
    return {status:"outside",distanceFeet:null,source:"County configuration — no verified CCCL zone",sourceUrl:CCCL_URL};
  if(lat===null||lng===null)return classifyCoastal(null);
  const key=`${county}:${lat.toFixed(5)}:${lng.toFixed(5)}`,hit=cache.get(key);
  if(hit&&hit.expires>Date.now())return hit.value;
  let result=classifyCoastal(null);
  try{
    const q=new URLSearchParams({f:"json",geometry:`${lng-.025},${lat-.025},${lng+.025},${lat+.025}`,geometryType:"esriGeometryEnvelope",
      inSR:"4326",outSR:"4326",returnGeometry:"true",outFields:"OBJECTID",spatialRel:"esriSpatialRelIntersects"});
    const r=await http(`${CCCL_URL}/query?${q}`,{signal:AbortSignal.timeout(5000)});
    if(r.ok){const j=await r.json();if(!j.error&&Array.isArray(j.features)&&!j.exceededTransferLimit){
      const distance=nearestLineFeet(lat,lng,j.features.flatMap((f:any)=>f.geometry?.paths??[]));
      result=classifyCoastal(distance);
    }}
    const point=new URLSearchParams({f:"json",geometry:`${lng},${lat}`,geometryType:"esriGeometryPoint",
      inSR:"4326",returnGeometry:"false",outFields:"COUNTY,DEFINITION_SOURCE_TYPE,COASTAL_BARRIER_ISLAND_NAME",
      spatialRel:"esriSpatialRelIntersects"});
    const polygon=await http(`${CBZ_URL}/query?${point}`,{signal:AbortSignal.timeout(8000)});
    if(polygon.ok)result=classifyPublishedZone(await polygon.json(),county,result.distanceFeet);
  }catch{/* Optional evidence never stops quoting. */}
  cache.set(key,{expires:Date.now()+(result.status==="unknown"?3600000:86400000*30),value:result});
  if(cache.size>2000)cache.delete(cache.keys().next().value!);
  return result;
}
