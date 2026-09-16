/**
 * Hillsborough Tax Collector bill scraper.
 *
 * The Property Appraiser's TaxEstimator API returns 0 for
 * nonAdValoremTaxes on every parcel, but real bills carry CDD fees,
 * solid waste, stormwater, etc. Those live only on the Tax Collector's
 * site (hillsborough.county-taxes.com), which is behind Cloudflare bot
 * protection — plain server-side fetch is blocked, and even Apify's
 * standard web-scraper (Chrome) gets 403s. Apify's Website Content
 * Crawler with playwright:firefox + residential proxies gets through.
 *
 * A scrape takes ~2-4 minutes (SPA needs a long dynamic-content wait),
 * so scrapes run in the background: the tax route returns immediately
 * with `pending`, the client re-polls, and the parsed result is cached
 * in non_ad_valorem_cache (keyed by county + folio) so each parcel is only
 * scraped once per cache window.
 */

import { db } from "../db";
import { nonAdValoremCache } from "@shared/schema";
import { eq } from "drizzle-orm";
import { supabaseAdmin } from "../supabase";
import { routedRead, routedWrite } from "../managed-data-routing";
import { streetAddressMatches } from "./hillsborough-tax";

const CACHE_DAYS = 180;
const FAILURE_CACHE_MINUTES = 10;
const APIFY_ACTOR = "apify~website-content-crawler";
/**
 * Exact Actor build validated against TaxSys's iframe and pageFunction
 * behavior. Do not replace this with a moving tag such as `version-0`.
 *
 * APIFY_WCC_BUILD can select an exact candidate build for the documented
 * two-run upgrade rehearsal. Invalid values fail back to this known build.
 */
export const TESTED_APIFY_WCC_BUILD = "0.3.94";
const RUN_TIMEOUT_SECS = 360;
const POLL_INTERVAL_MS = 15_000;
const PINELLAS_MAX_CRAWL_PAGES = 2;
const EXACT_APIFY_BUILD_NUMBER = /^\d+\.\d+\.\d+$/;

export const TAXSYS_COUNTIES = [
  "hillsborough",
  "pinellas",
  "manatee",
  "pasco",
  "hernando",
  "sarasota",
  "lee",
  "collier",
] as const;

export type TaxSysCounty = typeof TAXSYS_COUNTIES[number];

interface TaxSysCountyConfig {
  host: string;
  startPath: (account: string) => string;
}

/**
 * TaxSys hosts are deliberately allowlisted. Do not derive a host directly
 * from caller input: this both rejects unsupported providers and prevents an
 * untrusted county value from becoming part of a crawl URL.
 */
const TAXSYS_COUNTY_CONFIG: Record<TaxSysCounty, TaxSysCountyConfig> = {
  hillsborough: {
    host: "hillsborough.county-taxes.com",
    startPath: account => `/public/real_estate/parcels/${encodeURIComponent(account)}`,
  },
  pinellas: {
    host: "pinellas.county-taxes.com",
    // This legacy search route establishes the SPA session; direct parcel
    // routes return 404 for Pinellas.
    startPath: account =>
      `/public/search/property_tax?search_query=${encodeURIComponent(account)}`,
  },
  manatee: {
    host: "manatee.county-taxes.com",
    startPath: account => `/public/real_estate/parcels/${encodeURIComponent(account)}`,
  },
  pasco: {
    host: "pasco.county-taxes.com",
    startPath: account => `/public/real_estate/parcels/${encodeURIComponent(account)}`,
  },
  hernando: {
    host: "hernando.county-taxes.com",
    startPath: account => `/public/real_estate/parcels/${encodeURIComponent(account)}`,
  },
  sarasota: {
    host: "sarasota.county-taxes.com",
    startPath: account => `/public/real_estate/parcels/${encodeURIComponent(account)}`,
  },
  lee: {
    host: "lee.county-taxes.com",
    startPath: account => `/public/real_estate/parcels/${encodeURIComponent(account)}`,
  },
  collier: {
    host: "collier.county-taxes.com",
    startPath: account => `/public/real_estate/parcels/${encodeURIComponent(account)}`,
  },
};

/** Return the validated TaxSys county host and account-summary start URL. */
export function getTaxSysHostAndStartUrl(
  county: string,
  account: string,
): { host: string; startUrl: string } {
  const config = TAXSYS_COUNTY_CONFIG[county as TaxSysCounty];
  if (!config) {
    throw new RangeError(
      `Unsupported Tyler TaxSys county: ${JSON.stringify(county)}`,
    );
  }
  return {
    host: config.host,
    startUrl: `https://${config.host}${config.startPath(account)}`,
  };
}

export function resolveWebsiteContentCrawlerBuild(
  configuredBuild = process.env.APIFY_WCC_BUILD,
): string {
  const candidate = configuredBuild?.trim();
  if (!candidate) return TESTED_APIFY_WCC_BUILD;
  if (EXACT_APIFY_BUILD_NUMBER.test(candidate)) return candidate;

  console.warn(
    `[nav-scrape] ignoring invalid APIFY_WCC_BUILD=${JSON.stringify(candidate)}; ` +
    `using tested build ${TESTED_APIFY_WCC_BUILD}`,
  );
  return TESTED_APIFY_WCC_BUILD;
}

/**
 * TaxSys content is rendered inside an iframe. The Website Content Crawler's
 * normal dynamic-content detection can see the network become idle while the
 * iframe still contains only the advisory or Loading shell, then report the
 * request as successful without enqueuing a bill.
 *
 * A pageFunction can inspect every Playwright frame before extraction. Throwing
 * here makes the Actor use its request retry budget instead of accepting an
 * incomplete page. The current Actor build documents a `request` argument but
 * does not pass it, so route detection must use page.url().
 */
const PINELLAS_PAGE_FUNCTION = `async function pageFunction({ page }) {
  const isBillPage = /\\/bills\\//i.test(page.url());
  const deadline = Date.now() + 45000;

  while (Date.now() < deadline) {
    const frameStates = await Promise.all(page.frames().map(async (frame) => {
      try {
        const text = await frame.locator('body').innerText({ timeout: 2000 });
        const billLinkCount = await frame.locator('a[href*="/bills/"]').count();
        return { text, billLinkCount };
      } catch {
        return { text: '', billLinkCount: 0 };
      }
    }));

    if (isBillPage) {
      const text = frameStates.map((state) => state.text).join('\\n');
      if (
        /Bill Details/i.test(text) &&
        /Situs:/i.test(text) &&
        /Non-Ad Valorem Assessments/i.test(text) &&
        /Total Ad Valorem Taxes/i.test(text)
      ) {
        return;
      }
    } else if (frameStates.some((state) => state.billLinkCount > 0)) {
      return;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error(
    isBillPage
      ? 'TaxSys bill content did not become ready'
      : 'TaxSys bill links did not become ready'
  );
}`;

export interface NonAdValoremResult {
  folio: string;
  billYear: number | null;
  lines: Array<{ authority: string; amount: number }>;
  total: number;
  fromCache: boolean;
  /** Total ad valorem millage from the bill (e.g. 19.9197), when
   *  the bill's millage row parsed. */
  totalMillage: number | null;
  /** Per-authority millage rates from the bill's Ad Valorem table. */
  adValoremMills: Array<{ authority: string; mills: number }> | null;
  /**
   * Actual ad-valorem dollar total from the bill's "Total Ad Valorem
   * Taxes" row (e.g. $2,288.68 → 2288.68). Null when the bill did
   * not include a dollar amount on that row (only millage).
   * Use this for the refinance current-bill endpoint; do NOT use for
   * purchase estimates (reflects existing owner's exemptions/SOH cap).
   */
  totalAdValorem: number | null;
}

/** Folios with a scrape currently running (dedupe concurrent misses). */
const inFlight = new Set<string>();

interface ParsedBill {
  year: number | null;
  isAnnual: boolean;
  lines: Array<{ authority: string; amount: number }>;
  total: number;
  /** Bill explicitly states there are no non-ad valorem
   *  assessments — a valid $0 result, not a parse failure. */
  noAssessments?: boolean;
  /** Total ad valorem millage from the bill's
   *  "Total Ad Valorem Taxes" row (e.g. 19.9197). */
  totalMillage?: number | null;
  /** Actual dollar amount from the bill's "Total Ad Valorem Taxes"
   *  row (e.g. $2,288.68 → 2288.68). Null when absent. */
  totalAdValorem?: number | null;
  /** Per-authority millage rates from the bill's Ad Valorem table
   *  ("| NAME | 4.5423 | $assessed | $exempt | $taxable | $tax |"). */
  adValoremMills?: Array<{ authority: string; mills: number }> | null;
}

async function readNonAdValoremCache(folio: string) {
  return routedRead(
    () => db.select().from(nonAdValoremCache)
      .where(eq(nonAdValoremCache.folio, folio)).limit(1),
    async () => {
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      const { data, error } = await supabaseAdmin.from("non_ad_valorem_cache")
        .select("*").eq("folio", folio).limit(1);
      if (error) throw error;
      return (data ?? []).map(row => ({
        id: row.id, folio: row.folio, accountNumber: row.account_number,
        billYear: row.bill_year, status: row.status, lines: row.lines,
        totalNonAdValorem: row.total_non_ad_valorem,
        totalAdValoremCents: row.total_ad_valorem_cents,
        totalMillage: row.total_millage, adValoremMills: row.ad_valorem_mills,
        fetchedAt: new Date(row.fetched_at), expiresAt: new Date(row.expires_at),
      }));
    },
  );
}

async function writeNonAdValoremCache(value: typeof nonAdValoremCache.$inferInsert) {
  return routedWrite(
    async () => {
      const [row] = await db.insert(nonAdValoremCache).values(value)
        .onConflictDoUpdate({
          target: nonAdValoremCache.folio,
          set: { ...value, fetchedAt: new Date() },
        }).returning();
      return row;
    },
    async sourceRow => {
      if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
      const row = sourceRow ?? value;
      const { data, error } = await supabaseAdmin.from("non_ad_valorem_cache").upsert({
        ...(sourceRow?.id != null ? { id: sourceRow.id } : {}),
        folio: row.folio, account_number: row.accountNumber,
        bill_year: row.billYear, status: row.status, lines: row.lines,
        total_non_ad_valorem: row.totalNonAdValorem,
        total_ad_valorem_cents: row.totalAdValoremCents,
        total_millage: row.totalMillage, ad_valorem_mills: row.adValoremMills,
        fetched_at: (row.fetchedAt ?? new Date()).toISOString(),
        expires_at: row.expiresAt.toISOString(),
      }, { onConflict: "folio" }).select().single();
      if (error) throw error;
      return data as any;
    },
  );
}

export interface TaxSysSitusIdentity {
  county: string;
  situsAddress: string;
  situsCity: string;
}

function normalizedTaxSysCity(value: string): string {
  return value
    .toUpperCase()
    .replace(/\bFL(?:ORIDA)?\b/g, " ")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function taxSysSitusMatches(
  actual: TaxSysSitusIdentity | null,
  expected: TaxSysSitusIdentity,
): boolean {
  return Boolean(
    actual &&
    actual.county.trim().toLowerCase() ===
      expected.county.trim().toLowerCase() &&
    streetAddressMatches(expected.situsAddress, actual.situsAddress) &&
    normalizedTaxSysCity(actual.situsCity) ===
      normalizedTaxSysCity(expected.situsCity),
  );
}

/**
 * Parse the stable situs identity from either a Tyler TaxSys account summary
 * or bill detail page. A fully rendered summary moves the situs into its bill
 * pages, while the transient Loading summary includes it inline.
 */
export function parseTaxSysSitusIdentityMarkdown(
  md: string
): TaxSysSitusIdentity | null {
  const lines = md.split(/\r?\n/).map(line => line.trim());
  const heading = lines.find(line => /^#\s+\S/.test(line));
  const county = heading?.replace(/^#\s+/, "").trim() ?? "";
  const situsIndex = lines.findIndex(line => /^Situs:\s*$/i.test(line));
  if (!county || situsIndex < 0) return null;

  const situs: string[] = [];
  for (let i = situsIndex + 1; i < lines.length && situs.length < 2; i++) {
    const line = lines[i];
    if (!line) continue;
    if (/^(?:#{1,6}\s|\[|Owner:|Account Summary)/i.test(line)) break;
    situs.push(line.replace(/\s+/g, " ").trim());
  }
  if (situs.length !== 2) return null;

  return {
    county,
    situsAddress: situs[0],
    situsCity: situs[1],
  };
}

/** Parse the "Non-Ad Valorem Assessments" markdown table from a
 *  crawled bill page. Returns null when the page has no NAV section. */
export function parseBillMarkdown(md: string): ParsedBill | null {
  if (!/Non-Ad Valorem Assessments/i.test(md)) return null;

  // "## 2025\u200d Annual bill" (note the zero-width joiner)
  const yearMatch = md.match(/##\s*(\d{4})\S*\s*Annual bill/i);
  const isAnnual = /Annual bill/i.test(md);

  const seg = md
    .split(/###\s*Non-Ad Valorem Assessments/i)[1];
  if (!seg) return null;
  const section = seg.split(/\n##[^#]/)[0];

  // "| Total Ad Valorem Taxes | 19.9197 | ... | $2,288.68 |"
  // Match the entire row on a single line so we don't bleed across sections.
  // Pattern: capture mills (col 2) and last $N,NNN.NN on that line (col last).
  let totalMillage: number | null = null;
  let totalAdValorem: number | null = null;
  for (const line of md.split("\n")) {
    const m = line.match(
      /\|\s*Total Ad Valorem Taxes\s*\|\s*([\d.]+)\s*\|/i
    );
    if (!m) continue;
    totalMillage = parseFloat(m[1]);
    // Find the last dollar amount on this line.
    const dollars = Array.from(line.matchAll(/\$\s*([\d,]+\.\d{2})/g));
    if (dollars.length) {
      const last = dollars[dollars.length - 1][1];
      const val = parseFloat(last.replace(/,/g, ""));
      if (Number.isFinite(val) && val > 0) totalAdValorem = val;
    }
    break; // found the row
  }

  // Per-authority millage from the Ad Valorem table:
  // "| ST PETERSBURG | 6.4525 | $402,007.00 | … |"
  const adValoremMills: Array<{ authority: string; mills: number }> =
    [];
  const avSection = md.split(/###?\s*Ad Valorem Taxes/i)[1];
  if (avSection) {
    const avPart =
      avSection.split(/Non-Ad Valorem Assessments/i)[0];
    for (const row of avPart.split("\n")) {
      const m = row.match(
        /^\|\s*([A-Za-z][^|]*?)\s*\|\s*([\d.]+)\s*\|\s*\$[\d,]/
      );
      if (!m) continue;
      const authority = m[1].trim();
      if (/^Total Ad Valorem/i.test(authority)) continue;
      adValoremMills.push({
        authority,
        mills: parseFloat(m[2]),
      });
    }
  }

  const lines: Array<{ authority: string; amount: number }> = [];
  let total = 0;
  for (const row of section.split("\n")) {
    // "| BERRY BAY CDD |     | $2,978.04 |"
    const m = row.match(
      /^\|\s*([A-Za-z][^|]*?)\s*\|[^|]*\|\s*\$([\d,]+\.\d{2})\s*\|/
    );
    if (!m) continue;
    const authority = m[1].trim();
    const amount = parseFloat(m[2].replace(/,/g, ""));
    if (/^Total Non-Ad Valorem/i.test(authority)) {
      total = amount;
    } else if (!/^(Rate|Amount|Levying authority)$/i.test(authority)) {
      lines.push({ authority, amount });
    }
  }
  if (!lines.length) {
    // Some bills (e.g. Pinellas) explicitly say "No Non-Ad Valorem
    // assessments." — that's a trustworthy $0, not a failed parse.
    if (/No Non-Ad Valorem assessments/i.test(section)) {
      return {
        year: yearMatch ? parseInt(yearMatch[1], 10) : null,
        isAnnual,
        lines: [],
        total: 0,
        noAssessments: true,
        totalMillage,
        totalAdValorem: (totalAdValorem != null && Number.isFinite(totalAdValorem) && totalAdValorem > 0)
          ? totalAdValorem : null,
        adValoremMills: adValoremMills.length
          ? adValoremMills
          : null,
      };
    }
    return null;
  }
  if (!total) {
    total =
      Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  }
  return {
    year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    isAnnual,
    lines,
    total,
    totalMillage,
    totalAdValorem: (totalAdValorem != null && Number.isFinite(totalAdValorem) && totalAdValorem > 0)
      ? totalAdValorem : null,
    adValoremMills: adValoremMills.length ? adValoremMills : null,
  };
}

export interface TaxSysContractAnnualBill {
  year: number | null;
  isAnnual: boolean;
  lineCount: number;
  total: number;
  noAssessments: boolean;
  totalMillage: number | null;
  totalAdValorem: number | null;
  adValoremMills: Array<{ authority: string; mills: number }> | null;
}

export interface TaxSysContractPage {
  url: string;
  isBillPage: boolean;
  situsIdentity: TaxSysSitusIdentity | null;
  annualBill: TaxSysContractAnnualBill | null;
}

export interface TaxSysContractSnapshot {
  requestedCrawlerBuild: string;
  crawlerBuild: string | null;
  newestListedYear: number | null;
  pages: TaxSysContractPage[];
}

/**
 * Build the Website Content Crawler input separately so the Pinellas
 * provider-specific readiness behavior stays testable without starting an
 * Apify run.
 */
export function buildTaxSysCrawlerInput(
  account: string,
  county: string
): Record<string, unknown> {
  const isPinellas = county === "pinellas";
  const { startUrl } = getTaxSysHostAndStartUrl(county, account);

  return {
    startUrls: [{ url: startUrl }],
    includeUrlGlobs: [{ glob: "**/bills/*" }],
    // Pinellas only needs the account summary and its first (newest) annual
    // bill. Crawling every historical bill adds minutes and does not improve
    // freshness; incomplete newest bills are retried by pageFunction instead.
    maxCrawlPages: isPinellas ? PINELLAS_MAX_CRAWL_PAGES : 8,
    maxCrawlDepth: 1,
    maxResults: isPinellas ? PINELLAS_MAX_CRAWL_PAGES : 8,
    crawlerType: "playwright:firefox",
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
    },
    // Pinellas readiness is enforced across iframe contents below. Keep the
    // Actor's generic network-idle wait short so a quiet Loading shell cannot
    // consume the full run timeout before the explicit readiness check.
    dynamicContentWaitSecs: isPinellas ? 10 : 90,
    ...(isPinellas
      ? {
          requestTimeoutSecs: 120,
          maxRequestRetries: 3,
          pageFunction: PINELLAS_PAGE_FUNCTION,
        }
      : {}),
    // A main-document waitForSelector cannot see TaxSys's iframe content.
    expandIframes: true,
    saveMarkdown: true,
  };
}

function toTaxSysContractAnnualBill(
  bill: ParsedBill
): TaxSysContractAnnualBill {
  return {
    year: bill.year,
    isAnnual: bill.isAnnual,
    lineCount: bill.lines.length,
    total: bill.total,
    noAssessments: Boolean(bill.noAssessments),
    totalMillage: bill.totalMillage ?? null,
    totalAdValorem: bill.totalAdValorem ?? null,
    adValoremMills: bill.adValoremMills ?? null,
  };
}

/**
 * Return only annual-bill pages whose own parsed situs matches the expected
 * fixture. Identity from an account summary or a different bill page cannot
 * satisfy this association.
 */
export function filterTaxSysAnnualBillPagesForSitus(
  pages: TaxSysContractPage[],
  expected: TaxSysSitusIdentity
): TaxSysContractPage[] {
  return pages.filter(page =>
    page.isBillPage &&
    page.annualBill !== null &&
    taxSysSitusMatches(page.situsIdentity, expected)
  );
}

/** Start a Website Content Crawler run, poll until it finishes, and
 *  return the parsed bills found in its dataset. */
async function runWccScrape(
  account: string,
  county: string,
  expectedSitus?: TaxSysSitusIdentity,
): Promise<{
  requestedCrawlerBuild: string;
  crawlerBuild: string | null;
  bills: ParsedBill[];
  /** Newest "NNNN Annual bill" year listed on the account summary
   *  page — used to detect when the crawl only rendered old bills. */
  newestListedYear: number | null;
  contractPages: TaxSysContractPage[];
}> {
  const requestedCrawlerBuild = resolveWebsiteContentCrawlerBuild();
  // Validate even for diagnostic callers that invoke this path directly.
  getTaxSysHostAndStartUrl(county, account);
  const empty = {
    requestedCrawlerBuild,
    crawlerBuild: null,
    bills: [],
    newestListedYear: null,
    contractPages: [],
  };
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.error("[nav-scrape] APIFY_TOKEN is not configured");
    return empty;
  }

  const input = buildTaxSysCrawlerInput(account, county);
  const runParams = new URLSearchParams({
    token,
    timeout: String(RUN_TIMEOUT_SECS),
    memory: "4096",
    // Apify accepts a build tag or exact build number. Use an exact build
    // number so a moving Actor tag cannot silently alter TaxSys behavior.
    build: requestedCrawlerBuild,
  });

  const startResp = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?${runParams}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  const startData = await startResp.json();
  const runId = startData?.data?.id;
  const datasetId = startData?.data?.defaultDatasetId;
  const crawlerBuild =
    typeof startData?.data?.buildNumber === "string"
      ? startData.data.buildNumber
      : null;
  if (!startResp.ok || !runId) {
    console.error(
      "[nav-scrape] Apify run start failed:",
      JSON.stringify(startData).slice(0, 300)
    );
    return empty;
  }
  if (crawlerBuild !== requestedCrawlerBuild) {
    console.error(
      `[nav-scrape] Apify run ${runId} started unexpected build ` +
      `${crawlerBuild ?? "unknown"} (requested ${requestedCrawlerBuild}); ` +
      "discarding its output",
    );
    return empty;
  }
  console.log(
    `[nav-scrape] Apify run ${runId} started for ${account} ` +
    `(build ${crawlerBuild})`,
  );

  // Poll until the run terminates
  const deadline = Date.now() + (RUN_TIMEOUT_SECS + 60) * 1000;
  let status = "RUNNING";
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const st = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`
    ).then(r => r.json()).catch(() => null);
    status = st?.data?.status ?? status;
    if (
      ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)
    ) break;
  }
  console.log(`[nav-scrape] run ${runId} finished: ${status}`);

  // Fetch whatever items exist even on timeout — a partial crawl may
  // still include the bill page.
  const items = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`
  ).then(r => r.json()).catch(() => []);
  if (!Array.isArray(items)) return empty;

  const parsed: ParsedBill[] = [];
  const contractPages: TaxSysContractPage[] = [];
  let newestListedYear: number | null = null;
  for (const item of items) {
    const md = item?.markdown || item?.text || "";
    const url = String(item?.url ?? "");
    const isBillPage = /\/bills\//i.test(url);
    const situsIdentity = parseTaxSysSitusIdentityMarkdown(md);
    const bill = parseBillMarkdown(md);
    // Production requests fail closed unless the annual bill page itself
    // carries the verified parcel's situs. A matching account-summary page
    // cannot authorize a different or redirected bill page.
    if (
      bill &&
      isBillPage &&
      (!expectedSitus || taxSysSitusMatches(situsIdentity, expectedSitus))
    ) {
      parsed.push(bill);
    }
    contractPages.push({
      url,
      isBillPage,
      situsIdentity,
      annualBill: bill?.isAnnual
        ? toTaxSysContractAnnualBill(bill)
        : null,
    });
    // Account summary pages list "[2025 Annual bill](…)" links.
    for (const m of md.matchAll(/\[(\d{4}) Annual bill\]/g)) {
      const y = parseInt(m[1], 10);
      if (!newestListedYear || y > newestListedYear) {
        newestListedYear = y;
      }
    }
  }
  return {
    requestedCrawlerBuild,
    crawlerBuild,
    bills: parsed,
    newestListedYear,
    contractPages,
  };
}

/**
 * One uncached live TaxSys crawl for scheduled contract diagnostics.
 * Callers own retry policy and must not use this in request handling.
 */
export async function fetchTaxSysContractSnapshot(
  account: string,
  county: string
): Promise<TaxSysContractSnapshot> {
  const result = await runWccScrape(account, county);
  return {
    requestedCrawlerBuild: result.requestedCrawlerBuild,
    crawlerBuild: result.crawlerBuild,
    newestListedYear: result.newestListedYear,
    pages: result.contractPages,
  };
}

/** Background scrape + cache write for one county-qualified folio.
 *  Works for each allowlisted Tyler TaxSys county;
 *  Hillsborough account numbers carry an "A" prefix, other counties
 *  use the parcel identifier as-is. */
async function scrapeAndCache(
  cleanFolio: string,
  county: string = "hillsborough",
  accountOverride?: string,
  expectedSitus?: TaxSysSitusIdentity,
): Promise<void> {
  const account =
    accountOverride ??
    (county === "hillsborough" ? `A${cleanFolio}` : cleanFolio);
  console.log(
    `[nav-scrape] scraping ${county} bill for account ${account}…`
  );
  let bills: ParsedBill[] = [];
  let newestListedYear: number | null = null;
  // The Tax Collector SPA renders slowly and inconsistently; a run
  // can capture pages while they still say "Loading..." — including
  // the NEWEST bill, while older bills render fine (stale millage!).
  // Retry until the newest listed annual bill actually parsed.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      console.log(
        `[nav-scrape] ${account} — incomplete parse` +
        ` (have ${bills.length} bills, newest listed ` +
        `${newestListedYear ?? "?"}), retrying…`
      );
    }
    try {
      const run = await runWccScrape(account, county, expectedSitus);
      // Merge results across attempts; keep the max listed year seen.
      bills = bills.concat(run.bills);
      if (
        run.newestListedYear &&
        (!newestListedYear || run.newestListedYear > newestListedYear)
      ) {
        newestListedYear = run.newestListedYear;
      }
    } catch (e: any) {
      console.error("[nav-scrape] scrape error:", e?.message);
    }
    const haveNewest =
      newestListedYear !== null &&
      bills.some(b => b.isAnnual && b.year === newestListedYear);
    if (haveNewest || (bills.length && newestListedYear === null)) {
      break;
    }
  }

  // Fail closed: only trust parses with lines and a positive total,
  // or bills that explicitly state there are no assessments.
  const valid = bills.filter(
    b => (b.total > 0 && b.lines.length > 0) || b.noAssessments
  );
  // Rank merged bills: newest year first; among same-year duplicates
  // (bills merged across retry runs) prefer richer parses — ones that
  // carry per-authority mills, then ones with more assessment lines.
  const annuals = valid
    .filter(b => b.isAnnual && b.year)
    .sort(
      (a, b) =>
        (b.year ?? 0) - (a.year ?? 0) ||
        (b.totalAdValorem ? 1 : 0) - (a.totalAdValorem ? 1 : 0) ||
        (b.adValoremMills ? 1 : 0) - (a.adValoremMills ? 1 : 0) ||
        b.lines.length - a.lines.length
    );
  const best = annuals[0] ?? valid[0] ?? null;

  // Freshness: if the account summary listed a newer annual bill than
  // the one we parsed (its page failed to render), or — when the
  // summary never rendered — the parsed bill is older than last year,
  // treat the data as stale. Serve it, but only cache it short-term
  // so a later request re-scrapes instead of locking in old millage
  // for 180 days.
  const isFresh =
    best?.year != null &&
    (newestListedYear !== null
      ? best.year >= newestListedYear
      : best.year >= new Date().getFullYear() - 1);
  if (best && !isFresh) {
    console.warn(
      `[nav-scrape] ${account} — best parsed bill year ${best.year} ` +
      `is stale (newest listed: ${newestListedYear ?? "unknown"}); ` +
      `caching short-term only`
    );
  }

  const expiresAt = new Date();
  if (best && isFresh) {
    expiresAt.setDate(expiresAt.getDate() + CACHE_DAYS);
  } else {
    expiresAt.setMinutes(
      expiresAt.getMinutes() + FAILURE_CACHE_MINUTES
    );
  }
  try {
    await writeNonAdValoremCache({
      folio: cleanFolio,
      accountNumber: account,
      billYear: best?.year ?? null,
      status: best ? "success" : "error",
      lines: best?.lines ?? [],
      totalNonAdValorem: Math.round((best?.total ?? 0) * 100),
      totalAdValoremCents: (best?.totalAdValorem != null && best.totalAdValorem > 0)
        ? Math.round(best.totalAdValorem * 100)
        : null,
      totalMillage: best?.totalMillage
        ? Math.round(best.totalMillage * 10000)
        : null,
      adValoremMills: best?.adValoremMills ?? null,
      expiresAt,
    });
  } catch (e: any) {
    console.error("[nav-scrape] cache write failed:", e?.message);
  }
  console.log(
    best
      ? `[nav-scrape] ${account} year=${best.year} total=$${best.total} lines=${best.lines.length}`
      : `[nav-scrape] ${account} — no bill data obtained`
  );
}

export type NonAdValoremLookup =
  | { state: "ready"; data: NonAdValoremResult }
  | { state: "pending" }
  | {
      state: "unavailable";
      /** An operational reason callers can expose instead of treating this
       * as an ordinary no-assessment result. */
      reason: "apify_token_missing" | "cache_error" | "scrape_failed";
    };

/**
 * Non-blocking lookup of a parcel's non-ad valorem assessments.
 * - Cache hit → "ready" with data.
 * - Cache miss → kicks off a background Apify scrape (~2-4 min) and
 *   returns "pending"; callers should re-poll.
 * - Recent failure cached → "unavailable" (retry after short TTL).
 * - Missing Apify credentials → operational "unavailable", never a miss.
 */
export async function getNonAdValoremForFolio(
  folio: string,
  county: string = "hillsborough",
  accountOverride?: string,
  options?: {
    requireAdValoremTotal?: boolean;
    expectedSitus?: TaxSysSitusIdentity;
  },
): Promise<NonAdValoremLookup> {
  // Validate before any cache or background work. This keeps provider support
  // explicit rather than letting an arbitrary county become a crawl host.
  getTaxSysHostAndStartUrl(county, accountOverride ?? folio);
  if (!process.env.APIFY_TOKEN) {
    console.error("[nav-scrape] APIFY_TOKEN is not configured");
    return { state: "unavailable", reason: "apify_token_missing" };
  }

  // Only Hillsborough uses the A-prefixed account format.
  const bareFolio =
    county === "hillsborough" && folio.startsWith("A")
      ? folio.slice(1)
      : folio;
  // Every cache and in-flight key is county-qualified. A parcel string is
  // not globally unique, including across Hillsborough and another provider.
  // v2 invalidates rows created before bill-page situs association was
  // mandatory. Those older rows cannot safely prove parcel-to-bill identity.
  const cleanFolio = `v2:${county}:${bareFolio}`;

  try {
    const rows = await readNonAdValoremCache(cleanFolio);
    if (rows.length && rows[0].expiresAt > new Date()) {
      const row = rows[0];
      if (row.status === "success") {
        // Existing purchase-only cache rows predate totalAdValoremCents.
        // A refinance lookup must refresh those rows rather than reporting
        // "unavailable" until their normal 180-day expiry.
        if (
          !options?.requireAdValoremTotal ||
          row.totalAdValoremCents != null
        ) {
          return {
            state: "ready",
            data: {
              folio: cleanFolio,
              billYear: row.billYear,
              lines: row.lines ?? [],
              total: (row.totalNonAdValorem ?? 0) / 100,
              fromCache: true,
              totalMillage: row.totalMillage
                ? row.totalMillage / 10000
                : null,
              totalAdValorem: row.totalAdValoremCents != null
                ? row.totalAdValoremCents / 100
                : null,
              adValoremMills: row.adValoremMills ?? null,
            },
          };
        }
      }
      if (row.status !== "success") {
        // Recent failed attempt — don't hammer Apify.
        return inFlight.has(cleanFolio)
          ? { state: "pending" }
          : { state: "unavailable", reason: "scrape_failed" };
      }
      // A successful legacy row without ad-valorem dollars falls through and
      // starts one deduplicated refresh for the current-bill endpoint.
    }
  } catch (e: any) {
    console.error("[nav-scrape] cache read failed:", e?.message);
    return { state: "unavailable", reason: "cache_error" };
  }

  if (inFlight.has(cleanFolio)) return { state: "pending" };

  inFlight.add(cleanFolio);
  // cleanFolio may carry a "county:" cache prefix — the actual tax
  // site account must always be the bare parcel identifier.
  scrapeAndCache(
    cleanFolio,
    county,
    accountOverride ??
      (county === "hillsborough" ? `A${bareFolio}` : bareFolio),
    options?.expectedSitus,
  )
    .catch(e =>
      console.error("[nav-scrape] background scrape failed:", e?.message)
    )
    .finally(() => inFlight.delete(cleanFolio));
  return { state: "pending" };
}
