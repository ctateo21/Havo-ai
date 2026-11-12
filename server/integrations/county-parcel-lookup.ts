/**
 * County property appraiser parcel lookups for FL counties beyond
 * Hillsborough. Each lookup resolves an address to the parcel
 * identifier used by the county's Tax Collector site
 * (<county>.county-taxes.com) — or, for Manatee, returns the full
 * non-ad valorem assessment amounts directly (its ArcGIS layer
 * publishes them, so no bill scrape is needed).
 */

import {
  streetAddressMatches,
  streetQueriesForSearch,
} from "./hillsborough-tax";

const TIMEOUT_MS = 8_000;

function cityFromAddress(fullAddress: string): string {
  const parts = fullAddress.split(",");
  return normalizeCity(parts[1] ?? "");
}

function normalizeCity(value: string): string {
  return value
    .toUpperCase()
    .replace(/\bFL(?:ORIDA)?\b/g, " ")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Selects only an exact street/unit + exact city match from an ArcGIS result
 * list. A city-only match or the provider's first result is never accepted.
 */
export function selectStrictParcelCandidate(
  requestedAddress: string,
  features: any[],
  streetField: string,
  cityField: string,
): any | null {
  const requestedCity = cityFromAddress(requestedAddress);
  if (!requestedCity) return null;

  return features.find((feature: any) => {
    const attributes = feature?.attributes;
    if (!attributes) return false;
    const candidateStreet = String(attributes[streetField] ?? "");
    const candidateCity = normalizeCity(String(attributes[cityField] ?? ""));
    return (
      streetAddressMatches(requestedAddress, candidateStreet) &&
      candidateCity === requestedCity
    );
  }) ?? null;
}

// ── Pinellas ─────────────────────────────────────────────────────

/**
 * Pinellas County PA — PropertySearch_A ArcGIS layer.
 * Returns DISPLAY_STRAP_NOHYPHEN (18 digits, section/township/range
 * display order) — the only strap order pinellas.county-taxes.com's
 * search recognizes (INTERNAL_STRAP returns "no bills matched").
 */
export interface PinellasParcelData {
  /** DISPLAY_STRAP_NOHYPHEN — the tax-site search key. */
  account: string;
  /** Canonical situs street returned by the ArcGIS parcel layer. */
  situsAddress: string;
  /** Normalized situs city used by the strict identity match. */
  situsCity: string;
  /** Current just/market value from the PropertyPopup layer, or
   *  null when the popup lookup failed. */
  justValue: number | null;
}

export { lookupPinellasParcel } from "./pinellas-parcel";

async function legacyPinellasParcelLookupUnused(
  address: string
): Promise<PinellasParcelData | null> {
  try {
    for (const streetQuery of streetQueriesForSearch(address)) {
      const escapedStreet = streetQuery
        .toUpperCase()
        .replace(/'/g, "''");
      const street = encodeURIComponent(`${escapedStreet}%`);
      const url =
        "https://egis.pinellas.gov/pcpagis/rest/services/Pcpao_gov/" +
        "PropertySearch_A/MapServer/0/query" +
        `?where=SITE_ADDRESS+LIKE+%27${street}%27` +
        "&outFields=INTERNAL_STRAP,DISPLAY_STRAP_NOHYPHEN,SITE_ADDRESS,SITE_CITYZIP" +
        "&resultRecordCount=100&returnGeometry=false&f=json";

      const resp = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const features = data?.features ?? [];
      const best = selectStrictParcelCandidate(
        address,
        features,
        "SITE_ADDRESS",
        "SITE_CITYZIP",
      );
      if (!best) continue;

      const attributes = best.attributes;
      const account = attributes?.DISPLAY_STRAP_NOHYPHEN;
      if (!account) return null;

      // Second query: current just/market value (PropertyPopup layer).
      let justValue: number | null = null;
      const internal = attributes?.INTERNAL_STRAP;
      if (internal) {
        try {
          const popupUrl =
            "https://egis.pinellas.gov/pcpagis/rest/services/Pcpao_gov/" +
            "PropertyPopup_A/MapServer/0/query" +
            `?where=INTERNAL_STRAP=%27${encodeURIComponent(String(internal).replace(/'/g, "''"))}%27` +
            "&outFields=TOTAL_JST_VALUE" +
            "&returnGeometry=false&f=json";
          const popupResp = await fetch(popupUrl, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (popupResp.ok) {
            const popup = await popupResp.json();
            const jv =
              popup?.features?.[0]?.attributes?.TOTAL_JST_VALUE;
            if (typeof jv === "number" && jv > 0) justValue = jv;
          }
        } catch {
          // just value is a best-effort enhancement
        }
      }

      return {
        account: String(account),
        situsAddress: String(attributes?.SITE_ADDRESS ?? ""),
        situsCity: normalizeCity(String(attributes?.SITE_CITYZIP ?? "")),
        justValue,
      };
    }
    return null;
  } catch (err: any) {
    console.error("[pinellas-lookup]", err?.message);
    return null;
  }
}

// ── Manatee ──────────────────────────────────────────────────────

export interface ManateeParcelData {
  parid: string;
  situsAddress: string;
  situsCity: string;
  justValue: number;
  navCddName: string | null;
  /** Non-zero non-ad valorem lines, ready for disclosure display. */
  navLines: Array<{ authority: string; amount: number }>;
  totalNonAdValorem: number;
  /**
   * Best available actual annual tax bill from the ArcGIS record.
   *
   * Layer 0 publishes up to 4 historical tax years (TAX_YEAR1..4 /
   * TAXES_YEAR1..4). The current calendar year often appears as
   * TAX_YEAR1 with TAXES_YEAR1=0 (placeholder — bill not yet set).
   * We pick the newest TAX_YEARn whose TAXES_YEARn is a finite
   * positive number. CAD_AD_VAL_TAXES is frequently 0 even when
   * history rows are positive, so we do NOT use it here.
   *
   * This field is the actual owner's total bill (ad valorem +
   * non-ad valorem combined) and reflects existing exemptions — it
   * is NOT a safe new-buyer purchase estimate.
   */
  actualBillYear: number | null;
  /** Actual total annual tax dollars for actualBillYear (null when
   *  no positive historical row found). */
  actualBillTotal: number | null;
}

/**
 * Manatee County PA — WebLayers ArcGIS. The parcel record carries
 * ALL non-ad valorem amounts (CDD, fire, stormwater, …) directly,
 * so Manatee needs no Tax Collector scrape at all.
 *
 * Layer 0 fields used:
 *   PARID, SITUS_ADDRESS, SITUS_POSTAL_CITY, CAD_JUST_VALUE
 *   NAV_CDD_TAX, NAV_CDD_NAME, NAV_CITY_TAX, NAV_FIRE_TAX,
 *   NAV_STORM_TAX, NAV_DREDGE_TAX, NAV_LIGHT_TAX, NAV_OTHER_TAX,
 *   NAV_PARK_TAX, NAV_PAVE_TAX, NAV_SEWER_TAX, NAV_PACE_TAX,
 *   NAV_STEWARD_TAX,
 *   TAX_YEAR1..4, TAXES_YEAR1..4   ← actual historical bill totals
 */
export async function lookupManateeParcel(
  address: string
): Promise<ManateeParcelData | null> {
  try {
    const fields = [
      "PARID", "SITUS_ADDRESS", "SITUS_POSTAL_CITY", "CAD_JUST_VALUE",
      "NAV_CDD_TAX", "NAV_CDD_NAME", "NAV_CITY_TAX", "NAV_FIRE_TAX",
      "NAV_STORM_TAX", "NAV_DREDGE_TAX", "NAV_LIGHT_TAX",
      "NAV_OTHER_TAX", "NAV_PARK_TAX", "NAV_PAVE_TAX", "NAV_SEWER_TAX",
      "NAV_PACE_TAX", "NAV_STEWARD_TAX",
      // Historical annual bill totals (up to 4 years)
      "TAX_YEAR1", "TAXES_YEAR1",
      "TAX_YEAR2", "TAXES_YEAR2",
      "TAX_YEAR3", "TAXES_YEAR3",
      "TAX_YEAR4", "TAXES_YEAR4",
    ].join(",");

    let a: Record<string, any> | null = null;
    for (const streetQuery of streetQueriesForSearch(address)) {
      const escapedStreet = streetQuery
        .toUpperCase()
        .replace(/'/g, "''");
      const street = encodeURIComponent(`${escapedStreet}%`);
      const url =
        "https://gis.manateepao.com/arcgis/rest/services/Website/" +
        "WebLayers/MapServer/0/query" +
        `?where=SITUS_ADDRESS+LIKE+%27${street}%27` +
        `&outFields=${fields}` +
        "&resultRecordCount=100&returnGeometry=false&f=json";

      const resp = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const best = selectStrictParcelCandidate(
        address,
        data?.features ?? [],
        "SITUS_ADDRESS",
        "SITUS_POSTAL_CITY",
      );
      if (best?.attributes) {
        a = best.attributes;
        break;
      }
    }
    if (!a || !a.PARID) return null;

    const nav = (v: any) =>
      typeof v === "number" && v > 0 ? v : 0;

    const navLines: Array<{ authority: string; amount: number }> = [];
    const push = (authority: string, amount: number) => {
      if (amount > 0)
        navLines.push({
          authority,
          amount: Math.round(amount * 100) / 100,
        });
    };
    push(a.NAV_CDD_NAME ?? "CDD Assessment", nav(a.NAV_CDD_TAX));
    push("Fire Assessment", nav(a.NAV_FIRE_TAX));
    push("Stormwater", nav(a.NAV_STORM_TAX));
    push("Sewer/Water", nav(a.NAV_SEWER_TAX));
    push("Municipal", nav(a.NAV_CITY_TAX));
    push("Dredge", nav(a.NAV_DREDGE_TAX));
    push("Street Lighting", nav(a.NAV_LIGHT_TAX));
    push("Parks", nav(a.NAV_PARK_TAX));
    push("Paving", nav(a.NAV_PAVE_TAX));
    push("PACE", nav(a.NAV_PACE_TAX));
    push("Stewardship", nav(a.NAV_STEWARD_TAX));
    push("Other Assessments", nav(a.NAV_OTHER_TAX));

    const totalNonAdValorem =
      Math.round(navLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

    // Pick the best actual annual bill total: newest TAX_YEARn where
    // TAXES_YEARn is a finite positive number (skip zero placeholders).
    const { bestYear, bestTotal } = pickBestManateeBillYear(a);

    return {
      parid: String(a.PARID ?? ""),
      situsAddress: a.SITUS_ADDRESS ?? "",
      situsCity: a.SITUS_POSTAL_CITY ?? "",
      justValue: a.CAD_JUST_VALUE ?? 0,
      navCddName: a.NAV_CDD_NAME ?? null,
      navLines,
      totalNonAdValorem,
      actualBillYear: bestYear,
      actualBillTotal: bestTotal,
    };
  } catch (err: any) {
    console.error("[manatee-lookup]", err?.message);
    return null;
  }
}

/**
 * From a Manatee ArcGIS attribute object, find the newest TAX_YEARn /
 * TAXES_YEARn pair where the tax amount is a finite positive number.
 *
 * The layer publishes up to 4 slots. TAX_YEAR1 is often the current
 * calendar year with TAXES_YEAR1=0 (placeholder — bill not yet issued).
 * We walk all four slots, collect the ones with positive amounts, and
 * return the most recent year.
 *
 * CAD_AD_VAL_TAXES is intentionally NOT used here because it is
 * frequently 0 even when historical rows are positive.
 *
 * Exported for unit testing.
 */
export function pickBestManateeBillYear(
  attributes: Record<string, unknown>
): { bestYear: number | null; bestTotal: number | null } {
  let bestYear: number | null = null;
  let bestTotal: number | null = null;

  for (let i = 1; i <= 4; i++) {
    const yearVal = attributes[`TAX_YEAR${i}`];
    const taxVal  = attributes[`TAXES_YEAR${i}`];

    const year  = typeof yearVal === "number" && Number.isFinite(yearVal)
      ? Math.round(yearVal)
      : typeof yearVal === "string" ? parseInt(yearVal, 10) : NaN;
    const total = typeof taxVal  === "number" && Number.isFinite(taxVal)
      ? taxVal
      : typeof taxVal === "string" ? parseFloat(taxVal) : NaN;

    if (!Number.isFinite(year) || year <= 0) continue;
    if (!Number.isFinite(total) || total <= 0) continue;  // skip zero placeholders

    if (bestYear === null || year > bestYear) {
      bestYear  = year;
      bestTotal = total;
    }
  }

  return { bestYear, bestTotal };
}
