import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  insuranceQuoteCache,
  privateInsuranceProperties,
} from "@shared/schema";
import { isValidQuoteRushDate } from "@shared/quoterush-property-defaults";
import { selectReusableSharedQuoteCandidate } from "./quoterush-shared-cache";
import {verifyQuoteAccess} from "./quote-answer-identity";
import {
  savePrivateInsuranceProperty as saveManagedPrivateInsuranceProperty,
} from "../managed-account-records";
import {
  readQuoteCache as readManagedQuoteCache,
} from "../managed-quote-cache";

type InsuranceTables = {
  insuranceQuoteCache: typeof insuranceQuoteCache;
  privateInsuranceProperties: typeof privateInsuranceProperties;
};

type RouteDependencies = {
  db?: any;
  optionalUser: (req: any) => Promise<{ id: string } | null>;
  normalizeAddress: (address: string) => string;
  tables?: InsuranceTables;
};

function topThreePositiveQuotes(quotes: any[] | null) {
  return (quotes ?? [])
    .filter(quote => Number(quote.annualPremium) > 0)
    .sort((a, b) => a.annualPremium - b.annualPremium)
    .slice(0, 3)
    .map((quote, index) => ({ ...quote, rank: index + 1 }));
}

function publicConsumerPropertyAnswers(snapshot: unknown): Record<string, unknown> {
  const source =
    snapshot && typeof snapshot === "object"
      ? snapshot as Record<string, unknown>
      : {};
  const safeKeys = [
    "coverageA",
    "policyType",
    "yearBuilt",
    "roofYear",
    "openingProtection",
    "roofShape",
    "secondaryWaterResistance",
    "constIdx",
    "hurrIdx",
    "aopDeductible",
    "floodZone",
    "sqFt",
    "propertyCharacteristicLocks",
  ] as const;
  return Object.fromEntries(
    safeKeys
      .filter(key => source[key] !== undefined)
      .map(key => [key, source[key]]),
  );
}

export function registerInsuranceCacheRoutes(
  app: Express,
  dependencies: RouteDependencies,
) {
  const tables = dependencies.tables ?? {
    insuranceQuoteCache,
    privateInsuranceProperties,
  };

  app.put("/api/profile/insurance-property", async (req, res) => {
    try {
      const user = await dependencies.optionalUser(req);
      if (!user) return res.status(401).json({ error: "Sign in required" });
      const input = z.object({
        address: z.string().trim().min(5).max(300),
        currentPolicyExpirationDate: z.union([
          z.string().refine(isValidQuoteRushDate),
          z.null(),
        ]),
      }).parse(req.body);
      const addressNormalized = dependencies.normalizeAddress(input.address);
      if (dependencies.db) {
        await dependencies.db
          .insert(tables.privateInsuranceProperties)
          .values({
            userId: user.id,
            addressNormalized,
            currentPolicyExpirationDate: input.currentPolicyExpirationDate,
            quoteCacheScope: "unused",
          })
          .onConflictDoUpdate({
            target: [
              tables.privateInsuranceProperties.userId,
              tables.privateInsuranceProperties.addressNormalized,
            ],
            set: {
              currentPolicyExpirationDate: input.currentPolicyExpirationDate,
              updatedAt: new Date(),
            },
          });
      } else {
        await saveManagedPrivateInsuranceProperty(
          user.id,
          addressNormalized,
          input.currentPolicyExpirationDate,
        );
      }
      return res.json({ ok: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Enter a valid policy expiration date" });
      }
      return res.status(500).json({ error: "Private insurance details could not be saved" });
    }
  });

  app.get("/api/insurance/qr-cache", async (req, res) => {
    try {
      const user=await dependencies.optionalUser(req);
      if(!user||!req.get("X-Quote-Access"))return res.json({found:false});
      const address = String(req.query.address ?? "");
      const policyType = z.enum(["HO3", "HO6", "DP3"]).default("HO3")
        .parse(req.query.policyType);
      if (!address) return res.status(400).json({ error: "address required" });

      const normalizedAddress = dependencies.normalizeAddress(address);
      const rows = dependencies.db
        ? await dependencies.db
            .select()
            .from(tables.insuranceQuoteCache)
            .where(and(
              eq(tables.insuranceQuoteCache.addressNormalized, normalizedAddress),
              eq(tables.insuranceQuoteCache.policyType, policyType),
            ))
            .limit(20)
        : await readManagedQuoteCache({
            addressNormalized: normalizedAddress,
            policyType,
          });

      const row = selectReusableSharedQuoteCandidate(
        (rows as Array<typeof insuranceQuoteCache.$inferSelect>).filter(row=>verifyQuoteAccess(req.get("X-Quote-Access"),row,user.id)),
      );
      if (!row) return res.json({ found: false });
      return res.json({
        found: true,
        expired: row.expiresAt < new Date(),
        status: row.status === "failed" ? "error" : row.status,
        leadId: row.leadId,
        quotes: topThreePositiveQuotes(row.quotes).map(q=>({...q,quoteUrl:row.ownerUserId===user.id?q.quoteUrl:null})),
        quoteCounter: row.quoteCounter ?? 0,
        coverageA: row.coverageA ?? 0,
        propertyDataSnapshot: row.propertyDataSnapshot ?? {},
        propertyDataProvenance: row.propertyDataProvenance ?? {},
        consumerPropertyAnswers:
          publicConsumerPropertyAnswers(row.consumerPropertyAnswers),
        quoteProfileVersion: row.quoteProfileVersion,
        assumptions: row.assumptions ?? [],
        triggeredAt: row.triggeredAt,
        expiresAt: row.expiresAt,
      });
    } catch (error) {
      console.error("[qr-cache] error:", error);
      return res.status(500).json({ found: false });
    }
  });
}