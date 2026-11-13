import { z } from "zod";
import {
  isValidQuoteRushDate,
  resolveQuoteRushPropertyDefaults,
  type QuoteRushPropertyDefaults,
} from "@shared/quoterush-property-defaults";

function isClaimDateWithinFiveYears(value: string): boolean {
  if (!isValidQuoteRushDate(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  const oldest = new Date(Date.UTC(
    today.getUTCFullYear() - 5,
    today.getUTCMonth(),
    today.getUTCDate(),
    0,
    0,
    0,
  ));
  const latest = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
    23,
    59,
    59,
  ));
  return date >= oldest && date <= latest;
}

const quoteRushStartSchema = z.object({
  address: z.string().min(5),
  coverageA: z.number().positive(),
  policyType: z.enum(["HO3", "HO6", "DP3"]),
  // Exact inputs from the redesigned insurance estimate. Keep the legacy
  // indices optional for other callers that have not yet collected them.
  yearBuilt: z.number().int().min(1800).max(new Date().getFullYear()+1),
  roofYear: z.number().int().min(2000).max(2027),
  openingProtection: z.boolean().optional(),
  roofShape: z.enum(["Hip", "Flat", "Gable"]).optional(),
  secondaryWaterResistance: z.enum(["Yes", "No", "Unknown"]).optional(),
  windMitigationLocks: z.object({
    openingProtection: z.boolean().optional(),
    secondaryWaterResistance: z.boolean().optional(),
  }).optional(),
  currentlyInsured: z.boolean().optional(),
  currentCarrier: z.string().trim().min(1).max(120).optional(),
  yearIdx: z.number().int().min(0).max(3).default(1),
  roofIdx: z.number().int().min(0).max(3).default(1),
  constIdx: z.number().int().min(0).max(2),
  windIdx: z.number().int().min(0).max(2),
  hurrIdx: z.number().int().min(0).max(2),
  // Optional at shared-cache lookup time. The route requires this private
  // answer only after reusable success/pending rows have been returned and
  // before any paid claim or stale-row reclaim.
  hasClaims: z.boolean(),
  claimRecords: z.array(z.object({
    lossDate: z.string().refine(isClaimDateWithinFiveYears, {
      message: "Claim loss date must be within the past five years.",
    }),
    claimDetail: z.string().trim().min(1).max(250),
    amount: z.number().positive(),
    paid: z.boolean(),
    priorResidence: z.boolean(),
  })).max(3).default([]),
  hasMortgage: z.boolean().optional(),
  aopDeductible: z.number().default(2500),
  floodZone: z.string().default(""),
  floodZoneUnknown: z.boolean().default(false),
  sqFt: z.number().positive(),
  sqFtConfirmed: z.literal(true),
  // The browser reports a lock only after a person has edited an auto-filled
  // characteristic. Absent locks preserve backward-compatible explicit input.
  propertyCharacteristicLocks: z.object({
    floodZone: z.boolean().optional(),
    yearBuilt: z.boolean().optional(),
    squareFeet: z.boolean().optional(),
    construction: z.boolean().optional(),
  }).optional(),
  newPurchase: z.boolean(),
  // The single date question is the requested effective date for a rewrite,
  // and the confirmed closing date for a new purchase. purchaseDate remains
  // accepted for older browser sessions.
  purchaseDate: z.string().refine((value) => !value || isValidQuoteRushDate(value), {
    message: "A valid policy effective or closing date is required.",
  }).optional(),
  policyEffectiveDate: z.string().refine((value) => !value || isValidQuoteRushDate(value), {
    message: "A valid policy effective or closing date is required.",
  }).optional(),
  purchasePrice: z.number().positive().optional(),
  purchasePriceSource: z.enum([
    "user-confirmed-contract", "user-confirmed-property-value",
    "havo-purchase-scenario", "listing", "prior-sale", "property-value",
  ]).optional(),
  usageType: z.enum(["primary", "secondary", "investment"]).optional(),
  rentalTerm: z.enum(["annual", "monthly", "weekly"]).optional(),
}).superRefine((value, ctx) => {
  if(!value.floodZoneUnknown && !value.floodZone.trim())ctx.addIssue({code:z.ZodIssueCode.custom,path:["floodZone"],message:"Select your flood zone or explicitly choose I don't know."});
  if(!value.purchasePriceSource)ctx.addIssue({code:z.ZodIssueCode.custom,path:["purchasePriceSource"],message:"Confirm the source of the purchase price or current value."});
  if (value.hasClaims && value.claimRecords.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["claimRecords"],
      message: "Enter between one and three claim details.",
    });
  }
  if (!value.hasClaims && value.claimRecords.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["claimRecords"],
      message: "Remove claim details or answer yes to prior claims.",
    });
  }
  if (!value.purchasePrice) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["purchasePrice"],
      message: "A real property purchase price or current value is required before requesting live quotes.",
    });
  }
  if (value.newPurchase &&
      !isValidQuoteRushDate(value.policyEffectiveDate ?? value.purchaseDate ?? "")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["policyEffectiveDate"],
      message: "A valid closing date is required for a new purchase.",
    });
  }
  if ((value.policyType === "HO3" || value.policyType === "HO6") && !value.usageType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usageType"],
      message: `Residence use is required for an ${value.policyType} policy.`,
    });
  }
  if (value.policyType === "HO3" && value.usageType === "investment") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["usageType"], message: "HO3 supports primary or secondary residence only." });
  }
  if ((value.policyType === "HO6" && value.usageType === "investment") ||
      value.policyType === "DP3") {
    if (value.rentalTerm) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rentalTerm"],
      message: `Rental term is required for a ${value.policyType} investment property.`,
    });
  }
});

export type QuoteRushStartRequest = z.infer<typeof quoteRushStartSchema>;

export function toQuoteCachePolicyEffectiveDate(
  policyEffectiveDate: QuoteRushPropertyDefaults["policyEffectiveDate"],
): Omit<QuoteRushPropertyDefaults["policyEffectiveDate"], "value"> {
  return {
    source: policyEffectiveDate.source,
    isAssumption: policyEffectiveDate.isAssumption,
  };
}

export function prepareQuoteRushStartRequest(
  body: unknown,
  resolveDefaults: typeof resolveQuoteRushPropertyDefaults = resolveQuoteRushPropertyDefaults,
  currentPolicyExpirationDate?: string | null,
): {
  request: QuoteRushStartRequest;
  propertyDefaults: QuoteRushPropertyDefaults;
} {
  const request = quoteRushStartSchema.parse(body);
  const persistedExpiration =
    !request.newPurchase &&
    currentPolicyExpirationDate &&
    isValidQuoteRushDate(currentPolicyExpirationDate)
      ? currentPolicyExpirationDate
      : undefined;
  const propertyDefaults = resolveDefaults({
    policyType: request.policyType,
    rebuildCost: request.coverageA,
    newPurchase: request.newPurchase,
    purchaseDate: request.newPurchase
      ? request.policyEffectiveDate ?? request.purchaseDate
      : undefined,
    purchaseDateSource: request.newPurchase ? "user-confirmed" : undefined,
    policyEffectiveDate:
      request.policyEffectiveDate ??
      request.purchaseDate ??
      persistedExpiration,
    policyEffectiveDateSource:
      request.policyEffectiveDate || request.purchaseDate
        ? request.newPurchase
        ? "closing-date"
          : "user-requested"
        : persistedExpiration
          ? "current-policy-expiration"
          : request.newPurchase
            ? "closing-date"
            : "user-requested",
    usageType: request.usageType,
    rentalTerm: request.rentalTerm,
    purchasePrice: request.purchasePrice,
    purchasePriceSource: request.purchasePriceSource,
  });

  return { request, propertyDefaults };
}