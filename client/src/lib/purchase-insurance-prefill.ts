import type {
  QuoteRushPurchasePrice,
  QuoteRushRentalTerm,
  QuoteRushResidenceUse,
} from "@shared/quoterush-property-defaults";

/** Purchase-page facts the inline insurance questionnaire starts from. */
export interface PurchaseQuoteContext {
  price: number;
  /** How the purchase page got its price: typed by the buyer, an exact
   * listing, or a market/default value. */
  priceSource: "user" | "listing" | "estimate";
  occupancy: "primary" | "secondary" | "investment";
  /** Whether the purchase is financed (answers "Will this home have a
   * mortgage?" when the buyer has not). */
  financed?: boolean;
  /** Expected closing date (YYYY-MM-DD) when the purchase page knows it. */
  closeDate?: string;
}

/** The quote answers that describe the transaction itself. */
export interface QuotePropertyAnswers {
  newPurchase: boolean | null;
  purchaseDate: string;
  ho6ResidenceUse: QuoteRushResidenceUse | "";
  ho6RentalTerm: QuoteRushRentalTerm | "";
  purchasePrice: number;
  purchasePriceSource: QuoteRushPurchasePrice["source"] | "";
  currentlyInsured: boolean | null;
  currentCarrier: string;
}

function priceProvenance(source: PurchaseQuoteContext["priceSource"]): QuoteRushPurchasePrice["source"] {
  if (source === "user") return "user-confirmed-contract";
  if (source === "listing") return "listing";
  return "property-value";
}

/**
 * On the purchase page the property is being bought: it is a new purchase,
 * and the price and occupancy the buyer is planning with are the quote's
 * answers. Every other answer (wind, roof, deductibles, construction, …)
 * stays exactly as saved for this address on the Insurance tab. A rental
 * term the buyer already chose is kept; it is cleared only when the
 * occupancy is no longer investment.
 */
export function applyPurchaseQuotePrefill(
  saved: QuotePropertyAnswers,
  purchase: PurchaseQuoteContext,
): QuotePropertyAnswers {
  const price = Number.isFinite(purchase.price) && purchase.price > 0 ? Math.round(purchase.price) : 0;
  return {
    ...saved,
    newPurchase: true,
    purchaseDate: purchase.closeDate || saved.purchaseDate,
    ho6ResidenceUse: purchase.occupancy,
    ho6RentalTerm: purchase.occupancy === "investment" ? saved.ho6RentalTerm : "",
    purchasePrice: price || saved.purchasePrice,
    purchasePriceSource: price ? priceProvenance(purchase.priceSource) : saved.purchasePriceSource,
    // Not asked for a new purchase.
    currentlyInsured: null,
    currentCarrier: "",
  };
}
