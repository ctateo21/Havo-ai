import { z } from "zod";

export const CLIP_YEAR: Record<string, number> = {
  pinellas:1996, manatee:1996, sarasota:1996, lee:1996, collier:1996,
  hillsborough:1997, pasco:1997, hernando:1997, polk:1997,
};
const windObjectSchema = z.object({
  reportAvailable:z.boolean().default(false),
  report:z.object({
    reference:z.string().trim().min(3).max(120),
    uploadId:z.string().uuid().optional(),
    inspector:z.string().trim().max(200).optional(),
    yearBuilt:z.number().int().min(1800).max(2027).optional(),
    roofCovering:z.string().trim().max(300).optional(),
    inspectionDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v && Date.parse(v)<=Date.now()),
    transcribedFromReport:z.literal(true),
    roofToWall:z.enum(["Unknown","Toe Nails","Clips","Single Wraps","Double Wraps"]),
    roofDeck:z.enum(["Unknown","A","B","C","D"]),
    swr:z.enum(["Unknown","Yes","No"]),
    opening:z.enum(["Unknown","A","B","C","N","X"]),
    shape:z.enum(["Hip","Gable","Flat"]),
  }).optional(),
  shape:z.enum(["Hip","Gable","Flat","Not sure"]).default("Not sure"),
  allOpenings:z.enum(["all","partial","unsure"]).default("unsure"),
  openingsConfirmed:z.boolean().default(false),
  peelAndStick:z.enum(["yes","no","unsure"]).default("unsure"),
  gated:z.boolean().default(false),
}).refine(v=>!v.reportAvailable || !!v.report,{message:"Enter the values and identifying details from your existing report."});
export const windAnswersSchema=z.preprocess(value=>{
  if(value&&typeof value==="object"&&!("reportAvailable" in value && value.reportAvailable===true)){
    const {report,...rest}=value as Record<string,unknown>;return rest;
  }
  return value;
},windObjectSchema);
export type WindAnswers = z.infer<typeof windAnswersSchema>;
export type WindEvidence = {value:string; estimated:boolean; source:string};
export type PermitEvidence = {number:string; description:string; date:string; source:string; sourceUrl:string;
  classification?:{kind:"openings"|"garage_door"|"reroof"|"roof_detail"|"other";quote:string;swr:boolean}};
export type CoastalEvidence = {status:"inside"|"outside"|"unknown"; distanceFeet:number|null; source:string; sourceUrl:string; reason?:string};
export type WindResult = {haveReport:boolean; fields:Record<"roofToWall"|"roofDeck"|"swr"|"opening"|"shape",WindEvidence>; notes:string[]};
export function permitKinds(p:PermitEvidence) {
  // Unclassified permit text must never confer a credit. In particular "ROOF"
  // alone does not establish a replacement rather than a repair/inspection.
  return {roof:p.classification?.kind==="reroof",
    opening:p.classification?.kind==="openings",
    garage:p.classification?.kind==="garage_door"};
}
export function resolveWind(input:{county:string; yearBuilt:number; roofYear:number; answers?:WindAnswers; permits?:PermitEvidence[]; coastal?:CoastalEvidence}):WindResult{
  const a=windAnswersSchema.parse(input.answers??{}), permits=input.permits??[];
  const fact=(value:string,source:string,estimated=true):WindEvidence=>({value,source,estimated});
  if(a.reportAvailable && a.report){
    const r=a.report,source=`Report ${r.reference}, inspected ${r.inspectionDate} — transcribed by user`;
    return {haveReport:true,fields:{roofToWall:fact(r.roofToWall,source,false),roofDeck:fact(r.roofDeck,source,false),
      swr:fact(r.swr,source,false),opening:fact(r.opening,source,false),shape:fact(r.shape,source,false)},notes:[]};
  }
  const county=input.county.toLowerCase().replace(/ county$/,"");
  const cutoff=CLIP_YEAR[county]??2003;
  const clips=input.yearBuilt>=2003 || input.yearBuilt>=cutoff ||
    (input.yearBuilt>=1987 && input.yearBuilt<=1995 && input.coastal?.status==="inside");
  const roofPermit=permits.find(p=>permitKinds(p).roof && Date.parse(p.date)>Date.parse("2007-10-01"));
  const openings=permits.filter(p=>permitKinds(p).opening);
  const swrPermit=permits.find(p=>p.classification?.swr===true&&
    p.description.includes(p.classification.quote)&&
    /\b(peel.and.stick|self.adhered underlayment|seam tape)\b/i.test(p.classification.quote));
  const deck=roofPermit&&input.yearBuilt<2002?"C":input.roofYear>input.yearBuilt||input.yearBuilt>=2002?"B":"Unknown";
  const fields:WindResult["fields"]={
    roofToWall:fact(clips?"Clips":"Unknown",input.yearBuilt<1996&&clips?"coastal-zone check + year built":"year built"),
    roofDeck:fact(deck,roofPermit?`county permit ${roofPermit.number}`:"year built / user roof year"),
    swr:fact(swrPermit||input.roofYear>=2021?"Yes":input.roofYear>=2008&&a.peelAndStick==="yes"?"Yes":"Unknown",
      swrPermit?`county PA permit ${swrPermit.number}: "${swrPermit.classification!.quote}" (${swrPermit.sourceUrl})`:input.roofYear>=2021?"user roof year": "user answer"),
    opening:fact(a.allOpenings==="all"&&a.openingsConfirmed?(openings.length?"B":"N"):"X",openings.length?"county permit + user answer":"user answer"),
    shape:fact(a.shape==="Not sure"?"Gable":a.shape,a.shape==="Not sure"?"agency default — please confirm":"user answer",a.shape==="Not sure"),
  };
  return {haveReport:false,fields,notes:[
    ...openings.map(p=>`Opening permit ${p.number}: ${p.description}; confirm ALL windows, doors, sliders and garage door.`),
    ...(input.coastal?[`Coastal check: ${input.coastal.status}; distance ${input.coastal.distanceFeet??"unknown"} ft; ${input.coastal.source}; ${input.coastal.reason??""}`]:[]),
    "No wind mitigation report supplied; estimated credits require carrier verification.",
  ]};
}
export function windNotes(w:WindResult):string[]{
  return [...Object.entries(w.fields).map(([k,v])=>`${k}: ${v.value} — ${v.estimated?"estimated":"confirmed"}; ${v.source}`),...w.notes];
}
