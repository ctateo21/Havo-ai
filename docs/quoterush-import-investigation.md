# Import investigation — updated 2026-11-14

No live importer retry, carrier submission, migration, merge or publish was performed.

## Evidence and confidence

The incident returned HTTP 200 without a verified LeadId. Christian checked the
agency platform and found no lead. Business/authentication/validation rejection
inside a successful HTTP response is therefore the leading explanation (moderate
confidence). The exact rejecting field is unknown: the original response body was
not retained. Parser incompatibility is a proven separate defect, but does not
explain an absent lead by itself.

## Historical success attribution (read-only)

Production managed database: latest non-null LeadId 841, triggered September 11,
2026 at 14:00:35.133 UTC, status failed; older ID 745 July 16, status failed.
These prove stored IDs, not newly created leads. Historical logs are outside
30-day retention. Within retention, the only importer completion is November 13
12:33:21.819 UTC HTTP 200; no LeadId or GetNewLeads entries were found.

The nearest earlier repository checkpoint is
`6da559cede6ee81d2ab4c7ed683860e8a6b4884d` (September 10, 22:08:40 UTC).
Its entire quoterush.ts is byte-identical to `3358616^` (SHA256
6a2899191e9582f6ea3c142b911be385e89ed8721a0ceea2b4fdd03c3cc9fdb5).
The preceding deployment completed September 10 22:08:36 UTC, but deployment
metadata does not expose a commit SHA. **This is a comparison baseline, not a
confirmed last-known-good deployed commit.** Neither ID's importer-response vs
unsafe GetNewLeads fallback provenance can be established. The synthetic
historical contract fixture is explicitly not a captured successful request.

## Complete importer request diff: historical baseline versus this branch

| Field or transport | Before | Now | Rejection assessment |
|---|---|---|---|
| URL query | none | none | Removed optional JSON query to restore original transport |
| Client.DOB → DateOfBirth | DOB only | DateOfBirth only, MM/DD/YYYY | Single documented key; no duplicate |
| Client.Phone → PhoneNumber | Phone plus PhoneCell | PhoneNumber plus PhoneCell | Single documented primary phone key; cell field unchanged |
| HO.MonthsOccupied → MonthsOwnerOccupied | MonthsOccupied | MonthsOwnerOccupied | Single documented key; value unchanged |
| HO.PurchaseDate | date passed through, possibly YYYY-MM-DD | MM/DD/YYYY | Normalize at outgoing boundary |
| HO.PolicyEffectiveDate | date passed through, possibly YYYY-MM-DD | MM/DD/YYYY | Normalize at outgoing boundary |
| Client.CreditPermission | Yes | No | Intentional no-credit rule; provider acceptance with assumed score remains unverified |
| Client.AssumedCreditScore | literal Excellent | literal Excellent | Override removed from payload, assumption API and email |
| fetch timeout | no explicit timeout | 30 seconds | Local failure boundary, not request payload |

All other importer payload keys, formats and conditional inclusion rules are
unchanged from that parent, including DOB conversion, phone string formatting,
purchase price/year/coverage numeric strings,
claims, wind answers, and new-purchase defaults. POST, JSON Content-Type and
webpassword authentication header are unchanged. No required-field schema changed
in the payload builder. PR13's preflight now rejects missing name/phone before import.

Response/control changes are not request changes: the old arbitrary-number parser
was narrowed to `Lead #digits`; the unsafe GetNewLeads-first-record fallback was
removed. This update restores only explicit ID formats, never arbitrary numbers
in error text and never that fallback. Carrier discovery, Carriers and callbackUrl
were added to the later submission stage; they cannot explain rejection before a
LeadId exists.

Deductible strings, UsageType and FormType mappings are unchanged. Mixed
construction still sends ConstructionType=Mixed, Construction=selected masonry
subtype (or Mixed if absent); it was already this way in the September baseline.
No evidence supports inventing different enum values. CreditPermission is NOT
the sole difference: the documented key names and normalized dates also differ.
No + Excellent acceptance remains unverified; never revert permission to Yes.

Response inspection now ignores zero/false/empty error fields, accepts deeply
nested and array LeadIds, strips exact applicant/secret values before rejection
keyword checks, and preserves safe field-name diagnostics. An explicit rejection
still blocks carriers even with a LeadId; that ID is persisted through the same
generation-guarded hook and included in the sales review reason.

## Documentation checked

- Original attached build specs ending `1783187776342.txt` and `1783188405029.txt`:
  plain integer/text LeadId, original aliases, original credit Yes.
- https://api-docs.quoterush.com — responseType=JSON explicitly supported;
  errors are text with error/resolution details. Sample uses DateOfBirth,
  PhoneNumber, MonthsOwnerOccupied; successful text is `Success - Lead #...`.
- https://client-api-docs.quoterush.com — later carrier submission is separate.
- https://zapier.com/apps/code/integrations/quoterush — exposes Credit Permission,
  Assumed Credit Score, Date Of Birth and Phone Number.

Neither public page establishes a special companion field for No + Excellent,
or a complete required/enum validation contract for that combination. No basis
to change No to Yes or invent a companion field.

## Proposed controlled retry (NOT executed)

Exactly one POST to
`https://importer.quoterush.com/Json/Import/<QUOTERUSH_WEBID>`,
Content-Type application/json, webpassword from QUOTERUSH_WEBID_PASSWORD.
No EndpointKey, callback token, carrier list or Agency credential is in this
import request. No automatic retry. It can create a real agency lead.

Use the payload builder only, NOT importAndSubmit, qr-start or the durable worker:
those proceed to carrier submission after success. A diagnostic must stop after
the single importer response, with no GetPropertyData, GetNewLeads, carrier
discovery, SubmitQuoteRequest, polling, CRM dispatch or customer email.
The original queue payload was cleared; this is not a byte-identical replay.
Contact/DOB and all required quote answers must be recovered and confirmed first.

Field manifest (angle-bracket values are redacted/unconfirmed, not defaults):

```text
Client:
 NameFirst=<confirmed first name>; NameLast=<confirmed last name>
 DateOfBirth=<private DOB, MM/DD/YYYY>
 PhoneNumber=PhoneCell=<confirmed phone string>; PhoneOther=""
 EmailAddress=<confirmed email>; Assigned=<QUOTERUSH_ASSIGNED_EMAIL>
 Address=<street>; City=<city>; State="FL"; Zip=<five-digit string>; County=<county>
 EntityType="Individual"; Gender="Male"; MaritalStatus="Single"
 Industry="Business/Sales/Office"; Occupation="Account Executive"
 EPolicy=true; International=false
 CreditPermission="No"; AssumedCreditScore="Excellent"
 LeadSource="Havo Platform"; LeadStatus="New Lead"
 Lob_Home=true; Lob_Auto=false; Lob_Flood=false
HO:
 FormType="HO-3: Home Owners Policy"
 Address=<street>; City=<city>; State="FL"; Zip=<ZIP>; County=<county>
 NewPurchase="Yes"; PurchaseDate=<confirmed MM/DD/YYYY date, if present>
 PurchasePrice="300000"; UsageType=<confirmed use>
 MonthsOwnerOccupied=<confirmed enum>; RentalTerm=<if supplied>
 YearBuilt=<confirmed year string>; PolicyEffectiveDate=<confirmed MM/DD/YYYY date>
 SquareFeet=<positive confirmed sq ft, rounded string>
 ConstructionType=<confirmed type>; Construction=<confirmed subtype>
 MasonryConstruction=<confirmed subtype or empty>
 FoundationType="Slab"; RoofShape=<confirmed shape>; RoofMaterial="Composite Shingle"
 UpdateRoofYear=<confirmed roof year string>; UpdateRoofType="Full"
 CoverageA=<confirmed amount string>; CoverageB=<2% rounded>; CoverageBPercent="2%"
 CoverageC=<25% rounded>; CoverageCPercent="25%"
 CoverageD=<10% rounded>; CoverageDPercent="10%"
 CoverageE="$300,000"; CoverageF="$5,000"
 AllOtherPerilsDeductible=<confirmed>; HurricaneDeductible=WindHailDeductible=<confirmed>
 FloodZone=<verified/selected only, otherwise omitted>
 MilesToCoast=<if known, two decimal string>; FloodPolicy=false
 CurrentlyInsured="Yes"; CurrentCarrier=CurrentPolicyNumber="New Purchase"; AnyLapses="No"
 Claims=<Yes/No from confirmed history>; HaveWindMitForm=<confirmed>
 OpeningProtection=<confirmed>; SecondaryWaterResistance=<confirmed>
 Terrain="Exposure B"; BurglarAlarm=FireAlarm="None"
 FireHydrant="Within 1000 Feet"; FireStation="Within 5 Miles"
 Mortgage=<Yes/No if answered>; EPolicy=true; WaterBackup=true
 WaterBackupAmount="$10,000"; RoofLossSettlement="Replacement Cost"
 PersonalInjuryCoverage=IdentityTheft=IncreaseReplacementCostOnDwelling=true
Claims (only if confirmed claims exist):
 [{ClaimDetail:<confirmed>, Date:<MM/DD/YYYY>, Amount:<rounded dollar string>,
   PriorResidence:<boolean>, Paid:<boolean>}]
```

Demographic/amenity constants above are existing builder defaults, not newly
verified personal/property facts. They need review before a controlled retry.
The proposed diagnostic must explicitly verify the assumed-credit configuration
is Excellent without printing credentials.

## Changes

Accept positive safe integer/quoted integer IDs, case-insensitive ID keys, nested
Data/Result and explicit Lead # text. Error/validation bodies override IDs.
Log only response MIME type, byte length, digits-only flag, redacted key names
and conservative vocabulary-filtered diagnostics. Unknown words/numbers are
redacted, including unknown key names; this intentionally sacrifices detail for
privacy. Known submitted identity/credential values are additionally removed.
Never retain/log the raw body. Include sanitized rejection in the team's alert.
Persist property enrichment before terminal failure with a null lead-ID guard.
Remove street/city from the import-start log.
