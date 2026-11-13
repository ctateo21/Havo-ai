import {
  claimQuoteResultEmail,
  claimQuotePollJob,
  listPendingQuoteCaches,
  listQuoteEmailRecoveryRows,
  readQuoteCache,
  updateQuoteCache,
  type QuoteCacheRow,
  type QuoteCacheInsert,
  type QuoteCacheGeneration,
} from "../managed-quote-cache";
import {
  getQuotes,
  type QuoteRushQuote,
  type QuoteRushResult,
} from "./quoterush";
import { sendQuoteRushResultsEmail,sendInternalAlert } from "./property-alert-emails";
import {sendLiveInsuranceLeadAlert} from "./live-insurance-lead-alert";

export const QUOTE_POLL_INTERVAL_MS = 20_000;
export const MAX_QUOTE_POLL_ATTEMPTS = 36;
export const MAX_QUOTE_POLL_AGE_MS =
  QUOTE_POLL_INTERVAL_MS * MAX_QUOTE_POLL_ATTEMPTS;

export type QuoteJobOutcome =
  | "pending"
  | "completed"
  | "failed"
  | "missing";

export interface QuotePollingDependencies {
  alertManualReview?: (row:QuoteCacheRow)=>Promise<unknown>;
  getQuotes: (leadId: number) => Promise<QuoteRushResult>;
  readQuoteCache: (
    identity: { id: number },
    limit?: number,
  ) => Promise<QuoteCacheRow[]>;
  updateQuoteCache: (
    id: number,
    values: Partial<QuoteCacheInsert>,
    generation?: QuoteCacheGeneration,
  ) => Promise<unknown>;
  claimQuotePoll?: (
    id: number,
    generation: QuoteCacheGeneration,
    now?: Date,
  ) => Promise<QuoteCacheRow | undefined>;
  claimQuoteResultEmail: (
    id: number,
    now?: Date,
  ) => Promise<QuoteCacheRow | undefined>;
  sendResultsEmail: (args: {
    to: string;
    userId: string;
    propertyAddress: string;
    quotes: QuoteRushQuote[];
    windMitigationReportConfirmed: boolean;
    idempotencyKey: string;
    assumptions?: string[];
  }) => Promise<{ status: "sent" | "failed" | "skipped"; error: string | null }>;
}

const defaultDependencies: QuotePollingDependencies = {
  alertManualReview:async row=>{
    const {notifyInsuranceCrm}=await import("./quoterush-import-jobs");
    const {supabaseAdmin}=await import("../supabase");
    const {insuranceContact}=await import("../insurance-contact");
    const profile=row.ownerUserId&&supabaseAdmin
      ? (await supabaseAdmin.from("profiles").select("name,phone,email").eq("id",row.ownerUserId).maybeSingle()).data:null;
    const metadata=row.ownerUserId&&supabaseAdmin
      ? (await supabaseAdmin.auth.admin.getUserById(row.ownerUserId)).data.user?.user_metadata??{}:{};
    const contact=insuranceContact(profile,metadata,row.emailRecipient??"");
    await notifyInsuranceCrm(row,contact,"No usable carrier quotes; agent follow-up requested");
    await sendLiveInsuranceLeadAlert({address:row.addressDisplay,name:contact.name||"Contact details need review",email:contact.email,phone:contact.phone,
      requestId:`manual-${row.id}-${row.triggeredAt.getTime()}`});
  },
  getQuotes,
  readQuoteCache,
  updateQuoteCache,
  claimQuotePoll: claimQuotePollJob,
  claimQuoteResultEmail,
  sendResultsEmail: sendQuoteRushResultsEmail,
};

type PollState = {
  attempts: number;
  previousCounter: number | null;
  stablePolls: number;
};

const scheduledJobs = new Map<number, ReturnType<typeof setTimeout>>();
const pollStates = new Map<string, PollState>();

function sameGeneration(
  left: QuoteCacheGeneration,
  right: QuoteCacheGeneration,
): boolean {
  return left.leadId === right.leadId &&
    left.triggeredAt.getTime() === right.triggeredAt.getTime() &&
    (right.quotePollClaimedAt == null ||
      left.quotePollClaimedAt == null ||
      left.quotePollClaimedAt.getTime() === right.quotePollClaimedAt.getTime());
}

async function compareAndSetCache(
  row: QuoteCacheRow,
  values: Partial<QuoteCacheInsert>,
  dependencies: QuotePollingDependencies,
  expectedStatus: QuoteCacheRow["status"] = "pending",
): Promise<QuoteCacheRow | undefined> {
  const updated = await dependencies.updateQuoteCache(row.id, values, {
    triggeredAt: row.triggeredAt,
    leadId: row.leadId,
    quotePollClaimedAt: row.quotePollClaimedAt,
    expectedStatus,
  });
  if (!updated || typeof updated !== "object" || Array.isArray(updated)) {
    return undefined;
  }
  const updatedRow = updated as QuoteCacheRow;
  if (!sameGeneration(updatedRow, {
    triggeredAt: row.triggeredAt,
    leadId: row.leadId,
    quotePollClaimedAt: row.quotePollClaimedAt,
    expectedStatus,
  })) return undefined;
  return updatedRow;
}

export function topThreePositiveQuotes(quotes: QuoteRushQuote[]): QuoteRushQuote[] {
  return quotes
    .filter(quote => Number(quote.annualPremium) > 0)
    .sort((a, b) => a.annualPremium - b.annualPremium)
    .slice(0, 3)
    .map((quote, index) => ({ ...quote, rank: index + 1 }));
}

function quoteAgeMs(row: QuoteCacheRow, now: Date): number {
  const triggeredAt = row.triggeredAt instanceof Date
    ? row.triggeredAt.getTime()
    : Date.parse(String(row.triggeredAt));
  return Number.isFinite(triggeredAt)
    ? Math.max(0, now.getTime() - triggeredAt)
    : MAX_QUOTE_POLL_AGE_MS;
}

function pollStateKey(row: QuoteCacheRow): string {
  return `${row.id}:${row.triggeredAt.getTime()}:${row.leadId ?? "pending"}`;
}

function clearScheduledJob(id: number): void {
  const timer = scheduledJobs.get(id);
  if (timer) clearTimeout(timer);
  scheduledJobs.delete(id);
}

async function deliverResultsEmail(
  row: QuoteCacheRow,
  dependencies: QuotePollingDependencies,
): Promise<void> {
  const claimed = await dependencies.claimQuoteResultEmail(row.id);
  if (!claimed) return;
  if (claimed.emailDeliveryStatus === "quarantined") return;

  const recipient = claimed.emailRecipient?.trim();
  const userId = claimed.emailUserId?.trim();
  if (!recipient || !userId) {
    await compareAndSetCache(claimed, {
      emailDeliveryStatus: "skipped",
      emailSentAt: null,
      emailError: "recipient identity unavailable",
    }, dependencies, "success");
    return;
  }

  const provenance = claimed.propertyDataProvenance;
  const windMitigationReportConfirmed =
    provenance &&
    typeof provenance === "object" &&
    (provenance as Record<string, unknown>).windMitigationReportConfirmed === true;
  const result = await dependencies.sendResultsEmail({
    to: recipient,
    userId,
    propertyAddress: claimed.addressDisplay,
    quotes: topThreePositiveQuotes((claimed.quotes ?? []) as QuoteRushQuote[]),
    windMitigationReportConfirmed: windMitigationReportConfirmed === true,
    assumptions:claimed.assumptions??[],
    idempotencyKey:
      `insurance-quote-cache:${claimed.id}:` +
      `${claimed.triggeredAt.getTime()}:results`,
  });
  await compareAndSetCache(claimed, {
    emailDeliveryStatus: result.status,
    emailSentAt: result.status === "sent" ? new Date() : null,
    emailError: result.error,
  }, dependencies, "success");
  if(result.status==="sent" && !(claimed.quotes??[]).length)await dependencies.alertManualReview?.(claimed);
}

/** Perform one server-owned GetQuotes poll. The cache row remains pending
 * while the carrier count is changing, so reconnecting clients only observe
 * the durable cache and never contact QuoteRUSH themselves. */
export async function pollQuoteJob(
  cacheId: number,
  dependencies: QuotePollingDependencies = defaultDependencies,
  now = new Date(),
  leadIdOverride?: number,
  overrideTriggeredAt?: Date,
): Promise<QuoteJobOutcome> {
  const rows = await dependencies.readQuoteCache({ id: cacheId }, 1);
  let row = rows[0];
  if (!row) {
    return "missing";
  }
  // A lead retained only in memory after a failed DB publication belongs to
  // one run, not to the reusable address row. Never apply it to a replacement.
  if (leadIdOverride != null && (
    !overrideTriggeredAt ||
    row.triggeredAt.getTime() !== overrideTriggeredAt.getTime() ||
    (row.leadId != null && row.leadId !== leadIdOverride)
  )) return "missing";
  if (row.status !== "pending") {
    if (row.status === "success") {
      await deliverResultsEmail(row, dependencies);
      return "completed";
    }
    return row.status === "failed" || row.status === "error"
      ? "failed"
      : "missing";
  }
  const leadId = leadIdOverride ?? row.leadId;
  if (leadId && dependencies.claimQuotePoll) {
    const leased = await dependencies.claimQuotePoll(cacheId, {
      triggeredAt: row.triggeredAt,
      leadId: row.leadId,
    }, now);
    if (!leased) return "pending";
    row = leased;
  }
  if (quoteAgeMs(row, now) >= MAX_QUOTE_POLL_AGE_MS) {
    const partialQuotes = topThreePositiveQuotes(
      (row.quotes ?? []) as QuoteRushQuote[],
    );
    const updated = await compareAndSetCache(row, partialQuotes.length > 0
      ? {
          status: "success",
          quotes: partialQuotes,
          completedAt: now,
          quotePollAttempts: row.quotePollAttempts ?? MAX_QUOTE_POLL_ATTEMPTS,
          quotePollClaimedAt: null,
          quotePollLeaseUntil: null,
        }
      : {
          status: "success",
          completedAt: now,
          quotePollAttempts: row.quotePollAttempts ?? MAX_QUOTE_POLL_ATTEMPTS,
          quotePollClaimedAt: null,
          quotePollLeaseUntil: null,
          emailError: leadId
            ? "No usable carrier quote stabilized before the polling window expired"
            : "QuoteRUSH lead was not published before the polling window expired",
        }, dependencies);
    if (!updated) return "missing";
    await deliverResultsEmail(updated, dependencies);
    pollStates.delete(pollStateKey(row));
    return "completed";
  }
  // A concurrent caller may have claimed the row while its lead is still
  // being imported. Never treat that short null-lead window as a retryable
  // paid run; leave it pending until the original claimant publishes it.
  if (!leadId) return "pending";

  const stateKey = pollStateKey(row);
  const priorState = pollStates.get(stateKey);
  const state: PollState = priorState ?? {
    attempts: row.quotePollAttempts ?? 0,
    previousCounter: row.quotePreviousCounter ?? null,
    stablePolls: row.quoteStablePolls ?? 0,
  };
  state.attempts += 1;
  pollStates.set(stateKey, state);

  let result: QuoteRushResult;
  try {
    result = await dependencies.getQuotes(leadId);
  } catch {
    result = {
      status: "error",
      quotes: [],
      leadId,
      quoteCounter: row.quoteCounter ?? 0,
    };
  }

  const providerErrored = result.status === "error";
  const observedCounter = Number(result.quoteCounter ?? 0);
  const counter = providerErrored && state.previousCounter != null
    ? state.previousCounter
    : observedCounter;
  if (!providerErrored && counter > 0 && state.previousCounter === counter) {
    state.stablePolls += 1;
  } else if (!providerErrored) {
    state.stablePolls = 0;
  }
  if (!providerErrored) state.previousCounter = counter;

  // QuoteRUSH can return a transient transport/error response after it has
  // already produced usable carriers. Never replace those durable partials
  // with an empty error response.
  const observedQuotes = topThreePositiveQuotes(result.quotes ?? []);
  const quotes = observedQuotes.length > 0
    ? observedQuotes
    : topThreePositiveQuotes((row.quotes ?? []) as QuoteRushQuote[]);
  const reachedAttemptLimit = state.attempts >= MAX_QUOTE_POLL_ATTEMPTS;
  const stabilized = counter > 0 && state.stablePolls >= 3;
  const shouldComplete = quotes.length > 0 &&
    ((result.status === "success" && stabilized) || reachedAttemptLimit);

  if (shouldComplete) {
    const updated = await compareAndSetCache(row, {
      status: "success",
      leadId,
      quotes,
      quoteCounter: counter,
      quotePollAttempts: state.attempts,
      quoteStablePolls: state.stablePolls,
      quotePreviousCounter: state.previousCounter,
      completedAt: now,
      quotePollClaimedAt: null,
      quotePollLeaseUntil: null,
    }, dependencies);
    if (!updated) return "missing";
    await deliverResultsEmail(updated, dependencies);
    pollStates.delete(stateKey);
    return "completed";
  }

  if (reachedAttemptLimit || quoteAgeMs(row, now) >= MAX_QUOTE_POLL_AGE_MS) {
    if (quotes.length > 0) {
      const updated = await compareAndSetCache(row, {
        status: "success",
        leadId,
        quotes,
        quoteCounter: counter,
        quotePollAttempts: state.attempts,
        quoteStablePolls: state.stablePolls,
        quotePreviousCounter: state.previousCounter,
        completedAt: now,
        quotePollClaimedAt: null,
        quotePollLeaseUntil: null,
      }, dependencies);
      if (!updated) return "missing";
      await deliverResultsEmail(updated, dependencies);
      pollStates.delete(stateKey);
      return "completed";
    }
    const updated = await compareAndSetCache(row, {
      status: "success",
      leadId,
      quotes,
      quoteCounter: counter,
      quotePollAttempts: state.attempts,
      quoteStablePolls: state.stablePolls,
      quotePreviousCounter: state.previousCounter,
      completedAt: now,
      quotePollClaimedAt: null,
      quotePollLeaseUntil: null,
      emailError: result.status === "error"
        ? "QuoteRUSH did not return a usable result before the polling window expired"
        : "No positive carrier quote stabilized before the polling window expired",
    }, dependencies);
    if (!updated) return "missing";
    await deliverResultsEmail(updated,dependencies);
    pollStates.delete(stateKey);
    return "completed";
  }

  const updated = await compareAndSetCache(row, {
    status: "pending",
    leadId,
    quotes,
    quoteCounter: counter,
    quotePollAttempts: state.attempts,
    quoteStablePolls: state.stablePolls,
    quotePreviousCounter: state.previousCounter,
    quotePollClaimedAt: null,
    quotePollLeaseUntil: null,
  }, dependencies);
  if (!updated) return "missing";
  return "pending";
}

/** Run a complete job with an injected sleep function. Production uses the
 * one-poll scheduler below; tests can use a zero-delay sleep and mocked
 * QuoteRUSH responses without making paid requests. */
export async function runQuotePollingJob(
  cacheId: number,
  options: {
    dependencies?: QuotePollingDependencies;
    maxAttempts?: number;
    now?: Date;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<QuoteJobOutcome> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? MAX_QUOTE_POLL_ATTEMPTS;
  let outcome: QuoteJobOutcome = "pending";
  for (let attempt = 0; attempt < maxAttempts && outcome === "pending"; attempt++) {
    outcome = await pollQuoteJob(
      cacheId,
      dependencies,
      options.now ?? new Date(),
    );
    if (outcome === "pending" && attempt + 1 < maxAttempts) {
      await sleep(QUOTE_POLL_INTERVAL_MS);
    }
  }
  if (outcome === "pending") {
    const rows = await dependencies.readQuoteCache({ id: cacheId }, 1);
    let terminalRow: QuoteCacheRow | undefined = rows[0];
    if (
      terminalRow?.status === "pending" &&
      terminalRow.leadId &&
      dependencies.claimQuotePoll
    ) {
      terminalRow = await dependencies.claimQuotePoll(
        terminalRow.id,
        {
          triggeredAt: terminalRow.triggeredAt,
          leadId: terminalRow.leadId,
        },
        options.now ?? new Date(),
      );
    }
    if (terminalRow?.status === "pending" && terminalRow.leadId) {
      const partialQuotes = topThreePositiveQuotes(
        (terminalRow.quotes ?? []) as QuoteRushQuote[],
      );
      if (partialQuotes.length > 0) {
        const updated = await compareAndSetCache(terminalRow, {
          status: "success",
          quotes: partialQuotes,
          completedAt: options.now ?? new Date(),
        }, dependencies);
        if (!updated) return "missing";
        await deliverResultsEmail(updated, dependencies);
        return "completed";
      }
      const updated = await compareAndSetCache(terminalRow, {
        status: "failed",
        completedAt: options.now ?? new Date(),
        emailError: "No positive carrier quote stabilized before the polling window expired",
      }, dependencies);
      if (!updated) return "missing";
      return "failed";
    }
  }
  return outcome;
}

export function scheduleQuoteJob(
  cacheId: number,
  delayMs = QUOTE_POLL_INTERVAL_MS,
  leadIdOverride?: number,
  overrideTriggeredAt?: Date,
): void {
  clearScheduledJob(cacheId);
  const timer = setTimeout(async () => {
    scheduledJobs.delete(cacheId);
    try {
      const outcome = await pollQuoteJob(
        cacheId,
        defaultDependencies,
        new Date(),
        leadIdOverride,
        overrideTriggeredAt,
      );
      if (outcome === "pending") {
        scheduleQuoteJob(cacheId, QUOTE_POLL_INTERVAL_MS, leadIdOverride, overrideTriggeredAt);
      }
    } catch {
      scheduleQuoteJob(cacheId, QUOTE_POLL_INTERVAL_MS, leadIdOverride, overrideTriggeredAt);
    }
  }, delayMs);
  timer.unref?.();
  scheduledJobs.set(cacheId, timer);
}

/** Re-queue pending rows after a process restart and recover a successful row
 * whose email marker was still `sending` when the old process exited. */
export async function resumePendingQuoteJobs(): Promise<void> {
  try {
    const pending = await listPendingQuoteCaches();
    const now = new Date();
    for (const row of pending) {
      if (quoteAgeMs(row, now) >= MAX_QUOTE_POLL_AGE_MS) {
        await pollQuoteJob(row.id);
      } else if (row.leadId) {
        scheduleQuoteJob(row.id, 0);
      } else {
        scheduleQuoteJob(row.id, 0);
      }
    }
    const emailRecovery = await listQuoteEmailRecoveryRows();
    for (const row of emailRecovery) {
      await deliverResultsEmail(row, defaultDependencies);
    }
  } catch {
    // Do not log row identities or provider responses. The next deployment or
    // scheduler pass can retry the durable queue.
    console.error("[qr-background] resume failed");
  }
}

let quoteSweeper: ReturnType<typeof setInterval> | null = null;

/** Durable queue recovery must continue after boot. In particular, a fresh
 * `sending` claim is intentionally left alone for concurrent-worker safety,
 * then reclaimed by this bounded retry sweeper if its owner crashed. */
export function startQuoteJobSweeper(
  intervalMs = QUOTE_POLL_INTERVAL_MS,
  resume: () => Promise<void> = resumePendingQuoteJobs,
): void {
  if (quoteSweeper) return;
  void resume();
  quoteSweeper = setInterval(() => {
    void resume();
  }, intervalMs);
  quoteSweeper.unref?.();
}

export function stopQuoteJobSweeper(): void {
  if (!quoteSweeper) return;
  clearInterval(quoteSweeper);
  quoteSweeper = null;
}
