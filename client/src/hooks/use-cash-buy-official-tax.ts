import {useEffect,useState} from "react";
import {parseOfficialPropertyTaxResponse,type OfficialPropertyTaxResolution} from "@/lib/official-property-tax";
import type {CashBuyScenario} from "@/lib/auth";

export function useCashBuyOfficialTax(s:CashBuyScenario) {
  const useSelected=s.occupancyTypeSource==="manual"&&["primary","secondary","investment"].includes(s.occupancyType??"");
  const key=JSON.stringify([s.id,s.address,s.purchasePrice,s.occupancyType,useSelected,s.propertyTaxesSource,s.propertyTaxesSource==="manual"?s.propertyTaxes:null]);
  const [state,setState]=useState<{key:string;loading:boolean;result?:OfficialPropertyTaxResolution}>({key:"",loading:false});
  const manual=s.propertyTaxesSource==="manual"&&Number.isFinite(s.propertyTaxes)&&s.propertyTaxes!>=0;
  useEffect(()=>{
    if(!useSelected||manual||!s.address||!(s.purchasePrice!>0))return;
    const abort=new AbortController();
    setState({key,loading:true});
    fetch("/api/property-tax/county",{method:"POST",headers:{"Content-Type":"application/json"},signal:abort.signal,
      body:JSON.stringify({address:s.address,purchasePrice:s.purchasePrice,isPrimaryResidence:s.occupancyType==="primary"})})
      .then(async r=>{if(!r.ok)throw Error("Official county lookup unavailable");return r.json();})
      .then(data=>{
        const parsed=parseOfficialPropertyTaxResponse(data);
        const result:OfficialPropertyTaxResolution=parsed.status==="available"&&
          (!parsed.breakdown?.adValorem.source||!parsed.breakdown?.nonAdValorem.source)?
          {status:"unavailable",reason:"Official component provenance missing."}:parsed;
        if(!abort.signal.aborted)setState({key,loading:false,result});
      })
      .catch(error=>{if(!abort.signal.aborted)setState({key,loading:false,result:{status:"unavailable",reason:error.message}});});
    return()=>abort.abort();
  },[key]);
  const current=state.key===key?state:undefined;
  const result=current?.result;
  return {
    annualTax:!useSelected?null:manual?s.propertyTaxes!:result?.status==="available"?result.annualTax:null,
    loading:useSelected&&!manual&&!!s.address&&s.purchasePrice!>0&&(!current||current.loading),
    reason:!useSelected?"Select Property Use to calculate property taxes.":!s.purchasePrice?"Enter a purchase price.":result?.status==="unavailable"?(result.reason||"Official county figure unavailable."):"Official county figure unavailable.",
    breakdown:result?.breakdown,manual,
  };
}
