/**
 * Server-side boundary for official county purchase estimators.
 *
 * This module deliberately has no county-wide or parcel-millage fallback.
 * A parcel-appraiser ArcGIS response, a tax-collector bill, and a locally
 * calculated millage amount are not the same thing as the county's purchase
 * estimator output.  Until an estimator driver has been captured and
 * verified against a human-captured answer, this boundary fails closed.
 *
 * Keep the result contract small: callers can safely distinguish a verified
 * county result from an unavailable provider without inspecting a source
 * label or inferring meaning from a zero.
 */

import type { CountySlug } from "./parcel-resolver";

export interface CountyEstimatorRequest {
  county: CountySlug;
  parcelId?: string;
  address: string;
  purchasePrice: number;
  homestead: boolean;
  /**
   * Test-only failure injection.  This is intentionally not read from an
   * environment variable so production cannot accidentally force this path.
   */
  __forceUnavailable?: boolean;
}

export type CountyEstimatorResult =
  | {
      status: "ok";
      pageText: string;
      adValoremCents: number;
      source: "county-estimator";
    }
  | {
      status: "unavailable";
      error?: string;
    };

/**
 * Run an official purchase estimator.
 *
 * No current county driver is enabled here.  The existing integrations
 * expose parcel layers, tax bills, and rate APIs, but none is an auditable
 * purchase-estimator page/output driver under the strict standard.  Adding a
 * driver requires the official page/output, a parser fixture, and a known
 * answer; it must not be replaced with arithmetic over parcel millage.
 */
export async function runCountyEstimator(
  request: CountyEstimatorRequest,
): Promise<CountyEstimatorResult> {
  if (request.__forceUnavailable) {
    return {
      status: "unavailable",
      error: "Official county purchase estimator was forced unavailable.",
    };
  }

  if (
    !request.address.trim() ||
    !Number.isFinite(request.purchasePrice) ||
    request.purchasePrice <= 0
  ) {
    return {
      status: "unavailable",
      error: "Official county purchase estimator request is invalid.",
    };
  }

  return {
    status: "unavailable",
    error:
      `Official ${request.county} purchase estimator output is not ` +
      "available or verified; no formula substitute is used.",
  };
}
