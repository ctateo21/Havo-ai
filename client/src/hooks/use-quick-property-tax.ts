import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { mergeQuickPropertyTax, parseQuickPropertyTax, type QuickPropertyTax } from "@/lib/quick-property-tax";
import { officialTaxRequestKey } from "@/lib/official-property-tax";

interface TaxInputs {
  address: string;
  purchasePrice: number;
  isPrimaryResidence: boolean;
  scenarioId: string;
  propertyUseSelected: boolean;
  refinance?: boolean;
  /** Navigation can change a render before the active scenario address syncs. */
  requestScope?: string;
  manualOverride?: boolean;
}
export function useQuickPropertyTax(inputs: TaxInputs) {
  const { address, purchasePrice, isPrimaryResidence, scenarioId, propertyUseSelected, refinance = false, requestScope = "", manualOverride = false } = inputs;
  const identity = officialTaxRequestKey(scenarioId, address, purchasePrice, isPrimaryResidence);
  const key = JSON.stringify([identity, propertyUseSelected, refinance, requestScope]);
  const enabled = propertyUseSelected && !!address && address !== "Unknown Address" && Number.isFinite(purchasePrice) && purchasePrice > 0;
  const [revision, setRevision] = useState(0);
  const explicitlyRefreshedKey = useRef("");
  const [state, setState] = useState<{ key: string; loading: boolean; result?: QuickPropertyTax; error?: string }>({ key: "", loading: false });
  const refresh = useCallback(() => { explicitlyRefreshedKey.current = key; setRevision(value => value + 1); }, [key]);
  useEffect(() => {
    if (!enabled || (manualOverride && explicitlyRefreshedKey.current !== key)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 180_000;
    setState(previous => ({ key, loading: true, result: previous.key === key ? previous.result : undefined }));
    async function poll(serverKey: string) {
      if (abort.signal.aborted) return;
      if (Date.now() >= deadline) {
        setState(previous => previous.key !== key ? previous : {
          ...previous, loading: false, error: "Official verification timed out. The estimate is retained; refresh or enter your bill.",
          result: previous.result ? { ...previous.result, officialState: "failed" } : undefined,
        });
        return;
      }
      try {
        const response = await apiRequest("GET", `/api/property-tax/official-status?key=${encodeURIComponent(serverKey)}`, undefined, abort.signal);
        const next = parseQuickPropertyTax(await response.json());
        if (abort.signal.aborted) return;
        if (next.key !== serverKey) throw new Error("Official response does not match this property request.");
        setState(previous => previous.key !== key ? previous : {
          key, loading: false, result: previous.result ? mergeQuickPropertyTax(previous.result, next) : next,
        });
        if (next.officialState === "pending") timer = setTimeout(() => void poll(serverKey), 3000);
      } catch (error) {
        if (!abort.signal.aborted) setState(previous => previous.key !== key ? previous : {
          ...previous, loading: false, error: error instanceof Error ? error.message : "Official verification failed.",
          result: previous.result ? { ...previous.result, officialState: "failed" } : undefined,
        });
      }
    }
    void (async () => {
      try {
        const response = await apiRequest("POST", "/api/property-tax/quick", {
          address, purchasePrice, isPrimaryResidence, scenarioId, refinance,
          ...(revision ? { refresh: true } : {}),
        }, abort.signal);
        const result = parseQuickPropertyTax(await response.json());
        if (abort.signal.aborted) return;
        setState(previous => ({
          key, loading: false,
          result: previous.key === key && previous.result
            ? mergeQuickPropertyTax({
              ...previous.result, key: result.key,
              // Refreshing a tuple retains its usable amount, never its old official claim.
              status: result.key !== previous.result.key && previous.result.status === "official" ? "estimate" : previous.result.status,
            }, result) : result,
        }));
        if (result.officialState === "pending") timer = setTimeout(() => void poll(result.key), 3000);
      } catch (error) {
        if (!abort.signal.aborted) setState(previous => ({
          key, loading: false,
          result: previous.key === key && previous.result ? { ...previous.result, officialState: "failed" } : undefined,
          error: error instanceof Error ? error.message : "Property taxes unavailable.",
        }));
      }
    })();
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [key, enabled, revision, manualOverride]);
  const current = enabled && state.key === key ? state : undefined;
  return {
    key, result: current?.result,
    loading: enabled && (!manualOverride || explicitlyRefreshedKey.current === key) && (!current || current.loading),
    reason: !propertyUseSelected ? "Select Property Use to calculate property taxes."
      : !enabled ? "Enter a property address and purchase price." : current?.error ?? current?.result?.reason,
    refresh,
  };
}
