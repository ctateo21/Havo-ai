import type {DistrictRate} from "../../shared/quick-property-tax";
/** Pinellas publishes a repeated district-code boundary and twenty rate
 * columns. Reject layout changes rather than interpreting totals as levies. */
export function parsePinellasTacd(text:string,sourceUrl:string,fetchedAt:string):DistrictRate[]{
 const names=["General Fund","Health","Pinellas Planning Council","School","EMS","Municipal","MSTU","MSTU USSD","Fire","Library Services","CDD and community services","SWFWMD","Pinellas Park Water","Juvenile Welfare Board","Transit"];
 const rows:DistrictRate[]=[];
 const pattern=/\n([A-Z]{2,6})[ \t]*\n([\s\S]*?)\n\1[ \t]*(?=\n|$)/g;
 for(const match of text.matchAll(pattern)){
  const tokens=match[2].match(/N\/A|\d+\.\d{4}/g);if(!tokens||tokens.length!==20)continue;
  const levies=tokens.slice(3,18).flatMap((v,i)=>v==="N/A"?[]:[{name:names[i],mills:Number(v),school:i===3}]);
  const total=levies.reduce((s,l)=>s+l.mills,0);
  if(Math.abs(total-Number(tokens[18]))>.0002)throw Error(`TACD ${match[1]} levy total mismatch`);
  const title=match[2].split(/\d+\.\d{4}/)[0].trim().replace(/\s+/g," ");
  rows.push({county:"pinellas",tax_year:2025,district_code:match[1],district_name:title,school_mills:levies.filter(l=>l.school).reduce((s,l)=>s+l.mills,0),non_school_mills:levies.filter(l=>!l.school).reduce((s,l)=>s+l.mills,0),levies,source_name:"FL DOR 2025 TACD",source_url:sourceUrl,fetched_at:fetchedAt,verified_against:"Levy sum equals published district total"});
 }
 if(!rows.length)throw Error("TACD layout unrecognized; no rates imported");
 return rows;
}
