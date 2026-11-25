import {useId,useState} from "react";
import {Input} from "@/components/ui/input";
type Address={Address:string;City:string;State:string;Zip:string};
export function CurrentHomeForm({address,onAddress,mortgage,onMortgage,newPurchase}:{
  address:Address;onAddress:(value:Address)=>void;mortgage:string;onMortgage:(value:string)=>void;newPurchase:boolean;
}){
  const [open,setOpen]=useState(false);
  const id=useId();
  return <section className="container mx-auto px-4 py-2" aria-label="Current home and mortgage">
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 text-sm">
        <span className="block truncate">{newPurchase?Object.values(address).filter(Boolean).join(", ")||"Current home address not entered":"Mortgage details"}</span>
        <span className="text-muted-foreground">Mortgage: {mortgage==="yes"?"Yes":mortgage==="no"?"No":"Not answered"}</span>
      </div>
      <button type="button" className="shrink-0 text-primary underline" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(!open)}>
        {open?"Close":"Edit"}
      </button>
    </div>
    {open&&<div id={id} className="max-h-[40dvh] overflow-y-auto py-2">
      {newPurchase&&<fieldset><legend className="font-medium">Current home address</legend>
        <p className="text-sm text-muted-foreground">Optional. If omitted, the quoted property address is used for quoting only and flagged for agent verification.</p>
        <div className="grid gap-2 sm:grid-cols-4">{(["Address","City","State","Zip"] as const).map(key=><label key={key} className="text-sm">
          {key==="Address"?"Street and unit":key}<Input value={address[key]} onChange={e=>onAddress({...address,[key]:e.target.value})} autoComplete="off"/>
        </label>)}</div>
      </fieldset>}
      <label className="block py-2 text-sm">Will this home have a mortgage?
        <select aria-label="Will this home have a mortgage?" value={mortgage} onChange={e=>onMortgage(e.target.value)} className="block max-w-full border rounded p-2">
          <option value="">Please select</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
      </label>
      <button type="button" className="text-primary underline" onClick={()=>setOpen(false)}>Done</button>
    </div>}
  </section>;
}
