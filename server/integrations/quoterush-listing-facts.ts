import {supabaseAdmin} from "../supabase";
import {buildNormalizedPropertyKey} from "./apify-zillow";
/** Read-only reuse; never starts Zillow/Apify or any paid property request. */
export async function cachedQuoteRushListing(address:string):Promise<Record<string,unknown>> {
  if(!supabaseAdmin)return {};
  const {data,error}=await supabaseAdmin.from("property_cache").select("normalized,raw,fetched_at")
    .eq("cache_key",buildNormalizedPropertyKey(address)).maybeSingle();
  if(error||!data?.fetched_at||Date.now()-Date.parse(data.fetched_at)>7*86400000)return {};
  const value=data.normalized;
  if(!value||typeof value!=="object")return {};
  const raw=data.raw as Record<string,any>|null;
  return {propertyType:value.propertyType,stories:value.stories??raw?.resoFacts?.stories,
    hasPool:value.hasPool??raw?.resoFacts?.hasPool,
    fullBathCount:value.fullBathrooms??value.bathroomsFull??raw?.resoFacts?.bathroomsFull};
}
