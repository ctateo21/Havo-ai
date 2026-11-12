import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {calculateRefinance,calculateMonthlyPayment} from "./refi-calculations";
const source=readFileSync(new URL("../pages/estimate.tsx",import.meta.url),"utf8");
const body=source.match(/function calcConventionalPMI\([^]*?\n\}/)![0]
  .replace(/: number/g,"");
const conventionalPmiMonthly=new Function("CONVENTIONAL_MIN_FICO",`return (${body});`)(620);
for(const [credit,factor] of [[760,.0019],[740,.0029],[720,.0036],[700,.0045],[680,.0061],[660,.0098],[640,.0104],[620,.0117]])
test(`original credit-only PMI factor at score ${credit}`,()=>{
  for(const down of [.03,.05,.10,.15]){
    const loan=400000*(1-down);
    assert.equal(conventionalPmiMonthly(loan,400000,credit),loan*factor/12);
    assert.equal(conventionalPmiMonthly(loan,400000,credit+19),loan*factor/12);
  }
  assert.equal(conventionalPmiMonthly(320000,400000,credit),0);
});
test("PMI eligibility and 80% cutoff remain unchanged",()=>{
  assert.equal(conventionalPmiMonthly(380000,400000,619),0);
  assert.equal(conventionalPmiMonthly(300000,400000,780),0);
  assert.equal(conventionalPmiMonthly(320001,400000,780),320001*.0019/12);
});
test("refinance exposes a matched remaining-term comparison",()=>{
  const r=calculateRefinance({appraisedValue:500000,loanBalance:300000,currentInterestRate:7,newInterestRate:6,currentTermRemainingYears:18,newLoanTermYears:30,closingCostsPercent:0,closingCostsFixed:0,includeClosingCostsInLoan:false,refinanceType:"rate_and_term"});
  assert.equal(r.matchedTermPayment,calculateMonthlyPayment(300000,6,18));
  assert.notEqual(r.monthlyPaymentNew,r.matchedTermPayment);
});
