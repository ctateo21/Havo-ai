// ─── Initial Fees Worksheet + APR model ────────────────────────────
//
// Produces an itemized fee worksheet modeled on a lender "Initial Fees
// Worksheet / Loan Estimate" (Barrett Financial format) and computes an
// estimated APR from the fees that count as prepaid finance charges
// under TILA plus the monthly mortgage-insurance stream.
//
// All figures are ESTIMATES for illustration — the UI must always carry
// the "get an official Loan Estimate" disclaimer.

export interface FeeLine {
  label: string;
  amount: number;
  /** e.g. "12 Months @ $247.18" */
  note?: string;
}

export interface FeeSection {
  title: string;
  subtotal: number;
  lines: FeeLine[];
  /** optional sub-groupings rendered with a small heading */
  groups?: { heading: string; lines: FeeLine[] }[];
}

export interface FeeWorksheetInputs {
  purchasePrice: number;
  /** loan before financed UFMIP / VA funding fee */
  baseLoanAmount: number;
  /** total financed loan amount */
  loanAmount: number;
  /** final note rate in percent, e.g. 6.624 */
  ratePct: number;
  termMonths?: number; // default 360
  loanType: "conventional" | "fha" | "va" | "usda" | "dscr" | string;
  monthlyPI: number;
  monthlyTax: number;
  monthlyHOIns: number;
  monthlyFlood: number;
  monthlyMI: number;
  hoaMonthly: number;
  monthlyCDD: number;
  downPaymentAmt: number;
  /** discount-point buydown cost (cash) */
  discountPointsCost: number;
  discountPointsPct: number;
  /** DSCR 1% origination charge */
  dscrOriginationAmount: number;
  /**
   * DPA 5% silent-second program points charged by the first-mortgage
   * lender (cash and first-lien prepaid finance charge).
   */
  dpaExtraPointsCost: number;
  /** DPA amortizing 2nd-lien monthly payment (0 when none/silent) */
  dpaSecondMonthly?: number;
  /** seller concessions the user selected (uncapped — capped here
   *  against this worksheet's own eligible closing costs) */
  sellerCredits: number;
  /** DPA credits applied toward down payment / closing costs */
  dpaDownPaymentCredit: number;
  dpaClosingCostCredit: number;
  creditScore?: number;
  occupancy?: string;
  /** Purchase-only gate supplied by the purchase flow. */
  requiresElevationCertificate?: boolean;
  /** Defaults to true. When false, prepaids remain but escrow reserves are omitted. */
  escrowsEnabled?: boolean;
}

export interface FeeWorksheet {
  lenderFees: FeeSection;
  thirdPartyFees: FeeSection;
  govFees: FeeSection;
  prepaids: FeeSection;
  otherFees: FeeSection;
  monthlyHousing: FeeSection;
  totalMonthly: number;
  fundsToClose: {
    lines: FeeLine[];
    fundsFromBorrower: number; // (A)
    credits: FeeLine[];
    totalCredits: number; // (B)
    estimatedCash: number; // A - B
  };
  totalClosingCosts: number;
  aprPct: number;
  prepaidFinanceCharges: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// FL promulgated owner's title insurance rate (per $1,000):
// $5.75 first $100k, $5.00 from $100k–$1M.
function flTitlePremium(amount: number): number {
  if (amount <= 0) return 0;
  const first = Math.min(amount, 100_000);
  const rest = Math.max(0, Math.min(amount, 1_000_000) - 100_000);
  return r2((first / 1000) * 5.75 + (rest / 1000) * 5.0);
}

/**
 * Solve for APR: find the annual rate that discounts the actual payment
 * stream (P&I + monthly MI while it lasts) back to the amount financed
 * (loan amount − prepaid finance charges). Bisection: robust, fast enough.
 */
export function solveAPR(opts: {
  loanAmount: number;
  prepaidFinanceCharges: number;
  monthlyPI: number;
  monthlyMI: number;
  miMonths: number;
  termMonths: number;
  notePct: number;
}): number {
  const { loanAmount, prepaidFinanceCharges, monthlyPI, monthlyMI, miMonths, termMonths, notePct } = opts;
  const amountFinanced = loanAmount - prepaidFinanceCharges;
  if (amountFinanced <= 0 || monthlyPI <= 0) return notePct;
  const pv = (annualPct: number) => {
    const i = annualPct / 100 / 12;
    if (i === 0) return monthlyPI * termMonths + monthlyMI * miMonths;
    // PV of P&I annuity over full term
    const a = (1 - Math.pow(1 + i, -termMonths)) / i;
    // PV of MI annuity over miMonths
    const b = miMonths > 0 ? (1 - Math.pow(1 + i, -miMonths)) / i : 0;
    return monthlyPI * a + monthlyMI * b;
  };
  let lo = notePct; // APR is never below the note rate here
  let hi = notePct + 5;
  // Expand upper bound if needed
  while (pv(hi) > amountFinanced && hi < notePct + 20) hi += 5;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > amountFinanced) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 1000) / 1000;
}

export function buildFeeWorksheet(inp: FeeWorksheetInputs): FeeWorksheet {
  const term = inp.termMonths ?? 360;
  const {
    purchasePrice, baseLoanAmount, loanAmount, ratePct, loanType,
  } = inp;

  // ── Lender fees ──────────────────────────────────────────────────
  const underwritingFee = 1250;
  // Keep the user-selected discount-point buydown and the DPA 5%
  // silent-second program-points charge as SEPARATE line items so the
  // percentage label always matches its amount. The latter is not a
  // rate-buydown charge.
  const pointsAmt = r2(inp.discountPointsCost);
  const dpaPointsAmt = r2(inp.dpaExtraPointsCost);
  const originationAmt = r2(inp.dscrOriginationAmount);
  const lenderLines: FeeLine[] = [
    {
      label: `${(inp.discountPointsPct ?? 0).toFixed(3)}% of Loan Amount (Points)`,
      amount: pointsAmt,
    },
    ...(dpaPointsAmt > 0
      ? [{ label: "2.000% DPA Program Points (5% silent 2nd)", amount: dpaPointsAmt }]
      : []),
    { label: "Origination Charge", amount: originationAmt },
    { label: "Underwriting Fee", amount: underwritingFee },
  ];
  const lenderFees: FeeSection = {
    title: "Lender Fees",
    lines: lenderLines,
    subtotal: r2(pointsAmt + dpaPointsAmt + originationAmt + underwritingFee),
  };

  // ── Third-party fees ─────────────────────────────────────────────
  const cannotShop: FeeLine[] = [
    { label: "Appraisal Fee", amount: 595 },
    { label: "Credit Report Fee", amount: 75 },
    { label: "Flood Certificate Fee", amount: 8 },
    { label: "MERS Registration Fee", amount: 24.95 },
    { label: "Tax Service Fee", amount: 85 },
  ];
  // FL simultaneous-issue: owner's policy at promulgated rate on the
  // purchase price; lender's policy issued simultaneously for a nominal
  // amount when owner's covers the loan. Which party pays varies by
  // county — shown here as buyer-side estimates.
  const lendersTitle = flTitlePremium(loanAmount);
  const canShop: FeeLine[] = [
    { label: "Title - Abstract or Title Search", amount: 95 },
    { label: "Title - Insurance Binder", amount: 700 },
    { label: "Title - Lender's Endorsement Fee", amount: r2(lendersTitle * 0.15) },
    { label: "Title - Lender's Title Insurance", amount: lendersTitle },
    { label: "Title - Municipal Lien Search Fee", amount: 120 },
    { label: "Title - Settlement or Closing Fee", amount: 450 },
    { label: "Title - Title Examination", amount: 100 },
  ];
  const thirdPartySubtotal = r2(
    [...cannotShop, ...canShop].reduce((s, l) => s + l.amount, 0),
  );
  const thirdPartyFees: FeeSection = {
    title: "Third Party Fees",
    lines: [],
    groups: [
      { heading: "Services You Cannot Shop For", lines: cannotShop },
      { heading: "Services You Can Shop For", lines: canShop },
    ],
    subtotal: thirdPartySubtotal,
  };

  // ── Taxes & other government fees (Florida statutory) ────────────
  // Doc stamps on the mortgage: $0.35 per $100 (rounded up per $100).
  const docStampsMtg = r2(Math.ceil(loanAmount / 100) * 0.35);
  // Intangible tax on the mortgage: 0.2% of the loan amount.
  const intangibleTax = r2(loanAmount * 0.002);
  const govLines: FeeLine[] = [
    { label: "Recording Fees - Deed", amount: 35.5 },
    { label: "Recording Fees - Mortgage", amount: 265 },
    { label: "State Tax/Stamps - Mortgage (Doc Stamps)", amount: docStampsMtg },
    { label: "Intangible Tax - Mortgage", amount: intangibleTax },
  ];
  const govFees: FeeSection = {
    title: "Taxes and Other Government Fees",
    lines: govLines,
    subtotal: r2(govLines.reduce((s, l) => s + l.amount, 0)),
  };

  // ── Prepaids & initial escrow ────────────────────────────────────
  const dailyInterest = r2((loanAmount * (ratePct / 100)) / 365);
  const prepaidInterestDays = 15; // mid-month closing assumption
  const prepaidInterest = r2(dailyInterest * prepaidInterestDays);
  const hazardAnnual = r2(inp.monthlyHOIns * 12);
  const floodAnnual = r2(inp.monthlyFlood * 12);
  const prepaidLines: FeeLine[] = [
    {
      label: "Hazard Insurance Premium",
      note: `12 Months @ ${money(inp.monthlyHOIns)}`,
      amount: hazardAnnual,
    },
    ...(floodAnnual > 0
      ? [{
          label: "Flood Insurance Premium",
          note: `12 Months @ ${money(inp.monthlyFlood)}`,
          amount: floodAnnual,
        }]
      : []),
    {
      label: "Prepaid Interest",
      note: `${prepaidInterestDays} Days @ ${money(dailyInterest)}`,
      amount: prepaidInterest,
    },
    {
      label: "Property Taxes",
      note: `3 Months @ ${money(inp.monthlyTax)}`,
      amount: r2(inp.monthlyTax * 3),
    },
  ];
  // FHA requires an escrow account. Enforce this in the calculation as
  // well as the UI so a stale/off client preference can never remove it.
  const escrowsEnabled = loanType === "fha" || inp.escrowsEnabled !== false;
  const escrowLines: FeeLine[] = escrowsEnabled
    ? [
        {
          label: "Hazard Insurance Reserve",
          note: `3 Months @ ${money(inp.monthlyHOIns)}`,
          amount: r2(inp.monthlyHOIns * 3),
        },
        {
          label: "Property Taxes Reserve",
          note: `3 Months @ ${money(inp.monthlyTax)}`,
          amount: r2(inp.monthlyTax * 3),
        },
      ]
    : [];
  const prepaidsSubtotal = r2(
    [...prepaidLines, ...escrowLines].reduce((s, l) => s + l.amount, 0),
  );
  const prepaids: FeeSection = {
    title: "Prepaids and Initial Escrow Payment at Closing",
    lines: [],
    groups: [
      { heading: "Prepaids", lines: prepaidLines },
      ...(escrowsEnabled
        ? [{ heading: "Initial Escrow Payment at Closing", lines: escrowLines }]
        : []),
    ],
    subtotal: prepaidsSubtotal,
  };

  // ── Section H / Other ────────────────────────────────────────────
  // These are purchase-transaction estimates, not prepaid finance
  // charges. The elevation certificate is needed only when the purchase
  // flow confirms both a detached single-family home and a FEMA flood
  // zone that requires flood insurance.
  const otherLines: FeeLine[] = [
    { label: "Transaction Fee", amount: 995 },
    { label: "Survey", amount: 495 },
    ...(inp.requiresElevationCertificate
      ? [{ label: "Elevation Certificate", amount: 795 }]
      : []),
    { label: "Home Inspection", amount: 600 },
  ];
  const otherFees: FeeSection = {
    title: "Section H — Other",
    lines: otherLines,
    subtotal: r2(otherLines.reduce((sum, line) => sum + line.amount, 0)),
  };

  // ── Monthly housing expense ──────────────────────────────────────
  const dpaSecondMonthly = inp.dpaSecondMonthly ?? 0;
  const monthlyLines: FeeLine[] = [
    { label: "First Mortgage P&I", amount: r2(inp.monthlyPI) },
    ...(dpaSecondMonthly > 0
      ? [{ label: "Other Financing P&I (DPA 2nd)", amount: r2(dpaSecondMonthly) }]
      : []),
    { label: "Homeowner's Insurance", amount: r2(inp.monthlyHOIns) },
    ...(inp.monthlyFlood > 0 ? [{ label: "Flood Insurance", amount: r2(inp.monthlyFlood) }] : []),
    { label: "Property Taxes", amount: r2(inp.monthlyTax) },
    ...(inp.monthlyMI > 0 ? [{ label: "Mortgage Insurance", amount: r2(inp.monthlyMI) }] : []),
    ...(inp.hoaMonthly > 0 ? [{ label: "HOA Dues", amount: r2(inp.hoaMonthly) }] : []),
    ...(inp.monthlyCDD > 0 ? [{ label: "CDD Assessment", amount: r2(inp.monthlyCDD) }] : []),
  ];
  const totalMonthly = r2(monthlyLines.reduce((s, l) => s + l.amount, 0));
  const monthlyHousing: FeeSection = {
    title: "Estimated Proposed Monthly Housing Expense",
    lines: monthlyLines,
    subtotal: totalMonthly,
  };

  // ── Funds to close ───────────────────────────────────────────────
  const fundsLines: FeeLine[] = [
    { label: "Downpayment/Funds from Borrower", amount: r2(inp.downPaymentAmt) },
    { label: "Lender Fees", amount: lenderFees.subtotal },
    { label: "Third Party Fees", amount: thirdPartyFees.subtotal },
    { label: "Taxes and Other Government Fees", amount: govFees.subtotal },
    { label: "Prepaids and Initial Escrow", amount: prepaidsSubtotal },
    { label: "Section H — Other", amount: otherFees.subtotal },
  ];
  const fundsFromBorrower = r2(fundsLines.reduce((s, l) => s + l.amount, 0));
  // Cap seller concessions against THIS worksheet's eligible closing
  // costs (fees + prepaids/escrow) so credits can never exceed what
  // they may legally cover here — mirrors the page-level cap, but
  // against the itemized basis so A−B stays internally consistent.
  const worksheetEligibleCosts = r2(
    lenderFees.subtotal + thirdPartySubtotal +
    govLines.reduce((s, l) => s + l.amount, 0) +
    prepaidsSubtotal + otherFees.subtotal,
  );
  const sellerCreditsApplied = r2(Math.min(inp.sellerCredits, worksheetEligibleCosts));
  const credits: FeeLine[] = [
    { label: "Seller Credits", amount: sellerCreditsApplied },
    ...(inp.dpaDownPaymentCredit > 0
      ? [{ label: "DPA Down Payment Assistance", amount: r2(inp.dpaDownPaymentCredit) }]
      : []),
    ...(inp.dpaClosingCostCredit > 0
      ? [{ label: "DPA Closing Cost Credit", amount: r2(inp.dpaClosingCostCredit) }]
      : []),
  ];
  const totalCredits = r2(credits.reduce((s, l) => s + l.amount, 0));
  const estimatedCash = r2(Math.max(0, fundsFromBorrower - totalCredits));

  const totalClosingCosts = r2(
    lenderFees.subtotal + thirdPartyFees.subtotal + govFees.subtotal +
    prepaidsSubtotal + otherFees.subtotal,
  );

  // ── APR ──────────────────────────────────────────────────────────
  // Prepaid finance charges (TILA): first-lien points/origination,
  // underwriting, MERS, tax service, and prepaid interest. Under
  // 12 CFR 1026.4(a) and (b)(3), the DPA program points are included
  // here because the first-mortgage lender separately imposes them as
  // a condition of the first-lien credit used with the 5% silent-second
  // option. They are not also assigned to the no-payment second lien.
  // Appraisal / credit report / title / recording / transfer taxes are
  // excluded.
  const prepaidFinanceCharges = r2(
    pointsAmt + dpaPointsAmt + originationAmt + underwritingFee + 24.95 + 85 + prepaidInterest,
  );
  // Monthly-MI duration: FHA <10% down = life of loan; FHA ≥10% = 132
  // months; conventional PMI ≈ months until the balance amortizes to
  // 78% LTV; none otherwise.
  let miMonths = 0;
  if (inp.monthlyMI > 0) {
    if (loanType === "fha") {
      const ltv = baseLoanAmount / purchasePrice;
      miMonths = ltv > 0.9 ? term : 132;
    } else {
      miMonths = monthsTo78LTV(loanAmount, ratePct, term, purchasePrice);
    }
  }
  const aprPct = solveAPR({
    loanAmount,
    prepaidFinanceCharges,
    monthlyPI: inp.monthlyPI,
    monthlyMI: inp.monthlyMI,
    miMonths,
    termMonths: term,
    notePct: ratePct,
  });

  return {
    lenderFees, thirdPartyFees, govFees, prepaids, otherFees, monthlyHousing,
    totalMonthly,
    fundsToClose: { lines: fundsLines, fundsFromBorrower, credits, totalCredits, estimatedCash },
    totalClosingCosts,
    aprPct,
    prepaidFinanceCharges,
  };
}

function monthsTo78LTV(loanAmount: number, ratePct: number, term: number, price: number): number {
  const i = ratePct / 100 / 12;
  const target = price * 0.78;
  if (loanAmount <= target) return 0;
  if (i === 0) return Math.min(term, Math.ceil((loanAmount - target) / (loanAmount / term)));
  const pmt = (loanAmount * i) / (1 - Math.pow(1 + i, -term));
  let bal = loanAmount;
  for (let m = 1; m <= term; m++) {
    bal = bal * (1 + i) - pmt;
    if (bal <= target) return m;
  }
  return term;
}

export function money(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
