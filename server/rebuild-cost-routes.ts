import type {Express} from "express";
import {z} from "zod";
import {supabaseAdmin} from "./supabase";
import {requireInterestAdmin} from "./b2b-interest-routes";
import {geocodeAddress} from "./integrations/geocode";
import {authenticatedQuoteUser,hasAnonymousQuoteFor} from "./anonymous-quote";
export const rebuildRateUpdate=z.object({
  frame_cost_per_sqft:z.number().finite().positive().nullable(),
  masonry_cost_per_sqft:z.number().finite().positive().nullable(),
  source_note:z.string().trim().max(1000).optional(),
}).strict();
export function registerRebuildCostRoutes(app:Express){
  app.get("/api/admin/rebuild-cost-rates",async(req,res)=>{
    try{
      if(!await requireInterestAdmin(req,res))return;
      const {data,error}=await supabaseAdmin!.from("rebuild_cost_rates").select("*").order("supported",{ascending:false}).order("county_name");
      if(error)throw error;res.json({rates:data});
    }catch{res.status(503).json({error:"Rebuild rates unavailable. Approved database migration may be required."});}
  });
  app.patch("/api/admin/rebuild-cost-rates/:county",async(req,res)=>{
    try{
      if(!await requireInterestAdmin(req,res))return;
      const parsed=rebuildRateUpdate.safeParse(req.body);
      if(!parsed.success)return res.status(400).json({error:"Rates must be positive numbers or blank."});
      const token=/^Bearer\s+(.+)$/i.exec(req.headers.authorization??"")![1];
      const {data:auth,error:authError}=await supabaseAdmin!.auth.getUser(token);
      if(authError||!auth.user)return res.sendStatus(403);
      const {data,error}=await supabaseAdmin!.from("rebuild_cost_rates").update({...parsed.data,updated_by:auth.user.id}).eq("county_slug",req.params.county).select("*").single();
      if(error)throw error;res.json({rate:data});
    }catch{res.status(503).json({error:"Rate could not be saved. No successful update was confirmed."});}
  });
  app.get("/api/insurance/rebuild-rate",async(req,res)=>{
    try{
      const address=z.string().min(5).max(500).parse(req.query.address);
      if(!supabaseAdmin)return res.sendStatus(503);
      if(!await authenticatedQuoteUser(req)&&!hasAnonymousQuoteFor(req,address))return res.status(401).json({code:"SIGN_UP_REQUIRED",error:"Start your free quote or sign in"});
      const geo=await geocodeAddress(address);if(!geo)return res.status(422).json({error:"Unavailable — county could not be verified"});
      const {data:rate,error}=await supabaseAdmin.from("rebuild_cost_rates").select("county_slug,county_name,county_fips,frame_cost_per_sqft,masonry_cost_per_sqft,source_note,updated_at").eq("county_fips",geo.countyFips).maybeSingle();
      if(error||!rate)throw Error("Rates unavailable");
      res.json({...rate,county:rate.county_slug,countyName:rate.county_name});
    }catch{res.status(503).json({error:"Unavailable — please enter your rebuild cost or ask your agent"});}
  });
}
