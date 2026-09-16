import { load } from "cheerio";
export { runCountyEstimator } from "./county-estimator-runner";
export type { CountySlug } from "./parcel-resolver";
import type { CountySlug } from "./parcel-resolver";

/** Only supported captured layouts are parsed. Unknown layouts fail closed. */
export function parseEstimatorPage(
  county: CountySlug,
  page: string,
): { adValoremCents: number | null } {
  if (county !== "collier" || !page.trim()) return { adValoremCents: null };
  const $ = load(page);
  $("script, style, noscript").remove();
  // Preserve boundaries between table cells/blocks instead of concatenating amounts.
  $("br").replaceWith("\n");
  $("td, th, p, div, tr").append(" ");
  const text = $.root().text().replace(/\u00a0/g, " ");
  const matches = [...text.matchAll(
    /(?:Approximate\s+)?(?<!Non[- ])\bAd\s+Valorem\s+Taxes\s*\(\s*\$\s*\)\s*:?\s*\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\d,.])/gi,
  )];
  if (matches.length !== 1) return { adValoremCents: null };
  const amount = Number(matches[0][1].replace(/,/g, ""));
  const cents = Math.round(amount * 100);
  return { adValoremCents: Number.isSafeInteger(cents) && cents >= 0 ? cents : null };
}

type RescaleInput = {
  seedPrice: number;
  seedAdValoremCents: number;
  seedHomestead: boolean;
  newPrice: number;
  newHomestead: boolean;
};

/**
 * Applies only to an already verified official seed. Never use a formula
 * estimate as the seed. Homestead exemptions make changed-price scaling unsafe.
 */
export function rescaleAdValorem(input: RescaleInput):
  | { status: "rescaled"; adValoremCents: number }
  | { status: "recall-required" } {
  const { seedPrice, seedAdValoremCents, seedHomestead, newPrice, newHomestead } = input;
  const recall = { status: "recall-required" } as const;
  if (![seedPrice, newPrice, seedAdValoremCents].every(Number.isFinite) ||
      seedPrice <= 0 || newPrice <= 0 || seedAdValoremCents < 0 ||
      !Number.isSafeInteger(seedAdValoremCents) ||
      seedHomestead !== newHomestead ||
      Math.abs(newPrice - seedPrice) / seedPrice > 0.2 ||
      (seedHomestead && newPrice !== seedPrice)) return recall;
  const cents = Math.round(seedAdValoremCents * newPrice / seedPrice);
  return Number.isSafeInteger(cents)
    ? { status: "rescaled", adValoremCents: cents }
    : recall;
}