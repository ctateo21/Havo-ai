// ─── Regression tests for the Initial Fees Worksheet + APR model ───
//
// Run with: npm test  (tsx --test)
//
// The primary fixture is a real lender "Initial Fees Worksheet"
// (attached_assets/IFW16391610_1786020456742.pdf, Barrett Financial,
// quote #16391610): $330,000 purchase, $320,100 conventional loan,
// 6.624% note rate, lender-disclosed APR 6.927%. Our model computes
// 6.938% APR (0.011 pt above the lender — fee-schedule differences)
// and matches the total monthly payment exactly ($2,867.12).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFeeWorksheet,
  solveAPR,
  type FeeWorksheetInputs,
  type FeeWorksheet,
} from "./fee-worksheet";
import {
  calculateDiscountPointsCost,
  getDiscountPointsRateReduction,
  type DiscountPointsLoanType,
} from "./discount-points";

// ── helpers ─────────────────────────────────────────────────────────

const baseInputs: FeeWorksheetInputs = {
  purchasePrice: 330_000,
  baseLoanAmount: 320_100,
  loanAmount: 320_100,
  ratePct: 6.624,
  loanType: "conventional",
  monthlyPI: 2049.42,
  monthlyTax: 490.5,
  monthlyHOIns: 247.18,
  monthlyFlood: 0,
  monthlyMI: 80.02,
  hoaMonthly: 0,
  monthlyCDD: 0,
  downPaymentAmt: 9_900,
  discountPointsCost: 0,
  discountPointsPct: 0,
  dscrOriginationAmount: 0,
  dpaExtraPointsCost: 0,
  sellerCredits: 9_900,
  dpaDownPaymentCredit: 0,
  dpaClosingCostCredit: 0,
};

function inputs(overrides: Partial<FeeWorksheetInputs> = {}): FeeWorksheetInputs {
  return { ...baseInputs, ...overrides };
}

function allLines(ws: FeeWorksheet) {
  const sections = [ws.lenderFees, ws.thirdPartyFees, ws.govFees, ws.prepaids, ws.otherFees, ws.monthlyHousing];
  return sections.flatMap(s => [...s.lines, ...(s.groups ?? []).flatMap(g => g.lines)]);
}

function findLine(ws: FeeWorksheet, labelPart: string) {
  return allLines(ws).find(l => l.label.includes(labelPart));
}

function assertFiniteWorksheet(ws: FeeWorksheet) {
  for (const l of allLines(ws)) {
    assert.ok(Number.isFinite(l.amount), `non-finite amount on "${l.label}"`);
  }
  for (const n of [
    ws.totalMonthly, ws.totalClosingCosts, ws.aprPct, ws.prepaidFinanceCharges,
    ws.fundsToClose.fundsFromBorrower, ws.fundsToClose.totalCredits, ws.fundsToClose.estimatedCash,
  ]) {
    assert.ok(Number.isFinite(n), `non-finite worksheet total (${n})`);
  }
}

function monthlyPI(loanAmount: number, annualRatePct: number, months = 360): number {
  const monthlyRate = annualRatePct / 100 / 12;
  return loanAmount * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months));
}

function moneyDelta(withAmount: number, withoutAmount: number): number {
  return Math.round((withAmount - withoutAmount) * 100) / 100;
}

// ── 1. Lender-worksheet fixture (quote #16391610) ───────────────────

test("lender fixture: total monthly payment matches the worksheet exactly", () => {
  const ws = buildFeeWorksheet(inputs());
  assert.equal(ws.totalMonthly, 2867.12); // PDF: TOTAL APPROXIMATED MONTHLY PAYMENT
});

test("lender fixture: computed APR stays pinned at 6.938% (lender disclosed 6.927%)", () => {
  const ws = buildFeeWorksheet(inputs());
  assert.equal(ws.aprPct, 6.938);
  // Guardrail against solver/fee-schedule drift: stay within 0.05 pt
  // of the lender's disclosed APR and never below the note rate.
  assert.ok(Math.abs(ws.aprPct - 6.927) < 0.05, `APR ${ws.aprPct} drifted from lender's 6.927`);
  assert.ok(ws.aprPct >= 6.624, "APR must never be below the note rate");
});

test("lender fixture: section subtotals and closing-cost totals are pinned", () => {
  const ws = buildFeeWorksheet(inputs());
  assert.equal(ws.lenderFees.subtotal, 1250); // underwriting only (matches PDF)
  assert.equal(ws.thirdPartyFees.subtotal, 4179.78);
  assert.equal(ws.govFees.subtotal, 2061.05);
  assert.equal(ws.prepaids.subtotal, 7522.05);
  assert.equal(ws.otherFees.subtotal, 2090);
  assert.equal(ws.totalClosingCosts, 17102.88);
  assert.equal(ws.prepaidFinanceCharges, 2231.3);
  // Internal consistency: sections must sum to the total.
  assert.equal(
    ws.totalClosingCosts,
    Math.round((ws.lenderFees.subtotal + ws.thirdPartyFees.subtotal + ws.govFees.subtotal + ws.prepaids.subtotal + ws.otherFees.subtotal) * 100) / 100,
  );
});

test("lender fixture: Florida statutory taxes (doc stamps + intangible)", () => {
  const ws = buildFeeWorksheet(inputs());
  // Doc stamps: $0.35 per $100 (rounded up per $100) on $320,100 = $1,120.35
  assert.equal(findLine(ws, "Doc Stamps")?.amount, 1120.35);
  // Intangible tax: 0.2% of $320,100 = $640.20
  assert.equal(findLine(ws, "Intangible Tax")?.amount, 640.2);
});

test("lender fixture: funds to close A − B arithmetic holds", () => {
  const ws = buildFeeWorksheet(inputs());
  const f = ws.fundsToClose;
  assert.equal(f.fundsFromBorrower, 27002.88); // down payment 9,900 + closing costs 17,102.88
  assert.equal(f.totalCredits, 9900); // seller credits, uncapped here (below eligible costs)
  assert.equal(f.estimatedCash, 17102.88);
  assert.equal(f.estimatedCash, Math.round((f.fundsFromBorrower - f.totalCredits) * 100) / 100);
});

// ── 2. Zero purchase price ──────────────────────────────────────────

test("zero purchase price: no NaN/Infinity anywhere, APR falls back to note rate", () => {
  const ws = buildFeeWorksheet(inputs({
    purchasePrice: 0, baseLoanAmount: 0, loanAmount: 0,
    monthlyPI: 0, monthlyMI: 0, monthlyTax: 0, monthlyHOIns: 0,
    downPaymentAmt: 0, sellerCredits: 0,
  }));
  assertFiniteWorksheet(ws);
  assert.equal(ws.aprPct, 6.624); // solver bails to note rate
  assert.equal(ws.totalMonthly, 0);
  assert.equal(ws.fundsToClose.estimatedCash, ws.totalClosingCosts); // fixed fees remain
});

test("zero price but nonzero MI does not divide by zero in FHA LTV branch", () => {
  const ws = buildFeeWorksheet(inputs({
    purchasePrice: 0, baseLoanAmount: 0, loanAmount: 0,
    monthlyPI: 0, monthlyMI: 50, loanType: "fha",
    downPaymentAmt: 0, sellerCredits: 0,
  }));
  assertFiniteWorksheet(ws);
});

// ── 3. FHA with DPA ─────────────────────────────────────────────────

// FHA 96.5% LTV + UFMIP financed: $400k price, base $386k, +1.75% UFMIP.
const fhaBase = {
  purchasePrice: 400_000,
  baseLoanAmount: 386_000,
  loanAmount: 392_755, // base + 1.75% UFMIP
  ratePct: 6.75,
  loanType: "fha" as const,
  monthlyPI: 2547.5,
  monthlyMI: 180.1, // 0.55% annual MIP
  downPaymentAmt: 14_000,
  sellerCredits: 0,
};

test("FHA DPA amortizing 2nd: 'Other Financing P&I' appears and is in the monthly total", () => {
  const ws = buildFeeWorksheet(inputs({
    ...fhaBase,
    dpaSecondMonthly: 142.33,
    dpaDownPaymentCredit: 14_000,
    dpaClosingCostCredit: 6_000,
  }));
  const second = ws.monthlyHousing.lines.find(l => l.label === "Other Financing P&I (DPA 2nd)");
  assert.ok(second, "amortizing DPA 2nd must show as its own monthly line");
  assert.equal(second!.amount, 142.33);
  // total = P&I + 2nd + HOI + tax + MIP
  assert.equal(ws.totalMonthly, Math.round((2547.5 + 142.33 + 247.18 + 490.5 + 180.1) * 100) / 100);
  // DPA credits show up in funds-to-close credits
  assert.equal(findCredit(ws, "DPA Down Payment Assistance"), 14_000);
  assert.equal(findCredit(ws, "DPA Closing Cost Credit"), 6_000);
});

test("FHA DPA silent 2nd: first-lien program points are charged and included in first-lien APR exactly once", () => {
  const extra = Math.round(386_000 * 0.02 * 100) / 100; // 7,720
  const withoutProgramPoints = buildFeeWorksheet(inputs({ ...fhaBase }));
  const withProgramPoints = buildFeeWorksheet(inputs({ ...fhaBase, dpaExtraPointsCost: extra }));
  const line = withProgramPoints.lenderFees.lines.find(l => l.label.includes("DPA Program Points"));
  assert.ok(line, "silent-2nd DPA points must be a separate lender-fee line");
  assert.equal(line!.amount, extra);
  assert.equal(withProgramPoints.lenderFees.subtotal, 1250 + extra);
  assert.equal(
    Math.round(
      (withProgramPoints.fundsToClose.fundsFromBorrower - withoutProgramPoints.fundsToClose.fundsFromBorrower) * 100,
    ) / 100,
    extra,
    "borrower funds must include the program points exactly once",
  );
  assert.equal(
    Math.round(
      (withProgramPoints.fundsToClose.estimatedCash - withoutProgramPoints.fundsToClose.estimatedCash) * 100,
    ) / 100,
    extra,
    "cash to close must include the program points exactly once",
  );
  assert.equal(
    withProgramPoints.prepaidFinanceCharges - withoutProgramPoints.prepaidFinanceCharges,
    extra,
    "the first-lien prepaid finance charge must include the program points exactly once",
  );
  assert.ok(
    withProgramPoints.aprPct > withoutProgramPoints.aprPct,
    `first-lien APR ${withProgramPoints.aprPct} must exceed ${withoutProgramPoints.aprPct} when program points are charged`,
  );
  assert.equal(
    withProgramPoints.monthlyHousing.lines.some(l => l.label.includes("DPA 2nd")),
    false,
    "the silent second must receive neither a monthly charge nor a duplicate allocation",
  );
});

test("FHA <10% down: life-of-loan MIP makes APR higher than an identical loan with MI ending early", () => {
  const fha = buildFeeWorksheet(inputs({ ...fhaBase })); // LTV 96.5% → MI for full term
  const conv = buildFeeWorksheet(inputs({ ...fhaBase, loanType: "conventional" })); // PMI drops at 78% LTV
  assert.ok(fha.aprPct > conv.aprPct,
    `life-of-loan FHA MIP (${fha.aprPct}) should exceed drop-off PMI APR (${conv.aprPct})`);
});

// ── 4. VA financed funding fee ──────────────────────────────────────

test("VA financed funding fee: statutory taxes computed on the TOTAL financed amount", () => {
  const base = 400_000;
  const funded = 408_600; // + 2.15% funding fee
  const ws = buildFeeWorksheet(inputs({
    purchasePrice: 400_000, baseLoanAmount: base, loanAmount: funded,
    loanType: "va", ratePct: 6.25, monthlyPI: 2515.87, monthlyMI: 0,
    downPaymentAmt: 0, sellerCredits: 0,
  }));
  // Doc stamps and intangible tax must use the financed amount, not the base.
  assert.equal(findLine(ws, "Doc Stamps")?.amount, Math.ceil(funded / 100) * 0.35);
  assert.equal(findLine(ws, "Intangible Tax")?.amount, Math.round(funded * 0.002 * 100) / 100);
  // No MI → no Mortgage Insurance monthly line, APR still above note rate (fees only)
  assert.equal(ws.monthlyHousing.lines.some(l => l.label === "Mortgage Insurance"), false);
  assert.ok(ws.aprPct > 6.25);
});

test("Section H includes the standard purchase other fees", () => {
  const ws = buildFeeWorksheet(inputs());
  assert.deepEqual(
    ws.otherFees.lines.map((line) => [line.label, line.amount]),
    [
      ["Transaction Fee", 995],
      ["Survey", 495],
      ["Home Inspection", 600],
    ],
  );
  assert.equal(ws.otherFees.subtotal, 2090);
});

test("Section H adds an elevation certificate only when purchase flow requires it", () => {
  const required = buildFeeWorksheet(inputs({ requiresElevationCertificate: true }));
  const notRequired = buildFeeWorksheet(inputs({ requiresElevationCertificate: false }));
  assert.equal(findLine(required, "Elevation Certificate")?.amount, 795);
  assert.equal(required.otherFees.subtotal, 2885);
  assert.equal(findLine(notRequired, "Elevation Certificate"), undefined);
  assert.equal(notRequired.otherFees.subtotal, 2090);
  assert.equal(required.totalClosingCosts - notRequired.totalClosingCosts, 795);
  assert.equal(
    required.fundsToClose.fundsFromBorrower - notRequired.fundsToClose.fundsFromBorrower,
    795,
  );
});

test("turning escrows off preserves prepaids and removes only three-month reserves", () => {
  const withEscrows = buildFeeWorksheet(inputs({ escrowsEnabled: true }));
  const withoutEscrows = buildFeeWorksheet(inputs({ escrowsEnabled: false }));
  const reserveTotal = Math.round(
    (baseInputs.monthlyHOIns * 3 + baseInputs.monthlyTax * 3) * 100,
  ) / 100;

  const prepaidsGroup = (ws: FeeWorksheet) =>
    ws.prepaids.groups?.find((group) => group.heading === "Prepaids");
  assert.deepEqual(prepaidsGroup(withoutEscrows), prepaidsGroup(withEscrows));
  assert.equal(
    withoutEscrows.prepaids.groups?.some(
      (group) => group.heading === "Initial Escrow Payment at Closing",
    ),
    false,
  );
  const currencyDifference = (withValue: number, withoutValue: number) =>
    Math.round((withValue - withoutValue) * 100) / 100;
  assert.equal(
    currencyDifference(withEscrows.prepaids.subtotal, withoutEscrows.prepaids.subtotal),
    reserveTotal,
  );
  assert.equal(
    currencyDifference(withEscrows.totalClosingCosts, withoutEscrows.totalClosingCosts),
    reserveTotal,
  );
  assert.equal(
    currencyDifference(
      withEscrows.fundsToClose.fundsFromBorrower,
      withoutEscrows.fundsToClose.fundsFromBorrower,
    ),
    reserveTotal,
  );
});

test("FHA always includes escrow reserves even when the toggle preference is off", () => {
  const fha = buildFeeWorksheet(inputs({ loanType: "fha", escrowsEnabled: false }));
  const escrowGroup = fha.prepaids.groups?.find(
    (group) => group.heading === "Initial Escrow Payment at Closing",
  );
  assert.ok(escrowGroup, "FHA must always include the initial escrow group");
  assert.equal(escrowGroup.lines.length, 2);
  assert.equal(
    escrowGroup.lines.some((line) => line.label === "Hazard Insurance Reserve"),
    true,
  );
  assert.equal(
    escrowGroup.lines.some((line) => line.label === "Property Taxes Reserve"),
    true,
  );
});

// ── 5. DSCR origination ─────────────────────────────────────────────

test("DSCR 1% origination: in lender fees AND in prepaid finance charges (raises APR)", () => {
  const orig = 3_201; // 1% of loan
  const withOrig = buildFeeWorksheet(inputs({
    loanType: "dscr", monthlyMI: 0, dscrOriginationAmount: orig,
  }));
  const without = buildFeeWorksheet(inputs({ loanType: "dscr", monthlyMI: 0 }));
  assert.equal(withOrig.lenderFees.lines.find(l => l.label === "Origination Charge")?.amount, orig);
  assert.equal(withOrig.lenderFees.subtotal, without.lenderFees.subtotal + orig);
  assert.equal(withOrig.prepaidFinanceCharges, Math.round((without.prepaidFinanceCharges + orig) * 100) / 100);
  assert.ok(withOrig.aprPct > without.aprPct, "origination must increase APR");
});

test("ordinary points are included exactly once in fees, cash-to-close, and APR", () => {
  const fractionalLoanAmount = 320_123.45;
  const fractionalInputs = {
    baseLoanAmount: fractionalLoanAmount,
    loanAmount: fractionalLoanAmount,
    monthlyPI: monthlyPI(fractionalLoanAmount, baseInputs.ratePct),
  };
  const pointsCost = calculateDiscountPointsCost(fractionalLoanAmount, 1);
  const without = buildFeeWorksheet(inputs(fractionalInputs));
  const withPoints = buildFeeWorksheet(inputs({
    ...fractionalInputs,
    discountPointsPct: 1,
    discountPointsCost: pointsCost,
  }));

  assert.equal(findLine(withPoints, "1.000% of Loan Amount (Points)")?.amount, pointsCost);
  assert.equal(moneyDelta(withPoints.lenderFees.subtotal, without.lenderFees.subtotal), pointsCost);
  assert.equal(moneyDelta(withPoints.totalClosingCosts, without.totalClosingCosts), pointsCost);
  assert.equal(
    moneyDelta(
      withPoints.fundsToClose.fundsFromBorrower,
      without.fundsToClose.fundsFromBorrower,
    ),
    pointsCost,
  );
  assert.equal(
    moneyDelta(
      withPoints.fundsToClose.estimatedCash,
      without.fundsToClose.estimatedCash,
    ),
    pointsCost,
  );
  assert.equal(
    moneyDelta(
      withPoints.prepaidFinanceCharges,
      without.prepaidFinanceCharges,
    ),
    pointsCost,
  );
  assert.ok(withPoints.aprPct > without.aprPct);
});

test("actual buydowns increase APR spread even when the lower rate reduces absolute APR", () => {
  const loanTypes: DiscountPointsLoanType[] = [
    "conventional",
    "jumbo",
    "fha",
    "va",
    "usda",
    "dscr",
    "bank_statement",
  ];

  for (const loanType of loanTypes) {
    const baseRate = 6.624;
    const reduction = getDiscountPointsRateReduction(1, loanType);
    const boughtRate = baseRate - reduction;
    const common = {
      loanType,
      monthlyMI: 0,
      dscrOriginationAmount: loanType === "dscr" ? 3_201 : 0,
    };
    const without = buildFeeWorksheet(inputs({
      ...common,
      ratePct: baseRate,
      monthlyPI: monthlyPI(baseInputs.loanAmount, baseRate),
    }));
    const withPoints = buildFeeWorksheet(inputs({
      ...common,
      ratePct: boughtRate,
      monthlyPI: monthlyPI(baseInputs.loanAmount, boughtRate),
      discountPointsPct: 1,
      discountPointsCost: calculateDiscountPointsCost(baseInputs.baseLoanAmount, 1),
    }));

    assert.ok(
      withPoints.aprPct - boughtRate > without.aprPct - baseRate,
      `${loanType}: points must increase APR spread above note rate`,
    );
    if (loanType === "bank_statement") {
      assert.ok(withPoints.aprPct > without.aprPct, "same-rate points must raise absolute APR");
    } else {
      assert.ok(
        withPoints.aprPct < without.aprPct,
        `${loanType}: configured rate buydown can reduce absolute APR`,
      );
    }
  }
});

// ── 6. Seller-credit capping ────────────────────────────────────────

test("seller credits are capped at the worksheet's eligible closing costs", () => {
  const ws = buildFeeWorksheet(inputs({ sellerCredits: 1_000_000 }));
  const eligible = Math.round(
    (ws.lenderFees.subtotal + ws.thirdPartyFees.subtotal + ws.govFees.subtotal + ws.prepaids.subtotal + ws.otherFees.subtotal) * 100,
  ) / 100;
  const applied = ws.fundsToClose.credits.find(c => c.label === "Seller Credits")!.amount;
  assert.equal(applied, eligible); // capped, never the raw 1,000,000
  // Estimated cash can never go negative: down payment remains due.
  assert.equal(ws.fundsToClose.estimatedCash, baseInputs.downPaymentAmt);
});

test("seller credits below the cap pass through unchanged", () => {
  const ws = buildFeeWorksheet(inputs({ sellerCredits: 5_000 }));
  assert.equal(ws.fundsToClose.credits.find(c => c.label === "Seller Credits")!.amount, 5_000);
});

test("estimated cash is floored at zero when credits exceed borrower funds", () => {
  const ws = buildFeeWorksheet(inputs({
    downPaymentAmt: 0, sellerCredits: 1_000_000,
    dpaDownPaymentCredit: 50_000, dpaClosingCostCredit: 50_000,
  }));
  assert.equal(ws.fundsToClose.estimatedCash, 0);
});

// ── 7. solveAPR unit behavior ───────────────────────────────────────

test("solveAPR: zero prepaid charges and no MI returns ~the note rate", () => {
  // P&I computed exactly at the note rate → APR should round back to it.
  const loan = 320_100, rate = 6.624, i = rate / 100 / 12, n = 360;
  const pi = (loan * i) / (1 - Math.pow(1 + i, -n));
  const apr = solveAPR({
    loanAmount: loan, prepaidFinanceCharges: 0, monthlyPI: pi,
    monthlyMI: 0, miMonths: 0, termMonths: n, notePct: rate,
  });
  assert.ok(Math.abs(apr - rate) < 0.002, `APR ${apr} should equal note rate ${rate}`);
});

test("solveAPR: degenerate inputs fall back to the note rate", () => {
  assert.equal(solveAPR({ loanAmount: 0, prepaidFinanceCharges: 0, monthlyPI: 0, monthlyMI: 0, miMonths: 0, termMonths: 360, notePct: 7 }), 7);
  assert.equal(solveAPR({ loanAmount: 1000, prepaidFinanceCharges: 2000, monthlyPI: 10, monthlyMI: 0, miMonths: 0, termMonths: 360, notePct: 7 }), 7);
});

test("solveAPR: more prepaid charges → strictly higher APR", () => {
  const opts = {
    loanAmount: 320_100, monthlyPI: 2049.42, monthlyMI: 0, miMonths: 0,
    termMonths: 360, notePct: 6.624,
  };
  const a = solveAPR({ ...opts, prepaidFinanceCharges: 2_000 });
  const b = solveAPR({ ...opts, prepaidFinanceCharges: 6_000 });
  assert.ok(b > a, `APR must rise with prepaid charges (${a} vs ${b})`);
});

// helper for credit lookups
function findCredit(ws: FeeWorksheet, label: string): number | undefined {
  return ws.fundsToClose.credits.find(c => c.label === label)?.amount;
}
