# Official county tax implementation — incomplete draft

This is not ready for underwriter use. No additional county has been added to
the verified-estimator registry, and the browser feature flags remain off.

## Completed foundation
- Imported both commits from PR #6 and its supporting modules/fixture.
- Preserved the workspace's dependency-security fixes.
- Node 20.20.0 / npm 10.9.2 pins, explicit development dependencies in CI,
  and npx --no-install tsx. tsx was already a devDependency.
- Replaced Replit-only lockfile download URLs with public npm URLs without
  changing the locked package versions or integrity hashes.
- Clean npm 10.9.2 install, TypeScript, and 445 unit tests passed locally.
- Applied the additive parcel/year cache migration to live Supabase.
- Added draft direct HTTP, browser, bill parsing, concurrency, cache and
  provenance components. These are not yet connected to the production routes.
- Captured the Collier 2026 bill tax tables without owner/payment information.

## Live checks on 2026-11-12
| County | Estimator method / endpoint | Status |
|---|---|---|
| Hillsborough | Direct HCPA BasicSearch and TaxEstimator | $600k HX returned $9,236.59 |
| Pinellas | POST pcpao.gov/tax_estimatorout | $289k HX returned $4,018 |
| Pasco | WebForms search.pascopa.com/estimate-taxes.aspx | Page returned; amount parser failed |
| Polk | WebForms polkflpa.gov/TaxEstimatorIntro.aspx and taxEstimator.aspx | $400k HX returned $5,696 with letter NAV zero |
| Sarasota | Session + sarasotapropertyappraiser.gov/TaxEstimator/TaxEstOut.aspx | Page returned; amount parser failed |
| Lee | leepa.org/taxestimator/TaxEstimationService.asmx/CalculateTaxes | Known FolioId $400k HX returned $4,274.09; STRAP lookup not verified |
| Hernando | Firecrawl interaction, feature flag off | Not live verified |
| Manatee | Purchase disabled; direct collector bill adapter drafted | Bill adapter not live verified |
| Collier | Firecrawl interaction, feature flag off | Estimator not live verified; collector bill gross $4,998.85, AV $4,729.08, NAV $269.77 verified |

## Remaining acceptance work
- Reconcile all PR #6 predecessor changes with the workspace's newer client
  code. Do not assume cherry-picking only its two commits imports every
  predecessor change: the workspace and remote baseline diverged.
- Correct and capture Pasco/Sarasota parser output. Verify Lee STRAP resolution,
  all direct collector parsers, both browser estimators and their cleanup paths.
- Capture every requested homestead/no-homestead fixture and verify tax-year,
  parcel identity, exact totals and estimator/bill NAV disagreements.
- Wire the new adapters into county-estimator-runner, purchase/current-bill
  routes, and parcel resolution, with null amounts on every missing component.
- Wire the new parcel/year cache into those routes; verify real cache writes,
  cache hits, price changes, per-source timestamps and annual rollover.
- Finish UI breakdown, source links/time in ET, warnings, loading and unavailable
  states. Existing legacy formula and zero-sentinel behavior is not yet fully
  removed from the workspace client; do not use it as an official result.
- Run full npm test (including browser tests), all known-answer fixtures, live
  suites and GitHub Actions. Only then enable verified counties.
- Do not merge or publish until Christian reviews and approves.
