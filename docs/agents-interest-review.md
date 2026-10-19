# Agents interest experiment — review notes

## Routes
- `/agents`: public interest-only page; no checkout or payment data.
- `/admin/agents`: server-verified administrator results.
- Admins are the existing leaderboard administrators plus the optional
  `MARKET_ANALYSIS_ADMIN_EMAILS` allowlist. Client role/profile fields do not grant access.

## Live schema
Both migrations have been applied to the existing Supabase project and the two
tables verified with row-level security enabled. `anon` and `authenticated`
cannot read or write the tables or execute their RPCs. Only server service-role
access is permitted.

- `migrations/20261019_b2b_interest.sql`
- `migrations/20261019_b2b_interest_limits.sql`

Event UUIDs deduplicate transport retries. Each accepted submission creates its
signup and conversion event in one database transaction. All events and signups
retain URL UTM values. Metrics aggregate across all rows, not only the recent
100 signups shown in the results list. Repeated clicks count individually.

## Notifications and unsubscribe
Resend prefers the server-only `RESEND_API_KEY` supplied by the user. If no
secret is configured, it uses the existing Replit `resend` connection. It never
switches credentials after a failed send. Do not copy API credentials into code,
chat, or this document.

Follow Up Boss receives source `havofl.com - AGENT FAKE DOOR`, tag
`Havo B2B Interest`, and an explicit note with role, company, chosen tier, buyer
volume and UTM attribution. Existing email-matched contacts retain their other
tags/details; their lead-source field is set to the requested experiment source.

Notification status and provider IDs are stored on the signup. Database claims
prevent concurrent delivery. Admin retry is offered for pending/failed delivery.
An interrupted `sending` state needs provider reconciliation rather than blind
resending. Email retries are refused outside the provider idempotency window.

Unsubscribe uses a random per-signup token. GET shows a confirmation so email
scanners cannot unsubscribe people; POST also supports RFC 8058 one-click.
Suppression applies to all experiment signups sharing the email. Future launch
campaigns must honor this suppression; there is no launch broadcast feature yet.
Confirmation emails include the existing public brokerage mailing address.
The link uses the verified production domain; the new unsubscribe endpoint will
be publicly available only after Christian approves and publishes.

## Verification
- TypeScript and automated public-page/validation/admin-denial checks passed.
- Desktop and mobile public pages visually inspected.
- A real browser submission to the live database used Resend's controlled test
  recipient `delivered@resend.dev` (not a real prospect).
- QA signup reference: `a0b839e9-3d40-4fbf-a020-41b65263873c`.
- Follow Up Boss contact `2781`, note `2270` retrieved and verified.
- After restoring the server secret, Resend confirmed the email as `delivered`.
- The confirmation contains the mailing address and unsubscribe link.
- Unsubscribe GET and POST succeeded and persisted email suppression.
- QA events and signup have `is_test=true` and are excluded from demand metrics.
- Attribution filter `havo_internal_qa` isolates verification traffic.
- Signed-in admin UI has not yet been tested with a live administrator session.

Do not publish, merge to main, or trigger production workflows as part of review.
