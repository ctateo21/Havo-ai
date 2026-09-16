# County estimator evidence

The Collier text fixture is a visual transcription of the user-provided
`attached_assets/Collier_County_Property_Appraiser_1789584225220.pdf`,
captured 2026-09-16. The PDF was rendered and checked: price $525,000,
Homestead No, ad valorem $5,514, non-ad valorem $0.

This is **not downloaded page HTML** and does not validate an HTML scraper.
It validates extraction from the transcribed labeled result only. A live
result and its original page output must still pass before declaring Collier complete.

The proposed Hillsborough $4,676 value is approximate and has no supplied
capture. It is intentionally not used as a confirmed answer.
The other seven counties also lack human captures.

Run `npm run test:county-estimator:acceptance` to enforce the completeness
gate. It must fail while evidence is missing; do not increase the $1
tolerance or invent fixtures to make it pass.
Run with `RUN_LIVE_ESTIMATOR_TESTS=1` for the additional live checks.
Passing offline tests alone never establishes live county completion.