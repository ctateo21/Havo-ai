// AI-powered weekly market analysis for For Sale listings.
//
// All OpenRouter calls live server-side; the frontend never sees the API key.
// Results are cached in Supabase (`listing_market_analyses`) and refreshed at
// most once per Friday-aligned week per listing.
//
// The model returns a rich structured JSON object (see `StructuredAnalysis`)
// shaped like a weekly seller-facing listing recap. We persist the JSON in
// `raw_anthropic_response` (a text column) and also mirror a handful of
// scalar fields (recommended_next_steps, data_limitations, confidence_level,
// price_review_recommended) into dedicated columns for back-compat and
// indexing.
import { completeWithOpenRouter } from "../openrouter";
import { withAiUser } from "../ai-usage";
import { supabaseAdmin } from "../supabase";
import { type RealtorScrapeResult } from "./realtor-apify";
import { getOrFetchRealtorComps, type RealtorCachedResult } from "./realtor-cache";

// ───────────────────────────── Types ──────────────────────────────────

export interface ListingCompInput {
  address?: string | null;
  price?: number | null;
  sqft?: number | null;
  pricePerSqft?: number | null;
  beds?: number | null;
  baths?: number | null;
  daysOnMarket?: number | null;
  status?: string | null;          // active | pending | sold
  notes?: string | null;
}

export interface PlatformEngagementInput {
  zillow?:  { views?: number | null; saves?: number | null } | null;
  realtor?: { views?: number | null; saves?: number | null } | null;
  redfin?:  { views?: number | null; saves?: number | null } | null;
  similarAverage?: { views?: number | null; saves?: number | null } | null;
}

export interface MarketStatsInput {
  medianPrice?: number | null;
  monthsOfSupply?: number | null;
  saleToListRatio?: number | null;
  averageDom?: number | null;
  marketLabel?: string | null;     // "buyer" | "seller" | "balanced"
}

export interface ListingInput {
  listingId: string;
  userId: string;
  address: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  normalizedPropertyKey?: string | null;

  // Pricing
  estimatedSalePrice?: number | null;
  listPrice?: number | null;
  zillowValue?: number | null;
  lastSoldPrice?: number | null;
  lastSoldDate?: string | null;

  // Physical
  propertyType?: string | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  lotSize?: number | string | null;
  yearBuilt?: number | null;
  hoa?: number | null;
  hasSolar?: boolean | null;

  // Listing/activity
  daysOnMarket?: number | null;
  listDate?: string | null;
  priorPriceCuts?: number | null;
  showingCount?: number | null;
  onlineViews?: number | null;
  onlineSaves?: number | null;
  photoCount?: number | null;
  primaryPhotoUrl?: string | null;

  // Seller economics
  netProceeds?: number | null;
  mortgagePayoff?: number | null;
  realtorCommissionPct?: number | null;
  sellerClosingCosts?: number | null;

  // Status & timestamps
  status?: string | null;
  scenarioUpdatedAt?: string | null;

  // Optional connected data (only sent when actually available)
  comps?: ListingCompInput[] | null;
  pendingComps?: ListingCompInput[] | null;
  soldComps?: ListingCompInput[] | null;
  platformEngagement?: PlatformEngagementInput | null;
  marketStats?: MarketStatsInput | null;
  priorAnalysisSummary?: string | null;
}

// ── Structured response shape (what Anthropic returns + we render) ──

export type StatusLabel =
  | "Competitive"
  | "Price Review Advised"
  | "Overpriced Risk"
  | "Insufficient Data";

export type ComparisonLabel = "faster" | "similar" | "slower" | "unavailable";
export type EngagementComparison = "higher" | "similar" | "lower" | "unavailable";

export interface ListingMetric {
  label: string;
  value: string;
  note?: string | null;
}

export interface StructuredComp {
  address?: string | null;
  price?: number | null;
  sqft?: number | null;
  pricePerSqft?: number | null;
  beds?: number | null;
  baths?: number | null;
  daysOnMarket?: number | null;
  status?: string | null;
  notes?: string | null;
}

export interface PlatformStat {
  views?: number | null;
  saves?: number | null;
}

export interface StructuredAnalysis {
  week_of: string;
  status_label: StatusLabel;
  listing_snapshot: {
    summary: string;
    metrics: ListingMetric[];
  };
  market_comps: {
    summary: string;
    comps: StructuredComp[];
  };
  similar_pending_sold: {
    summary: string;
    items: StructuredComp[];
  };
  days_on_market_analysis: {
    summary: string;
    subject_dom: number | null;
    average_comp_dom: number | null;
    comparison_label: ComparisonLabel;
  };
  platform_engagement: {
    summary: string;
    zillow: PlatformStat | null;
    realtor: PlatformStat | null;
    redfin: PlatformStat | null;
    comparison_to_similar: EngagementComparison;
  };
  price_drop_recommendation: {
    recommended: boolean;
    summary: string;
    suggested_price_low: number | null;
    suggested_price_high: number | null;
  };
  projected_sale_price: {
    projected_low: number | null;
    projected_high: number | null;
    summary: string;
  };
  next_steps: string[];
  market_context: {
    summary: string;
    stats: { label: string; value: string; note?: string | null }[];
  };
  data_limitations: string[];
  confidence_level: "low" | "medium" | "high";

  /**
   * Honest inventory of which real-estate data sources actually fed this
   * analysis. Computed deterministically by the server (NOT asked from the
   * model), so the UI can show the seller exactly what's connected vs not
   * connected, with a friendly reason for each missing source.
   */
  data_sources: {
    available: { source: string; detail?: string | null }[];
    missing:   { source: string; reason: string }[];
  };

  /**
   * URLs the Anthropic `web_search` tool actually fetched while preparing
   * this recap. Empty array when the model didn't call web search (e.g.
   * very thin prompts) or when web search is disabled.
   */
  citations: AnthropicCitation[];
}

export interface MarketAnalysisRecord {
  id: string;
  listing_id: string;
  property_address: string;
  analysis_week_of: string;     // YYYY-MM-DD
  generated_at: string;
  next_update_due_at: string;
  status: "draft" | "published" | "error";

  // Back-compat scalar fields (mirrored from the structured response)
  market_summary: string | null;
  pricing_analysis: string | null;
  comps_summary: string | null;
  online_interest_summary: string | null;
  showing_summary: string | null;
  recommended_next_steps: string[] | null;
  risk_flags: string[] | null;
  price_review_recommended: boolean | null;
  confidence_level: "low" | "medium" | "high" | null;
  data_limitations: string[] | null;
  error_message: string | null;

  // Rich structured payload — parsed from `raw_anthropic_response` on read.
  // Optional so callers that load older rows still typecheck.
  structured?: StructuredAnalysis | null;
}

// ──────────────────── Friday 8 AM ET cycle scheduling ────────────────
//
// One cycle per week. Each cycle starts Friday 08:00 AM America/New_York
// and ends the following Friday 07:59:59.999 AM ET. A saved analysis is
// considered current as long as `now < next_update_due_at` AND its
// `analysis_week_of` (the ET date of the cycle start) matches the
// current cycle. We use ET (not UTC) so a Thursday-night generation in
// the US doesn't expire at midnight UTC the same day.

const TZ = "America/New_York";

// How many ms to ADD to a UTC timestamp to get the ET wall-clock time
// as if it were UTC. Used to bridge JS's UTC-only Date API into an
// "ET wall clock" we can do day-of-week math on. DST-aware.
function etOffsetMs(at: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const wallAsUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour === 24 ? 0 : +m.hour, +m.minute, +m.second);
  return wallAsUtc - at.getTime();
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the most recent Friday 08:00 AM America/New_York that is
 * <= `now`, as a real UTC Date. DST-aware (recomputes offset at the
 * candidate moment in case DST changed between now and the candidate).
 */
function fridayEightAmETOnOrBefore(now: Date): Date {
  const offset = etOffsetMs(now);
  // ET wall clock for `now`, expressed as a Date whose UTC parts match
  // the ET wall clock. Day-of-week math on this Date is ET-correct.
  const etWall = new Date(now.getTime() + offset);
  const dow = etWall.getUTCDay();           // 0=Sun..6=Sat
  let daysBack = (dow - 5 + 7) % 7;          // distance back to a Friday
  // If today IS Friday but before 08:00 ET, the active cycle is still
  // last Friday's.
  if (dow === 5 && (etWall.getUTCHours() < 8)) {
    daysBack = 7;
  }
  const candidate = new Date(Date.UTC(
    etWall.getUTCFullYear(), etWall.getUTCMonth(), etWall.getUTCDate() - daysBack,
    8, 0, 0, 0,
  ));
  // `candidate` currently holds an ET wall clock pretending to be UTC.
  // Convert to a true UTC instant by subtracting the offset at THAT
  // moment (DST may differ from `now`'s offset, e.g. across DST changes).
  let utc = candidate.getTime() - offset;
  const offsetThen = etOffsetMs(new Date(utc));
  if (offsetThen !== offset) utc = candidate.getTime() - offsetThen;
  return new Date(utc);
}

/**
 * Returns the ET date (YYYY-MM-DD) that the cycle started on. We use
 * the ET calendar date — not UTC — because some Fridays at 08:00 ET
 * fall on a different UTC calendar date.
 */
function etDateString(d: Date): string {
  const offset = etOffsetMs(d);
  const wall = new Date(d.getTime() + offset);
  return wall.toISOString().slice(0, 10);
}

export function currentWeekWindow(now: Date = new Date()) {
  const cycleStart = fridayEightAmETOnOrBefore(now);
  // Next cycle: cycleStart + 7 days (recompute the next Friday 8 AM ET
  // properly so DST transitions are handled).
  const next = fridayEightAmETOnOrBefore(new Date(cycleStart.getTime() + 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000));
  return {
    weekOf: cycleStart,
    weekOfStr: etDateString(cycleStart),
    nextUpdateDueAt: next,
  };
}

export function isStale(record: { analysis_week_of: string; next_update_due_at: string }, now: Date = new Date()): boolean {
  const cur = currentWeekWindow(now);
  if (new Date(record.next_update_due_at).getTime() <= now.getTime()) return true;
  // analysis_week_of is the ET date of the cycle start; compare lexically.
  if (record.analysis_week_of < cur.weekOfStr) return true;
  return false;
}

// ─────────────────────── Anthropic prompt + call ─────────────────────

export function buildPrompt(input: ListingInput, weekOfStr: string): string {
  // Strip nulls/undefined/empty so the model isn't told "null" over and over
  // — easier to reason about which fields it actually has.
  const known: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    known[k] = v;
  }

  // The schema we want back. Kept inline (instead of a JSON.parse-able
  // template) so the model treats it as a description, not a value.
  const schema = `{
  "week_of": "${weekOfStr}",
  "status_label": "Competitive | Price Review Advised | Overpriced Risk | Insufficient Data",
  "listing_snapshot": {
    "summary": "1-2 sentences for the seller about where this listing stands this week",
    "metrics": [
      { "label": "List price",       "value": "$ formatted",   "note": "optional context" },
      { "label": "Price / sqft",     "value": "$ formatted",   "note": "" },
      { "label": "Days on market",   "value": "string or 'Unavailable'", "note": "" },
      { "label": "Avg DOM (similar)", "value": "string or 'Unavailable'", "note": "" },
      { "label": "Beds / baths",     "value": "", "note": "" },
      { "label": "Sqft",             "value": "", "note": "" },
      { "label": "Last sold",        "value": "string or 'Unavailable'", "note": "" }
    ]
  },
  "market_comps": {
    "summary": "Seller-facing read on the comps we have, OR clearly say comps are not connected.",
    "comps": [ { "address": "...", "price": 0, "sqft": 0, "pricePerSqft": 0, "beds": 0, "baths": 0, "daysOnMarket": 0, "status": "active|pending|sold", "notes": "" } ]
  },
  "similar_pending_sold": {
    "summary": "What nearby pending/sold homes suggest about this listing's price.",
    "items": [ { "address": "...", "price": 0, "status": "pending|sold", "daysOnMarket": 0, "notes": "" } ]
  },
  "days_on_market_analysis": {
    "summary": "Plain-English read on whether this listing is moving faster, slower, or in line with similar homes.",
    "subject_dom": null,
    "average_comp_dom": null,
    "comparison_label": "faster|similar|slower|unavailable"
  },
  "platform_engagement": {
    "summary": "Are views/saves strong vs similar homes? Are views high but saves low (browse-only)? Etc.",
    "zillow":  { "views": null, "saves": null },
    "realtor": { "views": null, "saves": null },
    "redfin":  { "views": null, "saves": null },
    "comparison_to_similar": "higher|similar|lower|unavailable"
  },
  "price_drop_recommendation": {
    "recommended": false,
    "summary": "Why or why not. What the drop would accomplish (reset alerts, improve visibility, etc.) — or why more data is needed.",
    "suggested_price_low":  null,
    "suggested_price_high": null
  },
  "projected_sale_price": {
    "projected_low":  null,
    "projected_high": null,
    "summary": "How the range was determined and confidence in it."
  },
  "next_steps": [ "3 to 6 short, concrete action items the seller can take this week" ],
  "market_context": {
    "summary": "Local zip/city context (inventory, months supply, sale-to-list, average DOM, buyer/seller market) OR a clean 'not connected yet' note.",
    "stats": [ { "label": "Months of supply", "value": "string or 'Unavailable'", "note": "" } ]
  },
  "data_limitations": [ "specific missing fields that would meaningfully improve this analysis" ],
  "confidence_level": "low | medium | high"
}`;

  return [
    "You are a real estate listing advisor preparing a weekly market briefing for the home seller.",
    "Speak directly to the seller in plain, friendly English. No jargon. No emojis.",
    "Explain why each metric matters in one short sentence.",
    "",
    "DATA RULES — you may use the `web_search` tool to fill gaps:",
    "0. Use the structured listing data below as the source of truth for THIS specific property (beds, baths, sqft, list price, Zestimate, DOM, lot, year built, HOA, last sold). Do NOT override these with web data — supplement only.",
    "1. You MAY (and should) call `web_search` to look up: nearby active listings, pending/sold homes in the same neighborhood, zip-level market stats (median price, months of supply, sale-to-list ratio, average DOM), and reputable local market reports (Redfin Data Center, Realtor.com Research, Homes.com market pages, brokerage market reports). Up to 5 searches total — use them wisely (search the zip + 'condo market', the building/community name, recent sold comps, etc.).",
    "2. NEVER invent a comp, address, price, DOM, page view, save, showing count, or market stat. Every concrete number must come from either (a) the structured listing data below, or (b) a web search result you actually fetched. If you can't ground a number, say it is unavailable.",
    "3. For `market_comps.comps` and `similar_pending_sold.items`: include any active/pending/sold homes you found via web search. Put a short attribution in `notes` (e.g. 'per Redfin', 'per Realtor.com'). If web search returns nothing useful, set to [] and explain.",
    "4. For `platform_engagement.zillow/realtor/redfin`: only fill in `views`/`saves` numbers if `platformEngagement` in the input has them OR a web result explicitly lists them (very rare — those are usually private to the listing owner). Otherwise leave null and use the `summary` to give a qualitative read on engagement based on DOM, price-cut history, and how active the local market is per your web research.",
    "5. If DOM is missing → set `subject_dom`/`average_comp_dom` to null, `comparison_label` to 'unavailable', and say so plainly. If `daysOnMarket` IS provided, USE it in `subject_dom` and reference it in the listing snapshot — don't say DOM is unavailable when it isn't.",
    "5b. If `priorPriceCuts` is provided and > 0, mention it in the listing snapshot and factor it into the price-drop recommendation (further drops have diminishing returns after multiple cuts).",
    "5c. If `onlineViews` or `onlineSaves` is provided, USE the actual number in `platform_engagement.zillow` instead of null. Still mark `comparison_to_similar` as 'unavailable' unless similar-listing engagement data is also provided.",
    "6. If you cannot project a sale range from the data → set `projected_low`/`projected_high` to null and explain in the summary what would be needed.",
    "7. Do NOT recommend a specific price drop range unless comp data supports it.",
    "8. When data is thin, default `status_label` to 'Insufficient Data' and `confidence_level` to 'low'. Still give 3–6 useful `next_steps` (e.g. add comps, refresh photos, connect platform stats).",
    "9. Respond with a SINGLE JSON object — no markdown, no preamble, no code fences.",
    "",
    `Today's "week_of" is ${weekOfStr} (Friday-aligned). Use that value verbatim.`,
    "",
    "Return EXACTLY this JSON shape (fill in the values; keep the keys):",
    schema,
    "",
    "Listing data available to you (JSON):",
    JSON.stringify(known, null, 2),
  ].join("\n");
}

export interface AnthropicCitation {
  url: string;
  title: string;
}

/**
 * Calls OpenRouter with native web search for live market context.
 * Existing weekly caching avoids unnecessary repeat generations.
 * Search costs are additional to model tokens. Returns JSON text PLUS a
 * flat list of unique citation URLs so the seller can see exactly which
 * pages fed the recap.
 */
export async function callMarketAi(prompt: string): Promise<{ raw: string; citations: AnthropicCitation[] }> {
  const response = await completeWithOpenRouter({
    purpose: "market",
    maxTokens: 8192,
    webSearch: true,
    system:
      "You are a careful, conservative real estate analyst writing a weekly listing recap for a home seller. " +
      "You analyze the structured listing data the user provides AND you may use the `web_search` tool to " +
      "look up live, public real-estate data for the listing's zip and city — active listings on Redfin, " +
      "Realtor.com, Homes.com, recently sold homes, neighborhood market reports, months of supply, " +
      "sale-to-list ratios, average days on market, and similar published market context. " +
      "When you cite a number from a web result, briefly attribute it in the `notes` or `summary` field " +
      "(e.g. 'per Redfin', 'per Realtor.com'). If neither the structured data nor a reputable web result " +
      "supports a comp, address, DOM, page view, save, or market stat, say it is unavailable instead of " +
      "guessing. You respond with a single valid JSON object and nothing else.",
    content: prompt,
  });
  const raw = response.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return { raw, citations: response.citations };
}

// ─────────────────────── JSON parsing helpers ────────────────────────

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      const v = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch { return null; }
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}
function asObjArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}
function asStatusLabel(v: unknown): StatusLabel {
  const s = asString(v);
  if (s === "Competitive" || s === "Price Review Advised" || s === "Overpriced Risk" || s === "Insufficient Data") {
    return s;
  }
  return "Insufficient Data";
}
function asComparisonLabel(v: unknown): ComparisonLabel {
  const s = asString(v);
  return s === "faster" || s === "similar" || s === "slower" ? s : "unavailable";
}
function asEngagementComparison(v: unknown): EngagementComparison {
  const s = asString(v);
  return s === "higher" || s === "similar" || s === "lower" ? s : "unavailable";
}
function asConfidence(v: unknown): "low" | "medium" | "high" {
  const s = asString(v);
  return s === "medium" || s === "high" ? s : "low";
}

function coerceMetric(o: Record<string, unknown>): ListingMetric {
  return {
    label: asString(o.label),
    value: asString(o.value, "Unavailable"),
    note: typeof o.note === "string" && o.note.trim() ? o.note : null,
  };
}
function coerceComp(o: Record<string, unknown>): StructuredComp {
  return {
    address: typeof o.address === "string" ? o.address : null,
    price: asNumberOrNull(o.price),
    sqft: asNumberOrNull(o.sqft),
    pricePerSqft: asNumberOrNull((o as any).pricePerSqft ?? (o as any).price_per_sqft),
    beds: asNumberOrNull(o.beds),
    baths: asNumberOrNull(o.baths),
    daysOnMarket: asNumberOrNull((o as any).daysOnMarket ?? (o as any).days_on_market ?? (o as any).dom),
    status: typeof o.status === "string" ? o.status : null,
    notes: typeof o.notes === "string" ? o.notes : null,
  };
}
function coercePlatformStat(o: unknown): PlatformStat | null {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const views = asNumberOrNull(r.views);
  const saves = asNumberOrNull(r.saves);
  if (views == null && saves == null) return null;
  return { views, saves };
}

/**
 * Coerce arbitrary Anthropic JSON into our `StructuredAnalysis` shape. We
 * are defensive here because the model occasionally returns slightly off
 * keys or wraps fields differently across runs.
 */
function coerceStructured(raw: Record<string, unknown> | null, weekOfStr: string): StructuredAnalysis {
  const r = raw ?? {};
  const snapshot = (r.listing_snapshot && typeof r.listing_snapshot === "object")
    ? r.listing_snapshot as Record<string, unknown>
    : {};
  const comps = (r.market_comps && typeof r.market_comps === "object")
    ? r.market_comps as Record<string, unknown>
    : {};
  const pending = (r.similar_pending_sold && typeof r.similar_pending_sold === "object")
    ? r.similar_pending_sold as Record<string, unknown>
    : {};
  const dom = (r.days_on_market_analysis && typeof r.days_on_market_analysis === "object")
    ? r.days_on_market_analysis as Record<string, unknown>
    : {};
  const engagement = (r.platform_engagement && typeof r.platform_engagement === "object")
    ? r.platform_engagement as Record<string, unknown>
    : {};
  const priceDrop = (r.price_drop_recommendation && typeof r.price_drop_recommendation === "object")
    ? r.price_drop_recommendation as Record<string, unknown>
    : {};
  const projection = (r.projected_sale_price && typeof r.projected_sale_price === "object")
    ? r.projected_sale_price as Record<string, unknown>
    : {};
  const context = (r.market_context && typeof r.market_context === "object")
    ? r.market_context as Record<string, unknown>
    : {};

  return {
    week_of: asString(r.week_of, weekOfStr),
    status_label: asStatusLabel(r.status_label),
    listing_snapshot: {
      summary: asString(snapshot.summary),
      metrics: asObjArray(snapshot.metrics).map(coerceMetric).filter(m => m.label || m.value),
    },
    market_comps: {
      summary: asString(comps.summary),
      comps: asObjArray(comps.comps).map(coerceComp),
    },
    similar_pending_sold: {
      summary: asString(pending.summary),
      items: asObjArray(pending.items).map(coerceComp),
    },
    days_on_market_analysis: {
      summary: asString(dom.summary),
      subject_dom: asNumberOrNull(dom.subject_dom),
      average_comp_dom: asNumberOrNull(dom.average_comp_dom),
      comparison_label: asComparisonLabel(dom.comparison_label),
    },
    platform_engagement: {
      summary: asString(engagement.summary),
      zillow:  coercePlatformStat(engagement.zillow),
      realtor: coercePlatformStat(engagement.realtor),
      redfin:  coercePlatformStat(engagement.redfin),
      comparison_to_similar: asEngagementComparison(engagement.comparison_to_similar),
    },
    price_drop_recommendation: {
      recommended: typeof priceDrop.recommended === "boolean" ? priceDrop.recommended : false,
      summary: asString(priceDrop.summary),
      suggested_price_low: asNumberOrNull(priceDrop.suggested_price_low),
      suggested_price_high: asNumberOrNull(priceDrop.suggested_price_high),
    },
    projected_sale_price: {
      projected_low: asNumberOrNull(projection.projected_low),
      projected_high: asNumberOrNull(projection.projected_high),
      summary: asString(projection.summary),
    },
    next_steps: asStringArray(r.next_steps),
    market_context: {
      summary: asString(context.summary),
      stats: asObjArray(context.stats).map(o => ({
        label: asString(o.label),
        value: asString(o.value, "Unavailable"),
        note: typeof o.note === "string" && o.note.trim() ? o.note : null,
      })).filter(s => s.label || s.value),
    },
    data_limitations: asStringArray(r.data_limitations),
    confidence_level: asConfidence(r.confidence_level),
    // Filled in deterministically by computeDataSources() after coercion.
    data_sources: { available: [], missing: [] },
    // Citations are filled in from the live Anthropic response on fresh
    // generations, or restored from the cached JSON for cache hits.
    citations: Array.isArray((r as any).citations)
      ? ((r as any).citations as unknown[])
          .map((c) => {
            if (!c || typeof c !== "object") return null;
            const url = typeof (c as any).url === "string" ? (c as any).url : null;
            const title = typeof (c as any).title === "string" ? (c as any).title : url;
            return url ? { url, title: title || url } : null;
          })
          .filter((x): x is AnthropicCitation => !!x)
      : [],
  };
}

/**
 * Deterministic, server-computed inventory of which real-estate data
 * sources actually fed this analysis. We do this in code (not in the
 * Anthropic prompt) so the answer is always honest and reproducible.
 *
 * "Available" entries describe what we DID feed Claude; "missing" entries
 * describe what we couldn't, with a friendly reason the seller will
 * understand.
 */
function computeDataSources(
  input: ListingInput,
  citations: AnthropicCitation[] = [],
  realtor?: RealtorScrapeResult | null,
): StructuredAnalysis["data_sources"] {
  const available: { source: string; detail?: string | null }[] = [];
  const missing:   { source: string; reason: string }[] = [];

  const hasSubject =
    (input.beds != null) || (input.baths != null) || (input.sqft != null) ||
    (input.zillowValue != null) || (input.listPrice != null);
  if (hasSubject) {
    const bits: string[] = [];
    if (input.beds != null && input.baths != null) bits.push(`${input.beds}bd/${input.baths}ba`);
    if (input.sqft != null) bits.push(`${input.sqft} sqft`);
    if (input.yearBuilt != null) bits.push(`built ${input.yearBuilt}`);
    if (input.zillowValue != null) bits.push(`Zestimate $${Math.round(input.zillowValue).toLocaleString()}`);
    available.push({ source: "Zillow (subject property)", detail: bits.join(" • ") || null });
  } else {
    missing.push({
      source: "Zillow (subject property)",
      reason: "No cached Zillow scrape for this address yet — open the listing once to fetch it.",
    });
  }

  if (input.daysOnMarket != null || input.listDate) {
    const parts: string[] = [];
    if (input.daysOnMarket != null) parts.push(`${input.daysOnMarket} days on market`);
    if (input.listDate) parts.push(`listed ${input.listDate}`);
    if (input.priorPriceCuts != null && input.priorPriceCuts > 0) parts.push(`${input.priorPriceCuts} prior price cut${input.priorPriceCuts === 1 ? "" : "s"}`);
    available.push({ source: "Zillow listing activity", detail: parts.join(" • ") || null });
  } else {
    missing.push({
      source: "Zillow listing activity (DOM, list date, price history)",
      reason: "Zillow didn't return priceHistory or daysOnZillow for this listing on the last pull.",
    });
  }

  const zillowEngagement = input.onlineViews != null || input.onlineSaves != null;
  if (zillowEngagement) {
    const parts: string[] = [];
    if (input.onlineViews != null) parts.push(`${input.onlineViews.toLocaleString()} views`);
    if (input.onlineSaves != null) parts.push(`${input.onlineSaves.toLocaleString()} saves`);
    available.push({ source: "Zillow views & saves", detail: parts.join(" • ") || null });
  } else {
    missing.push({
      source: "Zillow views & saves",
      reason: "Zillow only exposes these to the listing owner — connect a Zillow Premier Agent or owner-dashboard feed to fill this in.",
    });
  }

  const hasComps = !!(input.comps && input.comps.length);
  if (hasComps) {
    available.push({ source: "Active comps", detail: `${input.comps!.length} comp${input.comps!.length === 1 ? "" : "s"} provided` });
  } else {
    missing.push({
      source: "Active comps",
      reason: "No MLS or comp-search source connected. Add an MLS/Stellar feed, a comps Apify actor, or enter comps manually.",
    });
  }
  if (input.pendingComps && input.pendingComps.length) {
    available.push({ source: "Pending comps", detail: `${input.pendingComps.length} provided` });
  } else {
    missing.push({
      source: "Pending comps",
      reason: "Requires an MLS feed — public Zillow scrapes don't reliably surface pending status.",
    });
  }
  if (input.soldComps && input.soldComps.length) {
    available.push({ source: "Recently sold comps", detail: `${input.soldComps.length} provided` });
  } else {
    missing.push({
      source: "Recently sold comps",
      reason: "Requires an MLS feed or a sold-comps data provider (ATTOM, RentCast, etc.).",
    });
  }

  // Anthropic's built-in web_search tool — when the model used it, the
  // citations array tells us exactly which pages fed the recap. We split
  // the citations into rough buckets so the seller sees which third-party
  // sources actually informed this analysis.
  if (citations.length > 0) {
    const bucket = (re: RegExp) => citations.filter((c) => re.test(c.url)).length;
    const redfin   = bucket(/redfin\.com/i);
    const realtor  = bucket(/realtor\.com/i);
    const homes    = bucket(/homes\.com/i);
    const zillowW  = bucket(/zillow\.com/i);
    const other    = citations.length - redfin - realtor - homes - zillowW;

    const detailParts: string[] = [];
    if (redfin)  detailParts.push(`${redfin} Redfin`);
    if (realtor) detailParts.push(`${realtor} Realtor.com`);
    if (homes)   detailParts.push(`${homes} Homes.com`);
    if (zillowW) detailParts.push(`${zillowW} Zillow`);
    if (other)   detailParts.push(`${other} other`);
    available.push({
      source: "OpenRouter native web search (live)",
      detail: `${citations.length} page${citations.length === 1 ? "" : "s"} fetched — ${detailParts.join(", ")}`,
    });
  } else {
    missing.push({
      source: "OpenRouter native web search (Redfin / Realtor.com / Homes.com / market reports)",
      reason: "The model didn't run web search on this listing — usually because the cached recap was reused. Click Refresh to fetch live web data.",
    });
  }

  // Realtor.com scraper (memo23/realtor-search-cheerio). Run per
  // generation against the subject ZIP; bucketed into active/pending/sold.
  if (realtor && realtor.ok) {
    const parts: string[] = [];
    if (realtor.active.length)  parts.push(`${realtor.active.length} active`);
    if (realtor.pending.length) parts.push(`${realtor.pending.length} pending`);
    if (realtor.sold.length)    parts.push(`${realtor.sold.length} sold`);
    available.push({
      source: "Realtor.com scraper (memo23/realtor-search-cheerio)",
      detail: parts.length ? parts.join(" • ") : `${realtor.total} listings`,
    });
  } else if (realtor && realtor.errorMessage) {
    missing.push({
      source: "Realtor.com scraper (memo23/realtor-search-cheerio)",
      reason: `Scrape failed this run: ${realtor.errorMessage}`,
    });
  } else {
    missing.push({
      source: "Realtor.com scraper (memo23/realtor-search-cheerio)",
      reason: "Scraper didn't run on this cache-served recap. Generates fresh on the next weekly cycle.",
    });
  }

  if (!(input.marketStats)) {
    missing.push({
      source: "Local market stats (MLS aggregate)",
      reason: "No MLS aggregate or Redfin Data Center API is connected. Web-search results above partly cover this, but a live MLS feed would be more precise.",
    });
  }

  return { available, missing };
}

/**
 * Quality gate for cache reuse. A saved analysis is "rich enough" to
 * reuse only when it has the core sections we promise the seller:
 * a real status label, at least one comp, a projected sale range, AND
 * at least one external data source (Anthropic web search OR Realtor
 * scraper) successfully fed it. Otherwise the cycle's saved row is
 * regenerated once — even within the same Friday window — so we don't
 * keep serving "Insufficient Data" stubs.
 */
function isRichEnough(s: StructuredAnalysis | null | undefined): boolean {
  if (!s) return false;
  if (s.status_label === "Insufficient Data") return false;
  if (!s.market_comps?.comps?.length) return false;
  if (s.projected_sale_price?.projected_low == null) return false;
  if (s.projected_sale_price?.projected_high == null) return false;
  const sources = s.data_sources?.available ?? [];
  const hasExternal = sources.some((src) => {
    const n = String(src.source || "").toLowerCase();
    return n.includes("anthropic web search") || n.includes("realtor");
  });
  return hasExternal;
}

/**
 * Derive the legacy back-compat scalar fields from the rich structured
 * payload so old UI / queries that only know about `market_summary` etc.
 * still keep working.
 */
function mirrorLegacyFields(s: StructuredAnalysis): {
  market_summary: string | null;
  pricing_analysis: string | null;
  comps_summary: string | null;
  online_interest_summary: string | null;
  showing_summary: string | null;
  recommended_next_steps: string[] | null;
  risk_flags: string[] | null;
  price_review_recommended: boolean | null;
} {
  return {
    market_summary: s.listing_snapshot.summary || null,
    pricing_analysis: s.price_drop_recommendation.summary || s.projected_sale_price.summary || null,
    comps_summary: s.market_comps.summary || null,
    online_interest_summary: s.platform_engagement.summary || null,
    showing_summary: null, // We don't have showing data in the new shape — leave null.
    recommended_next_steps: s.next_steps.length ? s.next_steps : null,
    risk_flags: s.data_limitations.length ? s.data_limitations : null,
    price_review_recommended: s.price_drop_recommendation.recommended,
  };
}

// ─────────────────────── Public entrypoint ───────────────────────────

export async function getOrGenerateMarketAnalysis(
  input: ListingInput,
  opts: { forceRefresh?: boolean } = {}
): Promise<MarketAnalysisRecord> {
  if (!supabaseAdmin) {
    throw new Error("Supabase admin client is not configured");
  }


  // Most recent stored row for this listing, scoped to the authenticated
  // owner. We bypass RLS via the service-role client, so we must scope by
  // user_id ourselves to prevent cross-tenant reads.
  const { data: existingRows, error: fetchErr } = await supabaseAdmin
    .from("listing_market_analyses")
    .select("*")
    .eq("listing_id", input.listingId)
    .eq("user_id", input.userId)
    .order("analysis_week_of", { ascending: false })
    .limit(1);

  if (fetchErr) {
    throw new Error(`Failed to read listing_market_analyses: ${fetchErr.message}`);
  }

  const existing = existingRows?.[0] as (MarketAnalysisRecord & { raw_anthropic_response?: string | null }) | undefined;

  const cur = currentWeekWindow();

  // Parse the cached structured payload up front so we can quality-gate
  // the cache hit (don't reuse generic "Insufficient Data" stubs).
  const cachedRaw = existing && typeof existing.raw_anthropic_response === "string"
    ? existing.raw_anthropic_response
    : null;
  const cachedStructured = cachedRaw
    ? coerceStructured(tryParseJsonObject(cachedRaw), existing!.analysis_week_of || cur.weekOfStr)
    : null;

  const currentCycle = !!existing && !isStale(existing);
  const richEnough = isRichEnough(cachedStructured);

  const cacheHit =
    existing &&
    existing.status === "published" &&
    !opts.forceRefresh &&
    currentCycle &&
    richEnough;

  if (cacheHit) {
    // Recompute data_sources on read so the panel reflects the CURRENT
    // listing input even when the recap text is reused from cache.
    if (cachedStructured) cachedStructured.data_sources = computeDataSources(input, cachedStructured.citations);
    return { ...existing!, structured: cachedStructured };
  }


  // ── Gather external market data BEFORE prompting Anthropic ──────────
  // Best-effort Realtor.com scrape against the subject ZIP. Failure is
  // logged but does NOT block generation — Anthropic's web_search tool
  // is still available as a fallback comp source.
  let realtor: RealtorCachedResult | null = null;
  try {
    realtor = await getOrFetchRealtorComps({
      address: input.address,
      zip: input.zip,
      propertyType: input.propertyType,
      normalizedPropertyKey: input.normalizedPropertyKey,
      forceRefresh: opts.forceRefresh,
    });
  } catch (e: any) {
    console.warn("[market-data] Realtor scrape threw:", e?.message);
  }

  // Inject scraped comps into the model input when the caller didn't
  // already provide them. We deliberately don't override caller-supplied
  // comps — those are higher-trust (MLS/manual entry).
  const enrichedInput: ListingInput = { ...input };
  if (realtor) {
    if ((!enrichedInput.comps || enrichedInput.comps.length === 0) && realtor.active.length) {
      enrichedInput.comps = realtor.active.slice(0, 12);
    }
    if ((!enrichedInput.pendingComps || enrichedInput.pendingComps.length === 0) && realtor.pending.length) {
      enrichedInput.pendingComps = realtor.pending.slice(0, 8);
    }
    if ((!enrichedInput.soldComps || enrichedInput.soldComps.length === 0) && realtor.sold.length) {
      enrichedInput.soldComps = realtor.sold.slice(0, 8);
    }
  }

  const prompt = buildPrompt(enrichedInput, cur.weekOfStr);


  let structured: StructuredAnalysis | null = null;
  let raw: string | null = null;
  let errorMessage: string | null = null;
  try {
    const result = await withAiUser(input.userId, () => callMarketAi(prompt));
    raw = result.raw;
    structured = coerceStructured(tryParseJsonObject(raw), cur.weekOfStr);
    // Attach the live citations to the structured payload BEFORE computing
    // data sources, so the Data Sources panel reflects what web_search
    // actually fetched.
    structured.citations = result.citations;
    structured.data_sources = computeDataSources(enrichedInput, result.citations, realtor);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    console.warn("[market-analysis] OpenRouter call failed:", errorMessage);
  }

  // Don't overwrite a previously-rich saved analysis with a weaker one.
  // If generation failed OR produced a weaker recap than what's already
  // saved, keep showing the prior analysis (with a soft warning when the
  // generation outright failed). This is what prevents "Insufficient
  // Data" from clobbering a good Friday-week recap.
  const freshIsWeaker = !errorMessage && existing?.status === "published" &&
    isRichEnough(cachedStructured) && !isRichEnough(structured);
  if ((errorMessage || freshIsWeaker) && existing && existing.status === "published" && cachedStructured) {
    cachedStructured.data_sources = computeDataSources(input, cachedStructured.citations, realtor);
    if (errorMessage) {
    } else {
    }
    return {
      ...existing,
      structured: cachedStructured,
      error_message: errorMessage
        ? `Latest weekly update failed — showing previous analysis. (${errorMessage})`
        : null,
    };
  }

  const legacy = structured ? mirrorLegacyFields(structured) : {
    market_summary: null, pricing_analysis: null, comps_summary: null,
    online_interest_summary: null, showing_summary: null,
    recommended_next_steps: null, risk_flags: null, price_review_recommended: null,
  };

  const row: Record<string, unknown> = {
    id:
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : `lma_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    listing_id: input.listingId,
    user_id: input.userId,
    property_address: input.address,
    analysis_week_of: cur.weekOfStr,
    generated_at: new Date().toISOString(),
    next_update_due_at: cur.nextUpdateDueAt.toISOString(),
    status: errorMessage ? "error" : "published",
    ...legacy,
    confidence_level: structured?.confidence_level ?? null,
    data_limitations: structured?.data_limitations?.length ? structured.data_limitations : null,
    raw_prompt: prompt,
    // Persist the COERCED structured JSON (not the raw text) so reads always
    // get a well-formed object back. Stored in the existing `raw_anthropic_response`
    // text column — we JSON.stringify it.
    raw_anthropic_response: structured ? JSON.stringify(structured) : raw,
    error_message: errorMessage,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("listing_market_analyses")
    .insert(row)
    .select("*")
    .single();

  if (insertErr) {
    console.warn("[market-analysis] failed to persist row:", insertErr.message);
    return { ...(row as unknown as MarketAnalysisRecord), structured };
  }
  return { ...(inserted as MarketAnalysisRecord), structured };
}
