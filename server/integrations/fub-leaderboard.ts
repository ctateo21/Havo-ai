/**
 * fub-leaderboard.ts — v10
 * Changes from v9:
 *   1. Deal Pipeline always uses full year view (Jan 1 to now) regardless
 *      of the activity period tab selected by the user.
 *   2. Activity period (calls/texts/emails/showings/newLeads/closedDeals)
 *      continues to use the selected period tab.
 */

const FUB_BASE = "https://api.followupboss.com/v1";

const _cache = new Map<string, { data: LeaderboardPayload; ts: number }>();
const _refreshes = new Map<Period, Promise<LeaderboardPayload>>();
const _refreshFailures = new Map<Period, { warnings: string[]; retryAt: number }>();
let _collectionTail: Promise<void> = Promise.resolve();
const CACHE_TTL_MS = 5 * 60 * 1000;
const PARTIAL_CACHE_TTL_MS = 30 * 1000;
const FUB_REQUEST_INTERVAL_MS = 300;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_INLINE_RETRY_DELAY_MS = 5_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const FUB_RESPONSE_CACHE_TTL_MS = 5 * 60 * 1000;
const _fubResponses = new Map<string, { promise: Promise<any>; ts: number }>();
let fubRequestQueue = Promise.resolve();
let fubNextRequestAt = 0;
let fubCooldownUntil = 0;
let fubCircuitOpenUntil = 0;

export const LEADERBOARD_TEAM = [
  { email: "christian@tateoco.com", name: "Christian Tateo", initials: "CT", isAdmin: true  },
  { email: "omar@tateoco.com",      name: "Omar Andujar",    initials: "OA", isAdmin: false },
  { email: "kyle@tateoco.com",      name: "Kyle Schweinitz", initials: "KS", isAdmin: false },
  { email: "alex@tateoco.com",      name: "Alex Szabo",      initials: "AS", isAdmin: false },
] as const;

export type TeamEmail = typeof LEADERBOARD_TEAM[number]["email"];

// Emails allowed to VIEW the leaderboard without appearing as an agent row
export const LEADERBOARD_VIEWERS = ["courtney@tateoco.com"] as const;

const FUB_ID_TO_TEAM_EMAIL: Record<number, TeamEmail> = {
  1: "christian@tateoco.com",
  2: "omar@tateoco.com",
  5: "kyle@tateoco.com",
  6: "alex@tateoco.com",
};

const FUB_NAME_TO_TEAM_EMAIL: Record<string, TeamEmail> = {
  "christian tateo": "christian@tateoco.com",
  "omar andujar":    "omar@tateoco.com",
  "kyle schweinitz": "kyle@tateoco.com",
  "alex szabo":      "alex@tateoco.com",
};

export const PIPELINE_STAGES = [
  "Lead", "Attempted Contact", "Spoke with Customer", "Appointment Set",
  "Met with Customer", "Showing Homes", "Listing Agreement", "Active Listing",
  "Submitting Offers", "Under Contract", "Nurture", "Closed", "Trash",
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];

export interface DealBucket {
  count: number;
  volume: number;
  commission: number;
}

function emptyBucket(): DealBucket {
  return { count: 0, volume: 0, commission: 0 };
}

function addToBucket(bucket: DealBucket, deal: any): void {
  bucket.count++;
  bucket.volume     += Number(deal.price           ?? 0);
  bucket.commission += Number(deal.commissionValue ?? 0);
}

export interface AgentDeals {
  reActiveListing:       DealBucket;
  reUnderContractBuy:    DealBucket;
  reUnderContractSell:   DealBucket;
  re2026Buy:             DealBucket;
  re2026Sell:            DealBucket;
  mortgageUnderContract: DealBucket;
  mortgage2026:          DealBucket;
  totalVolume:     number;
  totalCommission: number;
  totalCount:      number;
}

function emptyAgentDeals(): AgentDeals {
  return {
    reActiveListing:       emptyBucket(),
    reUnderContractBuy:    emptyBucket(),
    reUnderContractSell:   emptyBucket(),
    re2026Buy:             emptyBucket(),
    re2026Sell:            emptyBucket(),
    mortgageUnderContract: emptyBucket(),
    mortgage2026:          emptyBucket(),
    totalVolume:     0,
    totalCommission: 0,
    totalCount:      0,
  };
}

export interface AgentRow {
  email: string;
  name: string;
  initials: string;
  isAdmin: boolean;
  fubUserId: number | null;
  calls: number;
  texts: number;
  emails: number;
  showings: number;
  showingDays: number;
  closedDeals: number;
  closedDealsAllTime: number;
  underContract: number;
  pipeline: Record<string, number>;
  totalActivity: number;
  totalLeads: number;
  newLeads: number;
  deals: AgentDeals;
}

export interface LeaderboardPayload {
  period: string;
  generatedAt: string;
  collectionWarnings?: string[];
  agents: AgentRow[];
  teamTotals: {
    calls: number;
    texts: number;
    emails: number;
    showings: number;
    showingDays: number;
    closedDeals: number;
    underContract: number;
    totalActivity: number;
    totalLeads: number;
    newLeads: number;
    dealVolume: number;
    dealCommission: number;
    dealCount: number;
  };
}

export type LeaderboardRefreshState = "fresh" | "cached" | "partial";

export interface LeaderboardResult {
  data: LeaderboardPayload;
  refreshState: LeaderboardRefreshState;
  retryAfterSeconds?: number;
}

export type Period = "today" | "yesterday" | "week" | "month" | "quarter" | "year";

export function fubHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": "Basic " + Buffer.from(`${apiKey}:`).toString("base64"),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts FUB requests at a measured pace and shares a 429 cooldown across all
 * leaderboard work. This prevents per-person text/email calls from retrying
 * independently and extending a rate-limit window.
 */
async function acquireFubRequestSlot(failFastOnCircuit: boolean): Promise<void> {
  let releaseQueue!: () => void;
  const previous = fubRequestQueue;
  fubRequestQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
  await previous;
  try {
    // Re-check after every wait because another in-flight request can extend
    // the shared cooldown while this request is queued.
    while (Math.max(fubNextRequestAt, fubCooldownUntil) > Date.now()) {
      if (failFastOnCircuit && fubCircuitOpenUntil > Date.now()) {
        throw new Error(`FUB rate limit cooldown active for ${Math.ceil((fubCircuitOpenUntil - Date.now()) / 1000)}s`);
      }
      await wait(Math.max(fubNextRequestAt, fubCooldownUntil) - Date.now());
    }
    fubNextRequestAt = Date.now() + FUB_REQUEST_INTERVAL_MS;
  } finally {
    releaseQueue();
  }
}

function retryDelayMs(retryAfter: string | null): number {
  const raw = retryAfter?.trim() ?? "";
  const seconds = Number(raw);
  // Bound server-provided values so a bad header cannot wedge the worker.
  if (raw && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, 1), MAX_RATE_LIMIT_COOLDOWN_MS);
  }
  const retryDate = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(retryDate)) {
    return Math.min(Math.max(retryDate - Date.now(), 1), MAX_RATE_LIMIT_COOLDOWN_MS);
  }
  return 5_000;
}

async function requestFubUrl(apiKey: string, path: string, url: URL): Promise<any> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    // Once one request exhausts its retries (or receives a long cooldown),
    // other queued metric requests fail fast instead of repeating the burst.
    if (attempt === 0 && fubCircuitOpenUntil > Date.now()) {
      throw new Error(`FUB rate limit cooldown active for ${Math.ceil((fubCircuitOpenUntil - Date.now()) / 1000)}s`);
    }
    await acquireFubRequestSlot(attempt === 0);
    if (attempt === 0 && fubCircuitOpenUntil > Date.now()) {
      throw new Error(`FUB rate limit cooldown active for ${Math.ceil((fubCircuitOpenUntil - Date.now()) / 1000)}s`);
    }
    const res = await fetch(url.toString(), { headers: fubHeaders(apiKey) });
    if (res.status === 429) {
      const delay = retryDelayMs(res.headers.get("retry-after"));
      fubCooldownUntil = Math.max(fubCooldownUntil, Date.now() + delay);
      fubCircuitOpenUntil = Math.max(fubCircuitOpenUntil, Date.now() + delay);
      if (delay > MAX_INLINE_RETRY_DELAY_MS) {
        throw new Error(`FUB ${path} rate limited; retry available in ${Math.ceil(delay / 1000)}s`);
      }
      if (attempt === MAX_RATE_LIMIT_RETRIES) {
        throw new Error(`FUB ${path} remained rate limited after ${attempt + 1} attempts`);
      }
      console.warn(`[fub-lb] 429 on ${path}; shared cooldown ${Math.ceil(delay / 1000)}s (retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`FUB ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error(`FUB ${path} request retries exhausted`);
}

async function fubGet(apiKey: string, path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${FUB_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const cacheKey = url.toString();
  const cached = _fubResponses.get(cacheKey);
  if (cached && Date.now() - cached.ts < FUB_RESPONSE_CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = requestFubUrl(apiKey, path, url);
  _fubResponses.set(cacheKey, { promise, ts: Date.now() });
  try {
    return await promise;
  } catch (err) {
    if (_fubResponses.get(cacheKey)?.promise === promise) _fubResponses.delete(cacheKey);
    throw err;
  }
}

async function fetchAllPages(apiKey: string, path: string, params: Record<string, string> = {}): Promise<any[]> {
  const LIMIT = 200;
  let offset = 0;
  const all: any[] = [];
  while (true) {
    const data = await fubGet(apiKey, path, { ...params, limit: String(LIMIT), offset: String(offset) });
    const key = Object.keys(data).find((k) => k !== "_metadata" && Array.isArray(data[k]));
    const items: any[] = key ? data[key] : [];
    all.push(...items);
    const total: number = data._metadata?.total ?? items.length;
    offset += LIMIT;
    if (offset >= total || items.length === 0) break;
  }
  return all;
}

async function runBatched<T>(tasks: (() => Promise<T>)[], concurrency = 2): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((t) => t()));
    results.push(...batchResults);
  }
  return results;
}

function getPeriodDates(period: Period): { startMs: number; startIso: string; endMs: number } {
  const now = new Date();
  let start: Date;
  let end: Date = now;

  switch (period) {
    case "today":
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "yesterday":
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      end   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "week": {
      start = new Date(now);
      start.setDate(now.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case "month": {
      start = new Date(now);
      start.setDate(now.getDate() - 30);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case "quarter": {
      const q = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), q * 3, 1);
      break;
    }
    case "year":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  return { startMs: start.getTime(), startIso: start.toISOString(), endMs: end.getTime() };
}

function getCreatedMs(record: any): number {
  const raw = record.created ?? record.createdAt ?? record.date ?? record.startTime ?? null;
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return isNaN(ms) ? 0 : ms;
}

function getUpdatedMs(record: any): number {
  const raw = record.updated ?? record.updatedAt ?? null;
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return isNaN(ms) ? 0 : ms;
}

function resolveEmail(
  obj: any,
  idMap: Map<number, TeamEmail>,
  nameMap: Map<string, TeamEmail>,
): TeamEmail | undefined {
  for (const field of ["userId", "assignedUserId", "createdById", "createdByUserId"]) {
    const raw = obj[field];
    if (raw != null && Number(raw) > 0) {
      const e = idMap.get(Number(raw));
      if (e) return e;
    }
  }
  const name = (obj.userName ?? obj.assignedTo ?? obj.createdBy ?? "").toLowerCase().trim();
  if (name) return nameMap.get(name);
  return undefined;
}

type DealCategory =
  | "reActiveListing" | "reUnderContractBuy" | "reUnderContractSell"
  | "re2026Buy"       | "re2026Sell"
  | "mortgageUnderContract" | "mortgage2026"
  | null;

function classifyDeal(deal: any): { category: DealCategory; isActive: boolean } {
  const pipeline = (deal.pipelineName ?? "").toLowerCase();
  const stage    = (deal.stageName    ?? "").toLowerCase();

  const isMortgage   = pipeline.includes("mortgage");
  const isRealEstate = pipeline.includes("real estate");

  if (isMortgage) {
    if (stage === "under contract") return { category: "mortgageUnderContract", isActive: true  };
    if (stage === "2026")           return { category: "mortgage2026",          isActive: false };
    if (stage === "2025")           return { category: "mortgage2026",          isActive: false };
  }

  if (isRealEstate) {
    if (stage === "active listing")        return { category: "reActiveListing",     isActive: true  };
    if (stage === "under contract - buy")  return { category: "reUnderContractBuy",  isActive: true  };
    if (stage === "under contract - sell") return { category: "reUnderContractSell", isActive: true  };
    if (stage === "2026 - buy")            return { category: "re2026Buy",           isActive: false };
    if (stage === "2026 - sell")           return { category: "re2026Sell",          isActive: false };
    if (stage === "2025") {
      const reTxn = (deal.customRealEstateTransaction ?? "").toLowerCase();
      return reTxn === "seller"
        ? { category: "re2026Sell", isActive: false }
        : { category: "re2026Buy",  isActive: false };
    }
  }

  return { category: null, isActive: false };
}

async function collectLeaderboardData(apiKey: string, period: Period): Promise<LeaderboardPayload> {
  console.log(`[fub-lb] fetching: period=${period}`);
  const collectionWarnings = new Set<string>();
  const noteCollectionFailure = (source: string, err: unknown): void => {
    collectionWarnings.add(source);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[fub-lb] partial ${source}: ${message}`);
  };
  const { startMs, startIso, endMs } = getPeriodDates(period);

  // Deal Pipeline always uses full calendar year — independent of activity period tab
  const dealYearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const dealYearEnd   = Date.now();

  const idMap = new Map<number, TeamEmail>(
    Object.entries(FUB_ID_TO_TEAM_EMAIL).map(([id, e]) => [Number(id), e as TeamEmail]),
  );
  const nameMap = new Map<string, TeamEmail>(
    Object.entries(FUB_NAME_TO_TEAM_EMAIL).map(([n, e]) => [n, e as TeamEmail]),
  );
  const teamEmailToFubId = new Map<TeamEmail, number>(
    Object.entries(FUB_ID_TO_TEAM_EMAIL).map(([id, e]) => [e as TeamEmail, Number(id)]),
  );

  const counts: Record<string, { calls: number; texts: number; emails: number; showings: number; showingDays: number }> = {};
  for (const m of LEADERBOARD_TEAM) counts[m.email] = { calls: 0, texts: 0, emails: 0, showings: 0, showingDays: 0 };

  // ── CALLS ────────────────────────────────────────────────────────────────
  try {
    const calls = await fetchAllPages(apiKey, "/calls", { since: startIso });
    let matched = 0;
    for (const call of calls) {
      const callMs = getCreatedMs(call);
      if (callMs < startMs || callMs >= endMs) continue;
      const email = resolveEmail(call, idMap, nameMap);
      if (email && counts[email]) { counts[email].calls++; matched++; }
    }
    console.log(`[fub-lb] calls: ${calls.length} fetched, ${matched} matched`);
  } catch (err) { noteCollectionFailure("calls", err); }

  // ── SHOWINGS — notes starting "Showed Homes: N" ──────────────────────────
  // Homes shown sums N; showing days counts notes, not unique calendar dates.
  try {
    const notes = await fetchAllPages(apiKey, "/notes", { since: startIso });
    let matched = 0;
    const SHOWING_PREFIX = "showed homes:";
    for (const note of notes) {
      const noteMs = getCreatedMs(note);
      if (noteMs < startMs || noteMs >= endMs) continue;
      const body = (note.body ?? "").toLowerCase().trim();
      if (!body.startsWith(SHOWING_PREFIX)) continue;
      const raw = body.slice(SHOWING_PREFIX.length).trim();
      const homesShown = parseInt(raw, 10);
      if (!homesShown || isNaN(homesShown) || homesShown <= 0) continue;
      const email = resolveEmail({ userId: note.createdById }, idMap, nameMap);
      if (email && counts[email]) {
        counts[email].showings += homesShown;
        counts[email].showingDays += 1;
        matched++;
      }
    }
    console.log(`[fub-lb] showings: ${matched} notes matched — homes shown and showing days both tracked`);
  } catch (err) { noteCollectionFailure("showings", err); }

  // ── PIPELINE + NEW LEADS ─────────────────────────────────────────────────
  const pipeline: Record<string, Record<string, number>> = {};
  const newLeadCounts: Record<string, number> = {};
  for (const m of LEADERBOARD_TEAM) {
    pipeline[m.email] = {};
    for (const s of PIPELINE_STAGES) pipeline[m.email][s] = 0;
    newLeadCounts[m.email] = 0;
  }

  const activePeopleByEmail: Record<string, Array<{ id: number }>> = {};
  for (const m of LEADERBOARD_TEAM) activePeopleByEmail[m.email] = [];

  let newLeadsTotal = 0;
  try {
    const people = await fetchAllPages(apiKey, "/people");
    for (const person of people) {
      const stage = (person.stage ?? "") as string;
      const email = resolveEmail(person, idMap, nameMap);
      if (email) {
        if (stage && pipeline[email] && pipeline[email][stage] !== undefined) pipeline[email][stage]++;
        const createdMs = getCreatedMs(person);
        if (createdMs >= startMs && createdMs < endMs && newLeadCounts[email] !== undefined) {
          newLeadCounts[email]++; newLeadsTotal++;
        }
        if (getUpdatedMs(person) >= startMs) activePeopleByEmail[email].push({ id: person.id });
      }
    }
    console.log(`[fub-lb] people: ${people.length} total, ${newLeadsTotal} new leads in period`);
  } catch (err) { noteCollectionFailure("people and new leads", err); }

  // ── TEXTS (per-person) ───────────────────────────────────────────────────
  for (const m of LEADERBOARD_TEAM) {
    const ap = activePeopleByEmail[m.email];
    if (!ap.length) continue;
    const tasks = ap.map(({ id }) => async () => {
      try {
        const t = await fetchAllPages(apiKey, "/textMessages", { personId: String(id) });
        return t.filter((x) => { const ms = getCreatedMs(x); return ms >= startMs && ms < endMs; }).length;
      } catch (err) {
        noteCollectionFailure("text messages", err);
        return 0;
      }
    });
    try {
      const results = await runBatched(tasks);
      counts[m.email].texts = results.reduce((s, n) => s + n, 0);
    } catch (err) { noteCollectionFailure(`text messages for ${m.name}`, err); }
  }

  // ── EMAILS (per-person) ──────────────────────────────────────────────────
  for (const m of LEADERBOARD_TEAM) {
    const ap = activePeopleByEmail[m.email];
    if (!ap.length) continue;
    const tasks = ap.map(({ id }) => async () => {
      try {
        const e = await fetchAllPages(apiKey, "/emails", { personId: String(id) });
        return e.filter((x) => { const ms = getCreatedMs(x); return ms >= startMs && ms < endMs; }).length;
      } catch (err) {
        noteCollectionFailure("emails", err);
        return 0;
      }
    });
    try {
      const results = await runBatched(tasks);
      counts[m.email].emails = results.reduce((s, n) => s + n, 0);
    } catch (err) { noteCollectionFailure(`emails for ${m.name}`, err); }
  }

  const activityUnderContract: Record<string, number> = {};
  const activityClosed: Record<string, number> = {};
  for (const m of LEADERBOARD_TEAM) { activityUnderContract[m.email] = 0; activityClosed[m.email] = 0; }

  // ── DEALS — always full year, independent of activity period ─────────────
  // Active stages (Active Listing, Under Contract) = always shown.
  // Closed stages (2026/2025) = filtered by projectedCloseDate within current year.
  const agentDeals: Record<string, AgentDeals> = {};
  for (const m of LEADERBOARD_TEAM) agentDeals[m.email] = emptyAgentDeals();

  try {
    const allDeals = await fetchAllPages(apiKey, "/deals");
    let matched = 0;

    for (const deal of allDeals) {
      const { category, isActive } = classifyDeal(deal);
      if (!category) continue;

      const dealUsers: Array<{ id: number; name: string }> = deal.users ?? [];
      // Activity counts use the selected period, independently of pipeline year.
      for (const u of dealUsers) {
        const email =
          idMap.get(Number(u.id)) ??
          nameMap.get((u.name ?? "").toLowerCase().trim());
        if (!email) continue;
        if (isActive && category !== "reActiveListing") {
          const rawDate = deal.mutualAcceptanceDate ?? deal.enteredStageAt ?? null;
          const ucMs = rawDate ? new Date(rawDate).getTime() : 0;
          if (ucMs > 0 && ucMs >= startMs && ucMs < endMs && activityUnderContract[email] !== undefined) {
            activityUnderContract[email]++;
          }
        } else if (!isActive) {
          const closeMs = deal.projectedCloseDate ? new Date(deal.projectedCloseDate).getTime() : 0;
          if (closeMs > 0 && closeMs >= startMs && closeMs < endMs && activityClosed[email] !== undefined) {
            activityClosed[email]++;
          }
        }
      }

      // Closed deals: filter by projectedCloseDate within current calendar year
      if (!isActive) {
        const closeMs = deal.projectedCloseDate ? new Date(deal.projectedCloseDate).getTime() : 0;
        if (!closeMs || closeMs < dealYearStart || closeMs > dealYearEnd) continue;
      }

      for (const u of dealUsers) {
        const email =
          idMap.get(Number(u.id)) ??
          nameMap.get((u.name ?? "").toLowerCase().trim());
        if (!email || !agentDeals[email]) continue;
        addToBucket(agentDeals[email][category], deal);
        matched++;
      }
    }

    console.log(`[fub-lb] deals: ${allDeals.length} total, ${matched} pipeline attributions`);
  } catch (err) { noteCollectionFailure("deal pipeline", err); }

  // Compute deal totals per agent
  for (const m of LEADERBOARD_TEAM) {
    const d = agentDeals[m.email];
    const buckets = [
      d.reActiveListing, d.reUnderContractBuy, d.reUnderContractSell,
      d.re2026Buy, d.re2026Sell, d.mortgageUnderContract, d.mortgage2026,
    ];
    d.totalVolume     = buckets.reduce((s, b) => s + b.volume, 0);
    d.totalCommission = buckets.reduce((s, b) => s + b.commission, 0);
    d.totalCount      = buckets.reduce((s, b) => s + b.count, 0);
  }

  // ── Build rows ────────────────────────────────────────────────────────────
  const agents: AgentRow[] = LEADERBOARD_TEAM.map((m) => {
    const c = counts[m.email];
    const p = pipeline[m.email] ?? {};
    const totalActivity = c.calls + c.texts + c.emails;
    const totalLeads    = Object.values(p).reduce((sum, n) => sum + n, 0);

    return {
      email:              m.email,
      name:               m.name,
      initials:           m.initials,
      isAdmin:            m.isAdmin,
      fubUserId:          teamEmailToFubId.get(m.email) ?? null,
      calls:              c.calls,
      texts:              c.texts,
      emails:             c.emails,
      showings:           c.showings,
      showingDays:        c.showingDays,
      closedDeals:        activityClosed[m.email] ?? 0,
      closedDealsAllTime: pipeline[m.email]?.["Closed"] ?? 0,
      underContract:      activityUnderContract[m.email] ?? 0,
      pipeline:           p,
      totalActivity,
      totalLeads,
      newLeads:           newLeadCounts[m.email] ?? 0,
      deals:              agentDeals[m.email],
    };
  });

  agents.sort((a, b) =>
    b.totalActivity !== a.totalActivity
      ? b.totalActivity - a.totalActivity
      : b.closedDeals - a.closedDeals,
  );

  const teamTotals = {
    calls:          agents.reduce((s, r) => s + r.calls, 0),
    texts:          agents.reduce((s, r) => s + r.texts, 0),
    emails:         agents.reduce((s, r) => s + r.emails, 0),
    showings:       agents.reduce((s, r) => s + r.showings, 0),
    showingDays:    agents.reduce((s, r) => s + r.showingDays, 0),
    closedDeals:    agents.reduce((s, r) => s + r.closedDeals, 0),
    underContract:  agents.reduce((s, r) => s + r.underContract, 0),
    totalActivity:  agents.reduce((s, r) => s + r.totalActivity, 0),
    totalLeads:     agents.reduce((s, r) => s + r.totalLeads, 0),
    newLeads:       agents.reduce((s, r) => s + r.newLeads, 0),
    dealVolume:     agents.reduce((s, r) => s + r.deals.totalVolume, 0),
    dealCommission: agents.reduce((s, r) => s + r.deals.totalCommission, 0),
    dealCount:      agents.reduce((s, r) => s + r.deals.totalCount, 0),
  };

  const payload: LeaderboardPayload = {
    period,
    generatedAt: new Date().toISOString(),
    ...(collectionWarnings.size > 0 ? { collectionWarnings: [...collectionWarnings] } : {}),
    agents,
    teamTotals,
  };

  console.log(`[fub-lb] done — calls:${teamTotals.calls} texts:${teamTotals.texts} deals:${teamTotals.dealCount} vol:$${teamTotals.dealVolume.toLocaleString()}`);
  return payload;
}

function refreshStateFor(data: LeaderboardPayload): LeaderboardRefreshState {
  return data.collectionWarnings?.length ? "partial" : "fresh";
}

function startLeaderboardRefresh(apiKey: string, period: Period): Promise<LeaderboardPayload> {
  const existing = _refreshes.get(period);
  if (existing) return existing;

  // Serialize whole collections, not just individual HTTP request starts.
  // Different period tabs share most expensive FUB sources, so allowing their
  // collections to overlap would still create duplicate traffic.
  const collection = _collectionTail.then(() => collectLeaderboardData(apiKey, period));
  _collectionTail = collection.then(() => undefined, () => undefined);

  const refresh = collection
    .then((data) => {
      const warnings = data.collectionWarnings ?? [];
      const cached = _cache.get(period);

      if (warnings.length > 0) {
        _refreshFailures.set(period, {
          warnings,
          retryAt: Math.max(fubCircuitOpenUntil, Date.now() + PARTIAL_CACHE_TTL_MS),
        });

        // A degraded refresh must never replace a known-good snapshot. If
        // there is no complete snapshot yet, partial data is still useful.
        if (cached && !cached.data.collectionWarnings?.length) return cached.data;
        _cache.set(period, { data, ts: Date.now() });
        return data;
      }

      _refreshFailures.delete(period);
      _cache.set(period, { data, ts: Date.now() });
      return data;
    })
    .finally(() => {
      if (_refreshes.get(period) === refresh) _refreshes.delete(period);
    });
  _refreshes.set(period, refresh);
  return refresh;
}

export async function getLeaderboardData(apiKey: string, period: Period): Promise<LeaderboardResult> {
  const cached = _cache.get(period);
  const failedRefresh = _refreshFailures.get(period);
  if (failedRefresh && failedRefresh.retryAt <= Date.now()) {
    _refreshFailures.delete(period);
  } else if (cached && failedRefresh) {
    const retryAfterSeconds = Math.max(1, Math.ceil((failedRefresh.retryAt - Date.now()) / 1000));
    return {
      data: cached.data,
      refreshState: cached.data.collectionWarnings?.length ? "partial" : "cached",
      retryAfterSeconds,
    };
  }

  const cacheTtl = cached?.data.collectionWarnings?.length ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS;
  if (cached && Date.now() - cached.ts < cacheTtl) {
    console.log(`[fub-lb] cache hit: ${period}`);
    return { data: cached.data, refreshState: refreshStateFor(cached.data) };
  }

  const refresh = startLeaderboardRefresh(apiKey, period);
  if (cached) {
    // Keep this request fast and preserve the last complete/partial snapshot.
    // The shared promise means polling clients cannot start duplicate refreshes.
    void refresh.catch((err) => {
      console.error(`[fub-lb] background refresh failed (${period}):`, err);
    });
    const retryAfterSeconds = fubCooldownUntil > Date.now()
      ? Math.ceil((fubCooldownUntil - Date.now()) / 1000)
      : undefined;
    return {
      data: cached.data,
      refreshState: "cached",
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }

  const data = await refresh;
  const failure = _refreshFailures.get(period);
  if (failure) {
    return {
      data,
      refreshState: data.collectionWarnings?.length ? "partial" : "cached",
      retryAfterSeconds: Math.max(1, Math.ceil((failure.retryAt - Date.now()) / 1000)),
    };
  }
  return { data, refreshState: refreshStateFor(data) };
}

export function bustLeaderboardCache(period?: Period): void {
  _fubResponses.clear();
  if (period) {
    const cached = _cache.get(period);
    if (cached) cached.ts = 0;
    return;
  }
  for (const cached of _cache.values()) cached.ts = 0;
}