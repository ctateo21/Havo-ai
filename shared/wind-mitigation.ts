import { z } from "zod";

export const CLIP_YEAR: Record<string, number> = {
  pinellas:1996, manatee:1996, sarasota:1996, lee:1996, collier:1996,
  hillsborough:1997, pasco:1997, hernando:1997, polk:1997,
};
export const PRODUCT_APPROVAL = ["Meets FBC 2001","Meets FBC 1994","Non-FBC"] as const;
/** Planning assumptions approved for preliminary quotes, not inspection findings. */
export function assumeWindAttachments(county:string, yearBuilt:number, roofYear:number, coastal?:CoastalEvidence) {
  const known=Number.isFinite(yearBuilt)&&yearBuilt>=1800;
  const normalized=county.toLowerCase().replace(/ county$/,"");
  const clips=known && (yearBuilt>=2003 || yearBuilt>=(CLIP_YEAR[normalized]??2003) ||
    (yearBuilt>=1987&&yearBuilt<=1995&&coastal?.status==="inside"));
  const roofDeck=!known?"A":yearBuilt>=2002||roofYear>=2008?"C":yearBuilt>=1994?"B":"A";
  const basis=known?`Assumed from ${yearBuilt} build, ${county || "county not supplied"}${coastal?.status==="inside"?" and coastal-zone check":""}`:"Assumed conservative attachment; year built not supplied";
  return {roofDeck:roofDeck as "A"|"B"|"C",roofToWall:clips?"Clips" as const:"Toe Nails" as const,
    wallBasis:basis,deckBasis:`${basis}${known&&roofYear>=2008?`; ${roofYear} roof year`:""}`};
}
const windObjectSchema = z.object({
  reportAvailable:z.boolean().default(false),
  report:z.object({
    reference:z.string().trim().max(120).optional(),
    uploadId:z.string().uuid().optional(),
    inspector:z.string().trim().max(200).optional(),
    yearBuilt:z.number().int().min(1800).max(2027).optional(),
    roofCovering:z.string().trim().max(300).optional(),
    productApproval:z.enum(PRODUCT_APPROVAL).optional(),
    assumedFields:z.array(z.enum(["roofToWall","roofDeck","swr","opening","shape","roofCovering","productApproval"])).optional(),
    inspectionDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v && Date.parse(v)<=Date.now()),
    transcribedFromReport:z.literal(true),
    roofToWall:z.enum(["Unknown","Toe Nails","Clips","Single Wraps","Double Wraps","Structural","N/A"]),
    roofDeck:z.enum(["Unknown","A","B","C","D","Concrete"]),
    swr:z.enum(["Unknown","Yes","No"]),
    opening:z.enum(["Unknown","A","B","C","N","X"]),
    shape:z.enum(["Hip","Gable","Flat"]),
  }).optional(),
  shape:z.enum(["Hip","Gable","Flat","Not sure"]).default("Not sure"),
  roofDeck:z.enum(["A","B","C","Concrete"]).optional(),
  roofToWall:z.enum(["Toe Nails","Clips","Single Wraps","Double Wraps","Structural","N/A"]).optional(),
  roofCovering:z.enum(PRODUCT_APPROVAL).optional(),
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
export type PermitEvidence = {number:string; description:string; date:string; source:string; sourceUrl:string;dateBasis?:"issued"|"received";
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
    const r=a.report,source=`Report ${r.uploadId || r.reference || "user-confirmed values"}, inspected ${r.inspectionDate} — confirmed by user`;
    const field=(key:"roofToWall"|"roofDeck"|"swr"|"opening"|"shape",value:string)=>
      fact(value,r.assumedFields?.includes(key)?"Assumed value; not present in uploaded report":source,!!r.assumedFields?.includes(key));
    return {haveReport:true,fields:{roofToWall:field("roofToWall",r.roofToWall),roofDeck:field("roofDeck",r.roofDeck),
      swr:field("swr",r.swr),opening:field("opening",r.opening),shape:field("shape",r.shape)},notes:[]};
  }
  const assumed=assumeWindAttachments(input.county,input.yearBuilt,input.roofYear,input.coastal);
  const fields:WindResult["fields"]={
    roofToWall:fact(a.roofToWall??assumed.roofToWall,a.roofToWall?"User-selected estimate":assumed.wallBasis),
    roofDeck:fact(a.roofDeck??assumed.roofDeck,a.roofDeck?"User-selected estimate":assumed.deckBasis),
    swr:fact(a.peelAndStick==="no"?"No":a.peelAndStick==="yes"||input.roofYear>=2021?"Yes":"No",
      a.peelAndStick!=="unsure"?"User-selected estimate":`Assumed from ${input.roofYear || "missing"} roof year`),
    opening:fact(a.allOpenings==="all"?"A":"None",a.allOpenings==="all"?"User-selected estimate":"Assumed no complete opening protection"),
    shape:fact(a.shape==="Not sure"?"Gable":a.shape,a.shape==="Not sure"?"Agency default":"User-selected estimate"),
  };
  return {haveReport:false,fields,notes:[
    ...(input.coastal?[`Coastal check: ${input.coastal.status}; distance ${input.coastal.distanceFeet??"unknown"} ft; ${input.coastal.source}; ${input.coastal.reason??""}`]:[]),
    "No wind mitigation report supplied; estimated credits require carrier verification.",
  ]};
}
export function windNotes(w:WindResult):string[]{
  return [...Object.entries(w.fields).map(([k,v])=>`${k}: ${v.value} — ${v.estimated?"estimated":"confirmed"}; ${v.source}`),...w.notes];
}
