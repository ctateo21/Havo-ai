import {test} from "node:test";
import assert from "node:assert/strict";
import {directEstimator} from "../server/integrations/county-estimator-direct";
import {browserEstimator} from "../server/integrations/county-estimator-browser";
import {fetchOfficialBill} from "../server/integrations/official-county-bills";
import type {CountySlug} from "../server/integrations/parcel-resolver";

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
    skip:county==="hillsborough"&&process.env.COUNTY_TAX_NIGHTLY==="1"
      ? "HCPA on-demand only per supplied access guidance"
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
  timeout:180000,skip:!["pinellas","polk","manatee"].includes(county)&&!process.env.FIRECRAWL_API_KEY?"FIRECRAWL_API_KEY required":false,
},async()=>{
  const b=await fetchOfficialBill(county,parcels[county],2026,undefined,county==="pinellas"?"7400 36TH AVE N, ST PETERSBURG, FL 33710":undefined);
  assert.deepEqual([b.adValoremCents,b.navCents,b.combinedCents],[av,nav,gross]);
});
