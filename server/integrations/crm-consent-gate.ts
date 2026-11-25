/**
 * Server-owned marketing-consent check used before enrolling a person in CRM
 * calling/texting workflows. The most recent consent record (lead capture or
 * account consent) wins; no record means no enrollment.
 */

type ConsentQueryResult<T> = { data: T[] | null; error: unknown };

export type ConsentStore = {
  latestLeadConsent: (phoneE164: string) => Promise<ConsentQueryResult<{ marketing_consent: boolean | null; consent_at: string }>>;
  latestAccountConsent: (phones: string[]) => Promise<ConsentQueryResult<{ consent: boolean | null; recorded_at: string }>>;
};

export type ConsentDecision = "allowed" | "no_consent" | "unavailable";

export function consentPhoneVariants(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const e164 = digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
  return { digits, e164, all: [phone, e164, digits] };
}

export async function checkCrmConsent(store: ConsentStore | null, phone: string): Promise<ConsentDecision> {
  if (!store) return "unavailable";
  const { e164, all } = consentPhoneVariants(phone);
  const [leadConsent, accountConsent] = await Promise.all([
    store.latestLeadConsent(e164),
    store.latestAccountConsent(all),
  ]);
  if (leadConsent.error || accountConsent.error) return "unavailable";
  const history = [
    ...(leadConsent.data ?? []).map(r => ({ yes: r.marketing_consent, at: r.consent_at })),
    ...(accountConsent.data ?? []).map(r => ({ yes: r.consent, at: r.recorded_at })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return history[0]?.yes === true ? "allowed" : "no_consent";
}
