# County tax live contract checks

The county integrations have an opt-in smoke command for live parcel and bill
providers:

```sh
npm run test:live:county-tax
```

This command is intentionally separate from `npm test`, so normal local and CI
runs remain deterministic. It needs outbound network access and `APIFY_TOKEN`
because Tyler TaxSys is protected by Cloudflare and must be reached through the
same browser-backed crawler used in production.

## Supported county architecture

- Hillsborough, Pinellas, Manatee, Pasco, Hernando, Sarasota, Lee, and Collier
  resolve a strictly matched parcel and use their allowlisted Tyler TaxSys host
  for annual millage, non-ad valorem assessments, and current-owner bill totals.
- Pasco, Hernando, Sarasota, and Polk parcel identities come from the verified
  SWFWMD parcel-search layers. Lee uses the county parcel FeatureServer and
  Collier uses the county address-point FLN.
- Polk uses the SWFWMD PARNO to search its separate, allowlisted Phenix
  collector. The search result and bill detail must both preserve the exact
  parcel, street/unit, and city before millage, fixed assessments, or the
  current-owner total are accepted.
- Purchase calculations cache school/non-school millage and recompute Florida
  exemption math for any purchase price. Refinance lookups use only actual bill
  totals and never purchase-price math.

The production environment must expose `APIFY_TOKEN`. Hillsborough, Pinellas,
Manatee, Pasco, Hernando, Sarasota, Lee, and Collier tax-collector bills are
behind Cloudflare, and the Tyler scraper cannot run without that token.
Missing configuration returns `live-bill-service-not-configured`. It is not
treated as an ordinary parcel miss or a trustworthy zero-assessment result.
Polk uses the Phenix site and does not need the token. A purchase yearly
total is shown only after both the official estimator and this bill succeed;
a missing bill leaves the yearly total blank instead of pretending CDD is $0.

Run it on a low-frequency schedule, such as weekly. A successful run currently
checks:

- Pinellas ArcGIS resolves the fixture to the exact expected street and city,
  returns a positive numeric parcel ID, and preserves the lookup response shape.
- Pinellas TaxSys resolves that parcel to the exact same street and city,
  reaches a bill page, and returns a parsed annual-bill shape.
- Manatee ArcGIS resolves the fixture to the exact expected street and city,
  returns a positive numeric parcel ID, and preserves all tax/NAV result fields.
- Polk SWFWMD resolves the exact public fixture and Phenix returns the same
  parcel's annual millage, fixed assessments, and positive current-owner total.

Dollar totals are only checked for valid numeric shape where the fixture has a
bill. No volatile value is pinned.

Pinellas currently redirects its legacy public search URL to the
`county-taxes.net` SPA and renders account/bill content inside an iframe. The
browser crawler therefore waits across all Playwright frames for a bill link on
the account page and for the complete bill markers on the bill page. An
advisory-only or `Loading` shell fails that request and uses the crawler's
request retry budget; it is not accepted as a valid page. The crawl visits only
the account page and its first (newest) annual bill.

## Website Content Crawler build control

Production and this live contract use the exact Website Content Crawler build
number committed as `TESTED_APIFY_WCC_BUILD` in
`server/integrations/tax-bill-scraper.ts`. The current tested build is
`0.3.94`. Do not replace the number with `latest`, `version-0`, or another
moving tag.

Apify's [Run Actor API](https://docs.apify.com/api/v2/actors-runs-post)
supports a `build` query parameter containing either a tag or build number. If
the parameter is omitted, Apify uses the Actor's configured build, which is
typically a moving `latest` tag. The scraper always sends an exact number and
checks that the run reports the same `buildNumber`; mismatched output is
discarded. An unset or invalid `APIFY_WCC_BUILD` falls back to the committed
tested build.

### Testing and rolling forward an upgrade

1. Find the exact successful build number in the Website Content Crawler's
   Apify build history. Never test a moving tag.
2. Run the full live contract twice with that exact candidate:

   ```sh
   APIFY_WCC_BUILD=0.x.y npm run test:live:county-tax
   APIFY_WCC_BUILD=0.x.y npm run test:live:county-tax
   ```

   Both runs must report the candidate build and pass the Pinellas iframe,
   exact-situs, annual-bill, and parsed-tax assertions. A malformed override
   deliberately falls back to the committed build instead of selecting a tag.
3. Change `TESTED_APIFY_WCC_BUILD` to the tested number and run the unit tests
   plus the live contract once more without the override.
4. Deploy that code change. Remove any temporary `APIFY_WCC_BUILD` deployment
   override so production follows the reviewed committed pin. If a production
   override is intentionally used for a staged rollout, set it only to the
   exact build number that passed both live runs; removing it is the explicit
   rollback to the committed tested build.

## Scheduled monitoring

The repository includes an isolated GitHub Actions workflow at
`.github/workflows/county-tax-live-contract.yml`. It runs every Monday at
14:17 UTC and can also be started manually from the Actions tab. It is not
part of normal pull-request checks, because it calls live county providers and
can take several minutes.

Before its first scheduled run, add `APIFY_TOKEN` as a **repository Actions
secret**:

1. Open the repository's **Settings → Secrets and variables → Actions**.
2. Create a repository secret named `APIFY_TOKEN`.
3. Paste the token used by the production browser-backed TaxSys crawler.

The workflow passes this value only to the live test process; it never prints
the secret in workflow output. When the check fails, it retains
`county-tax-live-contract.log` as a downloadable Actions artifact for 90 days
and opens (or comments on) the tracked
`[Automated] County tax live contract check is failing` issue. The repository
owner is assigned to a newly created alert issue so the failure is visible to
the maintainer. Close that issue after a successful diagnosis or recovery; a
later failure will create a new alert.

## Public fixtures

The committed fixtures are public-facing, non-residential locations:

- Pinellas: `501 5th Ave NE, St Petersburg, FL 33701`
- Manatee: `1305 17th St W, Palmetto, FL 34221` (county-owned fairgrounds)
- Polk: `45098 Hwy 54, Lakeland, FL 33809` (commercial utility parcel)

## Rotating a fixture

Rotate a fixture only when the county record itself has legitimately changed,
not merely because the provider is temporarily unavailable.

1. Choose a stable public civic or public-facing commercial property. Do not
   commit a private residence or a customer address.
2. Confirm the exact canonical situs street and city in the county ArcGIS
   response.
3. For Pinellas, also confirm TaxSys shows the same situs identity and exposes
   at least one rendered annual bill.
4. Update the fixture query and exact situs constants in
   `scripts/county-tax-live-contract.test.ts`. Do not pin its parcel ID or any
   tax dollar amount.
5. Run `npm run test:live:county-tax` twice. Both runs must resolve the exact
   identity, a positive parcel ID, and the expected response shapes.