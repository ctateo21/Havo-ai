import { z } from "zod";

export const tiers = ["agent", "loan_officer", "brokerage"] as const;
const attribution = {
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  utmSource: z.string().max(200).default(""),
  utmMedium: z.string().max(200).default(""),
  utmCampaign: z.string().max(200).default(""),
};
export const interestEventSchema = z.object({
  ...attribution,
  eventType: z.enum(["page_view", "tier_click"]),
  tier: z.enum(tiers).nullable(),
}).strict().refine(v => v.eventType === "page_view" ? v.tier === null : v.tier !== null, {
  message: "A tier is required for a tier click, and not for a page view.",
});
export const interestSignupSchema = z.object({
  ...attribution,
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  company: z.string().trim().min(1).max(160),
  role: z.enum(["realtor", "loan_officer", "broker_owner", "insurance_agent"]),
  buyersPerYear: z.enum(["1_10", "11_25", "26_plus"]),
  tier: z.enum(tiers),
  consent: z.literal(true),
  website: z.string().max(0).default(""),
}).strict();

export type InterestSignup = z.infer<typeof interestSignupSchema>;
export function signupRecord(v: InterestSignup) {
  return {
    id: v.id, session_id: v.sessionId, name: v.name, email: v.email,
    company: v.company, role: v.role, buyers_per_year: v.buyersPerYear, tier: v.tier,
    utm_source: v.utmSource, utm_medium: v.utmMedium, utm_campaign: v.utmCampaign,
  };
}

export const roleLabels: Record<string, string> = {
  realtor: "Realtor", loan_officer: "Loan officer", broker_owner: "Broker or owner", insurance_agent: "Insurance agent",
};
export const tierLabels: Record<string, string> = {
  agent: "Agent ($49/month)", loan_officer: "Loan Officer ($79/month)", brokerage: "Brokerage (Contact us)",
};
