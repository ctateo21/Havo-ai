import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { supabaseAdmin } from "./supabase";
import {
  privateInsuranceProperties,
  privateUserProfiles,
  userSubscriptions,
} from "@shared/schema";
import { routedRead, routedWrite } from "./managed-data-routing";

function client() {
  if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
  return supabaseAdmin;
}

export async function savePrivateProfile(userId: string, dateOfBirth: string) {
  const now = new Date();
  return routedWrite(
    async () => {
      const [row] = await db.insert(privateUserProfiles).values({ userId, dateOfBirth })
        .onConflictDoUpdate({
          target: privateUserProfiles.userId,
          set: { dateOfBirth, updatedAt: now },
        }).returning();
      return row;
    },
    async sourceRow => {
      // A target-only DOB update must not erase a consent captured by an
      // earlier release. (Supabase upsert otherwise overwrites omitted fields.)
      const existing = sourceRow ? null : await client().from("private_user_profiles")
        .select("credit_score_consent_at,created_at").eq("user_id", userId)
        .maybeSingle().then(({ data, error }) => {
          if (error) throw error;
          return data;
        });
      const { data, error } = await client().from("private_user_profiles").upsert({
        user_id: userId, date_of_birth: dateOfBirth,
        credit_score_consent_at: sourceRow?.creditScoreConsentAt?.toISOString() ??
          existing?.credit_score_consent_at ?? null,
        created_at: sourceRow?.createdAt?.toISOString() ??
          existing?.created_at ?? now.toISOString(),
        updated_at: sourceRow?.updatedAt?.toISOString() ?? now.toISOString(),
      }, { onConflict: "user_id" }).select().single();
      if (error) throw error;
      return data;
    },
  );
}

export async function readPrivateProfile(userId: string) {
  return routedRead(
    async () => {
      const [row] = await db.select().from(privateUserProfiles)
        .where(eq(privateUserProfiles.userId, userId)).limit(1);
      return row ? { dateOfBirth: row.dateOfBirth } : undefined;
    },
    async () => {
      const { data, error } = await client().from("private_user_profiles")
        .select("date_of_birth").eq("user_id", userId).limit(1).maybeSingle();
      if (error) throw error;
      return data ? { dateOfBirth: data.date_of_birth as string } : undefined;
    },
  );
}

export async function savePrivateInsuranceProperty(
  userId: string,
  addressNormalized: string,
  currentPolicyExpirationDate: string | null,
) {
  const now = new Date();
  return routedWrite(
    async () => {
      const [row] = await db.insert(privateInsuranceProperties).values({
        userId, addressNormalized, currentPolicyExpirationDate, quoteCacheScope: "unused",
      }).onConflictDoUpdate({
        target: [privateInsuranceProperties.userId, privateInsuranceProperties.addressNormalized],
        set: { currentPolicyExpirationDate, updatedAt: now },
      }).returning();
      return row;
    },
    async sourceRow => {
      const { data, error } = await client().from("private_insurance_properties").upsert({
        user_id: userId, address_normalized: addressNormalized,
        current_policy_expiration_date: currentPolicyExpirationDate,
        quote_cache_scope: sourceRow?.quoteCacheScope ?? "unused",
        created_at: sourceRow?.createdAt?.toISOString() ?? now.toISOString(),
        updated_at: sourceRow?.updatedAt?.toISOString() ?? now.toISOString(),
      }, { onConflict: "user_id,address_normalized" }).select().single();
      if (error) throw error;
      return data;
    },
  );
}

export async function readPrivateInsuranceProperty(userId: string, addressNormalized: string) {
  return routedRead(
    async () => {
      const [row] = await db.select().from(privateInsuranceProperties).where(and(
        eq(privateInsuranceProperties.userId, userId),
        eq(privateInsuranceProperties.addressNormalized, addressNormalized),
      )).limit(1);
      return row ? { currentPolicyExpirationDate: row.currentPolicyExpirationDate } : undefined;
    },
    async () => {
      const { data, error } = await client().from("private_insurance_properties")
        .select("current_policy_expiration_date").eq("user_id", userId)
        .eq("address_normalized", addressNormalized).limit(1).maybeSingle();
      if (error) throw error;
      return data ? { currentPolicyExpirationDate: data.current_policy_expiration_date as string | null } : undefined;
    },
  );
}

type SubscriptionValues = {
  userId: string; email?: string | null; stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null; status: string;
  currentPeriodEnd?: Date | null;
};
export async function saveSubscription(value: SubscriptionValues) {
  const now = new Date();
  return routedWrite(
    async () => {
      const [row] = await db.insert(userSubscriptions).values(value)
        .onConflictDoUpdate({
          target: userSubscriptions.userId,
          set: { ...value, updatedAt: now },
        }).returning();
      return row;
    },
    async sourceRow => {
      const row = sourceRow ?? value;
      const { data, error } = await client().from("user_subscriptions").upsert({
        ...(sourceRow ? { id: sourceRow.id } : {}),
        user_id: row.userId, email: row.email ?? null,
        stripe_customer_id: row.stripeCustomerId ?? null,
        stripe_subscription_id: row.stripeSubscriptionId ?? null,
        status: row.status,
        current_period_end: row.currentPeriodEnd?.toISOString() ?? null,
        updated_at: sourceRow?.updatedAt?.toISOString() ?? now.toISOString(),
      }, { onConflict: "user_id" }).select().single();
      if (error) throw error;
      return data;
    },
  );
}

export async function readSubscription(userId: string) {
  return routedRead(
    async () => (await db.select().from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId)))[0],
    async () => {
      const { data, error } = await client().from("user_subscriptions")
        .select("*").eq("user_id", userId).limit(1).maybeSingle();
      if (error) throw error;
      return data ? {
        id: data.id, userId: data.user_id, email: data.email,
        stripeCustomerId: data.stripe_customer_id,
        stripeSubscriptionId: data.stripe_subscription_id,
        status: data.status,
        currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end) : null,
        updatedAt: data.updated_at ? new Date(data.updated_at) : null,
      } : undefined;
    },
  );
}