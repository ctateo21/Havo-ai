import {createHmac, randomUUID, timingSafeEqual} from "node:crypto";
import type {Express, Request, Response} from "express";
import {z} from "zod";
import {supabaseAdmin} from "./supabase";
import {rateLimit} from "express-rate-limit";

const COOKIE = "havo_first_quote";
const YEAR = 365 * 86400;
const types = ["purchase", "cash", "refinance", "insurance", "seller", "rent"] as const;
const inputSchema = z.object({
  quoteType: z.enum(types),
  address: z.string().trim().min(5).max(500),
});
type Claim = {id:string; quoteType:string; address:string; expires:number};
export function normalizeGuestAddress(address:string) {
  const aliases:Record<string,string>={street:"st",avenue:"ave",road:"rd",boulevard:"blvd",drive:"dr",court:"ct",lane:"ln",place:"pl",terrace:"ter",circle:"cir",parkway:"pkwy",highway:"hwy",north:"n",south:"s",east:"e",west:"w",florida:"fl",saint:"st",apartment:"unit",apt:"unit",suite:"unit"};
  return address.toLowerCase().replace(/,?\s*(usa|united states)\s*$/,"").replace(/[.,]/g,"").replace(/#\s*/g,"unit ").replace(/\b\d{5}-\d{4}\b/g,x=>x.slice(0,5)).replace(/\b[a-z]+\b/g,x=>aliases[x]??x).replace(/\s+/g," ").trim();
}
function digest(value:string,secret:string) {
  return createHmac("sha256",secret).update(value).digest("base64url");
}
export function signGuestClaim(claim:Claim,secret:string) {
  const data=Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${data}.${digest(data,secret)}`;
}
export function verifyGuestClaim(value:string|undefined,secret:string,now=Date.now()):Claim|null {
  try {
    if(!value||value.length>2000)return null;
    const [data,signature,...extra]=value.split(".");
    if(extra.length||!signature)return null;
    const expected=digest(data,secret);
    if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;
    const claim=JSON.parse(Buffer.from(data,"base64url").toString());
    if(typeof claim.id!=="string"||!types.includes(claim.quoteType)||typeof claim.address!=="string"||!Number.isFinite(claim.expires)||claim.expires<=now)return null;
    return claim;
  }catch{return null;}
}
function claimFor(req:Request) {
  const secret=process.env.SESSION_SECRET;
  if(!secret)return null;
  const cookie=(req.headers.cookie??"").split(";").map(x=>x.trim()).find(x=>x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
  return verifyGuestClaim(cookie,secret);
}
export function hasAnonymousQuoteFor(req:Request,address:unknown) {
  const claim=claimFor(req);
  return !!claim&&typeof address==="string"&&normalizeGuestAddress(claim.address)===normalizeGuestAddress(address);
}
export async function authenticatedQuoteUser(req:Request):Promise<boolean> {
  const token=/^Bearer\s+(.+)$/i.exec(req.headers.authorization??"")?.[1];
  if(!token||!supabaseAdmin)return false;
  try { const {data,error}=await supabaseAdmin.auth.getUser(token); return !error&&!!data.user; }
  catch{return false;}
}
const signup=(res:Response)=>res.status(401).json({
  code:"SIGN_UP_REQUIRED",
  error:"Create your free account to save, download, share, and run more quotes. Your first quote stays here.",
});

// Signed cookies survive server restarts. The bounded, keyed IP/UA bucket is a
// secondary abuse control, not a durable identity or a promise of fingerprinting.
// No raw IP/UA or anonymous contact data is persisted or sent to a CRM.
export function registerAnonymousQuoteRoutes(app:Express,authenticate=authenticatedQuoteUser) {
  const devices=new Map<string,{claim:Claim;count:number;reset:number}>();
  app.post("/api/anonymous-quote/start",async(req,res)=>{
    const parsed=inputSchema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Choose a quote type and property address."});
    if(await authenticate(req))return res.json({allowed:true,...parsed.data});
    const secret=process.env.SESSION_SECRET;
    if(!secret)return res.status(503).json({error:"First-quote access is temporarily unavailable."});
    const now=Date.now(),address=normalizeGuestAddress(parsed.data.address);
    const existing=claimFor(req);
    if(existing){
      if(normalizeGuestAddress(existing.address)!==address||existing.quoteType!==parsed.data.quoteType)return signup(res);
      return res.json({allowed:true,...parsed.data});
    }
    for(const [key,value] of devices)if(value.reset<now)devices.delete(key);
    const device=digest(`${req.ip??req.socket.remoteAddress}|${req.get("user-agent")??""}`,secret);
    const prior=devices.get(device);
    if(prior&&(prior.claim.address!==address||prior.claim.quoteType!==parsed.data.quoteType))return signup(res);
    if(prior&&++prior.count>30)return res.status(429).json({error:"Please wait before retrying your first quote."});
    if(!prior&&devices.size>=10000)return res.status(503).json({error:"First-quote access is busy. Please try again later."});
    const claim=prior?.claim??{id:randomUUID(),quoteType:parsed.data.quoteType,address,expires:now+YEAR*1000};
    devices.set(device,{claim,count:prior?.count??1,reset:prior?.reset??now+86400_000});
    res.cookie(COOKIE,signGuestClaim(claim,secret),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:YEAR*1000,path:"/"});
    return res.json({allowed:true,...parsed.data});
  });
  // Lookups remain address-bound. A client-side localStorage flag is never auth.
  app.use([
    "/api/property-tax/quick","/api/property-tax/county",
    "/api/refinance/property-tax/current","/api/flood-zone",
    "/api/property-tax/hillsborough","/api/zillow-property-lookup",
    "/api/ami","/api/properties/lookup-by-address","/api/properties/zestimate",
    "/api/properties/search",
  ],rateLimit({windowMs:60_000,limit:40,standardHeaders:"draft-7",legacyHeaders:false}),async(req,res,next)=>{
    if(await authenticate(req))return next();
    const path=req.originalUrl.split("?")[0];
    const address=path.startsWith("/api/zillow-property-lookup")?req.body?.addressOrUrl
      :path==="/api/properties/search"?req.body?.location
      :req.method==="GET"?req.query.address:req.body?.address;
    if(hasAnonymousQuoteFor(req,address))return next();
    return signup(res);
  });
  app.get("/api/properties/:id",async(req,res,next)=>{
    if(await authenticate(req))return next();
    return signup(res);
  });
  app.use(["/api/leads/notify-new-scenario","/api/fub/showing-request","/api/properties/zipcode-average"],async(req,res,next)=>{
    if(await authenticate(req))return next();
    return signup(res);
  });
}
