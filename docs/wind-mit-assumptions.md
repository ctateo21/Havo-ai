# Compact wind mitigation assumptions

Planning assumptions are not inspections or verified building-code compliance.
Each editable field has a basis note. Reviewed report values override assumptions.
Roof deck always defaults to Level C, including missing year built; missing build
still uses Toe Nails for roof-to-wall. Explicit user/report values override defaults.
Answering No to having a report collapses the editable list by default. Yes keeps
upload/review controls visible. County names in basis notes use proper case.

| Scenario | Roof year | Deck | Roof-to-wall |
|---|---:|---|---|
| 1985 inland, Pinellas | 2000 | Level C | Toe Nails |
| 1990 inside coastal zone, Collier | 2000 | Level C | Clips |
| 1996 Pinellas | 2000 | Level C | Clips |
| 1996 Hillsborough | 2000 | Level C | Toe Nails |
| 1998 Pinellas | 2015 | Level C | Clips |
| 2001 Hillsborough | 2005 | Level C | Clips |
| 2005 Polk | 2005 | Level C | Clips |

Deck: always C as an agency planning assumption, never an inspection finding.
Level A, Level B and Reinforced Concrete remain manual/report options.
Wall: 2003+ statewide; 1996+ Pinellas/Manatee/Sarasota/Lee/Collier;
1997+ Hillsborough/Pasco/Hernando/Polk; or 1987–1995 inside the verified
coastal zone → Clips. Otherwise Toe Nails. Uncertain geography cannot grant Clips.

## OIR-ordered list / importer contract
1. Roof Covering (material): Shingle → Architectural Shingles; Tile → Tile;
   Metal → Metal; Built Up → Tar and Gravel; Membrane → Rubber;
   Rolled Roofing → Rolled Roofing. Import key: RoofMaterial.
2. Product Approval Listing: RoofCovering, default Meets FBC 2001;
   choices Meets FBC 2001 / Meets FBC 1994 / Non-FBC.
3. Roof Deck: RoofDeckAttachment, Level A / Level B / Level C /
   Reinforced Concrete Roof Deck.
4. Roof-to-wall: RoofWallConnection, Toe Nails / Clips / Single Wraps /
   Double Wraps / Structural / N/A (Other).
5. Shape: RoofShape, Hip / Flat / Gable (Gable/Other).
6. SWR: SecondaryWaterResistance, Yes for 2021+ roof year, otherwise No.
   Explicit user selection and report values override the estimate.
7. All openings impact-rated or shuttered: Yes → Hurricane Protection;
   otherwise Unknown or None. Basic is allowed only for an explicit report B.
   Permits do not auto-select all openings or confer Basic.

There are no duplicate roof-type or wind selectors elsewhere in the form.
Roof year remains editable and required in the property questions.
Existing vision suggestions remain estimated; they do not override user/report values.

The quote answer fingerprint is versioned to prevent reuse of quotes priced under
the superseded assumptions. No schema migration is needed. CreditPermission No,
AssumedCreditScore Excellent, GatedCommunity No, and HaveWindMitForm true remain
unchanged. The checked affidavit default is not proof of a real inspection report.

All validation uses fictional fixtures and mocked provider responses.
No live carrier, Google or OpenRouter calls, migrations, merge or publish.
