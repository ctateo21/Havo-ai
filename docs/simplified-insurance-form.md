# Simplified insurance form

## Defaults and evidence

- Wind report question is first. Private uploads supply an internal reference;
  extracted answers remain editable in a collapsed review. No reference or
  inspector input is required. Confirmed report evidence overrides estimates.
- Without a report, county/year/permit standards supply wind estimates. Missing
  supporting evidence is described as an unverified/no-credit assumption, never
  fabricated as a verified property fact.
- GatedCommunity is `No`. HaveWindMitForm remains `true` as the agency checkbox
  default, not proof of an inspection. CreditPermission stays `No` and
  AssumedCreditScore stays `Excellent`.
- Claims default to none with a visible premium disclaimer.
- New-purchase effective dates use fourteen calendar days from today and are
  recorded as `14-day-default`, not user-confirmed closing dates. Owned-home
  insurance and optional mortgage answers remain separate.
- The roof material choices map to `Architectural Shingles`, `Metal`, `Tile`,
  and `Other`. Roof shape is Flat, Gable/Other, or Hip; Gable/Other sends Gable.
- Explicit SWR No overrides year/permit estimates. Otherwise 2021+ roofs and
  evidenced SWR permits retain estimated Yes. Missing evidence assumes no credit.
- Coverage A uses living area and the county block rate; frame is 85% of block,
  mixed is their average. A manual Coverage A survives recalculation until reset.
  Missing rates or area do not invent replacement cost.

## Roof imagery

Implemented the requested alternative: Google Static Maps satellite imagery,
analyzed through the existing OpenRouter document/vision integration. Requires
`GOOGLE_MAPS_SERVER_API_KEY` with Static Maps access and `OPENROUTER_API_KEY`.
The existing `OPENROUTER_DOCUMENT_MODEL` override remains optional.

Images are fetched server-side and sent as inline image bytes; the credential-
bearing Google URL is never placed in an AI prompt or log. The operation has a
20-second total cap, a confidence threshold, and returns no suggestion on errors
or ambiguous imagery. Results are cached with the existing property evidence.
Signed-in evidence requests can obtain imagery; anonymous visitors retain the
disclosed Gable/Other fallback. Explicit user choices and report answers win.

QuoteRush Roof AI / AugmentLeadData was **not** wired: the available integration
does not establish its endpoint contract, accepted authorization, returned shape,
or whether augmentation persists returned fields before carrier submission.
No speculative paid endpoint was added, and no live provider calls were made.

## Flood

FEMA zones load automatically; correction is available in assumptions. The
premium card explains that flood is separate and identifies A/V hazard zones.
No flood quote is submitted. A live flood integration needs QuoteRush's supported
flood LOB identifier, flood import mapping/required underwriting questions,
carrier discovery and submission eligibility, and result parsing confirmed with
the provider. The current code submits only `LOB: Home`; its Home endpoint
contract is not evidence that a Flood LOB is supported. Elevation, building and
coverage/deductible requirements must be confirmed rather than invented.

## Release

No migrations are needed. Existing private report storage, per-county rebuild
rates and property-evidence cache are reused. Tests use fictional fixtures and
mocked provider responses. No migration, merge or publication is part of this change.
