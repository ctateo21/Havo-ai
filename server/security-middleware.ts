import type {Express} from "express";
import helmet from "helmet";
import {rateLimit} from "express-rate-limit";
import {supabaseAdmin} from "./supabase";
export function installSecurity(app:Express) {
  app.disable("x-powered-by");
  app.set("trust proxy",1);
  app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false,
    xFrameOptions:process.env.NODE_ENV==="production"?{action:"sameorigin"}:false}));
  // Same-origin API only; public GET resources remain usable without credentials.
  app.use("/api",(req,res,next)=>{
    res.setHeader("Cache-Control","no-store");
    const origin=req.headers.origin;
    const allowed=new Set(["https://havofl.com","https://www.havofl.com","https://havofl.replit.app"]);
    if(process.env.NODE_ENV!=="production") {
      allowed.add("http://localhost:5000");allowed.add("http://127.0.0.1:5000");
      if(process.env.REPLIT_DEV_DOMAIN)allowed.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }
    if(origin && !allowed.has(origin))return res.status(403).json({error:"Origin not allowed"});
    if(origin){res.setHeader("Access-Control-Allow-Origin",origin);res.vary("Origin");}
    if(req.method==="OPTIONS"){res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");res.setHeader("Access-Control-Allow-Methods","GET, POST, PATCH, DELETE, OPTIONS");return res.sendStatus(204);}
    next();
  });
  const limit=rateLimit({windowMs:60_000,limit:30,standardHeaders:"draft-7",legacyHeaders:false});
  const userLimit=rateLimit({windowMs:60_000,limit:20,keyGenerator:(_req,res)=>res.locals.rateUserId,standardHeaders:"draft-7",legacyHeaders:false});
  app.use(["/api/leads","/api/quoterush","/api/insurance","/api/profile/complete-registration","/api/zillow-property-lookup","/api/analyze-statement","/api/analyze-closing-disclosure","/api/listing-market-analysis"],limit,async(req,res,next)=>{
    const token=/^Bearer (.+)$/i.exec(req.get("authorization")??"")?.[1];
    if(!token)return next();
    if(!supabaseAdmin)return res.status(503).json({error:"Authentication unavailable"});
    try{
      const {data,error}=await supabaseAdmin.auth.getUser(token);
      if(error||!data.user)return res.status(401).json({error:"Invalid session"});
      res.locals.rateUserId=data.user.id;return userLimit(req,res,next);
    }catch{return res.status(503).json({error:"Authentication unavailable"});}
  });
}
