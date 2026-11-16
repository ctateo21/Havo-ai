import {propertyCharacteristicsCache} from "./property-characteristics";
import {normalizeParcelAddress} from "./parcel-resolver";
import {lookupWindPermits,type PermitResult} from "./wind-permits";
import {checkCoastalZone} from "./wind-coastal-zone";
import type {CoastalEvidence} from "../../shared/wind-mitigation";
export type SupportingWind={permits:PermitResult;coastal:CoastalEvidence;fetchedAt:string};
const pending=new Map<string,Promise<SupportingWind|null>>();
/** Non-personal supporting evidence only. Reports and user attestations never enter this shared cache. */
export async function supportingWind(address:string):Promise<SupportingWind|null>{
  const key=normalizeParcelAddress(address);
  if(pending.has(key))return pending.get(key)!;
  const task=(async()=>{
    const profile=await propertyCharacteristicsCache.read(key,new Date());if(!profile)return null;
    const saved=profile.fieldSources?.windSupporting?.value as SupportingWind|undefined;
    if(saved&&Date.now()-Date.parse(saved.fetchedAt)<(saved.permits.status==="available"?86400000*30:300000))return saved;
    const [permits,coastal]=await Promise.all([
      lookupWindPermits(profile.county,address),
      checkCoastalZone(profile.county,profile.latitude,profile.longitude),
    ]);
    const value={permits,coastal,fetchedAt:new Date().toISOString()};
    // Re-read before writing so optional evidence cannot overwrite a newly confirmed property fact.
    const current=await propertyCharacteristicsCache.read(key,new Date());
    if(current)await propertyCharacteristicsCache.write({...current,fieldSources:{...current.fieldSources,
      windSupporting:{value,source:"County permit records / FDEP CCCL",sourceUrl:coastal.sourceUrl,fetchedAt:value.fetchedAt}}});
    return value;
  })().catch(()=>null);
  pending.set(key,task);try{return await task;}finally{pending.delete(key);}
}
