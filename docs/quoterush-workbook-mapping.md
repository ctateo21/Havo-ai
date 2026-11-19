# QuoteRush workbook alignment — November 18, 2026

Based on the exact mapping transcription supplied by Christian from Jeff's
workbook. The workbook binary was not available in the workspace. No live
QuoteRush request was made to validate these mappings.

This supersedes older enum/key observations in the home-completion review.
Built on the current insurance-current-home-collapse branch, not main.

| Import field | Outbound mapping |
|---|---|
| OpeningProtection | A → Hurricane Protection; B → Basic; other/missing → Unknown or None |
| SecondaryWaterResistance | Evidence Yes/No only; unknown omitted |
| WaterHeaterLocation | Garage, expressly an unverified property assumption |
| SprinklerSystem | None |
| FormType | HO-3: Home Owners Policy; HO-6: Condo Owners Policy; DP-3 Dwelling Fire/Renters |
| UsageType | Internal Investment → Rental; existing RentalTerm preserved |
| StructureType | Workbook allowlist; historical family-count suffixes removed; townhouse center/end mapped; Bi-Level/Tri-Level omitted |
| Stories | 1, 1.5, 2, 2.5, 3, 4, Bi-Level, Tri-Level; all others omitted |
| PoolType | None; Inground - small < 300 sq. ft.; Inground - 300 - 600 sq. ft.; Inground - large > 600 sq. ft.; Above Ground - Detached; Inground - small < 300 sq. ft. - Detached; Inground - 300 - 600 sq. ft. - Detached; Inground - large > 600 sq. ft. - Detached |
| ConstructionType | Masonry, Frame, Mixed Masonry-Frame; extra Construction key removed |
| MasonryConstruction / FrameConstruction | Only the supplied workbook subtype allowlists |
| RoofDeckAttachment | Evidence A/B/C → Level A/B/C; D/unknown omitted |
| RoofWallConnection | Existing evidence mapping retained; Unknown omitted |

The three detached-inground strings were subsequently supplied exactly and are
accepted unchanged. Historical detached variants without periods in `sq. ft.`
and with `med 300-600` normalize to the corresponding official strings.
Indoor is omitted, not converted to None.
Historical cached Pool and structure options normalize only at the importer/
enrichment boundary; no database migration or data rewrite.

Protected behaviors unchanged: HaveWindMitForm true as the current agency
checkbox default (not evidence of a real report); GatedCommunity was Single Entry
at workbook alignment and is now No under the simplified-form product decision;
CreditPermission No; AssumedCreditScore Excellent; RoofMaterial Architectural
Shingles; Coverage A never inferred; dates unchanged; previous-address fallback
only for new purchases; estimated wind evidence stays labeled in notes.

The final quoted phrase about unchecking the affidavit conflicts with the
repeated explicit instructions to retain current behavior. This change follows
the explicit instructions and does not alter the checkbox.
