import {test} from "node:test";
import assert from "node:assert/strict";
import {conventionalPmiMonthly,PMI_RATE_TABLE} from "../../../shared/pmi-rates";
import {calculateRefinance,calculateMonthlyPayment} from "./refi-calculations";
for(const row of PMI_RATE_TABLE)test(`PMI decreases with 3/5/10/15/20% down at credit ${row.minCredit}`,()=>{
  const values=[.03,.05,.10,.15,.20].map(d=>conventionalPmiMonthly(400000*(1-d),400000,row.minCredit));
  for(let i=1;i<values.length;i++)assert.ok(values[i]<values[i-1]);
  assert.equal(values[4],0);
});
test("refinance exposes a matched remaining-term comparison",()=>{
  const r=calculateRefinance({appraisedValue:500000,loanBalance:300000,currentInterestRate:7,newInterestRate:6,currentTermRemainingYears:18,newLoanTermYears:30,closingCostsPercent:0,closingCostsFixed:0,includeClosingCostsInLoan:false,refinanceType:"rate_and_term"});
  assert.equal(r.matchedTermPayment,calculateMonthlyPayment(300000,6,18));
  assert.notEqual(r.monthlyPaymentNew,r.matchedTermPayment);
});
