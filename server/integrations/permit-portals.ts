/**
 * Retired compatibility boundary. City/permit portals and browser interaction
 * are forbidden sources. These functions deliberately perform no network I/O.
 * Kept temporarily so callers outside this branch also fail closed.
 */
export const PERMIT_PORTALS:Record<string,string[]>={};
export const allowedPortalUrl=(_url:string,_portal:string)=>false;
export const parsePortalPermits=(_text:string,_markdown:string,_url:string,_address:string)=>[];
export async function lookupPortalPermits(_county:string,_address:string,_signal:AbortSignal,_http:typeof fetch=fetch){
  return {permits:[],checks:[{status:"disabled",count:0}]};
}
export async function browserPermitSearch(_portal:string,_address:string,_signal:AbortSignal,_http:typeof fetch=fetch){
  return {blocked:true,disabled:true};
}
