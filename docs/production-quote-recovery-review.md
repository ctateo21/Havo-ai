# Follow-up: strict property identity and bounded recovery

The free try covers every tool on the first property. Matching preserves all
comma-delimited street/unit segments, accepts ZIP only after the state, and
requires normalized city equality when ZIP is absent. Different units and
directionals are never treated as the same property.

Expired official-tax jobs receive at most two automatic restarts per request
cycle. Exhaustion retains any estimate with a friendly failed-verification state.

The preview workflow was restarted with `QUOTERUSH_PAUSED=true` so updated
credentials load without resuming imports, quote polling, or outbound QuoteRush
calls. This switch applies to the development workflow command, not the
production start command. It leaves durable jobs untouched while paused.
Remove the switch and restart only when live QuoteRush activity is authorized.

# Production quote recovery — review only

## Evidence

Production telemetry on 2026-11-13 at 20:02:58 UTC recorded importer HTTP 200.
At 20:02:59 UTC diagnostics recorded text/plain, length 54, onlyDigits false,
topLevelKeys [], and:

> Failed [redacted] Agency not valid. Verify [redacted] Id [redacted] Password.

At 20:03:02 UTC the job entered agent review in the import phase with no verified
lead ID. This is provider agency validation, not a lead-ID parsing failure.
The importer uses QUOTERUSH_WEBID in its URL and QUOTERUSH_WEBID_PASSWORD
in its webpassword header (legacy fallback QUOTERUSH_WEBPASSWORD).
QUOTERUSH_AGENCY_ID and QUOTERUSH_ENDPOINT_KEY are used by subsequent APIs.
Verify the importer credential pair belongs to the enabled QuoteRush agency;
the logs cannot establish which value is wrong. No credentials were changed
and no live retry was made. CreditPermission remains No / assumed Excellent.
The team email itself was not retrieved; the agent-review log is the evidence.

Guest request logs did not expose individual 401s in the incident window.
Therefore the exact failing browser requests cannot be attributed conclusively.
Code-level findings:

- ToolGate awaits first-quote authorization before mounting purchase/insurance.
- Zillow, AMI, flood, tax, facts and rebuild requests send credentials.
- Start previously rejected switching tools even for the same property.
- All lookup guards compare the property, not quote type; lookups do not consume
  the cookie. A type switch alone cannot explain a mounted result page's 401.
- Whole-address comparison rejected changed city spelling.
- Official-status stores jobs per process; a missing job on another autoscale
  instance incorrectly returned SIGN_UP_REQUIRED. It now returns 404 without
  data, and the client retries through the address-authorized quick route.
- Generic errors exposed raw status/JSON; summary values overflowed six columns.

## Changes / boundaries

Same first property can be explored across tools. Another property, saving,
downloads, sharing and live carrier quotes remain gated. Street and unit plus
ZIP must match before city spelling differences are ignored. Exact normalized
matching remains supported, including existing signed cookies.

No migration, provider calls, deployment or merge. Process-local job storage
and IP limits remain residuals; cache-backed retry mitigates lost polls but is
not a durable distributed queue. The reported old Tateo custom-quote text was
not present in current source; the existing fallback now explicitly says Havo
while retaining the phone/email buttons and licensed attribution.
