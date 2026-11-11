export type AffordabilityProgram = "conventional" | "fha" | "va";

export interface AffordabilityAssumptions {
  downPaymentPercent: number;
  annualInterestRatePercent: number;
  termYears: number;
  annualPropertyTaxPercent: number;
  monthlyHomeownersInsurance: number;
  annualPmiPercentOfLoan: number;
  monthlyHoaAndFlood: number;
  /** Financed insurance premium applied to the base loan for principal and interest. */
  financedUpfrontMortgageInsurancePercent?: number;
}

export const DEFAULT_AFFORDABILITY_ASSUMPTIONS: AffordabilityAssumptions = {
  downPaymentPercent: 5,
  annualInterestRatePercent: 6.9,
  termYears: 30,
  annualPropertyTaxPercent: 1.5,
  monthlyHomeownersInsurance: 200,
  annualPmiPercentOfLoan: 0.5,
  monthlyHoaAndFlood: 0,
};

export const FHA_AFFORDABILITY_ASSUMPTIONS: AffordabilityAssumptions = {
  ...DEFAULT_AFFORDABILITY_ASSUMPTIONS,
  downPaymentPercent: 3.5,
  annualInterestRatePercent: 6.6,
  annualPmiPercentOfLoan: 0.55,
  financedUpfrontMortgageInsurancePercent: 1.75,
};

export const VA_AFFORDABILITY_ASSUMPTIONS: AffordabilityAssumptions = {
  ...DEFAULT_AFFORDABILITY_ASSUMPTIONS,
  downPaymentPercent: 0,
  annualInterestRatePercent: 6.68,
  annualPmiPercentOfLoan: 0,
};

export const AFFORDABILITY_ASSUMPTIONS_BY_PROGRAM: Record<
  AffordabilityProgram,
  AffordabilityAssumptions
> = {
  conventional: DEFAULT_AFFORDABILITY_ASSUMPTIONS,
  fha: FHA_AFFORDABILITY_ASSUMPTIONS,
  va: VA_AFFORDABILITY_ASSUMPTIONS,
};

export interface AffordabilityEstimate {
  monthlyHousingBudgetLow: number;
  monthlyHousingBudgetHigh: number;
  purchasePriceLow: number;
  purchasePriceHigh: number;
  /** Context only for VA; it is not used as an underwriting limit. */
  actualTotalDtiLow?: number;
  actualTotalDtiHigh?: number;
}

export interface BuyerAffordabilityOptions {
  program?: AffordabilityProgram;
  monthlyHousingBudgetLow?: number;
  monthlyHousingBudgetHigh?: number;
}

/** Monthly principal and interest per dollar borrowed. */
export function monthlyAmortizationFactor(
  annualInterestRatePercent: number,
  termYears: number,
): number {
  if (!Number.isFinite(annualInterestRatePercent) || annualInterestRatePercent < 0) return 0;
  if (!Number.isFinite(termYears) || termYears <= 0) return 0;
  const payments = termYears * 12;
  const monthlyRate = annualInterestRatePercent / 100 / 12;
  if (monthlyRate === 0) return 1 / payments;
  const growth = (1 + monthlyRate) ** payments;
  return (monthlyRate * growth) / (growth - 1);
}

export function purchasePriceFromHousingBudget(
  monthlyBudget: number,
  assumptions: AffordabilityAssumptions = DEFAULT_AFFORDABILITY_ASSUMPTIONS,
): number {
  if (!Number.isFinite(monthlyBudget) || monthlyBudget <= 0) return 0;

  const downPaymentFraction = assumptions.downPaymentPercent / 100;
  const baseLoanFraction = 1 - downPaymentFraction;
  const financedLoanFraction =
    baseLoanFraction *
    (1 + (assumptions.financedUpfrontMortgageInsurancePercent ?? 0) / 100);
  const fixedMonthlyCosts =
    assumptions.monthlyHomeownersInsurance + assumptions.monthlyHoaAndFlood;
  if (monthlyBudget <= fixedMonthlyCosts) return 0;

  const principalAndInterest =
    financedLoanFraction *
    monthlyAmortizationFactor(
      assumptions.annualInterestRatePercent,
      assumptions.termYears,
    );
  const taxes = assumptions.annualPropertyTaxPercent / 100 / 12;
  // FHA annual MIP and conventional PMI are based on the base loan, not financed UFMIP.
  const mortgageInsurance =
    assumptions.downPaymentPercent < 20
      ? baseLoanFraction * assumptions.annualPmiPercentOfLoan / 100 / 12
      : 0;
  const monthlyCostPerDollar = principalAndInterest + taxes + mortgageInsurance;
  if (!Number.isFinite(monthlyCostPerDollar) || monthlyCostPerDollar <= 0) return 0;

  return Math.max(0, (monthlyBudget - fixedMonthlyCosts) / monthlyCostPerDollar);
}

function floorToFiveThousand(value: number): number {
  return Math.max(0, Math.floor(value / 5_000) * 5_000);
}

/**
 * Calculates a planning estimate. Existing callers default to Conventional.
 * VA requires explicitly entered housing-budget bounds and never derives a cap from income.
 */
export function calculateBuyerAffordability(
  grossMonthlyIncome: number,
  monthlyNonhousingDebt = 0,
  assumptions?: AffordabilityAssumptions,
  programOrOptions: AffordabilityProgram | BuyerAffordabilityOptions = "conventional",
): AffordabilityEstimate | null {
  const options =
    typeof programOrOptions === "string"
      ? { program: programOrOptions }
      : programOrOptions;
  const program = options.program ?? "conventional";
  const effectiveAssumptions =
    assumptions ?? AFFORDABILITY_ASSUMPTIONS_BY_PROGRAM[program];

  if (!Number.isFinite(monthlyNonhousingDebt) || monthlyNonhousingDebt < 0) return null;

  let monthlyHousingBudgetLow: number;
  let monthlyHousingBudgetHigh: number;
  if (program === "va") {
    const low = options.monthlyHousingBudgetLow;
    const high = options.monthlyHousingBudgetHigh;
    if (
      low == null ||
      high == null ||
      !Number.isFinite(low) ||
      !Number.isFinite(high) ||
      low < 0 ||
      high < 0 ||
      low > high
    ) {
      return null;
    }
    monthlyHousingBudgetLow = low;
    monthlyHousingBudgetHigh = high;
  } else {
    if (!Number.isFinite(grossMonthlyIncome) || grossMonthlyIncome <= 0) return null;
    const [lowDti, highDti] = program === "fha" ? [0.45, 0.55] : [0.43, 0.49];
    monthlyHousingBudgetLow = Math.max(
      0,
      grossMonthlyIncome * lowDti - monthlyNonhousingDebt,
    );
    monthlyHousingBudgetHigh = Math.max(
      0,
      grossMonthlyIncome * highDti - monthlyNonhousingDebt,
    );
  }

  const estimate: AffordabilityEstimate = {
    monthlyHousingBudgetLow,
    monthlyHousingBudgetHigh,
    purchasePriceLow: floorToFiveThousand(
      purchasePriceFromHousingBudget(monthlyHousingBudgetLow, effectiveAssumptions),
    ),
    purchasePriceHigh: floorToFiveThousand(
      purchasePriceFromHousingBudget(monthlyHousingBudgetHigh, effectiveAssumptions),
    ),
  };
  if (program === "va" && Number.isFinite(grossMonthlyIncome) && grossMonthlyIncome > 0) {
    estimate.actualTotalDtiLow =
      (monthlyHousingBudgetLow + monthlyNonhousingDebt) / grossMonthlyIncome;
    estimate.actualTotalDtiHigh =
      (monthlyHousingBudgetHigh + monthlyNonhousingDebt) / grossMonthlyIncome;
  }
  return estimate;
}