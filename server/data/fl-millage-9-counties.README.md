# Florida millage research supplied by Christian

`fl-millage-9-counties.json` preserves the supplied JSON, including abbreviated
names and grouped Collier labels. Research date: **2026-11-12**. These are
planning inputs, not a new live county-estimator capture.

## Sources supplied with the research

- Hillsborough: https://www.hcpafl.org/Portals/HCPAFL/pdfs/2026FinalMillage.pdf
- Pasco: https://search.pascopa.com/millage.aspx?taxyear=2026
- Polk: https://www.polkflpa.gov/Downloads/Files/finalmillage.pdf
- Sarasota: https://www.sarasotataxcollector.gov/files/docs/2026millages.pdf
  (district totals computed from that sheet).
- Lee: https://www.leepa.org/ — **2026 Taxing District Millage Book**.
- Manatee: https://www.manateepao.gov/ — **2026 Final Adopted Millage Rates.pdf**.
- Hernando: https://www.hernandocountypa-florida.us/ — MillageRates,
  **Millage Rate Breakdown.png**.
- Pinellas SP: https://www.pcpao.gov/tax_estimatorout — **2026 estimator levy table**.
- Every 2025 row: Florida DOR PTO Data Portal, TACD History,
  **2025 County TACD**:
  https://floridarevenue.com/property/dataportal/Pages/default.aspx
  The exact Pinellas PDF was independently retrieved during this work.
- Collier: all supplied district rows are **2025 DOR TACD**, not 2026.
  No Collier appraiser data endpoint was fetched.

The user supplied the Amendment 3 scenario description and cited FL DOR
**PTO 26-21**. The scenario is OFF by default, explicitly labeled as 2027
rules using 2026 mills, and is not an eligibility determination. Residency
exceptions and the non-homestead assessment cap cannot be determined from a
purchase price alone.

## Interpretation and boundaries

- A district's year is `dy`, flipped only for codes in `otherYear`.
- Select school mills from the corresponding year. Non-school mills are the
  district total less those school mills; no NAV is present in this file.
- Preserve leading zeros (Lee and Manatee identifiers are strings).
- Collier `1 +2` identifies code `1` plus two **unspecified** codes sharing its
  total. Only the explicit first code is mapped; the unspecified codes are
  not guessed or expanded into consecutive identifiers.
- Explicit city planning defaults are separate from a parcel's district:
  Tampa TA, St. Petersburg SP, North Port M0500, Marco Island 27. Marco Island
  has other districts; its city default is always rough, never a parcel match.
- Current-year live parcel rates override research. Admin and live-estimator
  rows are never overwritten by the seed.
- Seed `fetched_at` is the import timestamp, not a claimed live fetch time.
  `verified_against` records the supplied research date.
- Manatee remains flat $50,000 total in county-estimator mode until an admin
  changes the setting. Its published sheet's $51,411 alternative is disclosed.
- Sarasota M0500 is unresolved: the preserved estimator fixture uses school
  6.131 / non-school 8.4246 and AV $4,601, whereas this sheet uses school
  5.929 / non-school 8.4145. The research path is flagged unverified; the
  official-estimator fixture has not been altered.

## Seeding

`npx tsx scripts/seed-fl-millage.ts output.sql` generates the review-only seed
migration. It performs **no database writes**. The app can use this bundled
research when new tables are not yet approved. Admin changes require the
pending schema migration. No shared or managed migration was applied.
