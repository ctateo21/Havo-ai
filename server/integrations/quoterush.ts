// QuoteRUSH live carrier quoting integration.
//
// Flow: enrich property data → import lead → extract LeadId →
// submit quote request (triggers QuoteBot) → poll GetQuotes.
//
// Credentials come from process.env only. The saved Replit secrets
// are QUOTERUSH_WEBID / QUOTERUSH_WEBID_PASSWORD /
// QUOTERUSH_ENDPOINT_KEY / QUOTERUSH_AGENCY_ID; the spec's shorter
// aliases (QUOTERUSH_WEBPASSWORD / QUOTERUSH_AGENCY) are accepted as
// fallbacks so either naming works.
//
// GetPropertyData's complete successful response is retained server-side by
// the quote route for mapping review. Do not log it: it is not public data.

import type { QuoteRushPropertyDefaults } from "@shared/quoterush-property-defaults";

export interface QuoteRushParams {
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
  county: string;
  coverageA: number;
  policyType: string;
  yearBuilt: number;
  roofYear: number;
  constructionType: string;
  masonryConstruction: string;
  frameConstruction: string;
  hurrDeductible: string;
  aopDeductible: string;
  priorClaims: number;
  claimRecords: QuoteRushClaimRecord[];
  floodZone: string;
  sqFt: number;
  windMitForm: boolean;
  openingProtection: string;
  secondaryWaterResistance: string;
  roofShape: string;
  usageType: string;
  rentalTerm: QuoteRushPropertyDefaults["rentalTerm"];
  monthsOccupied: QuoteRushPropertyDefaults["monthsOccupied"];
  newPurchase: string;
  purchaseDate?: string;
  purchasePrice: number;
  policyEffectiveDate: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  email: string;
  phone: string;
  creditPermissionGranted: boolean;
  hasMortgage?: boolean;
  currentlyInsured?: boolean;
  currentCarrier?: string;
  milesToCoast?: number;
}

export interface QuoteRushClaimRecord {
  lossDate: string;
  /** The applicant's description of the loss type or cause. */
  claimDetail: string;
  amount: number;
  priorResidence: boolean;
  paid: boolean;
}

export interface QuoteRushQuote {
  returnedCoverageA?:number|null;
  siteName: string;
  annualPremium: number;
  monthlyPremium: number;
  coverageA: number;
  hurricaneDeductible: string;
  aop: string;
  quoteUrl: string | null;
  quoteMessage: string;
  quoteDate: string;
  rank: number;
}

export interface QuoteRushResult {
  status: "success" | "pending" | "error";
  quotes: QuoteRushQuote[];
  leadId: number;
  quoteCounter: number;
  errorMessage?: string;
}

function getWebId(): string {
  return process.env.QUOTERUSH_WEBID ?? "";
}
function getWebPassword(): string {
  return process.env.QUOTERUSH_WEBID_PASSWORD ?? process.env.QUOTERUSH_WEBPASSWORD ?? "";
}
function getEndpointKey(): string {
  return process.env.QUOTERUSH_ENDPOINT_KEY ?? "";
}
function getAgency(): string {
  return process.env.QUOTERUSH_AGENCY_ID ?? process.env.QUOTERUSH_AGENCY ?? "";
}

import { inspectImporterResponse } from "./quoterush-import-response";
export { parseLeadId } from "./quoterush-import-response";

function formatDateOfBirth(dateOfBirth: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  return match
    ? `${match[2]}/${match[3]}/${match[1]}`
    : dateOfBirth;
}
export function buildImporterPayload(
  p: QuoteRushParams,
  assignedEmail: string
): Record<string, any> {
  if (
    !Number.isInteger(p.priorClaims) ||
    p.priorClaims < 0 ||
    p.priorClaims > 3 ||
    p.claimRecords.length !== p.priorClaims
  ) {
    throw new Error(
      "Prior claim details must be confirmed before submitting to QuoteRUSH.",
    );
  }
  const formTypeMap: Record<string, string> = {
    HO3: "HO-3: Home Owners Policy",
    HO6: "HO-6: Condo Unit Owners Policy",
    DP3: "DP-3: Dwelling Fire Policy",
  };
  const formType =
    formTypeMap[p.policyType] ||
    "HO-3: Home Owners Policy";
  const payload: Record<string, any> = {
    Client: {
      NameFirst: p.firstName || "Havo",
      NameLast: p.lastName || "Lead",
      DateOfBirth: formatDateOfBirth(p.dateOfBirth),
      PhoneNumber: p.phone || "",
      PhoneCell: p.phone || "",
      PhoneOther: "",
      EmailAddress: p.email || "",
      EntityType: "Individual",
      Gender: "Male",
      MaritalStatus: "Single",
      Industry: "Business/Sales/Office",
      Occupation: "Account Executive",
      EPolicy: true,
      Address: p.streetAddress,
      City: p.city,
      State: p.state || "FL",
      Zip: p.zip,
      County: p.county || "",
      International: false,
      AssumedCreditScore: "Excellent",
      CreditPermission: "No",
      Assigned: assignedEmail,
      LeadSource: "Havo Platform",
      LeadStatus: "New Lead",
      Lob_Home: true,
      Lob_Auto: false,
      // FEMA flood-zone enrichment is property context only. A separate
      // flood quote must be explicitly requested and is never synthesized.
      Lob_Flood: false,
    },
    HO: {
      FormType: formType,
      Address: p.streetAddress,
      City: p.city,
      State: p.state || "FL",
      Zip: p.zip,
      County: p.county || "",
      NewPurchase: p.newPurchase || "No",
      ...(p.purchaseDate ? { PurchaseDate: formatDateOfBirth(p.purchaseDate) } : {}),
      PurchasePrice: String(Math.round(p.purchasePrice)),
      UsageType: p.usageType || "Primary",
      MonthsOwnerOccupied: p.monthsOccupied,
      ...(p.rentalTerm ? { RentalTerm: p.rentalTerm } : {}),
      YearBuilt: String(p.yearBuilt),
       PolicyEffectiveDate: formatDateOfBirth(p.policyEffectiveDate),
      // Do not fabricate a square-footage value. Carrier data is only useful
      // when it is supplied by the user or a verified property source.
      ...(p.sqFt > 0 ? { SquareFeet: String(Math.round(p.sqFt)) } : {}),
      ConstructionType: p.constructionType ||
        "Masonry",
      Construction:
        p.constructionType === "Mixed"
          ? p.masonryConstruction || "Mixed"
          : p.masonryConstruction ||
            p.constructionType ||
            "Concrete Block",
      // Do not send exterior-finish labels (for example Stucco) as a
      // structural framing subtype.
      MasonryConstruction:
        p.masonryConstruction || "",
      FoundationType: "Slab",
      RoofShape: p.roofShape || "Gable",
      RoofMaterial: "Composite Shingle",
      UpdateRoofYear: String(p.roofYear),
      UpdateRoofType: "Full",
      CoverageA: String(p.coverageA),
      ...(p.policyType === "HO6"
        ? {}
        : {
            CoverageB: String(Math.round(p.coverageA * 0.02)),
            CoverageBPercent: "2%",
          }),
      CoverageC: String(Math.round(p.coverageA * 0.25)),
      CoverageCPercent: "25%",
      CoverageD: String(Math.round(p.coverageA * 0.10)),
      CoverageDPercent: "10%",
      CoverageE: "$300,000",
      CoverageF: p.policyType === "HO6" ? "$2,000" : "$5,000",
      AllOtherPerilsDeductible: p.aopDeductible,
      HurricaneDeductible: p.hurrDeductible,
      WindHailDeductible: p.hurrDeductible,
      ...(p.floodZone ? { FloodZone: p.floodZone } : {}),
      ...(p.milesToCoast != null
        ? { MilesToCoast: p.milesToCoast.toFixed(2) }
        : {}),
      FloodPolicy: false,
       ...(p.newPurchase === "Yes"
         ? {
             // Required preliminary new-purchase Apply Defaults assumptions.
             CurrentlyInsured: "Yes", CurrentCarrier: "New Purchase",
             CurrentPolicyNumber: "New Purchase", AnyLapses: "No",
           }
         : {
             ...(p.currentlyInsured !== undefined
               ? { CurrentlyInsured: p.currentlyInsured ? "Yes" : "No" }
               : {}),
             ...(p.currentlyInsured && p.currentCarrier
               ? { CurrentCarrier: p.currentCarrier }
               : {}),
             // Lapse and policy details are omitted for existing homes until verified.
           }),
      Claims: p.priorClaims > 0 ? "Yes" : "No",
      HaveWindMitForm: p.windMitForm,
      OpeningProtection: p.openingProtection,
      SecondaryWaterResistance:
        p.secondaryWaterResistance,
      Terrain: "Exposure B",
      BurglarAlarm: "None",
      FireAlarm: "None",
      FireHydrant: "Within 1000 Feet",
      FireStation: "Within 5 Miles",
      ...(typeof p.hasMortgage === "boolean"
        ? { Mortgage: p.hasMortgage ? "Yes" : "No" }
        : {}),
      EPolicy: true,
      WaterBackup: true,
      WaterBackupAmount: "$10,000",
      RoofLossSettlement: "Replacement Cost",
      PersonalInjuryCoverage: true,
      IdentityTheft: true,
      IncreaseReplacementCostOnDwelling: true,
    },
  };
  if (p.claimRecords.length > 0) {
    payload.Claims = p.claimRecords.map((claim) => ({
      ClaimDetail: claim.claimDetail,
      Date: formatDateOfBirth(claim.lossDate),
      Amount: String(Math.round(claim.amount)),
      PriorResidence: claim.priorResidence,
      Paid: claim.paid,
    }));
  }

  return payload;
}

export interface QuoteRushPropertyDataResult {
  sqFt: number;
  yearBuilt: number;
  constructionType: string;
  masonryConstruction: string;
  /**
   * Complete successful provider JSON, for server-side persistence only.
   * Unknown provider fields are intentionally retained and may contain
   * sensitive or personal data. Never log or expose this payload publicly.
   */
  raw: Record<string, unknown>;
}

export async function getPropertyData(
  streetAddress: string,
  city: string,
  state: string,
  zip: string
): Promise<QuoteRushPropertyDataResult | null> {
  const ENDPOINT_KEY = getEndpointKey();
  const AGENCY = getAgency();

  try {
    const res = await fetch(
      "https://api.quoterush.com/GetPropertyData",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          EndpointKey: ENDPOINT_KEY,
          Agency: AGENCY,
          AddressLine1: streetAddress,
          AddressLine2: "",
          City: city,
          State: state,
          Zip: zip,
        }),
      }
    );
    const text = await res.text();
    if (!res.ok) return null;
    const json: unknown = JSON.parse(text);
    // JSONB requires a JSON object. Do not truncate a normal provider payload:
    // if QuoteRUSH changes to a non-object response, retain no "raw" value.
    if (!json || Array.isArray(json) || typeof json !== "object") return null;
    const raw = json as Record<string, unknown>;
    return {
      sqFt: parseInt(
        String(
          raw.SquareFeet ?? raw.sqFt ??
          raw.square_feet ?? 0
        ),
        10
      ),
      yearBuilt: parseInt(
        String(
          raw.YearBuilt ?? raw.yearBuilt ?? 0
        ),
        10
      ),
      constructionType:
        String(raw.ConstructionType ??
        raw.constructionType ?? ""),
      masonryConstruction:
        String(raw.MasonryConstruction ??
        raw.masonry ?? ""),
      raw,
    };
  } catch (e) {
    console.error(
      "[quoterush] GetPropertyData error:", e
    );
    return null;
  }
}

export async function importAndSubmit(
  params: QuoteRushParams,
  hooks:{callbackUrl?:string;onLeadCreated?:(id:number)=>Promise<void>;onCarriers?:(count:number|null,warning?:string)=>Promise<void>}={}
): Promise<{
  leadId: number;
  submitted: boolean;
  error?: string;
  /** Available after a successful GetPropertyData call even on later failure. */
  rawPropertyData?: Record<string, unknown>;
}> {
  const WEBID = getWebId();
  const WEBPASSWORD = getWebPassword();
  const ENDPOINT_KEY = getEndpointKey();
  const AGENCY = getAgency();
  const ASSIGNED_EMAIL =
    process.env.QUOTERUSH_ASSIGNED_EMAIL ??
    "christian@tateoco.com";

  if (!WEBID || !WEBPASSWORD ||
      !ENDPOINT_KEY || !AGENCY) {
    return {
      leadId: 0,
      submitted: false,
      error: "QuoteRUSH env vars not set",
    };
  }

  // Step A: Enrich with real property data
  const propData = await getPropertyData(
    params.streetAddress,
    params.city,
    params.state,
    params.zip
  );
  const rawPropertyData = propData?.raw;
  if (propData) {
    console.log(
      "[quoterush] property data enrichment:",
      {
        sqFt: propData.sqFt,
        yearBuilt: propData.yearBuilt,
        constructionType: propData.constructionType,
        masonryConstruction: propData.masonryConstruction,
      },
    );
    if (params.sqFt <= 0 && propData.sqFt > 0)
      params.sqFt = propData.sqFt;
    // Preserve the user's explicit building year and construction answer.
    // Enrichment remains useful for square footage when it was not supplied,
    // but must not replace the property details used to price this quote.
  }

  // Step B: Import lead
  console.log("[quoterush] importing lead");
  const importPayload = buildImporterPayload(
    params, ASSIGNED_EMAIL
  );
  let importRes: Response;
  let importText: string;
  try {
    importRes = await fetch(
      `https://importer.quoterush.com/Json/Import/${WEBID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webpassword": WEBPASSWORD,
        },
        body: JSON.stringify(importPayload),
        signal: AbortSignal.timeout(30000),
      }
    );
    importText = await importRes.text();
  } catch {
    console.error("[quoterush] importer response could not be read");
    return {
      leadId: 0,
      submitted: false,
      error: "QuoteRUSH importer response could not be read",
      ...(rawPropertyData ? { rawPropertyData } : {}),
    };
  }
  console.log("[quoterush] import completed:", importRes.status);
  const inspection = inspectImporterResponse(importText, importRes.headers.get("content-type"), [
    WEBID, WEBPASSWORD, ENDPOINT_KEY, AGENCY, ASSIGNED_EMAIL,
    params.firstName, params.lastName, params.email, params.phone, params.dateOfBirth,
    formatDateOfBirth(params.dateOfBirth), params.streetAddress, params.city, params.zip,
    hooks.callbackUrl ?? "",
  ]);
  console.log("[quoterush] importer diagnostics", inspection.diagnostics);

  if (!importRes.ok || inspection.rejected) {
    if (inspection.leadId) await hooks.onLeadCreated?.(inspection.leadId);
    return {
      leadId: inspection.leadId ?? 0,
      submitted: false,
      error: `Import failed (${importRes.status})${inspection.leadId ? `; LeadId ${inspection.leadId}` : ""}: ${inspection.error}`,
        ...(rawPropertyData ? { rawPropertyData } : {}),
    };
  }

  // Step C: Extract LeadId
  const leadId = inspection.leadId;

  if (!leadId || leadId <= 0) {
    // HTTP success is not business success. Do not log the raw response:
    // the provider may echo credentials or applicant data.
    console.warn("[quoterush] importer did not return a verified LeadId",{httpStatus:importRes.status,code:"IMPORT_LEAD_ID_MISSING"});
    return {
      leadId: 0,
      submitted: false,
      error: "Could not extract LeadId",
      ...(rawPropertyData ? { rawPropertyData } : {}),
    };
  }
  console.log("[quoterush] LeadId:", leadId);
  await hooks.onLeadCreated?.(leadId);

  // Step D: Submit quote request (triggers QuoteBot)
  let carriers:unknown[]|undefined;
  try{
    const r=await fetch("https://api.quoterush.com/GetQuotableSitesForLead",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({EndpointKey:ENDPOINT_KEY,Agency:AGENCY,LeadId:leadId,LOB:"Home"}),
      signal:AbortSignal.timeout(10000),
    });
    if(!r.ok)throw Error("Carrier discovery failed");
    const result=await r.json();
    if(!Array.isArray(result.Sites)||!result.Sites.length)throw Error("No carrier list");
    carriers=result.Sites;
  }catch{console.warn("[quoterush] Carrier discovery unavailable; submitting without Carriers");}
  await hooks.onCarriers?.(carriers?.length??null,carriers?undefined:"Carrier discovery unavailable; submitted without a carrier list.");
  let submitRes: Response;
  let submitText: string;
  try {
    submitRes = await fetch(
      "https://api.quoterush.com/SubmitQuoteRequest",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          EndpointKey: ENDPOINT_KEY,
          Agency: AGENCY,
          LeadId: leadId,
          LOB: "Home",
          Submitter: ASSIGNED_EMAIL,
          ...(carriers?{Carriers:carriers}:{}),
          ...(hooks.callbackUrl?{callbackUrl:hooks.callbackUrl}:{}),
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    submitText = await submitRes.text();
  } catch (error) {
    console.error(
      "[quoterush] SubmitQuoteRequest status could not be confirmed",
    );
    return {
      leadId,
      submitted: false,
      error: "Quote submission status could not be confirmed",
      ...(rawPropertyData ? { rawPropertyData } : {}),
    };
  }
  console.log(
    "[quoterush] SubmitQuoteRequest status:", submitRes.status
  );

  return {
    leadId,
    submitted: submitRes.ok,
    error: submitRes.ok ? undefined : `Quote submission failed (${submitRes.status})`,
    ...(rawPropertyData ? { rawPropertyData } : {}),
  };
}

export async function getQuotes(
  leadId: number
): Promise<QuoteRushResult> {
  const ENDPOINT_KEY = getEndpointKey();
  const AGENCY = getAgency();

  try {
    const res = await fetch(
      "https://api.quoterush.com/GetQuotes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          EndpointKey: ENDPOINT_KEY,
          Agency: AGENCY,
          LeadId: leadId,
          LOB: "Home",
        }),
      }
    );
    const text = await res.text();

    if (!res.ok) {
      return {
        status: "error",
        quotes: [],
        leadId,
        quoteCounter: 0,
        errorMessage: `GetQuotes failed (${res.status})`,
      };
    }

    const json = JSON.parse(text);
    const parsed=parseQuoteRushResponse(json,leadId);
    console.log("[quoterush] GetQuotes counts:",parsed.quoteCounter,parsed.quotes.length);
    return parsed;
  } catch {
    return {status:"error",quotes:[],leadId,quoteCounter:0,errorMessage:"QuoteRUSH results unavailable"};
  }
}

export function parseQuoteRushResponse(json:any,leadId:number):QuoteRushResult {
    const rawQuotes: any[] = json.Quotes ?? [];
    const quoteCounter = Number.isSafeInteger(Number(json.QuoteCounter)) && Number(json.QuoteCounter)>=0 ? Number(json.QuoteCounter):0;

    if (quoteCounter === 0) {
      return {
        status: "pending",
        quotes: [],
        leadId,
        quoteCounter: 0,
      };
    }

    const quotes: QuoteRushQuote[] = rawQuotes
      .filter(
        (q: any) =>
          q.Premium &&
          parseFloat(String(q.Premium)) > 0
      )
      .map((q: any) => {
        const annual = parseFloat(
          String(q.Premium ?? "0")
        );
        return {
          siteName: String(
            q.SiteName ?? "Unknown Carrier"
          ),
          annualPremium: Math.round(annual*100)/100,
          monthlyPremium: Math.round(annual/12*100)/100,
          coverageA: parseInt(
            String(q.CoverageA ?? "0"), 10
          ),
          returnedCoverageA:Number(q.CoverageA)>0&&Number.isFinite(Number(q.CoverageA))?Number(q.CoverageA):null,
          hurricaneDeductible: String(
            q.HurricaneDeductible ?? ""
          ),
          aop: String(q.AOP ?? ""),
          quoteUrl: q.QuoteURL ?? null,
          quoteMessage: "", // Provider free text can contain private applicant data.
          quoteDate: String(q.QuoteDate ?? ""),
          rank: 0,
        };
      })
      .sort(
        (a: QuoteRushQuote, b: QuoteRushQuote) =>
          a.annualPremium - b.annualPremium
      )
      .slice(0, 3)
      .map(
        (q: QuoteRushQuote, i: number) => ({
          ...q, rank: i + 1,
        })
      );

    return {
      status: "success",
      quotes,
      leadId,
      quoteCounter,
    };
}
