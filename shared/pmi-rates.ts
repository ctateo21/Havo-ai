// Illustrative planning premiums, not a carrier quote or verified 2026 rate card.
// Annual premium percentages by credit band and LTV: >95, >90, >85, >80.
// Replace centrally with agency-approved MI rate-card values when supplied.
export const PMI_RATE_TABLE=[
  {minCredit:760,rates:[.30,.19,.15,.10]},
  {minCredit:740,rates:[.40,.29,.22,.15]},
  {minCredit:720,rates:[.50,.36,.28,.20]},
  {minCredit:700,rates:[.65,.45,.35,.25]},
  {minCredit:680,rates:[.85,.61,.45,.32]},
  {minCredit:660,rates:[1.20,.98,.70,.50]},
  {minCredit:640,rates:[1.40,1.04,.85,.60]},
  {minCredit:620,rates:[1.65,1.17,.95,.70]},
] as const;
export function conventionalPmiMonthly(loan:number,price:number,credit:number):number {
  if(!Number.isFinite(price)||price<=0||loan<=0)return 0;
  const ltv=loan/price;if(ltv<=.8)return 0;
  const row=PMI_RATE_TABLE.find(r=>credit>=r.minCredit);if(!row)return 0;
  return loan*row.rates[ltv>.95?0:ltv>.9?1:ltv>.85?2:3]/100/12;
}
