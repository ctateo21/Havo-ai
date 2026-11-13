---
name: Official county tax standard
description: Underwriter-facing taxes must follow county tools and collector gross bills, never generic fallback math
---
**Rule:** Official purchase tax is official estimator ad valorem (low end if a range) plus current collector-bill NAV. Refinance uses gross bill AV plus NAV, not discounted amount due. Missing official components and total must be unavailable with a reason, never zero.

**Why:** The user sends these figures to actual mortgage underwriters and explicitly rejected generic rates and guessed amounts on 2026-11-12.

**How to apply:** This supersedes older memory permitting statewide 85% formulas, county-rate fallbacks, or linear price-rate caches. Follow each county's own assessment/exemption behavior, including current-just-value floors when the tool uses them. Every amount needs official provenance, fetched time in Eastern, parcel identity and link. Add counties to the verified registry only after known-answer verification.

**Rule:** Cache by county, parcel and tax year until the next November 1 midnight Eastern. Reuse collector NAV separately from the price-dependent estimator. Collier verified recomputation uses its captured school/non-school ratios, flat $25k/$50k exemptions and floor; never an effective $/price rate.

**Why:** A correct answer for one price must not become incorrect after price or homestead changes.

**Rule:** Collier automation must use public pages, agreement/session and at least ten seconds between new parcels. No direct data endpoints or anti-limit evasion.

**Why:** The user requires compliance with the appraiser's published access rules.

**Rule:** For Hernando, retain the estimator's published overall total and warn about its inconsistent county-portion breakdown. Do not replace the county line and recompute the grand total.

**Why:** On 2026-11-12 the user explicitly chose the published total with a warning after seeing that recomposition would change the $400,000 homestead example from $5,110.14 to $5,345.34.

**How to apply:** Treat the county breakdown as an inconsistency disclosure, not a replacement calculation.

**Rule:** Sarasota estimator access is on-demand only, with one-second request spacing. Do not use its disallowed property-search result/detail routes.

**Why:** The user's supplied, live-reproduced HTTP recipe explicitly requires following the county's robots access guidance.

**How to apply:** Manual live verification is allowed; omit Sarasota estimator requests from unattended nightly runs. Use the permitted TaxEstimator pages and existing approved parcel sources.

**Rule:** Manatee is an explicit exception to the purchase-estimator-only rule: use parcel-specific official 2026 school/non-school mills, 100% of entered price, flat $25k school/$50k non-school exemptions, plus collector NAV. Label exactly “Calculated from Manatee County official 2026 rates and exemptions (no official purchase-price estimator)”, never an official estimator.

**Why:** The user explicitly authorized this calculation because Manatee has no purchase-price input. A percentage derived from one homestead price understates tax at another price.

**How to apply:** Cache components per parcel through November 1 and recompute later prices without county calls. Keep access on-demand, no bulk harvesting. Refinance remains gross collector bill, including its one-cent rounding difference from the widget.

**Rule:** Purchase Property Use must be explicitly selected. Only Primary residence is homestead; secondary/investment are non-homestead, and blank blocks tax display. Preserve Zestimate/list-price prefill and leave refinance separate.

**Why:** A live purchase with blank Property Use incorrectly displayed homestead; the user explicitly rejected silent defaults.

**Rule:** The user now authorizes provisional, clearly labeled estimates from
official district millage while official results load. For unverified county
parameters with no approved researched model, the rough formula is 100% of
purchase price times sourced district millage, with no homestead deduction.
Christian subsequently approved the nine-county research model: use its
county-specific ratios and phased additional exemption even when the output
remains rough. All 2025 research rows are rough; current parcel rates win.
Add only current parcel bill NAV if known.
Missing NAV is pending, not a verified zero. Missing millage means no number.

**Why:** The user explicitly approved this rough formula to avoid long waits,
while keeping unverified figures distinguishable for underwriters.

**How to apply:** This supersedes the earlier prohibition on displaying all
non-official calculations. Preserve estimate/area_estimate/rough_estimate status,
source and rates year through totals, saves and exports; never label them official.
Use the exact rough disclosure: “Rough estimate — county assessment and exemption
rules not verified”. Replace provisional figures when verified results arrive.

**Rule:** Research settings default to county-estimator exemptions, except
Pasco's missing value uses the 2026 statutory additional exemption. Manatee
keeps flat $50,000 total until an explicit admin change. The 2027 Amendment 3
scenario is off by default and must disclose its year and eligibility limits.

**Why:** Christian approved these distinctions; a newer published Manatee
sheet did not constitute approval to change the saved exemption.
