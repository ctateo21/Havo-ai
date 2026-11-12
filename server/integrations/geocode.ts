export interface GeocodedAddress {
  lat: number; lng: number; countyName: string; countyFips: string;
  matchedAddress: string; zip: string; source: string;
}
const countyFips: Record<string,string> = {
  hillsborough:"12057",pinellas:"12103",pasco:"12101",polk:"12105",
  sarasota:"12115",lee:"12071",collier:"12021",hernando:"12053",manatee:"12081",
};
const cache = new Map<string,{value:GeocodedAddress;expires:number}>();
export async function geocodeAddress(address:string, options:{
  fetchImpl?:typeof fetch; serverKey?:string; skipCache?:boolean;
}={}):Promise<GeocodedAddress|null> {
  const key=address.trim().toUpperCase().replace(/\s+/g," ");
  if(!key)return null;
  const cached=cache.get(key);
  if(!options.skipCache && !options.fetchImpl && cached && cached.expires>Date.now())return cached.value;
  const http=options.fetchImpl??fetch;
  const save=(value:GeocodedAddress)=>{
    if(!Number.isFinite(value.lat)||!Number.isFinite(value.lng)||!value.countyName)return null;
    if(!options.fetchImpl){if(cache.size>5000)cache.clear();cache.set(key,{value,expires:Date.now()+86400000});}
    return value;
  };
  try{
    const params=new URLSearchParams({address,benchmark:"Public_AR_Current",vintage:"Current_Current",layers:"Counties",format:"json"});
    const r=await http(`https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?${params}`,{signal:AbortSignal.timeout(8000)});
    if(r.ok){
      const data=await r.json();const m=data.result?.addressMatches?.[0], c=m?.geographies?.Counties?.[0];
      if(m?.coordinates&&c)return save({lat:Number(m.coordinates.y),lng:Number(m.coordinates.x),countyName:String(c.NAME??"").replace(/ County$/i,""),countyFips:String(c.GEOID??`${c.STATE}${c.COUNTY}`),matchedAddress:m.matchedAddress,zip:String(m.addressComponents?.zip??address.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]??"").slice(0,5),source:"US Census Geocoder"});
    }
  }catch{/* No secrets or provider response bodies in logs. */}
  const serverKey=options.serverKey??process.env.GOOGLE_MAPS_SERVER_API_KEY;
  if(!serverKey)return null;
  try{
    const params=new URLSearchParams({address,key:serverKey});
    const r=await http(`https://maps.googleapis.com/maps/api/geocode/json?${params}`,{signal:AbortSignal.timeout(8000)});
    if(!r.ok)return null;
    const data=await r.json();const m=data.results?.[0];if(!m)return null;
    const component=(type:string)=>m.address_components?.find((c:any)=>c.types?.includes(type))?.long_name??"";
    const countyName=component("administrative_area_level_2").replace(/ County$/i,"");
    return save({lat:Number(m.geometry?.location?.lat),lng:Number(m.geometry?.location?.lng),countyName,countyFips:countyFips[countyName.toLowerCase()]??"",matchedAddress:m.formatted_address,zip:component("postal_code"),source:"Google Geocoding"});
  }catch{return null;}
}
