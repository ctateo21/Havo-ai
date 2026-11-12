import {createHash,createHmac,timingSafeEqual} from "node:crypto";
export function nonPersonalAnswerHash(request:Record<string,any>):string {
  const keys=["policyType","coverageA","hurrIdx","aopDeductible","roofYear","yearBuilt","sqFt","constIdx","openingProtection","roofShape","secondaryWaterResistance","windIdx","windMitigationLocks","usageType","rentalTerm","newPurchase","purchasePrice","policyEffectiveDate","floodZone","floodZoneUnknown","hasMortgage"];
  const stable=(v:any):any=>v&&typeof v==="object"?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  return createHash("sha256").update(JSON.stringify(keys.map(k=>[k,stable(request[k]??null)]))).digest("hex");
}
export function quoteAnswerIdentity(request:Record<string,any>,userId:string){
  const answerHash=nonPersonalAnswerHash(request);
  const privateHash=createHash("sha256").update(JSON.stringify([userId,request.claimRecords??[],request.currentCarrier??null,request.currentlyInsured??null])).digest("hex");
  return {answerHash,ownerUserId:userId,runHadClaims:request.hasClaims===true,
    cacheScope:`answers-v1:${answerHash}:${request.hasClaims?privateHash:"no-claims"}`};
}
export function canReuseAnsweredQuote(row:{answerHash?:string|null;ownerUserId?:string|null;runHadClaims?:boolean|null},hash:string,userId:string){
  return Boolean(row.answerHash&&row.answerHash===hash&&row.ownerUserId&&
    (row.ownerUserId===userId||row.runHadClaims===false));
}
type Run={id:number;triggeredAt:Date;expiresAt:Date};
function secret(){const key=process.env.SESSION_SECRET;if(!key)throw Error("Quote access signing is not configured");return key;}
export function issueQuoteAccess(row:Run,userId:string):string {
  const payload=Buffer.from(JSON.stringify([row.id,userId,row.triggeredAt.toISOString(),row.expiresAt.getTime()])).toString("base64url");
  return payload+"."+createHmac("sha256",secret()).update(payload).digest("base64url");
}
export function verifyQuoteAccess(token:unknown,row:Run,userId:string):boolean{
  try{
    if(typeof token!=="string"||token.length>2000)return false;
    const [payload,signature]=token.split(".");
    const expected=createHmac("sha256",secret()).update(payload).digest();
    const actual=Buffer.from(signature??"","base64url");
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return false;
    const [id,owner,generation,expires]=JSON.parse(Buffer.from(payload,"base64url").toString());
    return id===row.id&&owner===userId&&generation===row.triggeredAt.toISOString()&&expires>Date.now();
  }catch{return false;}
}
