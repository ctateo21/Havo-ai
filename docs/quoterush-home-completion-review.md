# Current importer mapping

The [November 18 workbook alignment](quoterush-workbook-mapping.md) supersedes
all historical JSON key/enum observations below, including old Pool, Sprinklers,
water-heater, wind, structure and policy strings. Historical investigation notes
below are retained for context, not the current importer contract.

# Four-county official portal fallback update

This supersedes the earlier blanket PA-only prohibition ONLY for Pasco, Polk,
Hernando and Sarasota. The other five counties are unchanged. No migration.

Implementation uses plain HTTP with a per-request cookie jar, identifying Havo UA,
one-second pacing, parent cancellation and a 75-second permit budget within the
existing 80-second enrichment cap. No browser/Firecrawl or automatic CAPTCHA solver
is used for these fallbacks. Any CAPTCHA markup, login wall, block or robots
restriction stops the request. Unknown errors never become evidence.

PA adapters must first return empty records or the specifically recognized
no-record/referral condition. PA failures, identity mismatches and unknown schemas
do not authorize fallback. Successful results retain the existing per-parcel cache.
Existing OpenRouter verbatim classification and report precedence are unchanged.
Re-roof alone does not establish SWR: explicit underlayment evidence is required.

| Jurisdiction | Route | Current limitation |
|---|---|---|
| Unincorporated Pasco, districts U/UF | PASCO Accela Building | Live check stopped by CAPTCHA/login safety detection; no records verified |
| Unincorporated Polk, districts 30/90/91/92/93 | POLKCO Accela Building | HTTP adapter implemented; live records not verified |
| North Port, M0500 | NORTHPORT Accela Building | Routing implemented, but not activated: Sarasota PA remains robots-restricted, so no qualifying PA-empty lookup |
| Other Pasco/Polk cities | Unknown | Public exact-address search not verified; never route to wrong county |
| Hernando current/legacy | Unknown | No validated record parser or public-search adapter; not implemented |
| Unincorporated Sarasota / Venice | Unknown | Login/CAPTCHA restrictions; not attempted |
| City of Sarasota | Unknown | Public search not verified; no scraping attempted |

Accela parser requires an exact address cell in both the search row and record
detail plus an explicitly labeled issue date. Layout differences fail closed.
No client address, owner details or live permit identifiers are committed.
This update is partial: the unverified and restricted paths above remain Unknown,
not claimed as working adapters.

# QuoteRush home completion and automatic carrier submission

## Current Apply Defaults override (supersedes earlier report-only/gated rules)

Christian explicitly approved always setting `HO.HaveWindMitForm=true` and
`HO.GatedCommunity="Single Entry"`. The checkbox is an **agency default**, not
proof of an uploaded report: stored `windEvidence.haveReport` remains truthful,
inspection dates are never fabricated, and lead notes distinguish default,
estimated and confirmed answers. Real report values still override estimates.
No live import was performed to verify the desktop rendering.

Source checked: https://api-docs.quoterush.com/ — **Add Lead**, public JSON example.
“Verified” below means the key/type/value appears in that example, NOT that a
new live lead was tested. The example is not a complete enumeration reference
and does not document an Apply Defaults API flag.

| Desktop field | Import field | Value / source | Documentation status |
|---|---|---|---|
| Families | HO.Families | `"1"` default; mapped multi-family count when known | Verified |
| Electrical | HO.ElectricalType | `"Circuit Breakers"` | Verified |
| Heat | HO.PrimaryHeatSource | `"Electric"` | Verified |
| Plumbing | HO.PlumbingType | `"PVC"` | Verified |
| Water heater location | HO.WaterHeaterLocation | `"Garage"` | Workbook mapping supplied November 18; location remains an unverified assumption |
| Terrain | HO.Terrain | `"Exposure B"` | Verified |
| Sprinkler | HO.SprinklerSystem | `"None"` | Workbook mapping supplied November 18 |
| Business | HO.BusinessOnPremises | `"No"` | Verified |
| Fire extinguisher | HO.underwriting.FireExtinguisher | `true` | Verified nesting and boolean |
| Secured community | HO.GatedCommunity | `"Single Entry"` always | Key verified; **value UNVERIFIED by API**, observed by Christian in desktop |
| Wind affidavit | HO.HaveWindMitForm | `true` always | Verified boolean; agency-default provenance in notes |
| SWR | HO.SecondaryWaterResistance | evidence Yes/No; otherwise omitted | Workbook mapping supplied November 18 |
| Openings | HO.OpeningProtection | A = `"Hurricane Protection"`, B = `"Basic"`, otherwise `"Unknown or None"` | Workbook mapping supplied November 18 |
| Roof-to-wall | HO.RoofWallConnection | evidence Clips/Toe Nails/Single Wraps/Double Wraps; Unknown omitted | Key/Single Wraps verified; other enums **UNVERIFIED** |
| Deck | HO.RoofDeckAttachment | evidence `Level A/B/C/D`; Unknown omitted | Key/Level A verified; B/C/D **UNVERIFIED** |
| Roof shape | HO.RoofShape | evidence/user; Gable fallback flagged | Key/Gable verified; Hip **UNVERIFIED** by example |
| Inspection date | HO.WindMitigationInspectionDate | real report only, MM/DD/YYYY | Verified |
| Burglar / fire alarm | HO.BurglarAlarm / HO.FireAlarm | `"None"` | Verified |
| Increased dwelling replacement | HO.IncreaseReplacementCostOnDwelling | `false` | Key/boolean verified; unchecked per Christian |
| Personal injury | HO.PersonalInjuryCoverage | `false` | Key/boolean verified; unchecked per Christian |
| Identity theft | HO.IdentityTheft | `false` | Key/boolean verified; **desktop default unknown**, unchecked per Christian. Sample's true is not Apply Defaults evidence |
| Structure type | HO.StructureType | property records/listing, then bounded OpenRouter | Key/Single Family verified; other desktop enums **UNVERIFIED** by API example |
| Stories | HO.Stories | property data, then OpenRouter, numeric string | Key/`"1"` verified; other allowed story counts not enumerated |
| Pool | HO.PoolType | property evidence, then OpenRouter; None agency fallback | Workbook mapping supplied November 18; unsupported options omitted |
| Dwelling Coverage Amount | HO.CoverageA | Havo Coverage A as numeric string, **never AI** | Verified |
| Screened enclosure | HO.PoolScreenedEnclosure | **boolean**, property data then AI; area >0 also establishes true | Verified boolean. Fixed missing positive-enclosure mapping |
| Enclosure area | HO.ScreenedEnclosureSquareFeet | property data then AI, numeric string | Verified |

The five reported blank Home fields now have payload contracts with supplied
property/AI evidence. No production UI acceptance is claimed without a live
import. Structure/stories remain omitted if both records and optional AI fail:
we do not silently invent these values to make a test pass. An absent pool uses
the previously approved, labeled None default. Enclosure false is labeled an
agency default when records do not establish it. Coverage A retains validation
and is never replaced with an AI suggestion.

### Sarasota official download research

https://www.sarasotapropertyappraiser.gov/downloads/download-data provides
`SCPA_Detailed_Data.zip` and a published layout:
https://www.sarasotapropertyappraiser.gov/media/mypn3r3w/data_layout_2024-11-12.xlsx
The layout was inspected (Building, Exemptions, Land, Lookup Tables,
Propertyownerlegal, Residentialgrid, Sales, SFYI, Sketchedarea,
Subdivisionindex, Taxdistricts, Values). No permit table or permit-number/date
columns were found. “permiter” is a perimeter field, not permit evidence.
No documented public permit API was found on the download/query-options pages.
This is not proof that the PA cannot provide a separate permitted data feed.

### Follow-up PA tab/record inspection — November 17

| County / sample | Exact PA record | Sections inspected | Permit result |
|---|---|---|---|
| Pasco — 8743 Sanders Tree Loop, Wesley Chapel | https://search.pascopa.com/parcel.aspx?parcel=2025260190012000220 | Address search; value/taxable comparison, land, additional land, sub-lines, building, extra features, sales; PA Value History and View Sketch | No permit rows. “Pasco County Permitting” is an external agency link, not followed. Adapter remains Unknown |
| Polk — 1515 New Jersey Oaks Ct, Lakeland | https://www.polkflpa.gov/CamaDisplay.aspx?OutputMode=Display&SearchType=RealEstate&ParcelID=242820239230000032 | Address search; property, building, sales, values/tax and PERMITS section | PERMITS contains issuing-agency referral only. Record card encountered CAPTCHA; excluded from verified evidence. Adapter remains Unknown |
| Hernando — 3301 Northeast Pkwy, Brooksville | https://propsearch.hernandocountypa-florida.us/parcel/1738622 | Address search; all six tabs: Land, Sales, Bldg Characteristics, Extra Features, Addresses, Businesses | No permit tab or rows. Adapter remains Unknown |
| Sarasota — intended sample 1182 S Salford Blvd, North Port | https://www.sarasotapropertyappraiser.gov/robots.txt | Public downloads and layout only; parcel inspection not performed | Disabled. Automated browser cannot provide the requested human/manual exception to robots restrictions. No verified permit schema or working adapter |

**Incomplete:** Sarasota's requested new flag-gated adapter was not implemented:
there is no verified permit tab, URL contract or schema to implement safely.
The existing unconditional restriction remains in force (zero network calls).
A human-supplied PA permit-page capture or an authorized documented permit feed
is needed before adding a useful disabled adapter, rather than a speculative
one that appears finished. No change to secrets/config was made.

**Research boundary incident:** the remote browser service automatically handled
a CAPTCHA on Polk's record-card page despite the stop instruction. That result
was discarded; the record-card path was not added to code, retried, or used as
evidence that an adapter works. The unchallenged parcel page's PERMITS referral
is the only Polk result relied upon. No permit-portal fallback was enabled.

These findings apply to the samples, not every parcel in those counties.
Existing verified HCPA/PCPAO/Manatee/Lee/Collier sources are unchanged.

## PA-only source policy — current, supersedes ALL portal sections below

All Accela, HillsGovHub, Tampa, Click2Gov, EnerGov and CityView permit paths
are disabled. The compatibility module has no URLs and performs zero network
calls. No Firecrawl browser-interact permit fallback remains. Old mixed-source
cached evidence is invalidated by the new supporting-evidence version.

HCPA, PCPAO, Lee, Manatee and Collier now have verified PA permit sources.
All seven remaining counties were investigated at parcel level where permitted.
Pasco, Polk and Hernando expose no usable PA permit records on the tested pages;
their adapters fail explicitly with a reason, never follow issuing-agency links.
Sarasota is skipped because the PA expressly disallows automated parcel access.

| County | PA URL inspected / existing source | Parcel permit section verified | Adapter returned records |
|---|---|---|---|
| Hillsborough | gis.hcpafl.org/CommonServices/property/search/ParcelData (existing exact-address/pin lookup) | Yes, existing verified integration | Yes, prior live check: pool permit |
| Pinellas | pcpao.gov/property-details (existing exact-address/strap lookup) | Yes, existing verified integration | Yes, prior live check: 2018 ROOF |
| Lee | https://www.leepa.org/Display/DisplayParcel.aspx?FolioID=10207619&PermitDetails=True | Yes | Yes: 2 records, 9793 Deerfoot Dr, Fort Myers; direct HTTP adapter, ~1.25 s |
| Manatee | https://www.manateepao.gov/parcel/?parid=2051711709 | Yes, Permits tab | Yes: 5 records, 7755 Pine Trace Dr, Sarasota; PA `pao-model-permits.php?parid=` request discovered from `showPermits()`, ~4.39 s |
| Pasco | https://search.pascopa.com/parcel.aspx?sec=26&twn=25&rng=20&sbb=0190&blk=01200&lot=0220&action=Submit | No records section on tested page; external permitting link only | No: 8743 Sanders Tree Loop, Wesley Chapel. Live adapter also failed strict parcel resolution, so it stopped before fetching the detail; separate read-only detail check found the external link only |
| Polk | https://www.polkflpa.gov/CamaDisplay.aspx?OutputMode=Display&SearchType=RealEstate&ParcelID=242820239230000032 | Yes, but only directions to issuing agency | No: 1515 New Jersey Oaks Ct, Lakeland. Old polkpa.org domain migration discovered with Firecrawl; current PA page has no records |
| Sarasota | https://www.sc-pa.com/robots.txt | Not inspected: access disallowed | Skipped: 1182 S Salford Blvd sample not scraped; rules disallow parcel/detail, Result and related paths |
| Hernando | https://propsearch.hernandocountypa-florida.us/parcel/1738622 | No on tested page | No: 3301 Northeast Pkwy, Brooksville; Firecrawl terms/address search resolved exact detail; no permits section |
| Collier | https://www.collierappraiser.com/Main_Search/ParcelDetail.html?FolioID=57647440005 | Yes, Detail tab | Yes: 6 dated records, 940 Montego Ct, Marco Island, ~9.87 s; undated seventh row excluded |

These checks did not use authenticated QuoteRush or bypass a CAPTCHA. No claim
is made that the tested absence of records proves absence for every parcel.

### Implementation and remaining source limitations

- Exact identity comes from existing county parcel resolution; address mismatch
  or ambiguity prevents fetching permit records. Collier's rendered FolioID must
  match the independently resolved parcel. Raw records also have a per-parcel
  30-day cache; concurrent callers share a request. Supporting evidence continues
  to persist through the existing property-characteristics cache.
- Collier uses Firecrawl **only on PA pages**, accepts I Agree, searches the
  supplied street, opens Detail and reads the permit table. It never requests PA
  data addresses. New parcel starts are spaced ten seconds, with at most two
  active sessions. Sessions are stopped in finally, including failed/CAPTCHA runs.
- New direct-source operations have an 18-second cap; Collier has a 50-second
  cap. The existing 75-second evidence / 80-second pre-import cap remains, with
  cancellation propagated. AI classification remains at most 20 seconds.
- Public permit descriptions alone enter the existing authenticated OpenRouter
  classifier. Source URLs, dates and permit numbers are not generated by AI.
  Its verbatim evidence validation and report-over-estimate priority are retained.
  Live checks above verified PA records, **not authenticated live AI classification**;
  classification mappings are fixture-tested.
- Lee explicitly says its displayed date is when the PA **received** the record.
  Store that qualification and do not use it to prove a reroof issue-date cutoff.
- Missing issue dates are never replaced by completion dates. Generic `ROOF`
  descriptions do not prove a replacement or SWR. No portal, CAPTCHA, robots or
  source-policy bypass was used.
- No migration is needed. Existing private report migration remains unapplied.
- Four counties remain unavailable under the PA-only restriction for the reasons
  above; this is a source limitation, not an assertion that they have no permits.

AI-classified explicit peel-and-stick/self-adhered underlayment/seam-tape evidence
now gives estimated SWR Yes with PA permit number, verbatim quote and source URL.
The quote must occur in the source description. Real reports still override.
Garage-door-only records no longer trigger likely-all-opening suggestions or
establish an all-openings permit credit. Window/door/shutter/impact-opening
records still require the user's explicit all-openings confirmation.

The 80-second pre-import cap, PA cache, user confirmation, private-report storage
migration awaiting approval, and credit/privacy safeguards remain unchanged.

## November 17 permit/report/coastal round (supersedes the November 16 limitations below)

### Implemented behavior

- Firecrawl search + scrape and bounded public-browser fallback are configured for
  HillsGovHub, Tampa, Pasco/Polk/Pinellas/Manatee/Sarasota/Lee Accela,
  St. Petersburg Click2Gov, Hernando/Cape Coral/Fort Myers/Marco Island EnerGov.
  HCPA and PCPAO parcel-permit adapters remain primary independent sources.
  Collier CityView is excluded. CAPTCHA/access-denied pages stop the adapter;
  no login, CAPTCHA solving, stealth proxies or bulk harvesting.
- Browser fallback only submits a visible address/search field. Multi-field
  forms without that supported control remain unavailable; this is not a claim
  that every jurisdiction's portal is operational.
- Model extraction is server-side OpenRouter, with untrusted-content instructions,
  schema checks and exact source matching. Permit identity, full property address,
  number, date and verbatim quote must appear in source text. Classification uses
  an existing record index, never model-created IDs/URLs. Broad `roof` matching
  no longer confers re-roof credit. Missing AI/config/evidence gives no credit.
  Classification records openings, garage doors, explicit re-roof, roof details
  (including explicit SWR materials), and other work.
- Authenticated AI is charged through existing per-user/global admission controls.
  Guests can read cached evidence/appraiser facts; uncached AI work requires the
  authenticated live-quote flow. Supporting evidence stays in the existing
  address-bound parcel profile cache, not a new table. Success TTL 30 days;
  unavailable results have short TTL. Per-process portal concurrency is two,
  with one-second admission spacing; provider requests and overall work are capped.
- qr-start waits up to 80 seconds; supporting evidence has a 75-second cap.
  This runs **before the import job is enqueued/claimed**, not inside its lease.
  The existing 20-second claimed_at heartbeat remains on the durable worker.
  Timed-out enrichment returns no permit/coastal credits; existing user/report
  evidence and separately labeled year-based rules remain unchanged.
- UI displays “Checking county permits and records…”. Opening-permit clues
  preselect likely-all only when untouched, never the explicit confirmation.
  A user must confirm all openings before any opening credit is used.
- Deck C is now limited to **pre-2002** homes with a classified re-roof permit
  after 2007-10-01. Homes built 2002+ remain B maximum without an actual report.
- Permit UA identifies `Havo/1.0` (not HavoPropertyTax); the direct
  appraiser adapters retain the existing Mozilla-compatible wrapper required
  by the PCPAO firewall.

### Private report uploads — migration awaiting approval

New migration, **written but NOT applied**:
`supabase/migrations/2026_11_17_private_wind_reports.sql`.
It creates the private `private-wind-reports` Supabase Storage bucket (8 MiB;
PDF/PNG/JPEG) and a restrictive storage-object policy denying direct anon and
authenticated client access to this bucket. It creates no application table.

The authenticated server stores objects under verified-user-UUID/random-UUID,
checks bucket privacy before upload, validates file signatures/type/size, and
streams downloads only from the current user's prefix. No public or signed
download URLs are returned. Responses are private/no-store. Upload IDs are checked
for owner access again at qr-start. Files never enter shared property evidence.
Until the migration is approved/applied, upload fails closed with manual entry
available. No live upload or storage provisioning was performed in this round.

OpenRouter uses the existing approved document model/provider policy with native
PDF or image input. Extraction is an editable **unconfirmed draft**: inspection
date, inspector, year built, roof covering, deck A/B/C/D, roof-to-wall, geometry,
SWR, opening code. Missing/illegible fields remain null/Unknown. The user must
explicitly confirm; editing a value clears confirmation. Saved files remain
available privately if AI extraction fails. Manual transcription still works.
Coverage A, flood, ProtectionClass and BCEG are never inferred.

### Coastal evidence and its limits

CCCL distance uses the requested FDEP line layer. Landward/island decisions use
FDEP's published **Florida Coastal Building Zone** polygon layer:
https://services1.arcgis.com/nRHtyn3uE1kyzoYc/ArcGIS/rest/services/Florida_Coastal_Building_Zone/FeatureServer/0

Its metadata explicitly describes 1,500 feet landward for mainland and 5,000 feet
landward or the entire narrower island for barrier islands; it supplies
DEFINITION_SOURCE_TYPE and island name. Point-in-polygon avoids inventing an
ocean-side bearing or classifying islands from street/city names.
Inside matching Standard/Barrier Island polygons => estimated inside; an
error-free empty result => outside; errors, unknown types, county mismatch or
truncation => Unknown. The requested no-CCCL county exclusions remain unchanged.
For 1987–1995 homes, inside supplies estimated Clips, never wraps.

**Important:** FDEP describes these polygons as approximate/illustrative, not
authoritative regulatory boundaries. This is a statutory-zone estimate, not proof
of a parcel's exact 1986 historical boundary; that remains unverified. Source and
this limitation are stored in evidence/lead notes. Do not call it a survey.
Read-only checks in this round: Marco Gulf-side coordinate (25.92712,-81.72891)
was inside a Barrier Island polygon, about 90.65 ft from CCCL; inland Naples
(26.18,-81.75) was outside. Fixture tests exercise those response shapes and errors.

### Exact QuoteRush importer fields and verification boundary

Reference: public **Add Lead** JSON importer example:
https://api-docs.quoterush.com/api/collections/9908457/2sAYX6pMfX?segregateAuth=true&versionTag=latest

This documents examples, **not a complete enum contract**. No authenticated
QuoteRush request was made to validate additional enum values in this round.

| Field sent under HO | Values Havo sends / origin | Documentation evidence |
|---|---|---|
| RoofWallConnection | Clips from year/coastal estimates; Toe Nails/Clips/Single Wraps/Double Wraps from confirmed report; Unknown omitted | Key and `Single Wraps` in Add Lead example. **UNVERIFIED enum values:** Toe Nails, Clips, Double Wraps |
| RoofDeckAttachment | `Level B` or `Level C` estimated; `Level A/B/C/D` from confirmed report; Unknown omitted | Key and `Level A` in example. **UNVERIFIED enum values:** Level B/C/D |
| SecondaryWaterResistance | `Yes` from requested roof-year/user-confirmation rule or report; otherwise `No` meaning no credit | Key and `No` in example. `Yes` is **UNVERIFIED** against the public enum contract |
| OpeningProtection | `Hurricane Protection` for evidence code A/B; otherwise `None` / no credit. Estimate B requires permit + explicit all-openings confirmation. Exact OIR code retained in notes | Key and `Hurricane Protection` in example. `None` is **UNVERIFIED**; no claim that API distinguishes OIR A from B |
| WindMitigationInspectionDate | Actual confirmed report date, MM/DD/YYYY; omitted without report | Key and `02/29/2020` in example |
| HaveWindMitForm | Boolean true only with attested real report (typed or uploaded/confirmed); false otherwise | Key and boolean true in example; false complements it, not an assertion that estimated answers are report-backed |

QuoteRush support still needs to confirm the unlisted enum options and whether
wind credits are honored when HaveWindMitForm is false. Carrier acceptance is
not established by mocked payload tests. CreditPermission remains No and
AssumedCreditScore remains Excellent.

### Portal verification boundary

HCPA returned pool permit BLD-20-0475137 (2020-06-12). PCPAO returned permit
18-02000050 (2018-02-01), description `ROOF`, in this round. A bare Havo UA
was rejected by its firewall, so the direct adapter retains the Mozilla-compatible
wrapper with the generic Havo product token; that recheck succeeded. Generic
`ROOF` is retained as evidence but is **not** sufficient to grant re-roof C.
Firecrawl indexed searches for the Tampa, St. Petersburg and Marco sample
properties returned no verified records. Public browser fallback is implemented
and session cleanup is tested, but do not describe any additional portal as a
working permit source until a real matched permit is returned. Other configured
portals remain unverified. A portal's failure never becomes evidence of no permits.
The browser-enabled recheck returned unavailable for HillsGovHub and Marco;
Tampa, Pinellas Accela and St. Petersburg returned no verified records.

Workspace and production secret-existence checks: FIRECRAWL_API_KEY **yes**;
OPENROUTER_API_KEY **yes**. No secret values inspected or changed.

## November 16 evidence and worker-safety update (supersedes older wind notes)

- Incomplete optional previous addresses are omitted on both client and server.
  They never reject a quote; the existing agent-completion note remains.
- Quote-path AI enrichment has a 20-second overall optional budget and an abortable
  provider request. Timeouts continue without AI. Worker claimed_at refreshes every
  20 seconds; the sweeper uses the observed timestamp and generation as a compare-
  and-set condition before quarantining a stale job. Ambiguous imports are never retried.
- ProtectionClass and BCEG are no longer AI fields, including cached AI reuse.
  Coverage A and flood remain never-AI. Single Entry requires an explicit gated answer.
- The report-first form supports **manual transcription from a real report** (the
  permitted alternative to upload): reference, inspection date, all six answers,
  and explicit unchecked attestation. Invalid report drafts block live submission;
  selecting no report discards report values at the server boundary.
  This is user transcription, not professional verification. No PDF extraction or
  file upload was added. Report values override estimates and alone enable
  HaveWindMitForm; a standalone legacy windMitForm boolean does not.
- User-confirmed Gable and uncertain/default Gable have distinct evidence. Hip is
  used only from an explicit answer or a transcribed report. Every resolved value
  is displayed with its estimated/confirmed status and source and saved with the
  quote provenance and lead notes. Report-bearing quote identities are owner-bound.

### Standards implemented

These are Christian's requested **preliminary estimation rules**, not assertions
that a particular home complies with OIR-B1-1802. Carriers/inspectors verify credits.

| Evidence | Preliminary result without report |
|---|---|
| Built 2003+ in any county | Roof-to-wall Clips maximum |
| Pinellas, Manatee, Sarasota, Lee, Collier built 1996+ | Clips maximum |
| Hillsborough, Pasco, Hernando, Polk built 1997+ | Clips maximum |
| Built 1987–1995 and verified inside coastal building zone | Clips maximum |
| Older / uncertain coastal evidence | Unknown, no connection credit |
| Re-roof/roof permit after October 1, 2007 | Deck C, estimated |
| No qualifying permit; built 2002+ original roof or newer user roof year | Deck B maximum, estimated |
| Pre-2002 original roof | Unknown |
| Roof year 2021+ | SWR Yes, estimated from user roof year |
| Roof year 2008–2020 | Yes only when user confirms peel-and-stick/seam tape |
| Otherwise | SWR Unknown, no credit |
| All openings confirmed, plus opening-protection permit | Opening B, estimated |
| All openings claimed, no permit | N, unverified; no protection credit sent |
| Partial/unsure | X/Unknown; permit number in notes |

County connection cutoffs live in shared/wind-mitigation.ts. Estimated connections
never become Single/Double Wraps. Opening protection never derives from building age.
Permit roof year is click-to-confirm, not silently substituted.

### Coastal geography: conservative limitation

FDEP public layer inspected November 16:
https://ca.dep.state.fl.us/arcgis/rest/services/OpenData/COASTAL_ENV_PERM/MapServer/2

It is a **polyline CCCL layer**, not a 1986 Coastal Building Zone polygon and not a
barrier-island/landward classifier. The implementation queries on-demand around
coordinates, computes nearest-line distance in feet, and stores source and distance.
The classifier supports verified mainland 1,500-ft and barrier-island 5,000-ft
landward thresholds (and verified whole narrow islands), but **no authoritative
landward/barrier-island classification has been integrated**. Live ambiguous
classifications therefore remain Unknown and cannot grant Clips for older homes.
Hillsborough/Pasco/Hernando/Polk follow the requested no-CCCL exclusion; no unverified
FEMA V-zone exception is invented. Tests cover inside/outside using explicit
geography fixtures, unavailable geometry and uncertain geography.

### Permit adapters: actually verified

| Adapter | Live read-only result, November 16 | Scope |
|---|---|---|
| HCPA ParcelData permitInfo | Nassau sample returned one pool permit, June 12, 2020; no invented roof/opening permit | Hillsborough appraiser records, including City of Tampa |
| PCPAO property-details tblPermit | St. Petersburg sample returned roof permit 18-02000050, February 1, 2018 | Pinellas appraiser records |

Both adapter functions were run end-to-end with public HTTP and no paid service.
PCPAO requires the identifying Havo User-Agent; its identity lookup uses the existing
strict matching resolver. The permit page's own address is checked again.
HCPA matches an exact normalized street and city before reading ParcelData.
There is a shared one-second admission pace, short network cap, bounded queue,
in-flight deduplication, and cached successes/failures. Supporting property evidence
is retained in existing property-characteristics field sources; no new table needed.
The UI checks asynchronously; live quotes use only immediately available supporting
evidence and never wait for portal completion.

No direct Accela, Click2Gov or EnerGov portal adapters are claimed as working.
The two appraiser adapters are the requested initial easier alternatives. Other
counties return unsupported rather than invented records. Collier CityView is
explicitly skipped due to CAPTCHA. No CAPTCHA or access restriction is bypassed.

### QuoteRush mapping

Public importer example inspected without calling the authenticated API:
https://api-docs.quoterush.com/api/collections/9908457/2sAYX6pMfX?segregateAuth=true&versionTag=latest

| Evidence | Import key |
|---|---|
| Connection | HO.RoofWallConnection, unknown omitted |
| Deck letter | HO.RoofDeckAttachment, Level A/B/C; unknown omitted |
| SWR | HO.SecondaryWaterResistance Yes; unknown sends No/no credit |
| Opening A/B | HO.OpeningProtection Hurricane Protection; other codes None/no credit; exact evidence code retained in notes |
| Shape | HO.RoofShape |
| Actual report available | HO.HaveWindMitForm and HO.WindMitigationInspectionDate |

The public example confirms these keys and example values, but is not a complete
enum catalogue. Exact carrier acceptance of Level B/C, Clips and desktop/report
options remains unverified without a separately approved live test. Do not claim
that OIR codes are the provider's enum strings; notes retain exact source codes.
No live QuoteRush or OpenRouter calls were made for this update. Credit stays
No/Excellent. Consent and attribution are unchanged. **No migrations are needed
or applied.**

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
Our earlier submission returned 403; the separately approved November 16 main-code
test subsequently imported successfully, discovered 20 carriers, submitted with HTTP
200 and returned a positive premium. These new wind fields have not been live-tested.
Please confirm Agency/EndpointKey, host and Submitter authorization requirements. Does SubmitQuoteRequest
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
