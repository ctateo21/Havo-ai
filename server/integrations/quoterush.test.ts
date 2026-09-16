import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildImporterPayload,
  getQuotes,
  importAndSubmit,
  type QuoteRushParams,
} from "./quoterush";
import { resolveQuoteRushPropertyInputs } from "./quoterush-inputs";
import { claimQuoteRushAddress } from "./quoterush-cache-claim";
import {
  prepareQuoteRushStartRequest,
  toQuoteCachePolicyEffectiveDate,
} from "./quoterush-start-request";
import { resolveQuoteRushPropertyDefaults } from "@shared/quoterush-property-defaults";
import { resolvePurchasePriceProvenance } from "@shared/purchase-price-provenance";

const params: QuoteRushParams = {
  streetAddress: "123 Palm Way",
  city: "Tampa",
  state: "FL",
  zip: "33602",
  county: "Hillsborough",
  coverageA: 425_000,
  policyType: "HO3",
  yearBuilt: 2007,
  roofYear: 2022,
  constructionType: "Mixed",
  masonryConstruction: "Concrete Block",
  frameConstruction: "Stucco",
  hurrDeductible: "5%",
  aopDeductible: "$1,000",
  priorClaims: 0,
  claimRecords: [],
  floodZone: "X",
  sqFt: 2_100,
  milesToCoast: 10.5,
  windMitForm: true,
  openingProtection: "Hurricane Protection",
  secondaryWaterResistance: "Yes",
  roofShape: "Hip",
  usageType: "Primary",
  rentalTerm: "",
  monthsOccupied: "9 months or more",
  newPurchase: "No",
  purchaseDate: "08/31/2023",
  purchasePrice: 425_000,
  policyEffectiveDate: "09/30/2023",
  firstName: "Test",
  lastName: "Applicant",
  email: "test@example.com",
  phone: "5555555555",
  creditPermissionGranted: true,
};

test("importer payload retains exact property answers, mixed construction, and both deductibles", () => {
  const payload = buildImporterPayload(params, "agent@example.com");
  assert.deepEqual(
    {
      yearBuilt: payload.HO.YearBuilt,
      roofYear: payload.HO.UpdateRoofYear,
      openingProtection: payload.HO.OpeningProtection,
      roofShape: payload.HO.RoofShape,
      swr: payload.HO.SecondaryWaterResistance,
      constructionType: payload.HO.ConstructionType,
      construction: payload.HO.Construction,
      masonry: payload.HO.MasonryConstruction,
      frame: payload.HO.FrameConstruction,
      hurricane: payload.HO.HurricaneDeductible,
      windHail: payload.HO.WindHailDeductible,
      aop: payload.HO.AllOtherPerilsDeductible,
      usageType: payload.HO.UsageType,
      rentalTerm: payload.HO.RentalTerm,
      monthsOccupied: payload.HO.MonthsOccupied,
      newPurchase: payload.HO.NewPurchase,
      purchaseDate: payload.HO.PurchaseDate,
      purchasePrice: payload.HO.PurchasePrice,
      milesToCoast: payload.HO.MilesToCoast,
    },
    {
      yearBuilt: "2007",
      roofYear: "2022",
      openingProtection: "Hurricane Protection",
      roofShape: "Hip",
      swr: "Yes",
      constructionType: "Mixed",
      construction: "Concrete Block",
      masonry: "Concrete Block",
      frame: undefined,
      hurricane: "5%",
      windHail: "5%",
      aop: "$1,000",
      usageType: "Primary",
      rentalTerm: undefined,
      monthsOccupied: "9 months or more",
      newPurchase: "No",
      purchaseDate: "08/31/2023",
      purchasePrice: "425000",
      milesToCoast: "10.50",
    },
  );
});

test("six zero-cost policy payload sanity cases stay normalized", () => {
  const cases = [
    {
      name: "HO3 primary purchase",
      input: { policyType: "HO3", usageType: "Primary", newPurchase: "Yes", rentalTerm: "" },
      expected: { formType: "HO-3: Home Owners Policy", usageType: "Primary", newPurchase: "Yes", rentalTerm: undefined },
    },
    {
      name: "HO3 secondary",
      input: { policyType: "HO3", usageType: "Secondary", newPurchase: "No", rentalTerm: "" },
      expected: { formType: "HO-3: Home Owners Policy", usageType: "Secondary", newPurchase: "No", rentalTerm: undefined },
    },
    {
      name: "HO6 primary",
      input: { policyType: "HO6", usageType: "Primary", newPurchase: "No", rentalTerm: "" },
      expected: { formType: "HO-6: Condo Unit Owners Policy", usageType: "Primary", newPurchase: "No", rentalTerm: undefined },
    },
    {
      name: "HO6 investment",
      input: { policyType: "HO6", usageType: "Investment", newPurchase: "No", rentalTerm: "Monthly" },
      expected: { formType: "HO-6: Condo Unit Owners Policy", usageType: "Investment", newPurchase: "No", rentalTerm: "Monthly" },
    },
    {
      name: "DP3 annual",
      input: { policyType: "DP3", usageType: "Investment", newPurchase: "No", rentalTerm: "Annual" },
      expected: { formType: "DP-3: Dwelling Fire Policy", usageType: "Investment", newPurchase: "No", rentalTerm: "Annual" },
    },
    {
      name: "DP3 weekly",
      input: { policyType: "DP3", usageType: "Investment", newPurchase: "No", rentalTerm: "Weekly" },
      expected: { formType: "DP-3: Dwelling Fire Policy", usageType: "Investment", newPurchase: "No", rentalTerm: "Weekly" },
    },
  ] as const;

  for (const item of cases) {
    const payload = buildImporterPayload(
      { ...params, ...item.input },
      "agent@example.com",
    );
    assert.deepEqual(
      {
        formType: payload.HO.FormType,
        usageType: payload.HO.UsageType,
        newPurchase: payload.HO.NewPurchase,
        rentalTerm: payload.HO.RentalTerm,
      },
      item.expected,
      item.name,
    );
  }
});

test("importer always sends the agency-confirmed credit permission value", () => {
  assert.equal(
    buildImporterPayload(
      { ...params, creditPermissionGranted: true },
      "agent@example.com",
    ).Client.CreditPermission,
    "Yes",
  );
  assert.equal(
    buildImporterPayload(
      { ...params, creditPermissionGranted: false },
      "agent@example.com",
    ).Client.CreditPermission,
    "Yes",
  );
});

test("prior insurance uses only documented new-purchase assumptions and private existing answers", () => {
  const newPurchase = buildImporterPayload(
    { ...params, newPurchase: "Yes" },
    "agent@example.com",
  );
  assert.deepEqual(
    {
      insured: newPurchase.HO.CurrentlyInsured,
      carrier: newPurchase.HO.CurrentCarrier,
      policy: newPurchase.HO.CurrentPolicyNumber,
      lapses: newPurchase.HO.AnyLapses,
    },
    { insured: "Yes", carrier: "New Purchase", policy: "New Purchase", lapses: "No" },
  );
  const existing = buildImporterPayload(
    { ...params, newPurchase: "No", currentlyInsured: true, currentCarrier: "Acme Insurance" },
    "agent@example.com",
  );
  assert.equal(existing.HO.CurrentlyInsured, "Yes");
  assert.equal(existing.HO.CurrentCarrier, "Acme Insurance");
  assert.equal("CurrentPolicyNumber" in existing.HO, false);
  assert.equal("AnyLapses" in existing.HO, false);
  const uninsured = buildImporterPayload(
    { ...params, newPurchase: "No", currentlyInsured: false },
    "agent@example.com",
  );
  assert.equal(uninsured.HO.CurrentlyInsured, "No");
  assert.equal("CurrentCarrier" in uninsured.HO, false);
});

test("year-built wind assumptions are conservative and manual wind answers win", () => {
  const resolve = (yearBuilt: number) => resolveQuoteRushPropertyInputs({
    yearBuilt, constIdx: 0, windIdx: 1,
    windMitigationLocks: {},
    openingProtection: true,
    secondaryWaterResistance: "Yes",
  });
  assert.deepEqual(
    { opening: resolve(1999).openingProtection, swr: resolve(1999).secondaryWaterResistance, assumption: resolve(1999).windAssumption },
    { opening: "None", swr: "No", assumption: "conservative/no-credit" },
  );
  assert.deepEqual(
    { opening: resolve(2010).openingProtection, swr: resolve(2010).secondaryWaterResistance, assumption: resolve(2010).windAssumption },
    { opening: "None", swr: "No", assumption: "basic/clips where supported" },
  );
  assert.deepEqual(
    { opening: resolve(2020).openingProtection, swr: resolve(2020).secondaryWaterResistance },
    { opening: "Hurricane Protection", swr: "Yes" },
  );
  const manual = resolveQuoteRushPropertyInputs({
    yearBuilt: 2022, constIdx: 0, windIdx: 0,
    windMitigationLocks: { openingProtection: true, secondaryWaterResistance: true },
    openingProtection: false, secondaryWaterResistance: "No",
  });
  assert.equal(manual.openingProtection, "None");
  assert.equal(manual.secondaryWaterResistance, "No");
});

test("policy defaults keep purchase price separate and resolve all occupancy and rental rules", () => {
  const base = {
    rebuildCost: 425_000,
    newPurchase: true,
    policyEffectiveDate: "2026-09-30",
    purchasePrice: 610_000,
    purchasePriceSource: "havo-purchase-scenario" as const,
  };
  for (const [policyType, usageType] of [
    ["HO3", "primary"], ["HO3", "secondary"], ["HO6", "primary"],
    ["HO6", "secondary"], ["HO6", "investment"], ["DP3", "investment"],
  ] as const) {
    const result = resolveQuoteRushPropertyDefaults({
      ...base, policyType, usageType,
      ...(usageType === "investment" ? { rentalTerm: "annual" as const } : {}),
    });
    assert.equal(result.purchasePrice.value, 610_000);
    assert.equal(result.purchasePrice.source, "havo-purchase-scenario");
    assert.notEqual(result.purchasePrice.value, base.rebuildCost);
  }

  for (const [input, expected] of [
    ["annual", "Annual"],
    ["monthly", "Monthly"],
    ["weekly", "Weekly"],
  ] as const) {
    const resolved = resolveQuoteRushPropertyDefaults({
      ...base,
      policyType: "HO6",
      usageType: "investment",
      rentalTerm: input,
    });
    assert.equal(resolved.usageType, "Investment");
    assert.equal(resolved.rentalTerm, expected);
    assert.equal(resolved.purchasePrice.value, 610_000);
  }

  assert.deepEqual(
    resolveQuoteRushPropertyDefaults({
      ...base,
      policyType: "DP3",
      newPurchase: false,
      policyEffectiveDate: "2023-08-31",
      rentalTerm: "weekly",
    }),
    {
      usageType: "Investment",
       rentalTerm: "Weekly",
      monthsOccupied: "9 months or more",
      newPurchase: "No",
      purchaseDate: {
        value: null,
        source: "unknown",
      },
      purchasePrice: {
        value: 610_000,
        source: "havo-purchase-scenario",
         isAssumption: true,
      },
      policyEffectiveDate: {
        value: "08/31/2023",
        source: "user-requested",
        isAssumption: false,
      },
    },
  );
});

test("policy effective date preserves supplied source and marks transparent +30 fallback", () => {
  const supplied = resolveQuoteRushPropertyDefaults({
    policyType: "HO3",
    rebuildCost: 425_000,
    newPurchase: true,
    usageType: "primary",
    purchasePrice: 610_000,
    policyEffectiveDate: "2027-04-15",
    policyEffectiveDateSource: "closing-date",
  });
  assert.deepEqual(supplied.policyEffectiveDate, {
    value: "04/15/2027",
    source: "closing-date",
    isAssumption: false,
  });
  assert.deepEqual(supplied.purchaseDate, {
    value: null,
    source: "unknown",
  });

  const before = new Date();
  before.setDate(before.getDate() + 30);
  const fallback = resolveQuoteRushPropertyDefaults({
    policyType: "HO3",
    rebuildCost: 425_000,
    newPurchase: false,
    usageType: "secondary",
    purchasePrice: 610_000,
  });
  const after = new Date();
  after.setDate(after.getDate() + 30);
  const expectedDates = [before, after].map(date => {
    const [year, month, day] = date.toISOString().slice(0, 10).split("-");
    return `${month}/${day}/${year}`;
  });
  assert.ok(expectedDates.includes(fallback.policyEffectiveDate.value));
  assert.equal(fallback.policyEffectiveDate.source, "30-day-default");
  assert.equal(fallback.policyEffectiveDate.isAssumption, true);
  assert.deepEqual(fallback.purchaseDate, {
    value: null,
    source: "unknown",
  });
});

test("purchase date is independent from rewrite policy effective dates", () => {
  const purchase = resolveQuoteRushPropertyDefaults({
    policyType: "HO3",
    rebuildCost: 425_000,
    newPurchase: true,
    usageType: "primary",
    purchasePrice: 610_000,
    purchaseDate: "2027-04-15",
    purchaseDateSource: "purchase-scenario",
    policyEffectiveDate: "2027-05-01",
    policyEffectiveDateSource: "closing-date",
  });
  assert.deepEqual(purchase.purchaseDate, {
    value: "04/15/2027",
    source: "purchase-scenario",
  });
  assert.equal(purchase.policyEffectiveDate.value, "05/01/2027");

  const rewrite = resolveQuoteRushPropertyDefaults({
    policyType: "HO3",
    rebuildCost: 425_000,
    newPurchase: false,
    usageType: "primary",
    purchasePrice: 610_000,
    policyEffectiveDate: "2027-05-01",
    policyEffectiveDateSource: "current-policy-expiration",
  });
  assert.deepEqual(rewrite.purchaseDate, {
    value: null,
    source: "unknown",
  });
});

test("unknown purchase price remains null and is never replaced with Coverage A", () => {
  const result = resolveQuoteRushPropertyDefaults({
    policyType: "HO3",
    rebuildCost: 425_000,
    newPurchase: false,
    usageType: "primary",
    purchasePrice: null,
  });
  assert.deepEqual(result.purchasePrice, {
    value: null,
    source: "unknown",
    isAssumption: false,
  });
  assert.notEqual(result.purchasePrice.value, 425_000);
});

const purchasePriceCandidates = {
  purchaseScenario: { price: 700_000, priceSource: "zillow" as const },
  cashBuyScenario: {
    purchasePrice: 650_000,
    purchasePriceSource: "zillow_listing" as const,
  },
  trackedLoan: {
    originalPurchasePrice: 500_000,
    estimatedHomeValue: 725_000,
  },
};

test("confirmed contract purchase price beats an exact listing", () => {
  assert.deepEqual(
    resolvePurchasePriceProvenance({
      ...purchasePriceCandidates,
      purchaseScenario: { price: 675_000, priceSource: "manual" },
    }),
    { value: 675_000, source: "user-confirmed-contract" },
  );
});

test("exact listing purchase price beats a prior sale", () => {
  assert.deepEqual(
    resolvePurchasePriceProvenance(purchasePriceCandidates),
    { value: 650_000, source: "listing" },
  );
});

test("prior sale purchase price beats market value", () => {
  assert.deepEqual(
    resolvePurchasePriceProvenance({
      purchaseScenario: purchasePriceCandidates.purchaseScenario,
      trackedLoan: purchasePriceCandidates.trackedLoan,
    }),
    { value: 500_000, source: "prior-sale" },
  );
});

test("unknown purchase price stays null", () => {
  assert.deepEqual(
    resolvePurchasePriceProvenance({}),
    { value: null, source: "unknown" },
  );
});

test("manual existing-home correction records property-value provenance", () => {
  assert.deepEqual(
    resolvePurchasePriceProvenance({
      manual: { value: 740_000, newPurchase: false },
      cashBuyScenario: purchasePriceCandidates.cashBuyScenario,
    }),
    { value: 740_000, source: "user-confirmed-property-value" },
  );
});

test("quote-start rejects incomplete property details before a cache claim can run", () => {
  const validRequest = {
    address: "123 Palm Way, Tampa, FL 33602",
    coverageA: 425_000,
    policyType: "HO3" as const,
    usageType: "primary" as const,
    constIdx: 1,
    windIdx: 1,
    hurrIdx: 1,
    hasClaims: false,
    claimRecords: [],
    newPurchase: true,
    policyEffectiveDate: "2026-09-30",
    purchasePrice: 610_000,
    purchasePriceSource: "havo-purchase-scenario" as const,
  };
  let resolverCalls = 0;
  let cacheClaims = 0;
  const resolver = (input: Parameters<typeof resolveQuoteRushPropertyDefaults>[0]) => {
    resolverCalls++;
    return resolveQuoteRushPropertyDefaults(input);
  };
  const prepareThenClaim = (request: unknown) => {
    const prepared = prepareQuoteRushStartRequest(request, resolver);
    cacheClaims++;
    return prepared;
  };

  for (const [invalidRequest, expectedPath] of [
    [{ ...validRequest, usageType: undefined }, "usageType"],
    [{ ...validRequest, policyType: "HO6" as const, usageType: undefined }, "usageType"],
    [
      {
        ...validRequest,
        policyType: "HO6" as const,
        usageType: "investment" as const,
      },
      "rentalTerm",
    ],
    [
      { ...validRequest, policyType: "DP3" as const },
      "rentalTerm",
    ],
  ] as const) {
    assert.throws(() => prepareThenClaim(invalidRequest), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.match(String(error), new RegExp(expectedPath, "i"));
      return true;
    });
  }
  assert.equal(resolverCalls, 0);
  assert.equal(cacheClaims, 0);
});

test("existing-home quote uses an explicit requested date before private expiration", () => {
  const { propertyDefaults } = prepareQuoteRushStartRequest(
    {
      address: "123 Palm Way, Tampa, FL 33602",
      coverageA: 425_000,
      policyType: "HO3",
      usageType: "primary",
      constIdx: 1,
      windIdx: 1,
      hurrIdx: 1,
      hasClaims: false,
      claimRecords: [],
      newPurchase: false,
      policyEffectiveDate: "2026-10-15",
      purchasePrice: 610_000,
      purchasePriceSource: "user-confirmed-property-value",
    },
    resolveQuoteRushPropertyDefaults,
    "2027-01-31",
  );

  assert.deepEqual(propertyDefaults.policyEffectiveDate, {
    value: "10/15/2026",
    source: "user-requested",
    isAssumption: false,
  });
});

test("current policy expiration cannot override a new-purchase closing date", () => {
  const { propertyDefaults } = prepareQuoteRushStartRequest(
    {
      address: "123 Palm Way, Tampa, FL 33602",
      coverageA: 425_000,
      policyType: "HO3",
      usageType: "primary",
      constIdx: 1,
      windIdx: 1,
      hurrIdx: 1,
      hasClaims: false,
      claimRecords: [],
      newPurchase: true,
      policyEffectiveDate: "2026-10-15",
      purchasePrice: 610_000,
      purchasePriceSource: "user-confirmed-contract",
    },
    resolveQuoteRushPropertyDefaults,
    "2027-01-31",
  );

  assert.deepEqual(propertyDefaults.policyEffectiveDate, {
    value: "10/15/2026",
    source: "closing-date",
    isAssumption: false,
  });
});

test("existing-home quote keeps requested date and disclosed fallback precedence without an expiration", () => {
  const request = {
    address: "123 Palm Way, Tampa, FL 33602",
    coverageA: 425_000,
    policyType: "HO3" as const,
    usageType: "primary" as const,
    constIdx: 1,
    windIdx: 1,
    hurrIdx: 1,
    hasClaims: false,
    claimRecords: [],
    newPurchase: false,
    purchasePrice: 610_000,
    purchasePriceSource: "user-confirmed-property-value" as const,
  };
  const requested = prepareQuoteRushStartRequest({
    ...request,
    policyEffectiveDate: "2026-10-15",
  }).propertyDefaults.policyEffectiveDate;
  const fallback = prepareQuoteRushStartRequest(request)
    .propertyDefaults.policyEffectiveDate;

  assert.deepEqual(requested, {
    value: "10/15/2026",
    source: "user-requested",
    isAssumption: false,
  });
  assert.equal(fallback.source, "30-day-default");
  assert.equal(fallback.isAssumption, true);
});

test("private current policy expiration is not accepted into shared consumer answers", () => {
  const routesSource = readFileSync(
    new URL("../routes.ts", import.meta.url),
    "utf8",
  );
  const cacheRoutesSource = readFileSync(
    new URL("./insurance-cache-routes.ts", import.meta.url),
    "utf8",
  );
  const sanitizerStart = routesSource.indexOf(
    "function publicConsumerPropertyAnswers",
  );
  const sanitizerEnd = routesSource.indexOf(
    "const qrCountyCache",
    sanitizerStart,
  );
  const sanitizer = routesSource.slice(sanitizerStart, sanitizerEnd);
  const privateEndpointStart = routesSource.indexOf(
    '"/api/profile/insurance-property"',
  );
  const quoteStart = routesSource.indexOf('"/api/insurance/qr-start"');

  assert.notEqual(sanitizerStart, -1);
  assert.doesNotMatch(sanitizer, /currentPolicyExpirationDate/);
  assert.notEqual(privateEndpointStart, -1);
  assert.ok(privateEndpointStart < quoteStart);
  assert.match(
    cacheRoutesSource,
    /saveManagedPrivateInsuranceProperty/,
  );
});

test("policy effective values are stripped from the shared quote snapshot", () => {
  const privateEffectiveDate = toQuoteCachePolicyEffectiveDate({
    value: "01/31/2027",
    source: "current-policy-expiration",
    isAssumption: false,
  });
  const ordinaryEffectiveDate = toQuoteCachePolicyEffectiveDate({
    value: "10/15/2026",
    source: "user-requested",
    isAssumption: false,
  });

  assert.deepEqual(privateEffectiveDate, {
    source: "current-policy-expiration",
    isAssumption: false,
  });
  assert.equal("value" in privateEffectiveDate, false);
  assert.deepEqual(ordinaryEffectiveDate, {
    source: "user-requested",
    isAssumption: false,
  });
  assert.equal("value" in ordinaryEffectiveDate, false);
});

test("private expiration never changes the shared paid-cache identity", () => {
  const routesSource = readFileSync(
    new URL("../routes.ts", import.meta.url),
    "utf8",
  );
  const quoteStart = routesSource.slice(
    routesSource.indexOf('"/api/insurance/qr-start"'),
    routesSource.indexOf('"/api/insurance/qr-quotes"'),
  );

  assert.match(quoteStart, /addressNormalized:\s*norm/);
  assert.match(quoteStart, /policyType:\s*cacheRequest\.policyType/);
  assert.doesNotMatch(quoteStart, /cacheScope|quoteCacheScope/);
});

test("changing a private expiration does not rotate quote identity", () => {
  const routesSource = readFileSync(
    new URL("./insurance-cache-routes.ts", import.meta.url),
    "utf8",
  );
  const privatePropertyPut = routesSource.slice(
    routesSource.indexOf('app.put("/api/profile/insurance-property"'),
    routesSource.indexOf('app.get("/api/insurance/qr-cache"'),
  );

  assert.match(privatePropertyPut, /currentPolicyExpirationDate:/);
  assert.doesNotMatch(privatePropertyPut, /randomUUID|cacheScope/);
});

test("insurance hydration always reuses shared quotes despite private expiration", () => {
  const insuranceSource = readFileSync(
    new URL("../../client/src/pages/insurance.tsx", import.meta.url),
    "utf8",
  );
  const hydration = insuranceSource.slice(
    insuranceSource.indexOf("// Auto-trigger / cache-hydrate QuoteRUSH"),
    insuranceSource.indexOf("// ── QuoteRUSH quoting"),
  );

  assert.match(hydration, /const local = getQRCache\(address, quotePolicyType\)/);
  assert.match(hydration, /const quoteIdentity = `\$\{address\}\|\$\{quotePolicyType\}`/);
  assert.doesNotMatch(
    hydration,
    /currentPolicyExpirationLoading|currentPolicyExpirationSaving|private:\$\{/,
  );
});

test("new-purchase quote cannot fall back when its closing date is missing", () => {
  assert.throws(() => prepareQuoteRushStartRequest({
    address: "123 Palm Way, Tampa, FL 33602",
    coverageA: 425_000,
    policyType: "HO3",
    usageType: "primary",
    constIdx: 1,
    windIdx: 1,
    hurrIdx: 1,
    hasClaims: false,
    claimRecords: [],
    newPurchase: true,
    purchasePrice: 610_000,
    purchasePriceSource: "user-confirmed-contract",
  }), /closing date/i);
});

test("insurance quote state auto-fills residence use from matching source occupancy", () => {
  const insuranceSource = readFileSync(
    new URL("../../client/src/pages/insurance.tsx", import.meta.url),
    "utf8",
  );
  const resolverStart = insuranceSource.indexOf(
    "function resolveQuotePropertyAnswersFor",
  );
  const resolverEnd = insuranceSource.indexOf(
    "const [initialQuotePropertyAnswers]",
    resolverStart,
  );
  const resolver = insuranceSource.slice(resolverStart, resolverEnd);
  assert.ok(resolverStart >= 0);
  assert.match(resolver, /cash\?\.occupancyType/);
  assert.match(resolver, /loan\?\.occupancyType/);
  assert.match(resolver, /ins\?\.occupancyType/);
  assert.match(resolver, /\(purchase \? "primary" : undefined\)/);
  assert.ok(
    resolver.indexOf("savedResidenceUse") <
      resolver.lastIndexOf("sourceOccupancy"),
    "an explicitly saved quote answer must remain authoritative",
  );
});

test("quote-start returns a valid shared cache before private preparation and gates", () => {
  const routesSource = readFileSync(
    new URL("../routes.ts", import.meta.url),
    "utf8",
  );
  const routeStart = routesSource.indexOf('"/api/insurance/qr-start"');
  const routeEnd = routesSource.indexOf(
    '"/api/insurance/qr-quotes"',
    routeStart,
  );
  const routeSource = routesSource.slice(routeStart, routeEnd);
  const preparation = routeSource.indexOf("prepareQuoteRushStartRequest");
  const cacheClaim = routeSource.indexOf("claimQuoteRushAddress");
  const cacheLookup = routeSource.indexOf("readQuoteCache");
  const paidSubmission = routeSource.indexOf(
    "const result = await importAndSubmit",
  );
  const cachedQuoteReturn = routeSource.indexOf(
    "cache hit (success)",
  );
  const dobGate = routeSource.indexOf("DOB_REQUIRED");
  const staleReclaim = routeSource.indexOf("reclaimQuoteCache");

  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  assert.notEqual(preparation, -1);
  assert.notEqual(cacheLookup, -1);
  assert.notEqual(cacheClaim, -1);
  assert.notEqual(paidSubmission, -1);
  assert.notEqual(cachedQuoteReturn, -1);
  assert.notEqual(dobGate, -1);
  assert.notEqual(staleReclaim, -1);
  assert.ok(cachedQuoteReturn < dobGate);
  assert.ok(cacheLookup < cachedQuoteReturn);
  assert.ok(cachedQuoteReturn < preparation);
  assert.ok(preparation < cacheClaim);
  assert.ok(dobGate < staleReclaim);
  assert.ok(cacheClaim < paidSubmission);
  assert.equal(routeSource.indexOf("CREDIT_PERMISSION_REQUIRED"), -1);
  assert.equal(routeSource.indexOf("const submissionConsentProfile"), -1);
  const preserveLead = routeSource.indexOf(
    "updateClaimedCache({\n            leadId: result.leadId",
  );
  const ambiguousSubmit = routeSource.indexOf(
    "if (!result.submitted)",
  );
  assert.ok(preserveLead > paidSubmission);
  assert.ok(ambiguousSubmit > preserveLead);
  assert.match(
    routeSource.slice(ambiguousSubmit),
    /status\(202\)[\s\S]*existing lead/,
  );
});

test("quote polling requires authenticated, address-and-policy-bound cache access", () => {
  const routesSource = readFileSync(
    new URL("../routes.ts", import.meta.url),
    "utf8",
  );
  for (const route of ["/api/insurance/qr-quotes", "/api/insurance/qr-refresh"]) {
    const start = routesSource.indexOf(`"${route}"`);
    const end = routesSource.indexOf("\n  );", start);
    const source = routesSource.slice(start, end);
    assert.ok(start >= 0);
    if (route === "/api/insurance/qr-quotes") {
      assert.ok(source.includes("optionalUser(req)"));
      assert.equal(source.indexOf("getQuotes(leadId)"), -1);
      assert.match(source, /Cache-only read/);
    } else {
      assert.ok(source.indexOf("optionalUser(req)") < source.indexOf("getQuotes(leadId)"));
    }
    assert.match(source, /address: z\.string\(\)\.min\(5\)/);
    assert.match(source, /policyType: z\.enum\(\["HO3", "HO6", "DP3"\]\)/);
    assert.ok(source.includes("findQuoteCacheLead("));
  }
});

test("delayed quote-start writes and refreshes use status/generation CAS", () => {
  const routesSource = readFileSync(
    new URL("../routes.ts", import.meta.url),
    "utf8",
  );
  const start = routesSource.indexOf('"/api/insurance/qr-start"');
  const refresh = routesSource.indexOf('"/api/insurance/qr-refresh"');
  const quotes = routesSource.indexOf('"/api/insurance/qr-quotes"');
  const startSource = routesSource.slice(start, quotes);
  const refreshSource = routesSource.slice(refresh);

  assert.match(startSource, /activeCacheGeneration/);
  assert.match(startSource, /updateClaimedCache/);
  assert.match(startSource, /expectedStatus:\s*"pending"/);
  assert.match(
    startSource,
    /if\s*\(!updated\)\s*\{\s*activeCacheGeneration\s*=\s*null/s,
  );
  assert.match(
    startSource,
    /This quote request was superseded by a newer run/,
  );
  assert.match(refreshSource, /expectedStatus:\s*cacheLead\.status/);
});

test("quote cache snapshots are explicitly non-PII", () => {
  const routesSource = readFileSync(
    new URL("../routes.ts", import.meta.url),
    "utf8",
  );
  const snapshotStart = routesSource.indexOf("const initialRunValues = {");
  const snapshotEnd = routesSource.indexOf("\n        };", snapshotStart);
  const snapshotSource = routesSource.slice(snapshotStart, snapshotEnd);
  assert.ok(snapshotStart >= 0);
  assert.doesNotMatch(
    snapshotSource,
    /\b(?:dateOfBirth|firstName|lastName|email|phone|userId)\b/,
  );
  assert.match(snapshotSource, /propertyDataProvenance:/);
  assert.match(
    snapshotSource,
    /windMitigationReportConfirmed:\s*false/,
  );
  assert.match(snapshotSource, /agencyDefaultSnapshot:/);
  assert.match(snapshotSource, /assumptions:/);
  assert.doesNotMatch(
    snapshotSource,
    /hasClaims|claimsCount|priorClaims/,
  );
});

test("verification assumptions and consumer wind disclosure remain explicit", () => {
  const routesSource = readFileSync(
    new URL("../routes.ts", import.meta.url),
    "utf8",
  );
  const insuranceSource = readFileSync(
    new URL("../../client/src/pages/insurance.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    routesSource,
    /Credit permission — assumed, confirm with client/,
  );
  assert.match(
    routesSource,
    /Credit score — assumed Excellent, not verified/,
  );
  assert.match(
    insuranceSource,
    /i === 0 && !windMitigationReportConfirmed/,
  );
  assert.match(
    insuranceSource,
    /This estimate assumes wind mitigation credits based on the home's age\. A wind mitigation inspection is required to confirm them — without one, your premium may be higher\./,
  );
  assert.match(insuranceSource, /Send wind mitigation report/);
  assert.doesNotMatch(
    insuranceSource,
    /creditScoreConsent|insurance-credit-score-consent|Authorization required/,
  );
});

test("quote-start resolves normalized HO3, HO6, and DP3 defaults before cache access", () => {
  const base = {
    address: "123 Palm Way, Tampa, FL 33602",
    coverageA: 425_000,
    constIdx: 1,
    windIdx: 1,
    hurrIdx: 1,
    hasClaims: false,
    claimRecords: [],
    newPurchase: true,
    policyEffectiveDate: "2026-09-30",
    purchasePrice: 610_000,
    purchasePriceSource: "havo-purchase-scenario" as const,
  };

  const cases = [
    [
      { ...base, policyType: "HO3" as const, usageType: "primary" as const },
       {
         usageType: "Primary",
         rentalTerm: "",
         purchasePrice: 610_000,
       },
    ],
    [
      {
        ...base,
        policyType: "HO6" as const,
        usageType: "investment" as const,
        rentalTerm: "monthly" as const,
      },
       { usageType: "Investment", rentalTerm: "Monthly", purchasePrice: 610_000 },
    ],
    [
      { ...base, policyType: "DP3" as const, newPurchase: false, rentalTerm: "weekly" as const },
      { usageType: "Investment", rentalTerm: "Weekly", purchasePrice: 610_000 },
    ],
  ] as const;

  for (const [request, expected] of cases) {
    const { propertyDefaults } = prepareQuoteRushStartRequest(request);
    assert.deepEqual(
      {
        usageType: propertyDefaults.usageType,
        rentalTerm: propertyDefaults.rentalTerm,
        purchasePrice: propertyDefaults.purchasePrice.value,
        purchaseDate: propertyDefaults.purchaseDate,
        newPurchase: propertyDefaults.newPurchase,
      },
      {
        ...expected,
        purchaseDate: request.newPurchase
          ? {
              value: "09/30/2026",
              source: "user-confirmed",
            }
          : {
              value: null,
              source: "unknown",
            },
        newPurchase: request.newPurchase ? "Yes" : "No",
      },
    );
  }
});

test("property enrichment can supplement square footage but cannot overwrite explicit quote answers", async () => {
  const previousFetch = globalThis.fetch;
  const oldEnv = {
    webId: process.env.QUOTERUSH_WEBID,
    password: process.env.QUOTERUSH_WEBID_PASSWORD,
    key: process.env.QUOTERUSH_ENDPOINT_KEY,
    agency: process.env.QUOTERUSH_AGENCY_ID,
  };
  Object.assign(process.env, {
    QUOTERUSH_WEBID: "test-web-id",
    QUOTERUSH_WEBID_PASSWORD: "test-password",
    QUOTERUSH_ENDPOINT_KEY: "test-key",
    QUOTERUSH_AGENCY_ID: "test-agency",
  });
  const calls: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    if (String(url).includes("GetPropertyData")) {
      return new Response(JSON.stringify({
        SquareFeet: 2600,
        YearBuilt: 1981,
        ConstructionType: "Frame",
        MasonryConstruction: "Brick",
      }));
    }
    if (String(url).includes("importer.quoterush.com")) {
      return new Response(JSON.stringify({ LeadId: 987 }));
    }
    return new Response("submitted");
  }) as typeof fetch;

  try {
    const result = await importAndSubmit({ ...params, sqFt: 0 });
    assert.deepEqual(result, {
      leadId: 987,
      submitted: true,
      error: undefined,
      rawPropertyData: {
        SquareFeet: 2600,
        YearBuilt: 1981,
        ConstructionType: "Frame",
        MasonryConstruction: "Brick",
      },
    });
    const importer = calls.find(({ url }) => url.includes("importer.quoterush.com"))!;
    const payload = JSON.parse(String(importer.body));
    assert.equal(payload.HO.SquareFeet, "2600");
    assert.equal(payload.HO.YearBuilt, "2007");
    assert.equal(payload.HO.ConstructionType, "Mixed");
    assert.equal(payload.HO.Construction, "Concrete Block");
    assert.equal("FrameConstruction" in payload.HO, false);

    await importAndSubmit({ ...params, sqFt: 2_100 });
    const importers = calls.filter(({ url }) => url.includes("importer.quoterush.com"));
    const explicitSquareFeetPayload = JSON.parse(String(importers.at(-1)!.body));
    assert.equal(
      explicitSquareFeetPayload.HO.SquareFeet,
      "2100",
      "late QuoteRUSH property enrichment must not replace a trusted square-foot value",
    );
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries({
      QUOTERUSH_WEBID: oldEnv.webId,
      QUOTERUSH_WEBID_PASSWORD: oldEnv.password,
      QUOTERUSH_ENDPOINT_KEY: oldEnv.key,
      QUOTERUSH_AGENCY_ID: oldEnv.agency,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("submit transport failure preserves the imported lead for reconciliation", async () => {
  const previousFetch = globalThis.fetch;
  const oldEnv = {
    webId: process.env.QUOTERUSH_WEBID,
    password: process.env.QUOTERUSH_WEBID_PASSWORD,
    key: process.env.QUOTERUSH_ENDPOINT_KEY,
    agency: process.env.QUOTERUSH_AGENCY_ID,
  };
  Object.assign(process.env, {
    QUOTERUSH_WEBID: "test-web-id",
    QUOTERUSH_WEBID_PASSWORD: "test-password",
    QUOTERUSH_ENDPOINT_KEY: "test-key",
    QUOTERUSH_AGENCY_ID: "test-agency",
  });
  globalThis.fetch = (async (url) => {
    if (String(url).includes("GetPropertyData")) {
      return new Response(JSON.stringify({}));
    }
    if (String(url).includes("importer.quoterush.com")) {
      return new Response(JSON.stringify({ LeadId: 654 }));
    }
    throw new TypeError("simulated connection reset");
  }) as typeof fetch;

  try {
    assert.deepEqual(
      await importAndSubmit(params),
      {
        leadId: 654,
        submitted: false,
        error: "Quote submission status could not be confirmed",
        rawPropertyData: {},
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries({
      QUOTERUSH_WEBID: oldEnv.webId,
      QUOTERUSH_WEBID_PASSWORD: oldEnv.password,
      QUOTERUSH_ENDPOINT_KEY: oldEnv.key,
      QUOTERUSH_AGENCY_ID: oldEnv.agency,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("successful property data survives a later importer failure for persistence", async () => {
  const previousFetch = globalThis.fetch;
  const oldEnv = {
    webId: process.env.QUOTERUSH_WEBID,
    password: process.env.QUOTERUSH_WEBID_PASSWORD,
    key: process.env.QUOTERUSH_ENDPOINT_KEY,
    agency: process.env.QUOTERUSH_AGENCY_ID,
  };
  Object.assign(process.env, {
    QUOTERUSH_WEBID: "test-web-id",
    QUOTERUSH_WEBID_PASSWORD: "test-password",
    QUOTERUSH_ENDPOINT_KEY: "test-key",
    QUOTERUSH_AGENCY_ID: "test-agency",
  });
  globalThis.fetch = (async (url) => {
    if (String(url).includes("GetPropertyData")) {
      return new Response(JSON.stringify({
        SquareFeet: 1999,
        UnmappedProviderField: { retained: true },
      }));
    }
    return new Response("import unavailable", { status: 503 });
  }) as typeof fetch;
  try {
    const result = await importAndSubmit(params);
    assert.equal(result.leadId, 0);
    assert.equal(result.submitted, false);
    assert.deepEqual(result.rawPropertyData, {
      SquareFeet: 1999,
      UnmappedProviderField: { retained: true },
    });
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries({
      QUOTERUSH_WEBID: oldEnv.webId,
      QUOTERUSH_WEBID_PASSWORD: oldEnv.password,
      QUOTERUSH_ENDPOINT_KEY: oldEnv.key,
      QUOTERUSH_AGENCY_ID: oldEnv.agency,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("successful property data survives an importer response-read exception", async () => {
  const previousFetch = globalThis.fetch;
  const oldEnv = {
    webId: process.env.QUOTERUSH_WEBID,
    password: process.env.QUOTERUSH_WEBID_PASSWORD,
    key: process.env.QUOTERUSH_ENDPOINT_KEY,
    agency: process.env.QUOTERUSH_AGENCY_ID,
  };
  Object.assign(process.env, {
    QUOTERUSH_WEBID: "test-web-id",
    QUOTERUSH_WEBID_PASSWORD: "test-password",
    QUOTERUSH_ENDPOINT_KEY: "test-key",
    QUOTERUSH_AGENCY_ID: "test-agency",
  });
  globalThis.fetch = (async (url) => {
    if (String(url).includes("GetPropertyData")) {
      return new Response(JSON.stringify({
        SquareFeet: 1888,
        UnmappedProviderField: "retained",
      }));
    }
    return {
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError("simulated body read failure");
      },
    } as unknown as Response;
  }) as typeof fetch;
  try {
    assert.deepEqual(await importAndSubmit(params), {
      leadId: 0,
      submitted: false,
      error: "QuoteRUSH importer response could not be read",
      rawPropertyData: {
        SquareFeet: 1888,
        UnmappedProviderField: "retained",
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries({
      QUOTERUSH_WEBID: oldEnv.webId,
      QUOTERUSH_WEBID_PASSWORD: oldEnv.password,
      QUOTERUSH_ENDPOINT_KEY: oldEnv.key,
      QUOTERUSH_AGENCY_ID: oldEnv.agency,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("successful property data survives an importer fetch exception", async () => {
  const previousFetch = globalThis.fetch;
  const oldEnv = {
    webId: process.env.QUOTERUSH_WEBID,
    password: process.env.QUOTERUSH_WEBID_PASSWORD,
    key: process.env.QUOTERUSH_ENDPOINT_KEY,
    agency: process.env.QUOTERUSH_AGENCY_ID,
  };
  Object.assign(process.env, {
    QUOTERUSH_WEBID: "test-web-id",
    QUOTERUSH_WEBID_PASSWORD: "test-password",
    QUOTERUSH_ENDPOINT_KEY: "test-key",
    QUOTERUSH_AGENCY_ID: "test-agency",
  });
  globalThis.fetch = (async (url) => {
    if (String(url).includes("GetPropertyData")) {
      return new Response(JSON.stringify({
        SquareFeet: 1777,
        Unknown: { retained: true },
      }));
    }
    throw new TypeError("simulated importer connection failure");
  }) as typeof fetch;
  try {
    assert.deepEqual(await importAndSubmit(params), {
      leadId: 0,
      submitted: false,
      error: "QuoteRUSH importer response could not be read",
      rawPropertyData: {
        SquareFeet: 1777,
        Unknown: { retained: true },
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries({
      QUOTERUSH_WEBID: oldEnv.webId,
      QUOTERUSH_WEBID_PASSWORD: oldEnv.password,
      QUOTERUSH_ENDPOINT_KEY: oldEnv.key,
      QUOTERUSH_AGENCY_ID: oldEnv.agency,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("public QuoteRUSH cache routes never serialize stored raw property data", () => {
  const routesSource = readFileSync(
    new URL("../routes.ts", import.meta.url),
    "utf8",
  );
  const publicCacheSource = readFileSync(
    new URL("./insurance-cache-routes.ts", import.meta.url),
    "utf8",
  );
  assert.match(publicCacheSource, /"\/api\/insurance\/qr-cache"/);
  assert.doesNotMatch(publicCacheSource, /rawQuoterushPropertyData/);
  assert.doesNotMatch(publicCacheSource, /raw_quoterush_property_data/);
  assert.match(routesSource, /rawQuoterushPropertyData: result\.rawPropertyData/);
  assert.match(routesSource, /rawQuoterushPropertyDataExpiresAt/);
});

test("import payload omits square footage when no trusted value is available", () => {
  const payload = buildImporterPayload({ ...params, sqFt: 0 }, "agent@example.com");
  assert.equal("SquareFeet" in payload.HO, false);
});

test("import payload never fabricates prior claim details", () => {
  assert.throws(
    () =>
      buildImporterPayload(
        { ...params, priorClaims: 1 },
        "agent@example.com",
      ),
    /claim details must be confirmed/i,
  );
});

test("import payload maps only completed applicant claim records", () => {
  const payload = buildImporterPayload({
    ...params,
    priorClaims: 1,
    claimRecords: [{
      lossDate: "2024-06-01",
      claimDetail: "Water damage from a supply line",
      amount: 12_500,
      paid: false,
      priorResidence: true,
    }],
  }, "agent@example.com");
  assert.equal(payload.HO.Claims, "Yes");
  assert.deepEqual(payload.Claims, [{
    ClaimDetail: "Water damage from a supply line",
    Date: "06/01/2024",
    Amount: "12500",
    PriorResidence: true,
    Paid: false,
  }]);
  assert.equal("ActOfGod" in payload.Claims[0], false);
  assert.equal("CatastrophicLoss" in payload.Claims[0], false);
  assert.throws(
    () => buildImporterPayload({ ...params, priorClaims: 1, claimRecords: [] }, "agent@example.com"),
    /claim details must be confirmed/i,
  );
});

test("HO6 keeps C/D/E, uses $2,000 medical, and omits Coverage B", () => {
  const payload = buildImporterPayload(
    { ...params, policyType: "HO6", coverageA: 212_500 },
    "agent@example.com",
  );
  assert.equal(payload.HO.CoverageA, "212500");
  assert.equal(payload.HO.CoverageF, "$2,000");
  assert.equal("CoverageB" in payload.HO, false);
  assert.equal("CoverageBPercent" in payload.HO, false);
  assert.equal(payload.HO.CoverageC, "53125");
  assert.equal(payload.HO.CoverageD, "21250");
  assert.equal(payload.HO.CoverageE, "$300,000");
  assert.equal("LossAssessment" in payload.HO, false);
});

test("quote-start requires a matching complete claim answer", () => {
  const base = {
    address: "123 Palm Way, Tampa, FL 33602", coverageA: 425_000,
    constIdx: 1, windIdx: 1, hurrIdx: 1, newPurchase: true,
    purchaseDate: "2026-09-30", hasClaims: true, claimRecords: [],
    purchasePrice: 610_000, purchasePriceSource: "havo-purchase-scenario" as const,
    usageType: "primary" as const,
  };
  assert.throws(() => prepareQuoteRushStartRequest(base), /claim/i);
  assert.throws(() => prepareQuoteRushStartRequest({
    ...base, claimRecords: [{
      lossDate: "2024-06-01", claimDetail: "Wind", amount: 0,
      paid: true, priorResidence: false,
    }],
  }), /amount/i);
  assert.doesNotThrow(() => prepareQuoteRushStartRequest({
    ...base, hasClaims: false, claimRecords: [], hasMortgage: false,
  }));
});

test("FEMA zone does not synthesize a separate flood policy", () => {
  const payload = buildImporterPayload(
    { ...params, floodZone: "AE" },
    "agent@example.com",
  );
  assert.equal(payload.Client.Lob_Flood, false);
  assert.equal(payload.HO.FloodZone, "AE");
  assert.equal(payload.HO.FloodPolicy, false);
  assert.equal("Flood" in payload, false);
});

test("unknown flood zone is omitted instead of fabricated as X", () => {
  const payload = buildImporterPayload(
    { ...params, floodZone: "" },
    "agent@example.com",
  );
  assert.equal("FloodZone" in payload.HO, false);
});

test("mortgage is omitted unless Havo has a derived answer", () => {
  const unknown = buildImporterPayload(params, "agent@example.com");
  assert.equal("Mortgage" in unknown.HO, false);

  const financed = buildImporterPayload(
    { ...params, hasMortgage: true },
    "agent@example.com",
  );
  assert.equal(financed.HO.Mortgage, "Yes");

  const freeAndClear = buildImporterPayload(
    { ...params, hasMortgage: false },
    "agent@example.com",
  );
  assert.equal(freeAndClear.HO.Mortgage, "No");
});

test("legacy index callers retain year/roof buckets while wind follows the corrected year rule", () => {
  const exact = resolveQuoteRushPropertyInputs({
    yearBuilt: 2011,
    roofYear: 2024,
    yearIdx: 3,
    roofIdx: 3,
    constIdx: 1,
    windIdx: 0,
    openingProtection: true,
    secondaryWaterResistance: "Unknown",
    roofShape: "Flat",
  }, 2026);
  assert.equal(exact.yearBuilt, 2011);
  assert.equal(exact.roofYear, 2024);
  assert.equal(exact.openingProtection, "Hurricane Protection");
  assert.equal(exact.secondaryWaterResistance, "Unknown");
  assert.equal(exact.roofShape, "Flat");
  assert.equal(exact.constructionType, "Mixed");
  assert.equal(exact.frameConstruction, "");

  const legacy = resolveQuoteRushPropertyInputs({
    yearIdx: 2,
    roofIdx: 0,
    constIdx: 0,
    windIdx: 2,
  }, 2026);
  assert.equal(legacy.yearBuilt, 1980);
  assert.equal(legacy.roofYear, 2024);
  assert.equal(legacy.openingProtection, "None");
  assert.equal(legacy.secondaryWaterResistance, "No");
});

test("concurrent address claims allow only one paid submission", async () => {
  let claimed = false;
  let paidSubmissions = 0;
  const insertPending = async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (claimed) return [];
    claimed = true;
    return [{ id: 1 }];
  };
  const findCurrent = async () => ({
    leadId: null,
    status: "pending",
  });

  const attempt = async () => {
    const claim = await claimQuoteRushAddress(insertPending, findCurrent);
    if (claim.claimed) paidSubmissions++;
    return claim;
  };
  const results = await Promise.all([attempt(), attempt()]);

  assert.equal(paidSubmissions, 1);
  assert.equal(results.filter(result => result.claimed).length, 1);
  const loser = results.find(result => !result.claimed);
  assert.deepEqual(loser, {
    claimed: false,
    row: { leadId: null, status: "pending" },
  });
});

test("same address and policy race allows only one paid submission", async () => {
  const claimedIdentities = new Set<string>();
  let paidSubmissions = 0;
  const identity = "123 palm way tampa fl 33602|HO6";

  const attempt = async () => {
    const claim = await claimQuoteRushAddress(
      async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (claimedIdentities.has(identity)) return [];
        claimedIdentities.add(identity);
        return [{ id: 1 }];
      },
      async () => ({ leadId: null, status: "pending" }),
    );
    if (claim.claimed) paidSubmissions++;
    return claim;
  };

  const claims = await Promise.all([attempt(), attempt()]);
  assert.equal(paidSubmissions, 1);
  assert.equal(claims.filter(claim => claim.claimed).length, 1);
});

test("same address with different policy types has independent claims", async () => {
  const claimedIdentities = new Set<string>();
  let paidSubmissions = 0;

  const attempt = async (policyType: "HO3" | "HO6") => {
    const identity = `123 palm way tampa fl 33602|${policyType}`;
    const claim = await claimQuoteRushAddress(
      async () => {
        if (claimedIdentities.has(identity)) return [];
        claimedIdentities.add(identity);
        return [{ id: claimedIdentities.size }];
      },
      async () => ({ leadId: null, status: "pending" }),
    );
    if (claim.claimed) paidSubmissions++;
  };

  await Promise.all([attempt("HO3"), attempt("HO6")]);
  assert.equal(paidSubmissions, 2);
  assert.deepEqual(
    [...claimedIdentities].sort(),
    [
      "123 palm way tampa fl 33602|HO3",
      "123 palm way tampa fl 33602|HO6",
    ],
  );
});

test("QuoteRUSH returns only the three cheapest positive carrier results", async () => {
  const previousFetch = globalThis.fetch;
  const previousEndpointKey = process.env.QUOTERUSH_ENDPOINT_KEY;
  const previousAgency = process.env.QUOTERUSH_AGENCY_ID;
  process.env.QUOTERUSH_ENDPOINT_KEY = "test-key";
  process.env.QUOTERUSH_AGENCY_ID = "test-agency";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    QuoteCounter: 5,
    Quotes: [
      { SiteName: "Expensive", Premium: "5000" },
      { SiteName: "Cheapest", Premium: "1000" },
      { SiteName: "Invalid", Premium: "0" },
      { SiteName: "Third", Premium: "3000" },
      { SiteName: "Second", Premium: "2000" },
      { SiteName: "Fourth", Premium: "4000" },
    ],
  }))) as typeof fetch;

  try {
    const result = await getQuotes(123);
    assert.equal(result.quoteCounter, 5);
    assert.deepEqual(
      result.quotes.map(quote => ({
        carrier: quote.siteName,
        premium: quote.annualPremium,
        rank: quote.rank,
      })),
      [
        { carrier: "Cheapest", premium: 1000, rank: 1 },
        { carrier: "Second", premium: 2000, rank: 2 },
        { carrier: "Third", premium: 3000, rank: 3 },
      ],
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEndpointKey === undefined) {
      delete process.env.QUOTERUSH_ENDPOINT_KEY;
    } else {
      process.env.QUOTERUSH_ENDPOINT_KEY = previousEndpointKey;
    }
    if (previousAgency === undefined) {
      delete process.env.QUOTERUSH_AGENCY_ID;
    } else {
      process.env.QUOTERUSH_AGENCY_ID = previousAgency;
    }
  }
});