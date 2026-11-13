export function calculateMonthlyPayment(principal: number, annualRate: number, termYears: number): number {
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = termYears * 12;
  if (monthlyRate === 0) return principal / numPayments;
  return (principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);
}

export function calculateTotalInterest(principal: number, annualRate: number, termYears: number): number {
  const mp = calculateMonthlyPayment(principal, annualRate, termYears);
  return mp * termYears * 12 - principal;
}

export interface RefinanceInput {
  appraisedValue: number;
  loanBalance: number;
  currentInterestRate: number;
  newInterestRate: number;
  currentTermRemainingYears: number;
  newLoanTermYears: number;
  closingCostsPercent: number;
  closingCostsFixed: number;
  includeClosingCostsInLoan: boolean;
  refinanceType: "rate_and_term" | "cash_out";
  cashOutAmount?: number;
}

export interface RefinanceResult {
  matchedTermPayment:number;
  matchedTermSavings:number;
  matchedTermYears:number;
  newLoanAmount: number;
  totalClosingCosts: number;
  monthlyPaymentCurrent: number;
  monthlyPaymentNew: number;
  monthlySavings: number;
  totalInterestCurrent: number;
  totalInterestNew: number;
  totalSavings: number;
  breakEvenMonths: number;
  ltvRatio: number;
  cashOutAvailable: number;
  cashOutExceedsMax: boolean;
}

export function calculateRefinance(input: RefinanceInput): RefinanceResult {
  const { appraisedValue, loanBalance, currentInterestRate, newInterestRate, currentTermRemainingYears, newLoanTermYears, closingCostsPercent, closingCostsFixed, includeClosingCostsInLoan, refinanceType, cashOutAmount = 0 } = input;

  const percentCosts = (loanBalance * closingCostsPercent) / 100;
  const totalClosingCosts = percentCosts + closingCostsFixed;
  const maxLtv = 0.80;
  const cashOutAvailable = Math.max(0, appraisedValue * maxLtv - loanBalance - totalClosingCosts);
  const cashOut = refinanceType === "cash_out" ? cashOutAmount : 0;
  const cashOutExceedsMax = refinanceType === "cash_out" && cashOut > cashOutAvailable;

  let newLoanAmount = loanBalance + cashOut;
  if (includeClosingCostsInLoan) newLoanAmount += totalClosingCosts;

  const monthlyPaymentCurrent = calculateMonthlyPayment(loanBalance, currentInterestRate, currentTermRemainingYears);
  const monthlyPaymentNew = calculateMonthlyPayment(newLoanAmount, newInterestRate, newLoanTermYears);
  const monthlySavings = monthlyPaymentCurrent - monthlyPaymentNew;
  const totalInterestCurrent = calculateTotalInterest(loanBalance, currentInterestRate, currentTermRemainingYears);
  const totalInterestNew = calculateTotalInterest(newLoanAmount, newInterestRate, newLoanTermYears);
  const totalSavings = totalInterestCurrent - totalInterestNew - totalClosingCosts;
  const breakEvenMonths = monthlySavings > 0 ? Math.ceil(totalClosingCosts / monthlySavings) : 0;
  const ltvRatio = (newLoanAmount / appraisedValue) * 100;

  const matchedTermPayment=calculateMonthlyPayment(newLoanAmount,newInterestRate,currentTermRemainingYears);
  return {matchedTermPayment,matchedTermSavings:monthlyPaymentCurrent-matchedTermPayment,matchedTermYears:currentTermRemainingYears, newLoanAmount, totalClosingCosts, monthlyPaymentCurrent, monthlyPaymentNew, monthlySavings, totalInterestCurrent, totalInterestNew, totalSavings, breakEvenMonths, ltvRatio, cashOutAvailable, cashOutExceedsMax };
}

export function amortizeBalance(balance: number, annualRatePct: number, monthlyPI: number, months: number): number {
  if (months <= 0 || balance <= 0) return balance;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return Math.max(0, balance - monthlyPI * months);
  const factor = Math.pow(1 + r, months);
  return Math.max(0, balance * factor - monthlyPI * ((factor - 1) / r));
}

export function monthsBetween(fromISO: string, toDate: Date = new Date()): number {
  const from = new Date(fromISO);
  return Math.max(0, Math.floor((toDate.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * (365.25 / 12))));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

export function formatCurrencyWithCents(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}
