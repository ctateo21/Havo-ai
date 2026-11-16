# QuoteRush home completion and automatic carrier submission

## Desktop recording update — supersedes earlier mapping limitations below

Christian's normal run is **Run Quotes > Add VIP Carriers > Execute**, with Run RCE
checked. "Lead Submitted to BOT!!!" queues the local BOT Manager, which opens Chrome
on the agency PC, logs into carrier portals and writes premiums to Overview >
Quote History. We must not assume the premium API executes remotely in the cloud.
Agent-review alerts now give this manual sequence and warn against duplicate imports.
An imported lead is retained on failure, but incomplete answers still require review;
we cannot promise a popup-free run.

Mapping updates:
- StructureType now accepts the observed Single Family, Duplex (2 Family), Triplex
  (3 Family), Quadplex (4 Family), Rowhouse (Townhouse Center), Rowhouse (Townhouse End),
  Bi-Level and Tri-Level strings. Single-family listing types map directly; multifamily
  records require unit count 2–4. Townhome center/end is never guessed from type alone.
- ConstructionType preserves user construction, including Masonry for block, never
  Apply Defaults' Frame for block. Mixed percentages need a verified split.
- Pool accepts None, Inground - small < 300 sq ft, Inground - med 300-600 sq ft,
  Inground - large > 600 sq ft, Above Ground, Indoor. No pool evidence uses Christian's
  None default, explicitly marked estimated rather than verified absence.
- RoofMaterial is Architectural Shingles. Existing user roof shape takes priority;
  Gable remains the unconfirmed fallback. Renovation system years remain omitted;
  UpdateRoofYear uses the user's roof year, never a fabricated year-built update.
- AdditionalLawOrdinance is 25%; OptionalPersonalPropertyReplacementCost true;
  existing dwelling replacement-cost setting remains true. Cov C remains 25%.
  Existing chosen deductibles override defaults. HO3 medical stays $5,000.
- HaveWindMitForm is false and inferred wind-form credits are omitted. Havo has no
  verified wind-mit upload workflow; the agent must obtain/review the actual form.
- PreviousAddress is a documented top-level importer object. New purchases now have
  an optional current-home-address question. If supplied, all address components
  are validated; if omitted, an agent must complete it before carrier execution.
  It stays out of shared property evidence and OpenRouter prompts.
  Quotes using this personal address are also isolated by owner in their answer
  identity, preventing cross-user quote reuse.
- FullBathCount is documented and uses an explicit full-bath count when present in
  cached listing data. Total fractional bathrooms are not treated as full bathrooms.
- FormType remains HO-3: Home Owners Policy for HO3; discovery/submission LOB Home.
  Carrier-specific Florida Peninsula HO3 confirmation is not documented as a
  separately controllable popup.
- WindMitigationInspectionDate exists in the importer example but no supplied report
  date is available, so it is omitted; do not invent an Olympus inspection date.
  Primary water-heater location and Copper wiring mappings still need API field names.
- Mortgage now has an explicit Yes (financed purchase/refinance) / No (cash/outright)
  question and is sent as Mortgage Yes/No. Unknown stays omitted, not invented.
  Existing-home current-carrier answers remain unchanged.

### Revised support question
Our imported lead succeeds, but SubmitQuoteRequest returns 403. Please confirm premium
activation, Agency/EndpointKey, host and Submitter authorization. Does SubmitQuoteRequest
route to a **cloud QuoteBot** or our **desktop BOT Manager**? Can an API request trigger
**Send To BOT** for an already imported lead, equivalent to Add VIP Carriers > Execute
with Run RCE checked? Must BOT Manager and Chrome remain running on our agency PC?
How are VIP carriers and Run RCE selected via API, and do results populate Overview >
Quote History as well as GetQuotes/callbacks? Can PreviousAddress, FullBathCount,
RoofShape and WindMitigationInspectionDate satisfy the respective carrier popups,
or are Olympus inspection-date and Florida Peninsula HO3 answers separate?
Please confirm the observed desktop StructureType/Pool strings are accepted by the
importer, plus primary-water-heater location and copper-wiring field names.
We require CreditPermission No / AssumedCreditScore Excellent. No credit pull.

## Review boundary
New branch from GitHub main `53d1b2b7638fabaa3e8c0d8d2308167a83cec73b`.
No merge, publishing, secret changes, migrations or live QuoteRush calls.
CreditPermission remains No; AssumedCreditScore remains Excellent.
Automatic submission still begins only after the user requests live quotes.

## Evidence and 403
November 16 2026 14:35 ET: importer HTTP 200, verified lead ID; SubmitQuoteRequest HTTP 403.
The old logs did not retain the submission response body. An exact provider reason cannot
be recovered or proven without a future approved attempt.

Public references inspected November 16:
- https://api-docs.quoterush.com — importer example and authentication.
- https://client-api-docs.quoterush.com — GetQuotableSitesForLead, SubmitQuoteRequest and GetQuotes.

Importer: POST https://importer.quoterush.com/Json/Import/{WebID}, header webpassword.
Carrier APIs: POST https://api.quoterush.com/{method}, JSON Agency and EndpointKey.
The documented field is Agency, not AgencyId; no WebID header is needed for submission.
The public collection displays relative URLs, so the agency-specific API host should
also be confirmed by support. No host was changed speculatively.

SubmitQuoteRequest is a separately enabled **premium service**. Billing must activate it.
It requires LeadId, LOB, Submitter (agency user email), and Carriers (names).
Havo now stops with the imported lead retained if discovery fails, rather than
sending an invalid request without Carriers. Every returned Home carrier name is
sent unchanged (deduplicated); no hardcoded carrier list or unavailable appointment
is invented. This is the documented automatic quoting API, not desktop automation.
GetQuotes and the existing verified callback/polling job retrieve results for Havo.
The docs do not guarantee how every carrier's result appears in the desktop Overview.

Submission and discovery failures now record status and sanitized response metadata/text.
Credential values, applicant values, callback URLs, IDs, arbitrary tokens are redacted.
No automatic retry of a paid or ambiguous import is introduced.

## Field mapping
| Desktop item | Import key / source / behavior |
|---|---|
| Families | HO.Families = "1", agency default |
| Electrical / heat / plumbing | ElectricalType Circuit Breakers / PrimaryHeatSource Electric / PlumbingType PVC, defaults |
| Roof renovation | UpdateRoofType Full, default; UpdateRoofYear user roof year |
| Water heater location | **Not documented in public importer example; omitted pending support** |
| Cov A | CoverageA, existing user-confirmed rebuild/manual amount; never AI or market value |
| B / C / D | CoverageB 2%, CoverageC 25%, CoverageD 10% of A, defaults; existing HO6 exception retained |
| E / F | CoverageE $300,000 / CoverageF $5,000; existing HO6 $2,000 retained |
| Hurricane / wind / AOP | HurricaneDeductible / WindHailDeductible / AllOtherPerilsDeductible, explicit user choices; existing UI defaults 2% / 2% / $2,500 |
| Lapses / carrier | AnyLapses No / CurrentCarrier New Purchase for purchases; existing-home personal insurance answers preserved |
| Effective date | PolicyEffectiveDate, confirmed closing/requested date in MM/DD/YYYY |
| Alarms | BurglarAlarm None / FireAlarm None, defaults |
| Station / hydrant | FireStation Within 5 Miles / FireHydrant Within 1000 Feet, defaults requiring verification |
| Sprinkler / community | Sprinklers None / GatedCommunity Single Entry; latter user-approved desktop value, not enumerated in public example |
| Business / extinguisher | BusinessOnPremises No / underwriting.FireExtinguisher true, defaults |
| Loss / roof settlement | LossAssessment $1,000 (HO3/DP3) / RoofLossSettlement Replacement Cost |
| Usage / occupied | UsageType user answer (never overwrite secondary/investment) / both MonthsOccupied and MonthsOwnerOccupied = 9 months or more |
| Block | Existing ConstructionType Masonry, Construction/MasonryConstruction Concrete Block, FoundationType Slab |
| Structure | StructureType, cached single-family listing first, otherwise estimated OpenRouter suggestion |
| Stories | Stories, county cache then cached listing then OpenRouter |
| Pool | Pool, only documented example enum supported; null if insufficient evidence |
| Screened enclosure | ScreenedEnclosureSquareFeet / ScreenedCoverage, bounded structured OpenRouter suggestions where unknown |
| Flood zone | FloodZone, existing FEMA/user answer; never AI inferred |
| Protection / BCEG | ProtectionClass / BCEG, bounded suggestions; prompt requires known supporting facts or null |

The public importer example documents keys, not a comprehensive allowed-value list.
StructureType is restricted to the documented Single Family value; Pool to the documented
Inground - 300 - 600 sq. ft. value. Other types remain absent, not forced into those values.
Numeric story/class ranges and BCEG codes require provider enum confirmation.
An unsupported value is omitted. Complete filling for every property is **not yet verified**.
There is no documented Apply Defaults flag; Havo supplies explicit fields.

## Inference, cache and review
Only address and whitelisted building facts go to OpenRouter—not contact information,
claims, DOB or credentials. Responses are constrained, validated, confidence-scored and
marked estimated. Confidence is the model's reported confidence, not measured accuracy.
AI cannot set dwelling CoverageA, roof age, flood zone, credit or applicant facts.
Defaults and evidence appear in Client.OverviewNotes and Havo's existing agent-only
verification panel on the insurance page. Existing server-side agent allowlist stays intact.
Evidence is stored in the existing property-characteristics field_sources JSON under
quoteRush keys; quote snapshot/provenance/assumptions are saved before import.
No migrations. Evidence can be reused while that property cache is valid.
If no valid characteristics cache row exists, suggestions cannot persist there; a later
run can repeat inference. Missing/unsupported answers remain blank for agent review.
Zillow reuse is read-only, using existing normalized cache rows no older than seven days.
No new Zillow/Apify scrape was added. Existing historical normalized listings may not
contain stories or pool details. Existing county facts are not overwritten by AI.

## Exact support question
Call QuoteRush **1-800-601-3541** or have the agency administrator contact billing@quoterush.com:

> Our Havo integration successfully imported a lead on November 16 at 2:35:45 PM ET,
> but POST SubmitQuoteRequest returned HTTP 403 at 2:35:49 PM ET. Is the premium
> SubmitQuoteRequest/QuoteBot service activated for our agency and EndpointKey?
> Please verify the Agency/EndpointKey pairing, permitted API host, and that our
> configured Submitter is an authorized agency user. Can GetQuotableSitesForLead(Home)
> followed by SubmitQuoteRequest with all returned Sites execute all appointed Florida
> HO3 carriers and populate desktop Overview > Quote History? Please confirm required
> setup, whether desktop QuoteBot must be running, and any carrier credentials needed.
> Also provide the importer enum list for StructureType, Stories, Pool, ProtectionClass,
> BCEG and GatedCommunity (Single Entry), the primary-water-heater-location field,
> and whether an Apply Defaults option exists. We intentionally send CreditPermission No
> and AssumedCreditScore Excellent; no credit pull is authorized.

Do not email raw credentials; use QuoteRush's approved secure verification channel.
OPENROUTER_API_KEY was confirmed present in development and production configuration
(existence only). No secret addition is currently needed.

The existing app startup logs also report AI usage accounting unavailable. The new
enrichment uses that existing fail-closed usage guard and the durable job owner's
identity; it does not bypass accounting. If that condition persists, AI suggestions
remain unavailable while sourced fields/defaults still import. No accounting migration
was applied or live OpenRouter call made to test this.
