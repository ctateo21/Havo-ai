# Official county tax verification — November 12, 2026

Draft PR only. Do not merge or publish. This supersedes the earlier foundation
status in official-county-tax-progress.md.

## Verified live results

AV means estimator ad valorem; NAV means current collector-bill assessments.
The purchase total always adds estimator AV (low end) to **bill** NAV.

| County | Method | Actual AV, matched to supplied answer | Bill NAV | Purchase total |
|---|---|---:|---:|---:|
| Hillsborough | HCPA direct HTTP, $600k HX | $9,236.59 | $284.77 | $9,521.36 |
| Pinellas | PCPAO POST, $289k no HX / HX | $4,873 / $4,018 | $0 | $4,873 / $4,018 |
| Pasco | WebForms, $400k HX / no HX | $4,988.48 / $6,726.76 | $4,358.04 | $9,346.52 / $11,084.80 |
| Polk | WebForms, $400k HX / no HX | $5,696 / $6,483 | $0 | $5,696 / $6,483 |
| Lee | LeePA service, $400k HX / no HX | $4,274.09 / $4,810.43 | $376.41 | $4,650.50 / $5,186.84 |
| Collier | Public-page browser, $750k HX / no HX | $6,370 / $6,714 | $269.77 | $6,639.77 / $6,983.77 |
| Collier | Same parcel, $400k HX / no HX | $3,236 / $3,580 | $269.77 | $3,505.77 / $3,849.77 |
| Hernando | Browser, $400k CWES HX / no HX | $5,110.14 / $5,661.16 | $159.17 | $5,269.31 / $5,820.33 |
| Sarasota | Same-session agreement POST then TaxEstOut GET, $400k HX / no HX | $4,601 / $5,180 | $963.66 | $5,564.66 / $6,143.66 |
| Manatee | No purchase-price estimator | **Unavailable by design** | $1,743.56 verified | **Unavailable** |

Polk's captured ranges were $5,696–$6,416 and $6,483–$7,203. Only the low end
is used, after subtracting any assessment amount from its letter.

Hernando's published total is retained. Christian explicitly approved warning
about the county-line/breakdown discrepancy instead of recomputing its total.

All nine collector samples matched the supplied gross bill figures. Manatee's
verified refinance gross bill is $4,480.54, not its discounted payment amount.

## Identity, provenance and cache

- Pinellas uses exact-single-match quick search, then official GIS with ZIP.
  Estimator strap, dashed parcel and collector account are distinct; all three
  were confirmed in Supabase for the sample. The bill's street address is checked.
- Lee now locates the matching account's View button, dismisses the notification
  overlay and validates the resulting real-estate account before reading its bill.
- Collier uses its public agreement/search/estimator pages, not data endpoints.
  An exact site-address match and returned FolioID establish cached identity.
  Captured school/non-school rates support verified new-price recomputation.
- Collier requests remain paced; browser sessions are deleted in finally.
  Malformed browser scripts are rejected locally before spending scrape credits.
- Source timestamps are preserved on cache hits. Expiry is next Nov 1 midnight ET.
- Refinance disclosures now retain the actual bill URL, parcel, tax year, ET fetch
  time, NAV lines and warnings. The new JSON evidence column was applied and
  confirmed in live Supabase. Manual/legacy values never get fabricated sources.

## Checks and opt-in nightly runs

Captured regression fixtures cover the newly verified county answers.
Local unit tests and GitHub unit CI were run after each enabled county.
The full application test suite also includes 25 browser tests.

`npm run test:live` contains the estimator and gross-bill known-answer matrix.
The new GitHub workflow runs manually, or nightly only when the repository
variable `ENABLE_OFFICIAL_TAX_NIGHTLY=true` is set. Firecrawl cases require
`FIRECRAWL_API_KEY` in **GitHub** secrets; Replit secrets are not automatically
GitHub secrets. Browser live checks require both estimator flags set to `on`.
The workflow supplies those flags, without changing application defaults.

HCPA and Sarasota estimator checks are omitted from scheduled runs under the supplied
on-demand-only access guidance. They remain available for manual live checks.
No workflow has been activated by merging or publishing.

## Sarasota correction

Sarasota is now in the verified registry after live results matched both cases.
The adapter posts the real I Agree event target with hidden fields, follows the
redirect, then GETs TaxEstOut on the same session with a bare integer price.
It never submits the TaxEst.aspx input form. Requests in that session are paced
at least one second apart. Input-form bounces are unavailable, with HTTP status
and final URL in the reason; missing results never become zero.

Captured result-page fixtures verify assessed value $356,000, AV $4,601 / $5,180,
tool NAV $1,141, tool totals $5,742 / $6,321, and composition with bill NAV $963.66.

Signed-in refinance UI still needs authenticated visual verification; helper,
rendered-markup and persistence-mapping tests do not replace that check.
