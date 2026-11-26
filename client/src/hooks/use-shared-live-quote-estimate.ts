import { useQuery } from "@tanstack/react-query";
import {
  fetchSharedLiveQuoteEstimate,
  sharedEstimatePath,
  type SharedLiveQuoteEstimate,
} from "@/lib/saved-insurance-quotes";

/** Recent lowest live carrier premium for this address + policy form +
 * occupancy (number and date only). Available to guests. */
export function useSharedLiveQuoteEstimate(
  address: string | null | undefined,
  policyType: string | null | undefined,
  occupancy: string | null | undefined,
): SharedLiveQuoteEstimate | null {
  const path = sharedEstimatePath(address ?? "", policyType, occupancy);
  const query = useQuery({
    queryKey: ["/api/insurance/shared-estimate", path],
    queryFn: () => fetchSharedLiveQuoteEstimate(path!),
    enabled: !!path,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return path ? query.data ?? null : null;
}
