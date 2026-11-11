# AI usage controls

## Required database deployment

Apply `migrations/20261013_ai_usage_controls.sql` to **Replit-managed PostgreSQL
(`DATABASE_URL`) before deploying this code**. It was applied to development.
Production still requires this migration. This does not change Supabase or the
separate `NEON_DATABASE_URL` database. No borrower-document migration is needed.
The tables also appear in `shared/schema.ts` so schema pushes retain them; the
SQL migration is required for permissions and the purpose constraint.

If the tables or database are unavailable, new AI calls fail closed with HTTP
503 rather than running without accounting. Existing saved recaps remain readable.

## Limits and semantics

`server/ai-usage.ts` defines explicit ceilings shared by documents, seller recaps,
admin refreshes, and scheduled generation:

* 20 admitted provider attempts per verified user per UTC day.
* 500 admitted provider attempts across the app per UTC day.
* 2 simultaneous calls per user; 10 across the app.
* At most 8,192 output tokens, 15 MiB serialized input, and a 120-second timeout.

Admission is a database transaction with a shared advisory lock. Every attempt
counts, including errors, timeouts, and malformed answers: these may still cost
money. There are **no automatic retries or alternate-provider fallbacks** at the
provider boundary. A user-initiated retry uses another allowance. Concurrent
leases expire after three minutes to recover from crashes; aborting a request
cannot guarantee the provider stops billing. UTC midnight resets admission by
selecting a new daily bucket; active leases survive that boundary.

These are usage ceilings, **not a guaranteed dollar cap**: model prices, PDF
processing, search charges, and provider-side work after a timeout can vary.
Set an OpenRouter API-key spending limit as the independent hard monetary
backstop. Model selection is intentionally unchanged by this task.

Document uploads now require a verified Supabase access token (all three
uploaders send it). The existing IP limit remains an extra layer. Seller routes
continue verifying ownership, admin-only refresh permission, and weekly caching.
The scheduler attributes calls to the scenario owner; cache hits do not reserve
usage. HTTP denials include actionable text, stable codes and `Retry-After`.
Background recap failures are returned through the existing recap error message.
Polling-driven retries after failed or weak recap generation are suppressed for
15 minutes on that server instance (including admin refreshes). The existing
weekly cache remains authoritative for successful rich recaps. Cross-instance
admission is still bounded by the database even though listing single-flight
and retry cooldowns are process-local.

## Privacy and operations

Daily rows contain only user ID, UTC date, purpose, admitted/successful counts,
aggregate prompt/completion tokens, reported USD cost, and unknown-cost count.
No prompt, document, address, credential, response, or provider error body is
added to accounting. Existing recap storage is not changed.
HTTP response-body logging is disabled for all three AI endpoints.

Cost is taken only from finite, nonnegative provider `usage.cost`; missing cost
is **unknown**, not a free request. A missing/invalid token count is recorded as
zero (unknown-cost counts also flag requests with no usage response). Finalization
failure emits a constant warning without private data, retains the admission
count and leaves the lease to expire. Reported cost is therefore a lower bound,
not an invoice; consult OpenRouter billing for authoritative spend.

Inspect `ai_usage_daily` through server-admin database tooling, never a public
API. Expired leases are deleted on admission. Daily aggregates are retained for
historical accounting; define an operational retention policy before deleting
them, and never delete current-day rows to “reset” a user's allowance.

## Verification

`server/ai-usage.test.ts` and `server/openrouter.test.ts` run in the normal unit
suite without paid calls. `npx tsx --test scripts/ai-usage-live.test.ts` is an
explicit development-database check: it creates synthetic user accounting rows,
checks race-safe admission and daily limits, and deletes only those rows afterward.
Do not run this live check against production.
