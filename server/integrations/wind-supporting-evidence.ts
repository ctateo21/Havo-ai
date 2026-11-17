import {propertyCharacteristicsCache} from "./property-characteristics";
import {normalizeParcelAddress} from "./parcel-resolver";
import {lookupWindPermits,type PermitResult} from "./wind-permits";
import {checkCoastalZone} from "./wind-coastal-zone";
import type {CoastalEvidence} from "../../shared/wind-mitigation";
import {classifyPermits} from "./permit-classification";
import {boundedOptional} from "./quote-job-safety";
import {withAiUser} from "../ai-usage";
export type SupportingWind={version:3;aiAttempted:boolean;permits:PermitResult;coastal:CoastalEvidence;fetchedAt:string};
const pending=new Map<string,Promise<SupportingWind|null>>();
/** Non-personal supporting evidence only. Reports and user attestations never enter this shared cache. */
export async function supportingWind(address:string,userId?:string):Promise<SupportingWind|null>{
  const key=normalizeParcelAddress(address);
  const pendingKey=`${key}:${userId?"ai":"public"}`;
  if(pending.has(pendingKey))return pending.get(pendingKey)!;
  const task=(async()=>{
    const profile=await propertyCharacteristicsCache.read(key,new Date());if(!profile)return null;
    const saved=profile.fieldSources?.windSupporting?.value as SupportingWind|undefined;
    if(saved?.version===3&&(!userId||saved.aiAttempted)&&Date.now()-Date.parse(saved.fetchedAt)<(saved.permits.status==="available"?86400000*30:300000))return saved;
    const value=await boundedOptional(async signal=>{
      const [appraiser,coastal]=await Promise.all([
        lookupWindPermits(profile.county,address,fetch,signal),
        checkCoastalZone(profile.county,profile.latitude,profile.longitude),
      ]);
      const all=appraiser.permits;
      const unique=all.filter((p,i)=>all.findIndex(q=>q.number===p.number&&q.date===p.date)===i);
      const classified=userId?await withAiUser(userId,()=>classifyPermits(unique,signal)):unique;
      if(signal.aborted)return null;
      return {version:3 as const,aiAttempted:!!userId,permits:{...appraiser,
        status:classified.length?"available" as const:appraiser.status,permits:classified},
        coastal,fetchedAt:new Date().toISOString()};
    },null,75000);
    if(!value)return null; // deadline never persists incomplete/guessed evidence
    // Re-read before writing so optional evidence cannot overwrite a newly confirmed property fact.
    const current=await propertyCharacteristicsCache.read(key,new Date());
    const currentEvidence=current?.fieldSources?.windSupporting?.value as SupportingWind|undefined;
    if(current&&!(currentEvidence?.aiAttempted&&!value.aiAttempted))await propertyCharacteristicsCache.write({...current,fieldSources:{...current.fieldSources,
      windSupporting:{value,source:"County permit records / FDEP CCCL",sourceUrl:value.coastal.sourceUrl,fetchedAt:value.fetchedAt}}});
    return value;
  })().catch(()=>null);
  pending.set(pendingKey,task);try{return await task;}finally{pending.delete(pendingKey);}
}
