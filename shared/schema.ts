import { pgTable, text, serial, integer, boolean, json, jsonb, date, timestamp, varchar, unique, index, primaryKey, bigint, numeric, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Server-only aggregate accounting; migration also revokes PUBLIC access.
export const aiUsageDaily = pgTable("ai_usage_daily", {
  userId: text("user_id").notNull(),
  day: date("day").notNull(),
  purpose: text("purpose").notNull(),
  attempts: integer("attempts").notNull().default(0),
  successes: integer("successes").notNull().default(0),
  promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
  completionTokens: bigint("completion_tokens", { mode: "number" }).notNull().default(0),
  reportedCostUsd: numeric("reported_cost_usd").notNull().default("0"),
  unknownCostAttempts: integer("unknown_cost_attempts").notNull().default(0),
}, table => [
  primaryKey({ columns: [table.userId, table.day, table.purpose] }),
  index("ai_usage_daily_day_idx").on(table.day),
]);

export const aiUsageLeases = pgTable("ai_usage_leases", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Main user table
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email").notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone"),
  contactPreference: text("contact_preference").default("email"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const services = pgTable("services", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull(),
  options: json("options").$type<string[]>().notNull(),
});

export const submissions = pgTable("submissions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  selectedServices: json("selected_services").$type<string[]>().notNull(),
  formData: json("form_data").notNull(),
  status: text("status").default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Integration data
export const integrationRequests = pgTable("integration_requests", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull(),
  provider: text("provider").notNull(), // "netcalcsheet", "arive", "canopy"
  requestData: json("request_data").notNull(),
  responseData: json("response_data"),
  status: text("status").default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Questionnaire responses table for tracking user progress
export const questionnaireResponses = pgTable("questionnaire_responses", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(), // Unique session identifier
  serviceType: text("service_type").notNull(), // mortgage, realEstate, insurance, etc.
  stepName: text("step_name").notNull(), // initial, property-type, financing, etc.
  responseData: json("response_data").notNull(), // The actual form data
  isCompleted: boolean("is_completed").default(false), // Whether this step is completed
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Stripe subscription state, keyed by Supabase auth user id (uuid).
// Written by the subscription confirm/status routes; read to gate access.
export const userSubscriptions = pgTable("user_subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  email: text("email"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: text("status").notNull().default("inactive"),
  currentPeriodEnd: timestamp("current_period_end"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Sensitive account attributes that are needed by server integrations but
// must never be sent to the browser as part of an auth session.
export const privateUserProfiles = pgTable("private_user_profiles", {
  userId: text("user_id").primaryKey(),
  dateOfBirth: date("date_of_birth").notNull(),
  creditScoreConsentAt: timestamp("credit_score_consent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Property-specific insurance details owned by one authenticated user. These
// values must not be copied into the shared address quote cache.
export const privateInsuranceProperties = pgTable(
  "private_insurance_properties",
  {
    userId: text("user_id").notNull(),
    addressNormalized: text("address_normalized").notNull(),
    currentPolicyExpirationDate: date("current_policy_expiration_date"),
    // Legacy physical column retained to avoid destructive migration risk.
    // Paid quote identity no longer reads or rotates this value.
    quoteCacheScope: text("quote_cache_scope").notNull().default("unused"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.userId, table.addressNormalized] }),
  }),
);

// Short-lived claims for IFW save/download/share notifications. Keeping these
// in Neon makes dedupe and per-user throttling shared by every server instance.
export const ifwActivityClaims = pgTable(
  "ifw_activity_claims",
  {
    dedupeKey: text("dedupe_key").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  table => ({
    userCreatedAtIdx: index("ifw_activity_claims_user_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
    expiresAtIdx: index("ifw_activity_claims_expires_at_idx").on(table.expiresAt),
  }),
);

// Schema for user input validation
export const insertUserSchema = createInsertSchema(users)
  .omit({
    id: true,
    createdAt: true,
  });

export const insertSubmissionSchema = createInsertSchema(submissions)
  .omit({
    id: true,
    createdAt: true,
  });

export const insertIntegrationRequestSchema = createInsertSchema(integrationRequests)
  .omit({
    id: true,
    createdAt: true,
  });

// Define form validation schemas
export const realEstateFormSchema = z.object({
  // Common fields
  intent: z.enum(["buy", "sell", "both"]),
  propertyType: z.enum(["residential", "commercial", "industrial", "land"]).optional(),
  
  // For Buy intent
  purchaseMethod: z.enum(["cash", "mortgage"]).optional(),
  purchasePrice: z.string().optional(),
  propertyAddress: z.string().optional(),
  
  // For Sell intent
  sellingPrice: z.string().optional(),
  sellingAddress: z.string().optional(),
  
  // For Both intent (Buy & Sell)
  sellType: z.enum(["primary", "1031exchange"]).optional(),
  buyType: z.enum(["primary", "other"]).optional(),
  
  // Legacy fields
  location: z.string().optional(),
  priceRangeMin: z.string().optional(),
  priceRangeMax: z.string().optional(),
});

export const mortgageFormSchema = z.object({
  // Address or ZIP
  locationType: z.enum(["address", "zipcode"]),
  propertyAddress: z.string().optional(),
  zipCode: z.string().optional(),
  
  // Property value
  estimatedValue: z.string().optional(),
  purchasePrice: z.string().optional(),
  
  // Mortgage details
  type: z.enum(["purchase", "refinance"]),
  ownershipType: z.enum(["primary", "secondary", "investment"]).optional(),
  
  // Original fields (for backward compatibility)
  propertyValue: z.string().optional(),
  mortgageBalance: z.string().optional(),
  creditScore: z.string().optional(),
});

export const mortgagePropertyTypeSchema = z.object({
  // Basic info from previous form
  type: z.enum(["purchase", "refinance"]),
  ownershipType: z.enum(["primary", "secondary", "investment"]),
  
  // Property type - different options based on ownership type
  propertyType: z.string(),
});

export const mortgageFinancingSchema = z.object({
  // Credit score range
  creditScore: z.enum([
    "780+",
    "760-779",
    "740-759",
    "720-739",
    "700-719",
    "680-699",
    "660-679",
    "640-659",
    "620-639",
    "600-619",
    "580-599",
    "580 and below"
  ]),
  
  // Loan type - changes based on ownership type
  loanType: z.string(),
  
  // Optional Non-QM specific fields
  nonQMType: z.string().optional(),
});

export const mortgageIncomeSchema = z.object({
  // Main income type
  incomeType: z.enum(["salary-w2", "hourly", "self-employed", "retired"]),
  
  // Salary/W2 specific fields
  salaryType: z.enum(["salary-only", "salary-commission", "salary-bonus", "salary-rsu"]).optional(),
  baseSalary: z.string().optional(),
  commissionAverage: z.string().optional(),
  bonusAverage: z.string().optional(),
  vestedRsuBalance: z.string().optional(),
  companyTickerSymbol: z.string().optional(),
  
  // Hourly specific fields
  hourlyRate: z.string().optional(),
  hoursPerWeek: z.string().optional(),
  
  // Self-employed specific fields
  businessType: z.enum(["1099-personal", "1099-business", "s-corp", "c-corp"]).optional(),
  grossAverage: z.string().optional(),
  netIncome: z.string().optional(),
  w2Income: z.string().optional(),
  k1Amount: z.string().optional(),
  cCorpNetProfit: z.string().optional(),
  businessOwnershipPercentage: z.string().optional(),
  
  // Retired specific fields (can select multiple)
  socialSecurityIncome: z.string().optional(),
  disabilityIncome: z.string().optional(),
  disabilityType: z.enum(["social-security", "va", "other"]).optional(),
  pensionIncome: z.string().optional(),
  rmdIncome: z.string().optional(),
});

export const insuranceFormSchema = z.object({
  // Step 1: Insurance category selection
  insuranceCategory: z.enum(["residential", "commercial"]).optional(),
  
  // Step 2a: Residential insurance types (multiple selection allowed)
  residentialTypes: z.array(z.enum(["auto", "home", "flood", "general-liability"])).optional(),
  
  // Step 2b: Commercial insurance types (multiple selection allowed)  
  commercialTypes: z.array(z.enum(["property", "business-owners-policy", "flood", "other"])).optional(),
  
  // Step 3: Quote type selection
  quoteType: z.enum(["new", "current"]).optional(),
  
  // For new insurance path - Personal information
  firstName: z.string().optional(),
  lastName: z.string().optional(), 
  email: z.string().optional(),
  dateOfBirth: z.string().optional(),
  
  // Property information
  currentAddress: z.string().optional(),
  currentAddressPlaceId: z.string().optional(),
  newAddress: z.string().optional(),
  newAddressPlaceId: z.string().optional(),
  hasMortgage: z.boolean().optional(),
  propertyType: z.enum(["primary", "secondary", "investment"]).optional(),
  
  // Investment property specific
  rentalTerm: z.enum([
    "1-2-nights", 
    "3-7-nights", 
    "7-30-nights", 
    "30-plus-days", 
    "90-plus-days", 
    "annual"
  ]).optional(),
  
  // Legacy fields for backward compatibility
  type: z.enum(["auto", "property", "other"]).optional(),
  currentProvider: z.string().optional(),
  coverageAmount: z.string().optional(),
  additionalInfo: z.string().optional(),
  address: z.string().optional(),
  placeId: z.string().optional(),
  notes: z.string().optional(),
}).superRefine((data, ctx) => {
  // Validate insurance category and types
  if (data.insuranceCategory) {
    if (data.insuranceCategory === "residential") {
      if (!data.residentialTypes || data.residentialTypes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Please select at least one residential insurance type",
          path: ["residentialTypes"],
        });
      }
    } else if (data.insuranceCategory === "commercial") {
      if (!data.commercialTypes || data.commercialTypes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Please select at least one commercial insurance type",
          path: ["commercialTypes"],
        });
      }
    }
  }
  
  // Apply conditional validation for new insurance path
  if (data.quoteType === "new") {
    // Require personal information for new insurance
    if (!data.firstName || data.firstName.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "First name is required",
        path: ["firstName"],
      });
    }
    
    if (!data.lastName || data.lastName.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Last name is required",
        path: ["lastName"],
      });
    }
    
    if (!data.email || data.email.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Email is required",
        path: ["email"],
      });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valid email is required",
        path: ["email"],
      });
    }
    
    if (!data.dateOfBirth || data.dateOfBirth.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Date of birth is required",
        path: ["dateOfBirth"],
      });
    }
    
    if (!data.propertyType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Property type is required",
        path: ["propertyType"],
      });
    }
    
    // Require rental term for investment properties
    if (data.propertyType === "investment" && !data.rentalTerm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rental term is required for investment properties",
        path: ["rentalTerm"],
      });
    }
    
    // Require at least one address
    if ((!data.currentAddress || data.currentAddress.trim() === "") && 
        (!data.newAddress || data.newAddress.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one address is required",
        path: ["currentAddress"],
      });
    }
  }
});

export const constructionFormSchema = z.object({
  type: z.enum(["build", "rehab"]),
  projectType: z.string().min(1, "Project type is required"),
  budget: z.string().min(1, "Budget is required"),
  timeline: z.string().optional(),
});

export const propertyManagementFormSchema = z.object({
  type: z.enum(["manage", "rentals"]),
  propertyCount: z.string().min(1, "Property count is required"),
  propertyType: z.enum(["residential", "commercial", "mixed"]),
  location: z.string().optional(),
});

export const homeServicesFormSchema = z.object({
  serviceType: z.string().min(1, "Service type is required"),
  urgency: z.enum(["emergency", "soon", "planning"]),
  description: z.string().optional(),
});

export const contactFormSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(10, "Phone number must be at least 10 digits"),
  contactPreference: z.enum(["email", "phone", "text"]),
  termsAgreed: z.boolean().refine(val => val === true, {
    message: "You must agree to the terms and conditions",
  }),
});

// Export types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissions.$inferSelect;

export type InsertIntegrationRequest = z.infer<typeof insertIntegrationRequestSchema>;
export type IntegrationRequest = typeof integrationRequests.$inferSelect;

export type RealEstateFormData = z.infer<typeof realEstateFormSchema>;
export type MortgageFormData = z.infer<typeof mortgageFormSchema>;
export type MortgagePropertyTypeData = z.infer<typeof mortgagePropertyTypeSchema>;
export type MortgageFinancingData = z.infer<typeof mortgageFinancingSchema>;
export type MortgageIncomeData = z.infer<typeof mortgageIncomeSchema>;
export type InsuranceFormData = z.infer<typeof insuranceFormSchema>;
export type ConstructionFormData = z.infer<typeof constructionFormSchema>;
export type PropertyManagementFormData = z.infer<typeof propertyManagementFormSchema>;
export type HomeServicesFormData = z.infer<typeof homeServicesFormSchema>;
export type ContactFormData = z.infer<typeof contactFormSchema>;

// Service type definitions
export const serviceCategories = [
  {
    id: "real-estate",
    displayName: "Real Estate",
    description: "Buy or sell residential and commercial properties with our expert agents.",
    options: ["Buy", "Sell"],
    imageUrl: "https://images.unsplash.com/photo-1582407947304-fd86f028f716?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1740&q=80"
  },
  {
    id: "mortgage",
    displayName: "Mortgage",
    description: "Get the best rates for new mortgages, refinancing, or cash-out options.",
    options: ["Purchase", "Refinance"],
    imageUrl: "https://images.unsplash.com/photo-1589939705384-5185137a7f0f?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1740&q=80"
  },
  {
    id: "insurance",
    displayName: "Insurance",
    description: "Protect your investments with comprehensive insurance coverage.",
    options: ["Auto", "Property", "Other"],
    imageUrl: "https://images.unsplash.com/photo-1450101499163-c8848c66ca85?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1740&q=80"
  },
  {
    id: "construction",
    displayName: "Construction",
    description: "Build your dream home or renovate your existing property with our construction services.",
    options: ["Build", "Rehab"],
    imageUrl: "https://images.unsplash.com/photo-1541888946425-d81bb19240f5?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1740&q=80"
  },
  {
    id: "property-management",
    displayName: "Property Management",
    description: "Let us handle the day-to-day management of your properties or find the perfect rental.",
    options: ["Manage", "Rentals"],
    imageUrl: "https://images.unsplash.com/photo-1556912172-45b7abe8b7e1?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1740&q=80"
  },
  {
    id: "home-services",
    displayName: "Home Services",
    description: "Access a wide range of home services from repairs to maintenance and more.",
    options: ["Maintenance", "Other"],
    imageUrl: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1740&q=80"
  }
];

export type ServiceCategory = typeof serviceCategories[0];

// Insert and select types for questionnaire responses
export const insertQuestionnaireResponseSchema = createInsertSchema(questionnaireResponses)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export type InsertQuestionnaireResponse = z.infer<typeof insertQuestionnaireResponseSchema>;
export type QuestionnaireResponse = typeof questionnaireResponses.$inferSelect;

// QuoteRUSH live carrier cache. Paid-run identity is normalized address +
// policy type only. cache_scope is a legacy inert physical column.
export const insuranceQuoteCache = pgTable(
  "insurance_quote_cache",
  {
    id: serial("id").primaryKey(),
    addressNormalized: text("address_normalized")
      .notNull(),
    addressDisplay: text("address_display")
      .notNull(),
    leadId: integer("lead_id"),
    status: text("status")
      .notNull()
      .default("pending"),
    quotes: jsonb("quotes")
      .$type<Array<{
        siteName: string;
        annualPremium: number;
        monthlyPremium: number;
        coverageA: number;
        hurricaneDeductible: string;
        aop: string;
        quoteUrl: string | null;
        quoteDate: string;
        rank: number;
      }>>()
      .default([]),
    quoteCounter: integer("quote_counter")
      .default(0),
    // Background polling state is durable so a deploy can resume a run
    // without relying on in-memory timers. These fields do not belong in the
    // public/shared quote snapshots.
    quotePollAttempts: integer("quote_poll_attempts")
      .notNull()
      .default(0),
    quoteStablePolls: integer("quote_stable_polls")
      .notNull()
      .default(0),
    quotePreviousCounter: integer("quote_previous_counter"),
    quotePollClaimedAt: timestamp("quote_poll_claimed_at"),
    quotePollLeaseUntil: timestamp("quote_poll_lease_until"),
    coverageA: integer("coverage_a").default(0),
    policyType: text("policy_type")
      .notNull()
      .default("HO3"),
    cacheScope: text("cache_scope")
      .notNull()
      .default("shared"),
    ownerUserId: text("owner_user_id"),
    answerHash: text("answer_hash"),
    runHadClaims: boolean("run_had_claims"),
    callbackTokenHash: text("callback_token_hash"),
    // Quote inputs and their sources only. These JSON snapshots must never
    // contain applicant identity/contact data or DOB.
    propertyDataSnapshot: jsonb("property_data_snapshot")
      .$type<Record<string, unknown>>()
      .default({}),
    propertyDataProvenance: jsonb("property_data_provenance")
      .$type<Record<string, unknown>>()
      .default({}),
    agencyDefaultSnapshot: jsonb("agency_default_snapshot")
      .$type<Record<string, unknown>>()
      .default({}),
    consumerPropertyAnswers: jsonb("consumer_property_answers")
      .$type<Record<string, unknown>>()
      .default({}),
    quoteProfileVersion: text("quote_profile_version")
      .notNull()
      .default("legacy-v1"),
    // Complete successful GetPropertyData response. Unknown provider fields
    // are retained and may contain sensitive or personal data. This column is
    // server-only mapping evidence: never log it or serialize it from a public
    // route.
    rawQuoterushPropertyData: jsonb("raw_quoterush_property_data")
      .$type<Record<string, unknown>>(),
    rawQuoterushPropertyDataSource: text("raw_quoterush_property_data_source"),
    rawQuoterushPropertyDataFetchedAt: timestamp(
      "raw_quoterush_property_data_fetched_at",
    ),
    rawQuoterushPropertyDataExpiresAt: timestamp(
      "raw_quoterush_property_data_expires_at",
    ),
    assumptions: jsonb("assumptions")
      .$type<string[]>()
      .default([]),
    triggeredAt: timestamp("triggered_at")
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at"),
    expiresAt: timestamp("expires_at")
      .notNull(),
    // Delivery metadata is separate from the shared property/quote snapshots.
    // It lets the first authenticated requester receive the result without
    // copying identity data into propertyDataSnapshot.
    emailRecipient: text("email_recipient"),
    emailUserId: text("email_user_id"),
    emailDeliveryStatus: text("email_delivery_status")
      .notNull()
      .default("pending"),
    emailClaimedAt: timestamp("email_claimed_at"),
    emailFirstAttemptAt: timestamp("email_first_attempt_at"),
    emailRetryCount: integer("email_retry_count")
      .notNull()
      .default(0),
    emailQuarantineAt: timestamp("email_quarantine_at"),
    emailSentAt: timestamp("email_sent_at"),
    emailError: text("email_error"),
  },
  table => ({
    addressPolicyUnique: unique(
      "insurance_quote_cache_address_policy_scope_unique",
    ).on(table.addressNormalized, table.policyType, table.cacheScope),
    expiresAtIdx: index("insurance_quote_cache_expires_at_idx").on(
      table.expiresAt,
    ),
  }),
);

export type InsuranceQuoteCache =
  typeof insuranceQuoteCache.$inferSelect;

// Cached non-ad valorem assessments (CDD, solid waste, stormwater, etc.)
// scraped from the Hillsborough Tax Collector's latest annual bill via
// Apify. Keyed by folio; refreshed yearly.
export const nonAdValoremCache = pgTable(
  "non_ad_valorem_cache",
  {
    id: serial("id").primaryKey(),
    folio: text("folio").notNull().unique(),
    accountNumber: text("account_number"),
    billYear: integer("bill_year"),
    status: text("status").notNull().default("pending"),
    lines: jsonb("lines")
      .$type<Array<{ authority: string; amount: number }>>()
      .default([]),
    totalNonAdValorem: integer("total_non_ad_valorem").default(0),
    // Actual ad valorem dollar amount from the bill's "Total Ad Valorem
    // Taxes" row, in cents (×100). Null when the bill didn't expose a
    // dollar total (only millage is sometimes present, not dollars).
    totalAdValoremCents: integer("total_ad_valorem_cents"),
    // Total ad valorem millage parsed from the bill, in mills × 10000
    // (e.g. 19.9197 mills → 199197). Null when the bill didn't parse.
    totalMillage: integer("total_millage"),
    // Per-authority millage rates parsed from the bill's Ad Valorem
    // table (e.g. [{authority:"ST PETERSBURG", mills:6.4525}, …]).
    adValoremMills: jsonb("ad_valorem_mills")
      .$type<Array<{ authority: string; mills: number }>>(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  }
);

export type NonAdValoremCache =
  typeof nonAdValoremCache.$inferSelect;

// Onboarding drip-campaign send log. Lives in the user's Supabase (see
// supabase/migrations/2026_08_06_email_campaign_log.sql); one row per
// user × campaign × step actually sent. Its presence is what prevents
// double-sends across server restarts.
export const emailCampaignLog = pgTable(
  "email_campaign_log",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .default("onboarding_v1"),
    stepNumber: integer("step_number").notNull(),
    sentAt: timestamp("sent_at").defaultNow().notNull(),
    status: text("status").notNull().default("sent"),
  }
);

export type EmailCampaignLog = typeof emailCampaignLog.$inferSelect;

// NOTE: property_tax_cache and current_tax_bills are Supabase-only tables
// (accessed via supabaseAdmin REST, not Drizzle/Neon). They are defined in
// supabase/schema.sql and supabase/migrations/. Types live in
// server/integrations/property-tax-cache.ts and server/integrations/current-tax-bill.ts.
