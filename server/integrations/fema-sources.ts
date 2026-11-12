export const FEMA_SOURCES=[
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHLWMS/MapServer/28",
  "https://hazards.fema.gov/arcgis/rest/services/FIRMette/NFHLREST_FIRMette/MapServer/20",
];
export type FloodResult={
  floodZone:string;floodZoneSubtype:string|null;sfha:boolean|null;staticBfe:number|null;
  dfirmId:string|null;source:string;sourceLabel:string;queriedAt:string;
};
export async function queryFloodSources(lat:number,lng:number,options:{
  fetchImpl?:typeof fetch;wait?:(ms:number)=>Promise<void>;countyLayer?:string;
}={}):Promise<FloodResult>{
  if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180)throw Error("Invalid coordinates for FEMA NFHL lookup");
  const request=options.fetchImpl??fetch;
  const wait=options.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const sources=[...FEMA_SOURCES,...(options.countyLayer?[options.countyLayer]:[])];
  for(const source of sources)for(let attempt=0;attempt<3;attempt++){
    if(attempt)await wait([1000,3000][attempt-1]);
    try{
      const query=new URLSearchParams({geometry:`${lng},${lat}`,geometryType:"esriGeometryPoint",inSR:"4326",spatialRel:"esriSpatialRelIntersects",
        outFields:"FLD_ZONE,ZONE_SUBTY,STATIC_BFE,SFHA_TF,DFIRM_ID",returnGeometry:"false",f:"json"});
      const response=await request(`${source}/query?${query}`,{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw Error("FEMA source unavailable");
      const body=await response.json();
      if(body.error)throw Error("FEMA source error");
      const rows=(body.features??[]).map((f:any)=>f.attributes).filter((a:any)=>a&&typeof a.FLD_ZONE==="string"&&a.FLD_ZONE.trim());
      const zones=new Set(rows.map((a:any)=>a.FLD_ZONE.trim().toUpperCase()));
      if(zones.size!==1)throw Error("Missing or ambiguous flood polygon");
      const a=rows[0],zone=a.FLD_ZONE.trim().toUpperCase();
      if(!/^[A-Z0-9][A-Z0-9 .-]{0,31}$/.test(zone))throw Error("Invalid zone");
      const bfe=a.STATIC_BFE==null?null:Number(a.STATIC_BFE);
      return {floodZone:zone,floodZoneSubtype:typeof a.ZONE_SUBTY==="string"?a.ZONE_SUBTY.trim().toUpperCase():null,
        sfha:a.SFHA_TF==="T"?true:a.SFHA_TF==="F"?false:null,staticBfe:bfe!==null&&Number.isFinite(bfe)&&bfe> -9000?bfe:null,
        dfirmId:typeof a.DFIRM_ID==="string"?a.DFIRM_ID:null,source,sourceLabel:source===options.countyLayer?"Pinellas County (FEMA effective data)":"FEMA National Flood Hazard Layer",
        queriedAt:new Date().toISOString()};
    }catch{/* Exhaust this source, then try the next verified service. */}
  }
  throw Error("All verified FEMA sources unavailable");
}
