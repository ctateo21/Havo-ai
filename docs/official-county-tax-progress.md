# Official county tax implementation — incomplete draft

This is not ready for all-county underwriter use. Hillsborough alone is enabled
in the verified-estimator registry. Browser feature flags remain off.

## Completed foundation
- Imported both commits from PR #6 and its supporting modules/fixture.
- Preserved the workspace's dependency-security fixes.
- Node 20.20.0 / npm 10.9.2 pins, explicit development dependencies in CI,
  and npx --no-install tsx. tsx was already a devDependency.
- Replaced Replit-only lockfile download URLs with public npm URLs without
  changing the locked package versions or integrity hashes.
- Clean npm 10.9.2 install, TypeScript, and 455 serial unit tests passed locally.
- Serial test execution avoids a timing-sensitive existing leaderboard test
  failing under the full suite's parallel load.
- Applied the additive parcel/year cache migration to live Supabase.
- Connected the new official path to the purchase and current-bill routes.
- Added purchase disclosure UI, source links/times, loading, warnings and
  explicit manual/official/unavailable handling. Withholds dependent totals
  rather than using the old formula or an automatic VA zero.
- Live Hillsborough composition returned exactly $9,521.36 at $600k HX.
  A second $650k request re-ran the direct estimator, reused the original bill
  source timestamp and NAV, and made zero Firecrawl calls.
- Captured the Collier 2026 bill tax tables without owner/payment information.

## Live checks on 2026-11-12
| County | Estimator method / endpoint | Status |
|---|---|---|
| Hillsborough | Direct HCPA BasicSearch and TaxEstimator | $600k HX returned $9,236.59 |
| Pinellas | POST pcpao.gov/tax_estimatorout | $289k HX returned $4,018 |
| Pasco | WebForms search.pascopa.com/estimate-taxes.aspx | Identified AV $4,988.48 in page; parser adjusted but not fully reverified; gross bill $18,216.91 verified |
| Polk | WebForms polkflpa.gov/TaxEstimatorIntro.aspx and taxEstimator.aspx | $400k HX returned $5,696 with letter NAV zero |
| Sarasota | Session + sarasotapropertyappraiser.gov/TaxEstimator/TaxEstOut.aspx | Session redirected to TaxEst.aspx, estimate unavailable; gross bill $3,371.93 verified |
| Lee | leepa.org/taxestimator/TaxEstimationService.asmx/CalculateTaxes | Known FolioId $400k HX returned $4,274.09; STRAP lookup not verified |
| Hernando | Firecrawl interaction, feature flag off | Estimator not verified; gross bill $10,010.53 verified |
| Manatee | Purchase disabled; direct collector bill adapter drafted | Bill adapter not live verified |
| Collier | Firecrawl interaction, feature flag off | Estimator not live verified; collector bill gross $4,998.85, AV $4,729.08, NAV $269.77 verified |

## Remaining acceptance work
- Finish verifying the reconciliation of PR #6 predecessor changes with the
  workspace's newer client code. The workspace and remote baseline diverged.
- Correct and capture Pasco/Sarasota parser output. Verify Lee STRAP resolution,
  all direct collector parsers, both browser estimators and their cleanup paths.
- Capture every requested homestead/no-homestead fixture and verify tax-year,
  parcel identity, exact totals and estimator/bill NAV disagreements.
- Complete estimator-runner unification and the remaining parcel resolution
  paths. Purchase/current-bill routes now use the new pipeline.
- Complete cache verification for other counties and browser concurrency,
  cleanup and pacing checks. Hillsborough cache/composition is live verified.
- Browser-test the purchase UI and add the breakdown to existing refinance
  consumers; they still need the full disclosure presentation.
- Fix collector adapters: Pinellas failed parcel match; Polk failed section
  parsing; Manatee failed total parsing; Lee Firecrawl could not load the page.
- Run full npm test (including browser tests), all known-answer fixtures, live
  suites and GitHub Actions. Only then enable verified counties.
- Do not merge or publish until Christian reviews and approves.
