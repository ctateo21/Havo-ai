---
name: Two-part property-tax architecture
description: Durable separation rules for purchase estimates versus refinance current-owner bills
---

**Rule:** Purchase-tax estimates and refinance current-owner bills are separate products. A refinance lookup accepts an address only and may return `ready` only from an actual annual bill total; it must never use purchase price, original price, Zillow value, or a purchase-estimate formula.

**Why:** Mixing estimate inputs into a current-owner bill can produce a plausible but false escrow figure and can also poison shared caches with values that scale differently.

**Per-county rollout policy (corrected by user 2026-09-16):** Keep labeled formula estimates for every county until that county's human-confirmed known-answer live test passes. Only then enable its verified-estimator gate and suppress its fallback on live failure. Never apply official-only behavior globally before replacements work.

**Why:** Globally removing fallbacks before implementing live runners blanked every purchase estimate. The user explicitly rejected that sequencing and requested surgical forward changes preserving other work. A human-captured answer within $1 plus a passing live estimator run is still required before promoting each county.

**How to apply:** Preserve manual overrides, actual refinance bills, and unrelated QuoteRUSH/managed-data work. Keep estimated versus official provenance distinct. Never invent county captures or treat the approximate Hillsborough example as verified; push each completed restoration/verification step to GitHub.

**Completeness rule:** Unavailable tax must also make payment/qualification summaries incomplete, not merely replace the tax row label. Manual zero is valid; missing tax is not zero.

**Why:** Removing a formula but summing a zero sentinel silently understates payments, DTI, reserves and carrying costs. This can mislead borrowers even when the tax row says unavailable.

**How to apply:** Carry completeness/provenance through saved scenarios, dashboards, exports and eligibility actions. Never advertise an exact complete payment or qualification when taxes are unknown.

**How to apply:** Keep separate cache tables and provenance labels. Official purchase caches must start from verified official estimator results; unverified counties may retain labeled fallback estimates. Current-bill caching stores only verified annual totals with their tax year and source.

**Refinance automation rule:** Start the address-only current-bill lookup automatically for every refinance, without requiring the user to expand a card or click a lookup button. Persist the verified annual total and include its monthly equivalent in proposed refinance PITI. Never overwrite a manually entered tax amount with a late automatic response.

**Why:** The user explicitly wants the actual tax bill to autopopulate and be included in every refinance analysis.

**Cache rule:** Verified official non-homestead seeds may scale only within the ±20% price guardrail and unchanged homestead status. Homestead seeds must not scale to changed prices. Formula seeds are never eligible.

**Why:** Fixed-dollar homestead exemptions make the effective percentage change as price changes, so scaling one sample's percentage to a different price understates or overstates tax.

**County-routing rule:** Treat official situs ZIP lists as candidate coverage, not proof of county identity. If a ZIP belongs to multiple counties, do not pick the first match; use a parcel-level verifier or report unavailable.

**Why:** Florida ZIP boundaries cross county lines, and formula-only county routes cannot reject an address from the wrong side of the boundary. A static priority can therefore apply the wrong county's rate while appearing successful.

**How to apply:** Keep shared ZIPs in every authoritative county set. Hillsborough may lead when its strict parcel matcher can reject and continue; other shared ZIPs must remain conservative until an equally strict county verifier exists.

**County calibration rule:** A matching county PDF example validates that example, not a county-wide default or every homestead/rounding branch. Use verified parcel millage for parcel-specific calculations; do not promote the example's district rates into a county-wide fallback.

**Why:** Collier has many millage areas. Applying a sample district everywhere can make the reported example correct while silently worsening other properties. Its estimator page was inaccessible during validation, so example-compatible rounding is not independently verified county JavaScript.

**How to apply:** Use labeled baseline fallbacks until each county is live-verified. Disclose limits when reporting county-estimator parity; never replace the county-wide fallback with the sample parcel's district rates.