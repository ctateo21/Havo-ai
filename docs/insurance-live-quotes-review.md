# Sourced insurance facts and durable quotes

Review branch stacked on `fix/privacy-compliance-and-planning`. Do not merge or publish.
No property-tax, mortgage/PMI or refinance calculation changes.

## Deployment prerequisites — NOT applied
- Review and approve the three new Supabase migrations first.
- The quote answer-identity migration also changes the active PostgreSQL source
  cache schema when that source is still authoritative. Apply to the appropriate
  source and target only with approval. Do not run an automatic schema push.
- Property-field provenance and rebuild-rate tables are Supabase service-role
  only. All 67 counties start with NULL rates; administrators supply actual rates.
- The private import outbox is Supabase-only, RLS-protected and server-owned.
  DOB is loaded from the existing private profile at execution, not copied into
  the outbox. Import payloads and callback tokens are cleared after handoff.

## Cache decision
Property facts/FEMA are shared per normalized address for one year. Per-field
provenance is retained; manual/confirmed facts win. Failed geocodes are not cached.

Paid quote runs last 30 days, keyed by address, policy and an exact non-personal
answer hash, with owner ID and claims marker stored privately. Same-owner runs
can be reused for matching answers. Another user can reuse only exact matching
non-personal answers from a run with no claims. Claim-bearing runs are owner
specific. Different dates, coverage, property facts, deductibles, residence use,
price or wind answers create a different identity; no address-only browser
hydration remains. Poll/cache access requires a signed user/run/generation token.

## Carrier flow
The request validates answers, claims a durable row, and queues the paid work.
Initial response is HTTP 202 with status pending, a run-access token and
**leadId:null** until the importer creates its real LeadId. Returning a fabricated
lead ID to make the first response appear synchronous would be unsafe.
The existing pending-without-lead polling flow obtains the actual ID.

Import/submit and polling survive browser closure. Ambiguous imports are never
re-imported automatically; they require agent reconciliation. Carrier discovery
failure is recorded as a warning. Authenticated callbacks use a random per-run
token hash plus matching LeadId. Polling remains the backup at 20 seconds, with a
12-minute cap. A stable positive count for three polls completes early.

Credit permission is always No. Assumed score defaults to Excellent.
**Carriers may re-rate after an actual credit check at application/binding;
final premiums can differ.** This implementation never requests that check.

Transactional results retain provider idempotency, include BCC, schedule link,
top-three carrier amounts and licensed-agency/not-a-binder disclosures. Zero
usable results still trigger a manual-review email and operational agent alert.
Marketing unsubscribe does not suppress requested results; later marketing
remains subject to existing consent controls.

## Free read-only verification — November 12, 2026
| Address | Census | County / DOR facts | FEMA |
|---|---|---|---|
| 7400 36th Ave N, St. Petersburg, FL 33710 | Pinellas 12103; 27.80450093142, -82.740998007011 | DOR 2026: actual year 1958, effective year 1988, living/adjusted area 1,166 | Live requests failed on two attempts. UI must report unavailable, not claim a live X result. Supplied X/minimal/SFHA false/-9999 fixture passes. |
| 3102 W Nassau St, Tampa, FL 33607 | Hillsborough 12057; 27.953439115332, -82.49336516374 | HCPA: 1958, heated area 2,105, two stories, Concrete Block, Gable Or Hip. DOR 2026: 1958, living/adjusted area 2,767. HCPA wins. | Live X, AREA OF MINIMAL FLOOD HAZARD, SFHA false, BFE null; DFIRM 12057C |

HCPA returned a pool permit, not a roof permit. No roof year was inferred.
FIRM panel/effective-date enrichment is optional and not implemented.

## Configuration
- `GOOGLE_MAPS_SERVER_API_KEY`: still absent at verification; add a dedicated
  server geocoding key in workspace and deployment. Browser keys are never used
  by the new server geocoder. Census operates without a key.
- `SCHEDULE_CALL_URL`: present in the workspace; verify deployment configuration.
  Code default: https://calendar.app.google/bGd2q1fVCsmzPgPb6
- `QUOTE_RESULTS_BCC`: optional; default sales@havofl.com.
- Assumed credit is fixed to Excellent; credit permission is always No.
- `AGENCY_PHYSICAL_ADDRESS`: present in the workspace. Missing value falls back
  to Tampa Bay, Florida and records a warning.
- Existing QuoteRUSH env names remain unchanged.

## Verification boundaries
No paid QuoteRUSH requests, real quote-result emails, shared-database migrations,
merges or publishes were performed. Contract/browser tests mock carrier calls.
Documented importer aliases are sent alongside old keys; actual provider
acceptance of both aliases and the real callback payload shape still require an
authorized carrier integration test. A callback missing the matching LeadId or
token is rejected, not guessed.

## CI blocker found on the unchanged base branch
GitHub includes nine cash-buy browser tests that are absent from this workspace.
They expect an official-estimator cash-buy UI, including `cash-buy-property-taxes`,
that the unchanged PR #9 cash-buy page does not implement. The remote base also
contains an unused cash-buy tax helper and its tests. These were retained, not
deleted or excluded to make CI green. Resolving that mismatch requires separate
property-tax work, outside this insurance request's explicit scope.

The additional CI-only accessibility failure was a test setup issue: without a
real Google Maps key, the labeled homepage input is not upgraded to a combobox.
Its test now checks the accessible label rather than requiring the optional
third-party upgrade. No address-input behavior was changed.

The migration that changes quote-cache uniqueness must be coordinated with the
application rollout; do not apply it independently to a running older version.
