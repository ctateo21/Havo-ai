export type QuoteRushPolicyType = "HO3" | "HO6" | "DP3";
export type QuoteRushResidenceUse = "primary" | "secondary" | "investment";
export type QuoteRushRentalTerm = "annual" | "monthly" | "weekly";

export const QUOTERUSH_MONTHS_OCCUPIED = "9 months or more";

export interface QuoteRushPropertyDefaultInput {
  policyType: QuoteRushPolicyType;
  rebuildCost: number;
  newPurchase: boolean;
  /** Legacy name retained for callers that have not moved to usageType. */
  ho6ResidenceUse?: QuoteRushResidenceUse | "";
  ho6RentalTerm?: QuoteRushRentalTerm | "";
  usageType?: QuoteRushResidenceUse | "";
  rentalTerm?: QuoteRushRentalTerm | "";
  purchasePrice?: number | null;
  purchasePriceSource?: QuoteRushPurchasePrice["source"];
  purchaseDate?: string | null;
  purchaseDateSource?: QuoteRushPurchaseDate["source"];
  policyEffectiveDate?: string;
  policyEffectiveDateSource?: Exclude<QuoteRushPolicyEffectiveDate["source"], "30-day-default">;
}

export interface QuoteRushPurchasePrice {
  value: number | null;
  source: "user-confirmed-contract" | "user-confirmed-property-value" |
    "havo-purchase-scenario" | "listing" | "prior-sale" | "property-value" |
    "unknown";
  isAssumption: boolean;
}
export interface QuoteRushPolicyEffectiveDate {
  value: string;
  source: "closing-date" | "user-requested" | "current-policy-expiration" | "30-day-default" | "14-day-default";
  isAssumption: boolean;
}
export interface QuoteRushPurchaseDate {
  value: string | null;
  source: "user-confirmed" | "purchase-scenario" | "prior-sale" | "unknown" | "14-day-default";
}
export interface QuoteRushPropertyDefaults {
  usageType: "Primary" | "Secondary" | "Investment";
  rentalTerm: "" | "Annual" | "Monthly" | "Weekly";
  monthsOccupied: typeof QUOTERUSH_MONTHS_OCCUPIED;
  newPurchase: "Yes" | "No";
  purchaseDate: QuoteRushPurchaseDate;
  purchasePrice: QuoteRushPurchasePrice;
  policyEffectiveDate: QuoteRushPolicyEffectiveDate;
}

export function isValidQuoteRushDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function formatQuoteRushDate(value: string): string {
  if (!isValidQuoteRushDate(value)) {
    throw new Error("A valid purchase or closing date is required.");
  }
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}

function thirtyDaysFromToday(): string {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
}

export function resolveQuoteRushPropertyDefaults(
  input: QuoteRushPropertyDefaultInput,
): QuoteRushPropertyDefaults {
  if (!Number.isFinite(input.rebuildCost) || input.rebuildCost <= 0) {
    throw new Error("A valid rebuild cost is required.");
  }

  let usageType: QuoteRushPropertyDefaults["usageType"];
  let rentalTerm: QuoteRushPropertyDefaults["rentalTerm"] = "";
  const requestedUsage = input.usageType ?? input.ho6ResidenceUse;
  const requestedRentalTerm = input.rentalTerm ?? input.ho6RentalTerm;

  if (input.policyType === "HO3") {
    if (!requestedUsage) {
      throw new Error("Select how the HO3 residence will be used.");
    }
    if (requestedUsage === "investment") {
      throw new Error("HO3 is only available for a primary or secondary residence.");
    }
    usageType = requestedUsage === "secondary" ? "Secondary" : "Primary";
  } else if (input.policyType === "DP3") {
    usageType = "Investment";
    if (!requestedRentalTerm) {
      throw new Error("Select the rental term for the DP3 investment property.");
    }
    const rentalMap: Record<
      QuoteRushRentalTerm,
      Exclude<QuoteRushPropertyDefaults["rentalTerm"], "">
    > = { annual: "Annual", monthly: "Monthly", weekly: "Weekly" };
    rentalTerm = rentalMap[requestedRentalTerm];
  } else {
    const usageMap: Record<QuoteRushResidenceUse, QuoteRushPropertyDefaults["usageType"]> = {
      primary: "Primary",
      secondary: "Secondary",
      investment: "Investment",
    };
    if (!requestedUsage) {
      throw new Error("Select how the HO6 residence will be used.");
    }
    usageType = usageMap[requestedUsage];
    if (requestedUsage === "investment") {
      const rentalMap: Record<QuoteRushRentalTerm, Exclude<QuoteRushPropertyDefaults["rentalTerm"], "">> = {
        annual: "Annual",
        monthly: "Monthly",
        weekly: "Weekly",
      };
      if (!requestedRentalTerm) {
        throw new Error("Select the rental term for the HO6 investment property.");
      }
      rentalTerm = rentalMap[requestedRentalTerm];
    }
  }
  const priceValue = Number.isFinite(input.purchasePrice) && Number(input.purchasePrice) > 0
    ? Math.round(Number(input.purchasePrice)) : null;
  const purchasePrice: QuoteRushPurchasePrice = {
    value: priceValue,
    source: priceValue ? (input.purchasePriceSource ?? "unknown") : "unknown",
    // Confirmed/manual transaction values, exact listings, and prior sales are
    // facts. Current/market-value fallbacks (and the coarse legacy Havo source)
    // remain explicit assumptions.
    isAssumption: priceValue !== null && (
      input.purchasePriceSource === "property-value" ||
      input.purchasePriceSource === "havo-purchase-scenario" ||
      input.purchasePriceSource === undefined
    ),
  };
  const suppliedDate = input.policyEffectiveDate ?? "";
  const hasSuppliedDate = isValidQuoteRushDate(suppliedDate);
  const effectiveIso = hasSuppliedDate ? suppliedDate : thirtyDaysFromToday();
  const policyEffectiveDate: QuoteRushPolicyEffectiveDate = {
    value: formatQuoteRushDate(effectiveIso),
    source: hasSuppliedDate
      ? (input.policyEffectiveDateSource ?? (input.newPurchase ? "closing-date" : "user-requested"))
      : "30-day-default",
    isAssumption: !hasSuppliedDate || input.policyEffectiveDateSource === "14-day-default",
  };
  const suppliedPurchaseDate = input.purchaseDate ?? "";
  const hasPurchaseDate = isValidQuoteRushDate(suppliedPurchaseDate);
  const purchaseDate: QuoteRushPurchaseDate = {
    value: hasPurchaseDate ? formatQuoteRushDate(suppliedPurchaseDate) : null,
    source: hasPurchaseDate
      ? (input.purchaseDateSource ?? "user-confirmed")
      : "unknown",
  };

  return {
    usageType,
    rentalTerm,
    monthsOccupied: QUOTERUSH_MONTHS_OCCUPIED,
    newPurchase: input.newPurchase ? "Yes" : "No",
    // PurchaseDate is transaction history only. It never inherits a rewrite
    // effective date or a current-policy expiration.
    purchaseDate,
    purchasePrice,
    policyEffectiveDate,
  };
}