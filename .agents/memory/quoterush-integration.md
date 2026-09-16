---
name: QuoteRUSH live carrier quoting
description: How Havo's live insurance quoting talks to QuoteRUSH — manual trigger, address+policy cache, property provenance, lead authz, privacy, and duplicate-spend protection.
---

# QuoteRUSH integration

Live carrier home-insurance quoting on the insurance page. Flow:
enrich property data → import lead (importer.quoterush.com) → extract
LeadId → SubmitQuoteRequest (triggers QuoteBot) → client polls
GetQuotes every 30s (QuoteCounter=0 means still processing; quotes
arrive over 2–10 min).

## Quoting is MANUAL-only (no auto-trigger anywhere)
Per product decision, a new (paid) QuoteRUSH quote fires **only** when
the user clicks "Get Live Quotes" in the insurance page's detailed view
(`startQuoteRush`). All automatic triggering is disabled:
- The background pre-warm `triggerAutoQuote(...)` calls were removed from
  the estimate, refinance, seller-estimate, and cash-buy pages.
- The insurance-page auto-hydrate effect no longer calls `startQuoteRush()`
  when the cache is empty; it now only *reads* cache to display existing
  results and otherwise leaves `qrStatus` "idle" so the button shows.
**Why:** the owner wanted to stop spending on quotes for every address
that merely gets viewed. Cache display is preserved everywhere; only the
paid submission is gated behind the explicit click.
**How to apply:** if asked to "auto-quote" or "warm the cache" again,
re-add `triggerAutoQuote` and/or restore the `startQuoteRush()` fallthrough
— but confirm intent first, this was deliberately turned off.

## Secret-name mismatch (important)
The original spec referenced `QUOTERUSH_WEBPASSWORD` and
`QUOTERUSH_AGENCY`, but the **actual stored Replit secrets** are
`QUOTERUSH_WEBID_PASSWORD` and `QUOTERUSH_AGENCY_ID`.
`server/integrations/quoterush.ts` reads the real names first with the
spec names as fallback. Also uses `QUOTERUSH_WEBID`,
`QUOTERUSH_ENDPOINT_KEY`, and `QUOTERUSH_ASSIGNED_EMAIL` (defaults to a
Tateo agent email when unset).
**Why:** if a future change "follows the spec literally" it will read
empty env vars and silently fail with "QuoteRUSH env vars not set".

## Shared address + policy cache
Paid quotes are shared for 30 days by normalized property address plus
policy type (HO3/HO6/DP3), not by user and not by address alone. The first
searcher pays; later searchers receive only the three lowest positive
carrier results and the original non-private property/default context.

**Privacy rule:** shared snapshots may contain property facts, provenance,
coverage/default assumptions, and manual-lock flags. They must never contain
DOB, identity/contact data, user IDs, claim history/count/details, or reusable
personal underwriting data.

**Authorization rule:** polling and refresh require authentication and must
bind lead ID, normalized address, and policy type before any QuoteRUSH call or
cache write. Never authorize on an enumerable lead ID alone.

**Why:** address-only identity mixed policy forms; unbound lead polling enabled
enumeration/cache poisoning; applicant-specific fields are unsafe to share.

**How to apply:** keep the Neon composite uniqueness constraint, client cache
key, server lookup, atomic claim, polling request, and update predicate in
lockstep whenever the cache identity changes.

## Concurrent claim race + lost-race client flow
qr-start claims the cache row atomically via `onConflictDoNothing`.
Pending rows are **never deleted** (returning them lets late arrivals
attach to the in-flight lead). If a caller loses the claim race it gets
`{leadId:null, fromCache:true, status:"pending"}` — it must NOT fire a
second (paid) submission.
**Client rule:** every pending-without-leadId entry point (startQuoteRush,
the auto-hydrate effect's local+server branches, and quoterush-auto.ts's
qr-start handler) funnels into `pollCacheForLead(addr)` which polls
qr-cache every 5s (24-attempt cap) until a leadId/success appears, then
hands off to `startPolling`. Treat `{status:"pending"}` as pending, not
error. `qrWaitRef` holds that timer and is cleared on address change.

If QuoteRUSH has already created a lead but submit status is ambiguous (HTTP
error, timeout, or connection reset), preserve that lead and keep the cache
pending for reconciliation/polling. Never mark it retryable and re-import,
because the first submit may have succeeded and a retry can duplicate spend.

## Poll-until-stable (fixes "only 1 carrier")
Client GetQuotes polling waits for **3 consecutive stable polls**
(unchanging QuoteCounter) before declaring success, so it doesn't stop
at the first carrier while others are still arriving.

## Effective-date precedence
New purchases use the consumer-confirmed closing date. Existing homes use the
explicit requested effective date when supplied, then the user's private,
property-specific current-policy expiration. Only when both existing-home dates are
unavailable may the quote use today + 30 days, and that fallback must be
labeled as an assumption in provenance. New purchases must never use the
30-day fallback.

PurchaseDate is a separate transaction-history value. A confirmed new-purchase
closing date may populate both PurchaseDate and PolicyEffectiveDate; rewrite
requested dates, current-policy expirations, and +30 fallbacks must never
populate PurchaseDate. Unknown historical purchase dates are omitted.

**Why:** silently regenerating today + 30 inside the importer discarded a
confirmed transaction date and made a material rating input untraceable.
Changing a private expiration must not invalidate or replace a still-valid
shared preliminary quote.

**How to apply:** return valid address+policy cache hits before resolving private
dates. For a first paid run, resolve the date at the server boundary and keep
expiration values only in the private user/property store. Never use legacy
scope columns for lookup, claim, polling, uniqueness, or expiration rotation;
omit effective-date values from shared snapshots and browser local storage.

## Explicit property answers always win
When a user provides exact property answers for a live quote, send those
answers unchanged and do not let QuoteRUSH property enrichment replace
the year built or construction. Any client capable of starting a paid
quote must require the exact year, roof, opening-protection, roof-shape,
SWR, construction, and deductible inputs rather than silently filling
legacy bucket defaults. Values the UI does not collect must be disclosed
as carrier assumptions that need confirmation.
**Why:** the general estimate collects exact details, and grouped or
enriched substitutes can materially change a carrier result while the
address+policy cache preserves that first result for 30 days.
**How to apply:** keep exact fields first-priority at the quote boundary;
use enrichment only for missing ancillary data such as square footage,
and retain the shared cache/race protections rather than re-quoting when
answers change.

## Property characteristics and no-fabrication boundary
Automated factual precedence is manual confirmation → county/parcel →
QuoteRUSH property data → FEMA/government → Zillow/Havo cache → disclosed
agency default. A manual lock always wins.

The shared property-characteristics cache lives in Supabase with a one-year
TTL; the paid quote cache lives in Neon. Hillsborough and Collier intentionally
cache null county-building data because no reliable source is available.

Never fabricate square footage, unknown FEMA zone X, claim records, a flood
policy, mortgage status, or framing subtype. Stucco is an exterior finish, not
a framing value. Unknown values are omitted or explicitly collected. Claims
are user-owned/private and require complete actual details before submission.

**Why:** invented rating inputs can materially misprice a quote and are then
amplified by the 30-day shared cache.

**How to apply:** verified enrichment may fill only missing unlocked values;
cache/public responses must preserve provenance without exposing private
underwriting answers.

## QuoteRUSH Apply Defaults is emulated in the importer

Havo cannot click the Apply Defaults control inside the QuoteRUSH desktop
application. Policy-specific defaults must be resolved in Havo and sent as
explicit importer fields so a new lead arrives in the same intended state.
The current property-information rules require Primary/Secondary for HO3,
force Investment for DP3, allow Primary/Secondary/Investment for HO6, and
require annual/monthly/weekly rental terms for DP3 and investment HO6. Every
policy uses 9 months or more occupied.

PurchasePrice and Coverage A are independent. PurchasePrice precedence is
consumer-confirmed value → exact listing → prior sale → market estimate →
explicitly requested manual value. It must never be derived from rebuild cost,
insurance premium, or an HO6 multiplier.

**Why:** the integration has only the JSON importer and quote-submission API;
it has no control channel into the desktop UI.

**How to apply:** future QuoteRUSH phases should add equivalent importer
fields rather than attempting UI automation, and should resolve material
policy defaults at the server boundary before the address cache is claimed.

## Expired/error cache reclaim integrity
Valid unexpired cache hits remain readable without collecting a new person's
private answers. For a stale/error row, however, all consent, claims,
occupancy/rental, purchase-price/date, and prior-insurance gates must pass
before the row is mutated to pending.

Reclaim must atomically replace every run-specific snapshot, provenance,
assumption, answer, profile-version, and timestamp field while preserving
independently retained server-only raw property evidence.

**Why:** mutating first lets invalid callers poison the shared slot for 30 days,
and partial reset causes new paid inputs to be paired with stale public context.

**How to apply:** keep valid-hit returns before private gates; keep every stale
reclaim mutation after those gates and guarded by the same expired/error
predicate used for the atomic claim.

## Top-3 for 30 days then expired
Cache stores the top-3 ranked quotes; after the 30-day TTL the entry is
served with an `expired` flag → UI shows stale top-3 plus a re-run
prompt (Refresh = GetQuotes only, no re-submit, no cost).

## Credit-score authorization handling
Quote requests do not ask the consumer for credit permission and are never
blocked by the private consent timestamp. The importer always sends
`CreditPermission: "Yes"` while the agent verification view labels permission
and Excellent credit as unverified assumptions to confirm on follow-up.

Keep the historical private consent column physically present to avoid a
destructive migration, but do not restore its removed consumer API/status flow.

**Why:** product policy treats credit permission as an agent follow-up item;
the consumer checkbox and five consent gates contradicted that low-friction
flow and blocked otherwise valid quote requests.

**How to apply:** do not add a consumer consent question, disabled-button
condition, pre-cache gate, or pre-import recheck unless product policy changes.
Never place any recorded consent state in the shared quote context.

## Wind-mitigation premium disclosure
Current paid-quote inputs infer wind credits from property answers and do not
include a reviewed inspection report. Carrier results must therefore identify
the report as unconfirmed and show the dedicated higher-premium warning beside
the premium, with a direct report-send action.

**Why:** a generic preliminary disclaimer does not adequately reveal that an
unverified wind credit can materially understate the premium.

**How to apply:** do not change the existing rating assumptions merely to hide
the warning. Hide it only when a future trusted review flow records explicit
confirmation in the cached property provenance.

## Address parsing
qr-start splits the formatted address on commas and scans segments
**from the end** for a `ST 12345` pattern (not just the last segment),
so a trailing country segment like ", USA" from Google doesn't swallow
the state/zip.

## Auto-hydrate effect + rebuild guard (historical — auto-fire now removed)
The insurance-page effect used to auto-start a quote once `rebuild`
(Coverage A) was ready, and the gotcha was to NOT bail permanently on
missing `rebuild` (it's async — bailing early meant the quote never fired).
That auto-fire is now removed (see "Quoting is MANUAL-only"), so the effect
only hydrates cache. **If auto-quoting is ever re-enabled**, restore the
fallthrough shape: early-return only on `!isAuthenticated || !address`,
then `if (!rebuild) return;` right before starting, with `rebuild` in the
dep array so it re-runs once ready — never put `!rebuild` in the top guard.

## Per-page QR display polling: tear down on address change
Any page that shows live QR quotes with its own poll (e.g. estimate page)
must, on active-address change, clear the interval AND reset leadId, gate
"start poll" on `!pollRef.current` (not `!leadIdRef.current`), and inside
the poll callback ignore results when unmounted or `addrRef.current !== addr`.
**Why:** cached pending/success for a new address otherwise leaves the old
interval running and a stale leadId ref blocking the new poll → wrong quotes.

## Server-owned completion and bounded email recovery
Quote completion must not depend on an open browser. Treat every paid run as
its own generation even though the shared address/policy cache row is reused.
Guard delayed start responses, worker writes, and email updates against both
generation and expected status; an in-memory lead override must also carry its
original generation.

**Why:** a timeout/reclaim can occur while an old provider request is still
in flight. A row ID or lead check alone can then attach the old response to
the next borrower's run. Concurrent restart workers also need durable leases.

**How to apply:** retain the existing atomic paid-run claim and 30-day shared
key. Resume server work after restart, preserve usable partial quotes on
transient errors, and keep delivery-recipient metadata out of public responses.

Result emails need provider idempotency as well as persistent local state.
Never blindly resend an ambiguous delivery outside the provider's idempotency
window; quarantine it for reconciliation instead.

**Why:** marking sent only after provider acceptance leaves a crash window;
marking before acceptance can lose delivery. Resend's idempotency protection
expires after 24 hours, so unlimited recovery retries can create duplicates.

**How to apply:** bound retries from the first delivery attempt and retain the
same generation-specific key and message payload. Require a real configured
agency mailing address rather than inventing a compliance footer.

## Exact internal lead-alert subjects
Use a direct team email for exact requested subject wording while retaining
the FUB contact update separately. Do not encode each property's address into
a new FUB lead source merely to influence notification subjects.

**Why:** the events API exposes source and event type, not a supported exact
notification-subject override. Per-property sources would also fragment lead
source reporting without guaranteeing the requested email format.

**How to apply:** keep the insurance FUB source stable; put the property in
the direct email subject and restrict its body to the requested contact fields.
