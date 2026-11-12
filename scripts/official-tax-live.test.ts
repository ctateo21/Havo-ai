import {test} from "node:test";
import assert from "node:assert/strict";
import {directEstimator} from "../server/integrations/county-estimator-direct";
import {browserEstimator} from "../server/integrations/county-estimator-browser";
import {fetchOfficialBill} from "../server/integrations/official-county-bills";
import type {CountySlug} from "../server/integrations/parcel-resolver";
import {MANATEE_RATES_URL} from "../server/integrations/manatee-official-rates";
import {officialParcelTax} from "../server/integrations/official-tax-pipeline";
import {MANATEE_RATES_LABEL} from "../shared/manatee-property-tax";

// User-supplied official 2026 answers, not synthesized provider fixtures.
// Unsupported cases deliberately fail; a scheduled job never changes the gate.
const parcels:Record<string,string>={
  hillsborough:"1803310000",pinellas:"06-31-16-92862-080-0010",
  pasco:"26-25-20-0190-01200-0220",polk:"242820239230000032",
  sarasota:"0980038501",lee:"21-45-24-29-00004.1230",
  collier:"57647440005",hernando:"R07-223-18-3261-0000-0060",manatee:"1731576259",
};
const cases:[CountySlug,number,boolean,number][]=[
  ["hillsborough",600000,true,923659],
  ["pinellas",289000,false,487300],["pinellas",289000,true,401800],
  ["pasco",400000,true,498848],["pasco",400000,false,672676],
  ["polk",400000,true,569600],["polk",400000,false,648300],
  ["sarasota",400000,true,460100],["sarasota",400000,false,518000],
  ["lee",400000,true,427409],["lee",400000,false,481043],
  ["collier",750000,false,671400],["collier",750000,true,637000],
  ["collier",400000,false,358000],["collier",400000,true,323600],
  ["hernando",400000,true,511014],["hernando",400000,false,566116],
];
for(const [county,purchasePrice,homestead,expected] of cases){
  const browser=["collier","hernando"].includes(county);
  test(`${county}: $${purchasePrice}, homestead ${homestead}`,{
    timeout:180000,
    skip:["hillsborough","sarasota"].includes(county)&&process.env.COUNTY_TAX_NIGHTLY==="1"
      ? "On-demand only per supplied county access guidance"
      : browser&&!process.env.FIRECRAWL_API_KEY ? "FIRECRAWL_API_KEY required" : false,
  },async()=>{
    const input={county,parcelId:parcels[county],purchasePrice,homestead,taxYear:2026,
      address:county==="collier"?"940 MONTEGO CT":county==="sarasota"?"1182 S SALFORD BLVD":county==="pinellas"?"7400 36TH AVE N":"",
      folioId:county==="lee"?"10207619":undefined,taxDistrict:county==="hernando"?"CWES":undefined};
    const result=await (browser?browserEstimator(input):directEstimator(input));
    assert.equal(result.adValoremCents,expected,`${county} official estimator mismatch`);
  });
}
const bills:[CountySlug,number,number,number][]=[
  ["hillsborough",1121424,28477,1149901],["pinellas",452107,0,452107],
  ["pasco",1385887,435804,1821691],["polk",382818,0,382818],
  ["sarasota",240827,96366,337193],["lee",228243,37641,265884],
  ["hernando",985136,15917,1001053],["manatee",273698,174356,448054],
  ["collier",472908,26977,499885],
];
for(const [county,av,nav,gross]of bills)test(`${county}: 2026 gross bill`,{
  timeout:180000,skip:county==="manatee"&&process.env.COUNTY_TAX_NIGHTLY==="1"?"Manatee on-demand only":!["pinellas","polk","manatee"].includes(county)&&!process.env.FIRECRAWL_API_KEY?"FIRECRAWL_API_KEY required":false,
},async()=>{
  const b=await fetchOfficialBill(county,parcels[county],2026,undefined,county==="pinellas"?"7400 36TH AVE N, ST PETERSBURG, FL 33710":undefined);
  assert.deepEqual([b.adValoremCents,b.navCents,b.combinedCents],[av,nav,gross]);
});
test("Manatee live widget, gross bill and persisted zero-call price recomputation",{
  timeout:180000,skip:process.env.COUNTY_TAX_NIGHTLY==="1"?"Manatee on-demand only":false,
},async()=>{
  const raw=await (await fetch(`${MANATEE_RATES_URL}?parid=2051711709`)).json();
  assert.equal(raw.taxes[0].v_est_taxes,4613.22);
  const hx=await (await fetch(MANATEE_RATES_URL,{method:"POST",body:new URLSearchParams({Exemptions:JSON.stringify({...raw.taxes[0],v_exemptions:"HX1,",v_discount:0,v_chart_mode:{state:"tax",funds:true,breakdown:{show:false,fundKey:""}}})})})).json();
  assert.equal(Math.round(hx.taxes[0].v_est_taxes*100),403433);
  const input={county:"manatee" as const,parcelId:"2051711709",address:"7755 PINE TRACE DR",purchasePrice:313498,homestead:false,taxYear:2026};
  const first=await officialParcelTax(input);
  assert.equal(first.adValorem.cents,461322);assert.equal(first.total.cents,489558);
  assert.equal(first.adValorem.source?.name,MANATEE_RATES_LABEL);
  const real=globalThis.fetch;let countyCalls=0;
  globalThis.fetch=async(url,init)=>{
    if(/manateepao|taxcollector\.com|firecrawl/.test(String(url))){countyCalls++;throw Error("Unexpected county call on cached price");}
    return real(url,init);
  };
  try{
    for(const [homestead,total] of [[false,616848],[true,558959]] as const){
      const result=await officialParcelTax({...input,purchasePrice:400000,homestead});
      assert.equal(result.total.cents,total);
    }
    assert.equal((await officialParcelTax({...input,homestead:true})).total.cents,431669);
    assert.equal((await officialParcelTax(input,true)).total.cents,489559);
    assert.equal(countyCalls,0);
  }finally{globalThis.fetch=real;}
  console.log("Manatee live GET 4613.22; HX POST 4034.33; cache totals 6168.48/5589.59; gross 4895.59; new county calls 0");
});
