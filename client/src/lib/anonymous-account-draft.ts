import {
  getSession, getPurchaseScenarios, savePurchaseScenarios, getCashBuyScenarios, saveCashBuyScenarios,
  getSellerScenarios, saveSellerScenarios, getInsuranceScenarios, saveInsuranceScenarios,
  getTrackedLoans, saveTrackedLoans, type PurchaseScenario, type CashBuyScenario,
  type SellerScenario, type InsuranceScenario, type TrackedLoan,
  confirmScenarioPersistence,
} from "@/lib/auth";

export const ANONYMOUS_ACCOUNT_DRAFT_KEY = "havo_pending_anonymous_quote_v1";
type DraftType = "purchase" | "cash" | "seller" | "insurance" | "refinance";
const tables: Record<DraftType, string> = {
  purchase: "purchase_scenarios", cash: "cash_buy_scenarios", seller: "seller_scenarios",
  insurance: "insurance_scenarios", refinance: "tracked_loans",
};
const mountedPaths: Record<DraftType, string> = {
  purchase: "/estimate", cash: "/cash-buy", seller: "/seller", insurance: "/insurance", refinance: "/refinance",
};

/** Failed saves remain restorable even after the visitor has signed in. */
export function hasPendingAnonymousAccountDraft(): boolean {
  try {
    const draft = JSON.parse(localStorage.getItem(ANONYMOUS_ACCOUNT_DRAFT_KEY) || "null");
    if (!draft || mountedPaths[draft.type as DraftType] !== window.location.pathname) return false;
    const address = new URLSearchParams(window.location.search).get("address")?.trim().toLowerCase();
    const addresses = draft.type === "refinance"
      ? (draft.payload as TrackedLoan[]).map(loan => loan.propertyAddress.trim().toLowerCase())
      : [String(draft.payload?.address || "").trim().toLowerCase()];
    return !!address && addresses.includes(address);
  } catch { return false; }
}

export async function confirmAnonymousAccountDraftSaved(type: DraftType, save: () => void | Promise<void>) {
  let raw: string | null = null;
  const address = new URLSearchParams(window.location.search).get("address")?.trim().toLowerCase();
  try { raw = localStorage.getItem(ANONYMOUS_ACCOUNT_DRAFT_KEY); } catch { /* Still save the mounted draft. */ }
  await confirmScenarioPersistence(tables[type], save);
  try {
    if (raw && localStorage.getItem(ANONYMOUS_ACCOUNT_DRAFT_KEY) === raw) {
      const draft = JSON.parse(raw);
      const addresses = type === "refinance"
        ? (draft.payload as TrackedLoan[]).map(loan => loan.propertyAddress.trim().toLowerCase())
        : [String(draft.payload?.address || "").trim().toLowerCase()];
      if (draft.type === type && address && addresses.includes(address)) {
        localStorage.removeItem(ANONYMOUS_ACCOUNT_DRAFT_KEY);
      }
    }
  } catch { /* Retaining a draft is safer than losing one. */ }
}

export function rememberAnonymousAccountDraft(type: DraftType, payload: unknown) {
  if (getSession()) return;
  try {
    localStorage.setItem(ANONYMOUS_ACCOUNT_DRAFT_KEY, JSON.stringify({ type, payload }));
  } catch { /* Mounted page and per-field draft remain available. */ }
}

function mergeByAddress<T extends { id: string }>(existing: T[], incoming: T, address: (item: T) => string): T[] {
  const key = address(incoming).trim().toLowerCase();
  const match = existing.find(item => address(item).trim().toLowerCase() === key);
  return match
    ? existing.map(item => item.id === match.id ? { ...item, ...incoming, id: match.id } : item)
    : [...existing, incoming];
}

/** Also handles signup from the home/header after leaving the quote page. */
export async function promoteAnonymousAccountDraft() {
  if (!getSession()) return;
  const raw = localStorage.getItem(ANONYMOUS_ACCOUNT_DRAFT_KEY);
  if (!raw) return;
  const draft = JSON.parse(raw) as { type: DraftType; payload: unknown };
  // Mounted pages already retain their exact draft and use their normal save
  // effects. Do not race those effects or overwrite newer edits.
  const address = new URLSearchParams(window.location.search).get("address")?.trim().toLowerCase();
  const draftAddresses = draft.type === "refinance"
    ? (draft.payload as TrackedLoan[]).map(loan => loan.propertyAddress.trim().toLowerCase())
    : [(draft.payload as { address: string }).address.trim().toLowerCase()];
  if (mountedPaths[draft.type] === window.location.pathname && address && draftAddresses.includes(address)) return;
  await confirmScenarioPersistence(tables[draft.type], async () => {
    switch (draft.type) {
      case "purchase":
        savePurchaseScenarios(mergeByAddress(getPurchaseScenarios(), draft.payload as PurchaseScenario, item => item.address));
        break;
      case "cash":
        saveCashBuyScenarios(mergeByAddress(getCashBuyScenarios(), draft.payload as CashBuyScenario, item => item.address));
        break;
      case "seller":
        saveSellerScenarios(mergeByAddress(getSellerScenarios(), draft.payload as SellerScenario, item => item.address));
        break;
      case "insurance":
        await saveInsuranceScenarios(mergeByAddress(getInsuranceScenarios(), draft.payload as InsuranceScenario, item => item.address));
        break;
      case "refinance": {
        let merged = getTrackedLoans();
        for (const loan of draft.payload as TrackedLoan[]) {
          merged = mergeByAddress(merged, loan, item => item.propertyAddress);
        }
        await saveTrackedLoans(merged);
        break;
      }
    }
  });
  if (localStorage.getItem(ANONYMOUS_ACCOUNT_DRAFT_KEY) === raw) localStorage.removeItem(ANONYMOUS_ACCOUNT_DRAFT_KEY);
}
