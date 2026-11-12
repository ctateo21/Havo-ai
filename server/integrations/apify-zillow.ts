/**
 * Apify Zillow Scraper integration.
 *
 * Calls the Apify Actor (ENK9p4RZHg0iVso52) synchronously, normalizes its
 * output into our PropertyScenario model, and parses listing descriptions
 * for insurance-relevant clues (roof age, impact windows, etc.).
 *
 * Caching of results lives in the route handler (server/routes.ts) so this
 * module stays a pure I/O + transform layer.
 */

const APIFY_ACTOR_ID = "ENK9p4RZHg0iVso52";
const APIFY_RUN_TIMEOUT_MS = 90_000; // hard ceiling per request

// ── Types ───────────────────────────────────────────────────────────
export type PropertyTypeNorm =
  | "Single Family" | "Townhome" | "Condo" | "Multifamily"
  | "Manufactured" | "Villa" | "Land" | "Other";

export type OccupancyType = "Primary" | "Secondary" | "Investment" | "";

export interface ParsedInsuranceClues {
  roofYear: number | null;
  roofConditionText: string | null;
  hasImpactWindows: boolean | null;
  hasImpactDoors: boolean | null;
  hasImpactGarageDoor: boolean | null;
  hasHurricaneShutters: boolean | null;
  updatedElectrical: boolean | null;
  updatedPlumbing: boolean | null;
  updatedHVAC: boolean | null;
  floodZoneMentioned: boolean | null;
  windMitigationMentioned: boolean | null;
  rawMatchedPhrases: string[];
}

export interface PropertyScenario {
  source: "Zillow via Apify";
  address: string;
  zillowUrl: string;
  zestimate: number | null;
  listingPrice: number | null;
  purchasePrice: number | null;
  estimatedHomeValue: number | null;
  /** Zillow's monthly rent estimate (Rent Zestimate). Never used as a purchase price. */
  rentZestimate: number | null;
  hoaMonthly: number | null;
  propertyType: PropertyTypeNorm | "";
  yearBuilt: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  lotSize: number | null;
  photos: string[];
  listingDescription: string;
  parsedInsuranceClues: ParsedInsuranceClues;
  insurancePolicyType: "HO3" | "HO6" | "DP3" | "";
  occupancyType: OccupancyType;
  rawZillowData: unknown;
  lastPulledAt: string;
  /** City as parsed from the original Google-formatted address (if available). */
  googleCity?: string;
  /** City as reported by Zillow for the matched property (if available). */
  zillowCity?: string;
  /** UI-preferred city — defaults to Google's, falls back to Zillow's. */
  displayCity?: string;
  /** True when street/ZIP/state matched but Google and Zillow disagree on city. */
  cityMismatch?: boolean;
  /** True when Zillow reports the home as sold (homeStatus SOLD / RECENTLY_SOLD). */
  isSold?: boolean;
  /** Last sold price reported by Zillow (only set when isSold). */
  soldPrice?: number | null;
  /** Last sold date reported by Zillow as an ISO string (only set when isSold). */
  soldDate?: string | null;

  // ── Listing-activity fields (best-effort, often missing from Apify) ──
  /** Days the active listing has been on Zillow (null when not listed). */
  daysOnZillow?: number | null;
  /** ISO date the listing was first posted, derived from priceHistory or
   *  `datePostedString` when present. Null when not derivable. */
  listDate?: string | null;
  /** Zillow page-view count for this listing. Apify often omits this. */
  pageViewCount?: number | null;
  /** Zillow favorite (save) count for this listing. Apify often omits this. */
  favoriteCount?: number | null;
  /** Count of "Price change" events with a price DECREASE in priceHistory. */
  priorPriceCuts?: number | null;
  /** Compact priceHistory summary: most-recent first, max 6 events. Empty
   *  when Apify didn't return a priceHistory array. */
  priceHistory?: Array<{ date: string; price: number | null; event: string }>;
}

// ── Apify HTTP call ─────────────────────────────────────────────────
function isZillowUrl(input: string): boolean {
  return /^https?:\/\/(www\.)?zillow\.com\//i.test(input.trim());
}

/**
 * Run the actor synchronously and return the dataset rows. We use
 * `run-sync-get-dataset-items` so we don't have to poll. The actor accepts
 * either `startUrls` (Zillow URL) or `addresses` (free-form address strings).
 */
async function runApify(addressOrUrl: string): Promise<unknown[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN is not configured on the server");

  const input: Record<string, unknown> = isZillowUrl(addressOrUrl)
    ? { startUrls: [{ url: addressOrUrl.trim() }] }
    : { addresses: [addressOrUrl.trim()] };

  const url =
    `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&clean=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APIFY_RUN_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Apify returned ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    // Apify usually returns a raw array of dataset items, but some actor
    // configurations wrap it as `{ items: [...] }` or `{ data: [...] }`.
    // Accept any of those shapes so a future actor-side change doesn't 502 us.
    if (Array.isArray(data)) return data;
    if (data && Array.isArray((data as any).items)) return (data as any).items;
    if (data && Array.isArray((data as any).data)) return (data as any).data;
    if (data && typeof data === "object") return [data]; // single-result fallback
    throw new Error("Apify response shape was not recognized");
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error("Apify run timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Normalization helpers ───────────────────────────────────────────
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ── Address normalization & matching ────────────────────────────────
// Why this exists: Zillow and Google occasionally disagree on the *city*
// for the same property (e.g. an address in 33709 that Google labels
// "St. Petersburg, FL" but Zillow indexes under "Kenneth City, FL"). The
// Apify actor's built-in geocoder rejects those queries and returns zero
// rows, which the UI then surfaces as "Zillow data unavailable" even
// though the underlying property exists. We retry with the city stripped
// and validate the returned row ourselves using stronger identifiers
// (street #, normalized street name, ZIP5, state). City becomes a soft
// signal — mismatch is logged but never blocks an otherwise-valid match.

// Street-suffix canonicalization. Both sides get reduced to the short form
// so "Way" / "Wy" / "way" all compare equal. Conservative list — only the
// suffixes the spec explicitly calls out.
const SUFFIX_MAP: Record<string, string> = {
  street: "st", st: "st",
  avenue: "ave", ave: "ave", av: "ave",
  road: "rd", rd: "rd",
  drive: "dr", dr: "dr",
  boulevard: "blvd", blvd: "blvd", boulvd: "blvd",
  lane: "ln", ln: "ln",
  circle: "cir", cir: "cir",
  way: "way", wy: "way",
  court: "ct", ct: "ct",
  place: "pl", pl: "pl",
  // Directionals — canonicalized so "Way N" and "Way North" produce the
  // same cache key. Also covers two-letter combos.
  north: "n", n: "n",
  south: "s", s: "s",
  east: "e", e: "e",
  west: "w", w: "w",
  northeast: "ne", ne: "ne",
  northwest: "nw", nw: "nw",
  southeast: "se", se: "se",
  southwest: "sw", sw: "sw",
};

function stripPunctLower(s: string): string {
  return s.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

// Tokens that are ONLY canonicalized to their short form when they appear
// as the first or last token of a street name (e.g. "North Ave" / "Way N").
// Restricting position avoids accidentally collapsing a literally-named
// interior token like "Old North Road" → "Old N Rd" (wrong).
const DIRECTIONAL_SET = new Set([
  "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest",
  "n", "s", "e", "w", "ne", "nw", "se", "sw",
]);

function normalizeStreetName(s: string): string {
  const cleaned = stripPunctLower(s);
  if (!cleaned) return "";
  const tokens = cleaned.split(" ");
  return tokens
    .map((tok, i) => {
      const mapped = SUFFIX_MAP[tok];
      if (mapped == null) return tok;
      // Suffixes (st/ave/rd/dr/blvd/ln/cir/way/ct/pl) canonicalize anywhere.
      // Directionals only canonicalize at the first or last position.
      if (DIRECTIONAL_SET.has(tok)) {
        const isEdge = i === 0 || i === tokens.length - 1;
        return isEdge ? mapped : tok;
      }
      return mapped;
    })
    .join(" ");
}

function normalizeCity(s: string): string {
  return stripPunctLower(s);
}

interface ParsedAddr {
  streetNum?: string;
  streetName?: string;   // normalized
  unit?: string;         // normalized subpremise identity (designator excluded)
  unitConflict?: boolean;// contradictory unit values were present in the source
  city?: string;         // normalized (lowercase, no punct)
  cityRaw?: string;      // original casing/punct for display
  state?: string;        // uppercase 2-letter
  zip5?: string;
}

function normalizeUnit(raw: string): string | undefined {
  const value = raw.trim().toLowerCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : undefined;
}

/** Parse an explicitly-designated unit suffix, never a bare trailing token. */
function parseDesignatedUnit(raw: string): { unit?: string; withoutUnit: string } {
  const match = raw.match(
    /^(.*?)(?:\s+|^)(?:(?:apt|apartment|unit)\.?\s*#?\s*|#\s*)([a-z0-9]+(?:\s*-\s*[a-z0-9]+)*)\s*$/i,
  );
  if (!match) return { withoutUnit: raw.trim() };
  const unit = normalizeUnit(match[2]);
  return unit
    ? { unit, withoutUnit: match[1].trim() }
    : { withoutUnit: raw.trim() };
}

function addUnit(out: ParsedAddr, unit: string | undefined): void {
  if (!unit) return;
  if (out.unit && out.unit !== unit) out.unitConflict = true;
  else out.unit = unit;
}

/**
 * Build a stable cache key for a property based on STRONG identifiers only
 * (street number + normalized street name + ZIP5 + state). City is
 * intentionally excluded — Google and Zillow can disagree on city for the
 * same property. Returns null if the address lacks the minimum required
 * identifiers (street# + street name + ZIP5).
 *
 * Example outputs:
 *   "addr:v2:4311-63rd-way-n-33709"   (street + zip5; state omitted)
 *   null                              (when zip or street missing)
 */
export function buildNormalizedPropertyKey(addr: string): string | null {
  if (!addr) return null;
  const parsed = parseAddressString(addr);
  if (!parsed.streetNum || !parsed.streetName || !parsed.zip5) return null;
  // State is intentionally excluded — ZIP5 already implies state, and
  // including state would prevent state-less variants (e.g. "4311 63rd
  // Way N 33709") from sharing a cache entry with state-tagged ones.
  const street = `${parsed.streetNum}-${parsed.streetName}`.replace(/\s+/g, "-");
  const unit = parsed.unit ? `-unit-${parsed.unit}` : "";
  const slug = `${street}${unit}-${parsed.zip5}`.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  return `addr:v2:${slug}`;
}

/** Drop Google's trailing country tag so it doesn't confuse the parser. */
function stripCountrySuffix(addr: string): string {
  return addr.replace(/,\s*(USA|United States(?:\s+of\s+America)?)\s*\.?\s*$/i, "").trim();
}

/**
 * Parse a free-form address string of the shape
 *   "4311 63rd Way N, St. Petersburg, FL 33709, USA"
 * Tolerant: any missing piece simply comes back undefined. The state/ZIP
 * tail is searched across ALL comma-separated parts (not just the last)
 * so a trailing "USA" or other noise doesn't strand state+zip in the
 * middle of the array.
 */
function parseAddressString(addr: string): ParsedAddr {
  const cleaned = stripCountrySuffix(addr);
  const rawParts = cleaned.split(",").map(s => s.trim()).filter(Boolean);
  const out: ParsedAddr = {};
  const first = parseDesignatedUnit(rawParts[0] ?? "");
  addUnit(out, first.unit);
  const parts = [first.withoutUnit];
  for (const part of rawParts.slice(1)) {
    const designated = parseDesignatedUnit(part);
    // A comma-separated "Unit 4B" is part of the street address, not a city.
    if (designated.unit && !designated.withoutUnit) {
      addUnit(out, designated.unit);
    } else {
      parts.push(part);
    }
  }
  let street = parts[0] ?? "";

  // No-comma form like "4311 63rd Way N 33709" — peel a trailing ZIP5 (and
  // optional state immediately before it) out of the street part so the
  // normalizer doesn't treat "33709" as part of the street name.
  if (parts.length === 1) {
    const tail = street.match(/^(.*?)\s+(?:([A-Za-z]{2})\s+)?(\d{5})(?:-\d{4})?\s*$/);
    if (tail) {
      street = tail[1].trim();
      if (tail[2]) out.state = tail[2].toUpperCase();
      out.zip5 = tail[3];
    }
  }

  // In the no-comma form the unit precedes the state/ZIP just peeled off.
  const streetUnit = parseDesignatedUnit(street);
  addUnit(out, streetUnit.unit);
  street = streetUnit.withoutUnit;
  const m = street.match(/^(\d+\w?)\s+(.+)$/);
  if (m) {
    out.streetNum = m[1];
    out.streetName = normalizeStreetName(m[2]);
  }
  // Find "<state> <zip5>" anywhere in the parts (handles cases where a
  // country suffix or stray fragment ended up at the tail).
  let szIdx = -1;
  for (let i = parts.length - 1; i >= 1; i--) {
    const sz = parts[i].match(/\b([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\b/);
    if (sz) {
      out.state = sz[1].toUpperCase();
      out.zip5 = sz[2];
      szIdx = i;
      break;
    }
  }
  // City sits between the street and the state/zip part. If we found
  // state+zip at index N, the city is at N-1 (when N-1 > 0). Otherwise
  // fall back to parts[1] if it's the only piece after the street.
  if (szIdx > 1) {
    out.cityRaw = parts[szIdx - 1];
    out.city = normalizeCity(parts[szIdx - 1]);
  } else if (szIdx === -1 && parts.length >= 2) {
    out.cityRaw = parts[1];
    out.city = normalizeCity(parts[1]);
  }
  return out;
}

/**
 * Pull a comparable ParsedAddr out of an Apify Zillow row. The actor
 * usually returns an `address` object with discrete fields; fall back to
 * parsing the joined string if not.
 */
function parseAddressFromRow(row: any): ParsedAddr {
  /**
   * The current actor uses `listingAddress` while older actor builds used
   * `address.streetAddress`. Parse the full address first so a sparse object
   * (for example, one with only `full`) still participates in the strong
   * identifier checks below, then let discrete fields override it.
   */
  const parseAddressValue = (value: any): ParsedAddr => {
    if (typeof value === "string") return parseAddressString(value);
    if (!value || typeof value !== "object") return {};

    const full = typeof value.full === "string"
      ? parseAddressString(value.full)
      : {};
    const out: ParsedAddr = { ...full };
    const street = String(
      value.streetAddress ??
      value.street ??
      value.addressLine1 ??
      value.line1 ??
      "",
    ).trim();
    const designatedStreet = parseDesignatedUnit(street);
    addUnit(out, designatedStreet.unit);
    const m = designatedStreet.withoutUnit.match(/^(\d+\w?)\s+(.+)$/);
    if (m) {
      out.streetNum = m[1];
      out.streetName = normalizeStreetName(m[2]);
    }
    for (const rawUnit of [value.subpremise, value.unit, value.unitNumber]) {
      if (rawUnit == null || typeof rawUnit === "object") continue;
      const text = String(rawUnit).trim();
      const designated = parseDesignatedUnit(text);
      addUnit(out, designated.unit ?? normalizeUnit(text));
    }
    if (value.city) {
      out.cityRaw = String(value.city);
      out.city = normalizeCity(out.cityRaw);
    }
    const state = value.state ?? value.stateCode;
    if (state) out.state = String(state).toUpperCase().slice(0, 2);
    const zip = value.zipcode ?? value.zipCode ?? value.postalCode ?? value.zip;
    if (zip) out.zip5 = String(zip).slice(0, 5);
    return out;
  };

  // Prefer the explicit current-actor field, but retain the old field and
  // string fallbacks for rows produced by previous actor versions.
  for (const value of [row?.listingAddress, row?.address]) {
    const parsed = parseAddressValue(value);
    if (
      parsed.streetNum ||
      parsed.streetName ||
      parsed.zip5 ||
      parsed.state ||
      parsed.city
    ) {
      for (const rawUnit of [row?.subpremise, row?.unit, row?.unitNumber]) {
        if (rawUnit == null || typeof rawUnit === "object") continue;
        const text = String(rawUnit).trim();
        const designated = parseDesignatedUnit(text);
        addUnit(parsed, designated.unit ?? normalizeUnit(text));
      }
      return parsed;
    }
  }

  // Some actor responses flatten the address at the row level.
  const flattened = parseAddressString(
    typeof row?.streetAddress === "string"
      ? row.streetAddress
      : typeof row?.fullAddress === "string"
        ? row.fullAddress
        : "",
  );
  for (const rawUnit of [row?.subpremise, row?.unit, row?.unitNumber]) {
    if (rawUnit == null || typeof rawUnit === "object") continue;
    const text = String(rawUnit).trim();
    const designated = parseDesignatedUnit(text);
    addUnit(flattened, designated.unit ?? normalizeUnit(text));
  }
  return flattened;
}

interface MatchDecision {
  accept: boolean;
  reason: string;
  cityMismatch: boolean;
  matched: string[];
  mismatched: string[];
}

function actorInvalidReason(row: any): string | null {
  if (!row || typeof row !== "object") return null;
  const explicitlyInvalid =
    row.isValid === false ||
    row.valid === false ||
    String(row.status ?? "").toLowerCase() === "invalid";
  const reason = [
    row.invalidReason,
    row.invalid_reason,
    row.errorMessage,
    row.error_message,
    row.error,
    row.reason,
  ].find((value) => typeof value === "string" && value.trim());
  return explicitlyInvalid && typeof reason === "string"
    ? reason.trim()
    : explicitlyInvalid
      ? "actor marked row invalid"
      : null;
}

/**
 * Decide whether a Zillow row is the same property the caller asked for.
 *
 * Hard reject when any of street#, normalized street name, ZIP5, or state
 * disagree (those are strong identifiers). City is soft: a mismatch is
 * recorded and logged but never blocks acceptance. If we lack the data to
 * compare a field on either side, that field is skipped rather than treated
 * as a mismatch — this keeps the matcher tolerant of sparse rows.
 */
function decideAddressMatch(googleParsed: ParsedAddr, row: any): MatchDecision {
  const invalidReason = actorInvalidReason(row);
  if (invalidReason) {
    return {
      accept: false,
      reason: `actor invalid: ${invalidReason}`,
      cityMismatch: false,
      matched: [],
      mismatched: [],
    };
  }
  const zillow = parseAddressFromRow(row);
  const matched: string[] = [];
  const mismatched: string[] = [];

  if (googleParsed.unitConflict || zillow.unitConflict) {
    return { accept: false, reason: "contradictory unit identifiers", cityMismatch: false, matched, mismatched: ["unit"] };
  }
  if (!googleParsed.unit && zillow.unit) {
    return { accept: false, reason: "unexpected unit in Zillow address", cityMismatch: false, matched, mismatched: ["unit"] };
  }

  const check = (field: keyof ParsedAddr, hard: boolean): "ok" | "diff" | "skip" => {
    const g = googleParsed[field];
    const z = zillow[field];
    if (!g || !z) return "skip";
    if (g === z) { matched.push(field); return "ok"; }
    mismatched.push(field);
    return "diff";
  };

  const streetNum = check("streetNum", true);
  const streetName = check("streetName", true);
  const zip = check("zip5", true);
  const state = check("state", true);
  const cityRes = check("city", false);

  if (streetNum === "diff") return { accept: false, reason: "street number mismatch", cityMismatch: false, matched, mismatched };
  if (zip === "diff")       return { accept: false, reason: "ZIP mismatch",            cityMismatch: false, matched, mismatched };
  if (state === "diff")     return { accept: false, reason: "state mismatch",          cityMismatch: false, matched, mismatched };
  if (streetName === "diff")return { accept: false, reason: "street name mismatch",    cityMismatch: false, matched, mismatched };

  // A requested unit is a required property identifier. It must be explicit
  // in Zillow's parsed address and must agree everywhere Zillow supplies it.
  // In particular, a building-level or sparse ZIP-only row cannot satisfy a
  // unit-address request.
  if (googleParsed.unit) {
    if (zillow.unitConflict) {
      mismatched.push("unit");
      return { accept: false, reason: "contradictory Zillow unit identifiers", cityMismatch: false, matched, mismatched };
    }
    if (!zillow.unit) {
      return { accept: false, reason: "requested unit missing from Zillow address", cityMismatch: false, matched, mismatched };
    }
    if (googleParsed.unit !== zillow.unit) {
      mismatched.push("unit");
      return { accept: false, reason: "unit mismatch", cityMismatch: false, matched, mismatched };
    }
    matched.push("unit");
  }

  // Require at least one strong identifier to actually have matched —
  // otherwise we have nothing to base acceptance on (e.g. an unparseable
  // input). Without this, an empty Google parse would accept anything.
  const strongMatched = matched.some(f => f === "streetNum" || f === "zip5");
  if (!strongMatched) {
    return { accept: false, reason: "no strong identifier matched", cityMismatch: false, matched, mismatched };
  }

  const cityMismatch = cityRes === "diff";
  return {
    accept: true,
    reason: cityMismatch ? "soft accept (city mismatch ignored)" : "full match",
    cityMismatch,
    matched,
    mismatched,
  };
}

/** Exposed for regression tests and diagnostics without making an Apify call. */
export function evaluateZillowAddressMatch(address: string, row: unknown): MatchDecision {
  return decideAddressMatch(parseAddressString(address), row);
}

/** Re-cased "St Petersburg" → "St Petersburg" (Title Case) for display. */
function toTitleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Normalize Zillow's home-type strings into our restricted set.
 * Zillow values seen in the wild: SINGLE_FAMILY, CONDO, TOWNHOUSE,
 * MULTI_FAMILY, MANUFACTURED, LOT, APARTMENT, "Single Family Residence", etc.
 */
function normalizePropertyType(raw: unknown): PropertyTypeNorm | "" {
  if (!raw) return "";
  const s = String(raw).toUpperCase().replace(/[^A-Z]/g, "");
  if (s.includes("CONDO") || s === "APARTMENT") return "Condo";
  if (s.includes("TOWN")) return "Townhome";
  if (s.includes("VILLA")) return "Villa";
  if (s.includes("MULTI")) return "Multifamily";
  if (s.includes("MANUFACTURED") || s.includes("MOBILE")) return "Manufactured";
  if (s.includes("LOT") || s.includes("LAND")) return "Land";
  if (s.includes("SINGLE") || s.includes("SFR") || s.includes("HOUSE")) return "Single Family";
  return "Other";
}

/**
 * Convert HOA fee into a monthly number. Zillow exposes either
 * `monthlyHoaFee` (already monthly) or `hoaFee` with a frequency like
 * "Annually" / "Quarterly". We coerce everything to monthly.
 */
function normalizeHoaMonthly(raw: any): number | null {
  if (raw == null) return null;
  // Simple numeric/monthly cases.
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return num(raw);
  // Object cases: { value, frequency } or { amount, period }.
  const value = num(raw.value ?? raw.amount ?? raw.fee);
  if (value == null) return null;
  const freq = String(raw.frequency ?? raw.period ?? raw.unit ?? "monthly").toLowerCase();
  if (freq.startsWith("ann") || freq.includes("year")) return Math.round((value / 12) * 100) / 100;
  if (freq.startsWith("quart")) return Math.round((value / 3) * 100) / 100;
  if (freq.startsWith("semi")) return Math.round((value / 6) * 100) / 100;
  return value; // monthly by default
}

/** Read a numeric amount from either a legacy scalar or a current actor
 * amount object such as `{ amount, currency, formatted }`. */
function amountValue(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const value = raw as Record<string, unknown>;
  return value.amount ??
    value.value ??
    value.price ??
    value.unformattedPrice ??
    value.formatted ??
    null;
}

function pickAddress(p: any): string {
  if (typeof p.listingAddress === "string") return p.listingAddress;
  if (typeof p.listingAddress?.full === "string") return p.listingAddress.full;
  if (typeof p.address === "string") return p.address;
  const a = p.listingAddress ?? p.address ?? {};
  return [
    a.streetAddress ?? a.street ?? a.addressLine1,
    a.city,
    a.state,
    a.zipcode ?? a.zipCode ?? a.postalCode,
  ].filter(Boolean).join(", ");
}

/**
 * Extract every photo URL we can find in a raw Zillow/Apify property
 * blob. Apify returns different shapes depending on which actor was
 * used (`photos`, `images`, `responsivePhotos`, `originalPhotos`,
 * `mediaContents`, etc.) so we walk a known set of candidate fields,
 * pull every string url, dedupe, and return a flat string[]. The
 * downstream `PropertyScenario.photos` contract is still `string[]`
 * to avoid breaking existing consumers (Cash Buy, Seller, the
 * `property_cache.normalized` blob already stored).
 *
 * Data-safety:
 *   - skips empty / non-http urls
 *   - dedupes (preserves insertion order so the first/primary photo
 *     wins for `primaryPhotoUrl`)
 *   - never throws: returns [] for any unexpected shape
 */
export function pickPhotos(p: any): string[] {
  if (!p || typeof p !== "object") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<object>();
  const push = (raw: any) => {
    const url =
      typeof raw === "string"
        ? raw
        : raw?.url
          ?? raw?.href
          ?? raw?.src
          ?? raw?.imgSrc
          ?? raw?.hiResImageLink
          ?? raw?.image
          ?? raw?.mixedSources?.jpeg?.[0]?.url
          ?? raw?.mixedSources?.webp?.[0]?.url
          ?? null;
    if (typeof url !== "string") return;
    const trimmed = url.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  const arrayFields = [
    "photos",
    "images",
    "imageUrls",
    "photoUrls",
    "responsivePhotos",
    "originalPhotos",
    "carouselPhotos",
    "propertyImages",
    "listingPhotos",
    "propertyPhotos",
  ];
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 4 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(item => visit(item, depth + 1));
      return;
    }

    // The current actor names its primary image `mainImage`. Visit it before
    // the gallery so the normalized first photo remains the primary photo.
    push(node.mainImage);
    push(node.mainImageUrl);

    for (const f of arrayFields) {
      const value = node[f];
      if (Array.isArray(value)) value.forEach(push);
    }

    // `media` / `mediaContents` are often arrays of objects with a
    // `mediaUrl` or nested `images[]`.
    for (const f of ["media", "mediaContents"]) {
      const value = node[f];
      if (Array.isArray(value)) {
        for (const media of value) {
          if (!media) continue;
          push(media.mediaUrl ?? media.url ?? media);
          if (Array.isArray(media.images)) media.images.forEach(push);
        }
      }
    }

    // Singletons.
    push(node.imgSrc);
    push(node.hiResImageLink);
    push(node.primaryPhotoUrl);
    push(node.attributionInfo?.photoUrl);

    // Common actor wrappers. This is deliberately bounded and does not
    // recurse through arbitrary response fields.
    for (const key of ["property", "listing", "home", "data", "result"]) {
      visit(node[key], depth + 1);
    }
  };

  visit(p, 0);
  return out;
}

function pickDescription(p: any): string {
  return String(p.description ?? p.homeDescription ?? p.listingDescription ?? p.caption ?? "");
}

// ── Insurance-clue parser ───────────────────────────────────────────
/**
 * Scan a free-form listing description for insurance-relevant features.
 * All `false`/null distinctions matter: `null` means "not mentioned",
 * `true`/`false` mean we found explicit language either way (we never
 * assert false unless the description directly negates the feature, which
 * is uncommon — so most negatives stay null).
 */
export function parseInsuranceClues(description: string): ParsedInsuranceClues {
  const clues: ParsedInsuranceClues = {
    roofYear: null,
    roofConditionText: null,
    hasImpactWindows: null,
    hasImpactDoors: null,
    hasImpactGarageDoor: null,
    hasHurricaneShutters: null,
    updatedElectrical: null,
    updatedPlumbing: null,
    updatedHVAC: null,
    floodZoneMentioned: null,
    windMitigationMentioned: null,
    rawMatchedPhrases: [],
  };
  if (!description) return clues;
  const text = description.toLowerCase();
  const matched = new Set<string>();

  const record = (phrase: string) => matched.add(phrase);

  // Roof year: capture phrases like "new roof 2021", "roof replaced in 2020",
  // "2022 roof", "roof (2019)". Accept any 4-digit year 1950..currentYear+1.
  const currentYear = new Date().getFullYear();
  const yearPatterns: RegExp[] = [
    /\b(?:new|newer|recently\s+replaced|replaced|installed|updated)\s+roof[^.\n]{0,40}?(\b(?:19|20)\d{2}\b)/i,
    /\broof[^.\n]{0,40}?(?:replaced|installed|updated|new)[^.\n]{0,20}?(\b(?:19|20)\d{2}\b)/i,
    /\b(\b(?:19|20)\d{2}\b)\s+roof\b/i,
    /\broof\s*\(?\s*(\b(?:19|20)\d{2}\b)\s*\)?/i,
  ];
  for (const re of yearPatterns) {
    const m = text.match(re);
    if (m) {
      const year = Number(m[1]);
      if (year >= 1950 && year <= currentYear + 1) {
        clues.roofYear = year;
        record(m[0]);
        break;
      }
    }
  }

  // Roof condition language (independent of year).
  const roofCondRe = /\b(new roof|newer roof|recently replaced roof|roof recently replaced|roof replacement|updated roof|brand new roof)\b/i;
  const roofCondMatch = text.match(roofCondRe);
  if (roofCondMatch) {
    clues.roofConditionText = roofCondMatch[0];
    record(roofCondMatch[0]);
  }

  // Impact / hurricane features. We deliberately distinguish windows, doors,
  // and garage doors because insurers price them separately.
  const check = (key: keyof ParsedInsuranceClues, patterns: RegExp[]) => {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        (clues as any)[key] = true;
        record(m[0]);
        return;
      }
    }
  };

  // Negation-aware feature detection: skip matches preceded by "no", "not",
  // "without", "lacks", or "missing" within ~3 words (e.g. "no impact windows"
  // should NOT set hasImpactWindows=true). We strip those phrases out of the
  // search text up-front so the existing positive regexes work as intended.
  const NEG = /\b(no|not|without|lacks|lacking|missing|none)\s+([a-z\- ]{0,30}?)\b/gi;
  const positiveText = text.replace(NEG, "");
  const checkPos = (key: keyof ParsedInsuranceClues, patterns: RegExp[]) => {
    for (const re of patterns) {
      const m = positiveText.match(re);
      if (m) {
        (clues as any)[key] = true;
        record(m[0]);
        return;
      }
    }
  };

  checkPos("hasImpactWindows", [
    /\b(impact|hurricane[- ]impact|hurricane[- ]rated)\s+windows?\b/i,
    /\bimpact[- ]rated\s+windows?\b/i,
    /\bhurricane\s+windows?\b/i,
  ]);
  checkPos("hasImpactDoors", [
    /\b(impact|hurricane[- ]impact|hurricane[- ]rated)\s+doors?\b/i,
    /\bimpact[- ]rated\s+doors?\b/i,
  ]);
  checkPos("hasImpactGarageDoor", [
    /\bhurricane[- ]rated\s+garage\s+door\b/i,
    /\bimpact\s+garage\s+door\b/i,
    /\bimpact[- ]rated\s+garage\b/i,
  ]);
  checkPos("hasHurricaneShutters", [
    /\b(hurricane|storm|accordion|roll[- ]down)\s+shutters?\b/i,
  ]);
  checkPos("updatedElectrical", [
    /\b(updated|new|new(ly)?\s+installed|upgraded)\s+electrical\b/i,
    /\belectrical\s+(updated|upgraded|replaced)\b/i,
  ]);
  checkPos("updatedPlumbing", [
    /\b(updated|new|upgraded|re-?piped|repipe)\s+plumbing\b/i,
    /\bplumbing\s+(updated|upgraded|replaced|repiped)\b/i,
  ]);
  checkPos("updatedHVAC", [
    /\b(updated|new|upgraded|replaced)\s+(hvac|a\/?c|air\s+conditioning|ac\s+unit)\b/i,
    /\b(hvac|a\/?c|air\s+conditioning)\s+(updated|upgraded|replaced|new)\b/i,
  ]);
  // Flood zone: use raw text (not positiveText) so "not in a flood zone"
  // still flags the topic as mentioned — but record whether it was negated.
  if (/\bflood\s+zone\b/i.test(text)) {
    clues.floodZoneMentioned = true;
    record(text.match(/[^.]*\bflood\s+zone\b[^.]*/i)?.[0]?.trim() ?? "flood zone");
  }
  checkPos("windMitigationMentioned", [
    /\bwind\s+mitigation\b/i,
    /\bwind[- ]mit\b/i,
  ]);

  clues.rawMatchedPhrases = Array.from(matched);
  return clues;
}

// ── Insurance policy-type rule ──────────────────────────────────────
export function derivePolicyType(
  propertyType: PropertyTypeNorm | "",
  occupancy: OccupancyType,
): "HO3" | "HO6" | "DP3" | "" {
  if (!propertyType) return "";
  // Condos / Townhomes are always HO6 regardless of occupancy.
  if (propertyType === "Condo" || propertyType === "Townhome") return "HO6";
  // Detached residential: HO3 for owner-occupied, DP3 for investment.
  const detached: PropertyTypeNorm[] = ["Single Family", "Multifamily", "Manufactured", "Other"];
  if (detached.includes(propertyType)) {
    if (occupancy === "Investment") return "DP3";
    return "HO3"; // Primary, Secondary, or unspecified
  }
  return ""; // Land has no homeowner policy
}

// ── Top-level normalize ─────────────────────────────────────────────
// Minimum value (USD) we will accept as a *purchase* price. Anything below
// this is almost certainly a monthly rent figure and must not flow into
// purchase-price / loan-amount calculations.
const MIN_PURCHASE_PRICE = 20_000;

// ── Listing activity helpers ────────────────────────────────────────
// Apify's Zillow actor returns priceHistory, daysOnZillow, pageViewCount,
// and favoriteCount inconsistently — depends on the page, the listing
// status, and the actor build. Everything here is defensive: any field we
// can't confidently read becomes null and the UI labels it Unavailable.

function parsePriceHistoryDate(v: unknown): string | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n) && n > 0) {
    // Apify sometimes returns seconds, sometimes ms — heuristic split.
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function extractListingActivity(row: any): {
  priceHistory: Array<{ date: string; price: number | null; event: string }>;
  listDate: string | null;
  daysOnZillow: number | null;
  pageViewCount: number | null;
  favoriteCount: number | null;
  priorPriceCuts: number | null;
} {
  // priceHistory: sort most-recent first, keep 6, count price-decrease events.
  const rawHistory = Array.isArray(row.priceHistory) ? row.priceHistory : [];
  const normalizedHistory = rawHistory
    .map((h: any) => ({
      date: parsePriceHistoryDate(h?.date ?? h?.time) ?? "",
      price: num(h?.price),
      event: typeof h?.event === "string" ? h.event : (typeof h?.priceChangeReason === "string" ? h.priceChangeReason : ""),
    }))
    .filter((h: { date: string }) => !!h.date)
    .sort((a: { date: string }, b: { date: string }) => (a.date < b.date ? 1 : -1));
  const priceHistory = normalizedHistory.slice(0, 6);

  let priorPriceCuts = 0;
  for (let i = 0; i < normalizedHistory.length - 1; i++) {
    const cur = normalizedHistory[i];
    const prev = normalizedHistory[i + 1];
    const ev = (cur.event || "").toLowerCase();
    if ((ev.includes("price") && (ev.includes("change") || ev.includes("cut") || ev.includes("drop"))) &&
        cur.price != null && prev.price != null && cur.price < prev.price) {
      priorPriceCuts++;
    }
  }

  // List date: prefer the most recent "Listed for sale" event, else the
  // actor's own datePostedString.
  let listDate: string | null = null;
  for (const h of normalizedHistory) {
    const ev = (h.event || "").toLowerCase();
    if (ev.includes("listed") && (ev.includes("sale") || ev.includes("market"))) {
      listDate = h.date;
      break;
    }
  }
  if (!listDate) {
    const posted = row.datePostedString ?? row.datePosted ?? row.hdpData?.homeInfo?.datePosted;
    listDate = parsePriceHistoryDate(posted);
  }

  // daysOnZillow: trust Apify when present, else derive from listDate.
  let daysOnZillow: number | null = null;
  const rawDom = num(row.daysOnZillow ?? row.hdpData?.homeInfo?.daysOnZillow);
  if (rawDom != null && rawDom >= 0) daysOnZillow = Math.round(rawDom);
  else if (listDate) {
    const diff = Date.now() - new Date(listDate + "T00:00:00Z").getTime();
    if (diff > 0) daysOnZillow = Math.floor(diff / 86_400_000);
  }

  const pageViewCount = num(row.pageViewCount ?? row.hdpData?.homeInfo?.pageViewCount);
  const favoriteCount = num(row.favoriteCount ?? row.hdpData?.homeInfo?.favoriteCount);

  return {
    priceHistory,
    listDate,
    daysOnZillow,
    pageViewCount,
    favoriteCount,
    priorPriceCuts: normalizedHistory.length > 0 ? priorPriceCuts : null,
  };
}

function normalizeOne(row: any): PropertyScenario {
  const description = pickDescription(row);
  const propertyType = normalizePropertyType(row.homeType ?? row.propertyType ?? row.hdpData?.homeInfo?.homeType);

  // Detect whether the active Zillow listing is a rental. When it is,
  // `row.price` is the monthly rent — NOT a sale price — and must be
  // discarded for purchase-price purposes.
  const homeStatusRaw = String(
    row.homeStatus ?? row.listingStatus ?? row.hdpData?.homeInfo?.homeStatus ?? ""
  ).toUpperCase();
  const isRentalListing =
    homeStatusRaw.includes("FOR_RENT") ||
    homeStatusRaw.includes("RENTAL") ||
    homeStatusRaw === "RENT";

  // Detect sold status. When a property is sold, we prefer its actual
  // sale price over the (now-stale) listing price or Zestimate so the
  // purchase-price field stays stable for scenarios built around the
  // sold value.
  const isSold =
    homeStatusRaw.includes("SOLD") ||
    homeStatusRaw === "RECENTLY_SOLD";
  const rawSoldPrice = num(
    amountValue(
      row.lastSoldPrice ?? row.soldPrice ?? row.hdpData?.homeInfo?.lastSoldPrice,
    ),
  );
  const soldPrice =
    isSold && rawSoldPrice != null && rawSoldPrice >= MIN_PURCHASE_PRICE
      ? rawSoldPrice
      : null;
  const soldDateRaw = row.dateSold ?? row.lastSoldDate ?? row.hdpData?.homeInfo?.dateSold;
  const soldDate = (() => {
    if (!isSold || !soldDateRaw) return null;
    const n = typeof soldDateRaw === "number" ? soldDateRaw : Number(soldDateRaw);
    if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
    const d = new Date(String(soldDateRaw));
    return isNaN(d.getTime()) ? null : d.toISOString();
  })();

  // Rent Zestimate — Zillow's monthly rent estimate. Captured separately
  // and never permitted to populate the purchase price.
  const rentZestimate = num(
    row.rentZestimate ?? row.rentZestimateValue ?? row.zestimateRent ?? row.monthlyRent
  );

  // Home-value Zestimate. Important: do NOT fall back to
  // `priceHistory[0].price` here — the most recent priceHistory event can
  // be a rental listing event, which would inject rent into the home value.
  const rawZestimate = num(row.zestimate ?? row.zestimateValue);
  const zestimate =
    rawZestimate != null && rawZestimate >= MIN_PURCHASE_PRICE ? rawZestimate : null;

  // Listing price — trust the current actor's `listingPrice.amount` or the
  // legacy scalar fields for sale listings, never for rentals. Also reject
  // obvious rent values.
  // The current actor wraps this as `{ amount, currency, formatted }`.
  const rawListingPrice = num(amountValue(
    row.listingPrice ?? row.price ?? row.listPrice ?? row.unformattedPrice,
  ));
  const listingPrice =
    !isRentalListing && rawListingPrice != null && rawListingPrice >= MIN_PURCHASE_PRICE
      ? rawListingPrice
      : null;

  // Purchase price priority:
  //   1. last sold price (when the home is sold — stable, real transaction)
  //   2. active sale listing price (when actively for sale)
  //   3. home Zestimate (fallback estimate)
  //   4. null
  // Never fall back to rent.
  const purchasePrice = soldPrice ?? listingPrice ?? zestimate;
  const estimatedHomeValue = soldPrice ?? zestimate ?? listingPrice;
  const clues = parseInsuranceClues(description);
  const activity = extractListingActivity(row);

  return {
    source: "Zillow via Apify",
    address: pickAddress(row),
    zillowUrl: String(row.propertyUrl ?? row.url ?? row.hdpUrl ?? row.detailUrl ?? ""),
    zestimate,
    listingPrice,
    purchasePrice,
    estimatedHomeValue,
    rentZestimate,
    hoaMonthly: normalizeHoaMonthly(row.monthlyHoaFee ?? row.hoaFee ?? row.hoa),
    propertyType,
    yearBuilt: num(row.yearBuilt),
    bedrooms: num(row.bedrooms),
    bathrooms: num(row.bathrooms),
    squareFeet: num(row.livingArea ?? row.livingAreaValue ?? row.squareFeet),
    lotSize: num(row.lotSize ?? row.lotAreaValue ?? row.lotAreaSize),
    photos: pickPhotos(row),
    listingDescription: description,
    parsedInsuranceClues: clues,
    insurancePolicyType: derivePolicyType(propertyType, ""),
    occupancyType: "",
    rawZillowData: row,
    lastPulledAt: new Date().toISOString(),
    isSold,
    soldPrice,
    soldDate,
    daysOnZillow: activity.daysOnZillow,
    listDate: activity.listDate,
    pageViewCount: activity.pageViewCount,
    favoriteCount: activity.favoriteCount,
    priorPriceCuts: activity.priorPriceCuts,
    priceHistory: activity.priceHistory,
  };
}

/**
 * Public entry point used by the route handler. Returns the normalized
 * scenario for the first Zillow result, or throws a descriptive error.
 */
export async function fetchZillowProperty(addressOrUrl: string): Promise<PropertyScenario> {
  const input = addressOrUrl?.trim();
  if (!input) throw new Error("Missing address or Zillow URL");

  // URL lookups bypass the address matcher — the URL itself uniquely
  // identifies the listing, so trust the actor's first row.
  if (isZillowUrl(input)) {
    const rows = await runApify(input);
    if (rows.length === 0) throw new Error("No Zillow results found for that address");
    const normalized = normalizeOne(rows[0]);
    const hasAnyValuation =
      normalized.zestimate != null || normalized.listingPrice != null || normalized.soldPrice != null;
    if (!normalized.address && !hasAnyValuation) {
      throw new Error("No Zillow results found for that address");
    }
    return normalized;
  }

  const googleParsed = parseAddressString(input);

  // Walk a list of rows and return the first one our matcher accepts.
  // Logs every per-row decision so a mistaken acceptance can be traced.
  const rejectedReasons: string[] = [];
  const pickAcceptable = (rows: unknown[], attemptLabel: string): { row: any; decision: MatchDecision } | null => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const decision = decideAddressMatch(googleParsed, row);
      if (decision.accept) return { row, decision };
      const detail = `${attemptLabel} row ${i + 1}: ${decision.reason}`;
      rejectedReasons.push(detail);
      console.warn("[zillow-validate] rejected", detail);
    }
    return null;
  };

  // Build an ordered list of query variants to try. We start with the
  // caller's input as-is, then progressively strip pieces that Zillow's
  // geocoder is known to choke on (country suffix, then city). Each
  // variant is tried at most once; duplicates are deduped so a property
  // with a missing field doesn't burn extra Apify calls.
  const variants: string[] = [];
  const pushVariant = (s: string | undefined | null) => {
    const v = (s ?? "").trim().replace(/\s+/g, " ");
    if (v && !variants.includes(v)) variants.push(v);
  };

  if (googleParsed.unit && googleParsed.streetNum && googleParsed.streetName) {
    // Unit aliases share a canonical query plan. Prefer country-free "Apt"
    // because Zillow indexes that form reliably, with one bounded "#"
    // alternative. City-present and city-free forms keep the historical
    // four-run ceiling, and every run retains the exact requested unit.
    const street = `${googleParsed.streetNum} ${googleParsed.streetName}`;
    const tail = googleParsed.state && googleParsed.zip5
      ? `${googleParsed.state} ${googleParsed.zip5}`
      : googleParsed.zip5 ?? googleParsed.state ?? "";
    const withCity = [googleParsed.cityRaw, tail].filter(Boolean).join(", ");
    const withoutCity = tail;
    pushVariant(`${street} Apt ${googleParsed.unit}${withCity ? `, ${withCity}` : ""}`);
    pushVariant(`${street} #${googleParsed.unit}${withCity ? `, ${withCity}` : ""}`);
    pushVariant(`${street} Apt ${googleParsed.unit}${withoutCity ? `, ${withoutCity}` : ""}`);
    pushVariant(`${street} #${googleParsed.unit}${withoutCity ? `, ${withoutCity}` : ""}`);
  } else {
    pushVariant(input);
    // Drop "USA" / "United States" — same data, but the actor sometimes
    // geocodes the country-suffixed form to nothing.
    pushVariant(stripCountrySuffix(input));
    if (googleParsed.streetNum && googleParsed.streetName) {
      const street = `${googleParsed.streetNum} ${googleParsed.streetName}`;
      // "<street>, <state> <zip>" — city omitted entirely. Most-likely
      // winner when Google and Zillow disagree on the city.
      if (googleParsed.state && googleParsed.zip5) {
        pushVariant(`${street}, ${googleParsed.state} ${googleParsed.zip5}`);
      }
      // "<street> <zip>" — even shorter; helps when the actor's
      // state-parser is the failure point.
      if (googleParsed.zip5) {
        pushVariant(`${street} ${googleParsed.zip5}`);
      }
    }
  }


  let picked: { row: any; decision: MatchDecision } | null = null;
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    let rows: unknown[];
    try {
      rows = await runApify(variant);
    } catch (err: any) {
      console.log(`[zillow-validate] attempt ${i + 1} threw:`, err?.message ?? err);
      continue;
    }
    if (rows.length === 0) {
      continue;
    }
    picked = pickAcceptable(rows, `attempt${i + 1}`);
    if (picked) break;
  }

  if (!picked) {
    const detail = rejectedReasons.length
      ? ` (${Array.from(new Set(rejectedReasons)).join("; ")})`
      : "";
    throw new Error(`No Zillow results found for that address${detail}`);
  }


  const normalized = normalizeOne(picked.row);

  // Stamp city metadata onto the response so the UI can choose whichever
  // city it wants to show. The Google city stays user-facing by default.
  const zillowAddr = parseAddressFromRow(picked.row);
  if (googleParsed.cityRaw) normalized.googleCity = googleParsed.cityRaw;
  if (zillowAddr.cityRaw) normalized.zillowCity = zillowAddr.cityRaw;
  normalized.displayCity =
    normalized.googleCity ?? (zillowAddr.city ? toTitleCase(zillowAddr.city) : undefined);
  normalized.cityMismatch = picked.decision.cityMismatch;

  const hasAnyValuation =
    normalized.zestimate != null || normalized.listingPrice != null || normalized.soldPrice != null;
  if (!normalized.address && !hasAnyValuation) {
    throw new Error("No Zillow results found for that address");
  }
  return normalized;
}
