import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeFromCache,
  isCacheRowValid,
  totalNonSchoolHomesteadExemptionForYear,
  type PropertyTaxCacheRow,
} from "./property-tax-cache";
import {
  computePinellasAdValorem,
  deriveCountyAssessmentBasis,
  getCountyPurchaseTax,
  getHillsboroughPurchaseTax,
} from "./property-tax-service";
import { calcAdValorem } from "./hillsborough-tax";
import { PURCHASE_TAX_LOW_ASSESSMENT_RATIO } from "@shared/property-tax-policy";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const BILL_MILLS = [
  { authority: "PINELLAS COUNTY SCHOOL", mills: 6.293 },
  { authority: "PINELLAS COUNTY GENERAL", mills: 10.25 },
];

test("purchase routes fail closed when no official county estimator is verified", async () => {
  const counties = [
    "pinellas",
    "manatee",
    "pasco",
    "hernando",
    "sarasota",
    "lee",
    "collier",
    "polk",
  ] as const;

  for (const county of counties) {
    const result = await getCountyPurchaseTax({
      county,
      address: "112 Palmetto Dunes Cir, Naples, FL 34113",
      purchasePrice: 525_000,
      isPrimaryResidence: false,
    });
    assert.equal(result.adValoremTax, null, county);
    assert.equal(result.annualTax, null, county);
    assert.equal(result.monthlyTax, null, county);
    assert.match(result.source, /county-estimator-unavailable$/, county);
    assert.equal(result.nonAdValoremTax, null, county);
  }

  const hillsborough = await getHillsboroughPurchaseTax({
    address: "3440 Laurel Dale Dr, Tampa, FL 33618",
    purchasePrice: 350_000,
    isPrimaryResidence: true,
  }, {
    lookupPin: async () => null,
    readCache: async () => null,
  });
  assert.equal(hillsborough.adValoremTax, null);
  assert.equal(hillsborough.annualTax, null);
  assert.match(hillsborough.source, /county-estimator-unavailable$/);
  assert.match(hillsborough.operationalError ?? "", /manually/i);
});

test("Hillsborough purchase total is page low-end plus the collector bill", async () => {
  const result = await getHillsboroughPurchaseTax({
    address: "100 N Tampa St, Tampa, FL 33602",
    purchasePrice: 1_000_000,
    isPrimaryResidence: false,
  }, {
    readCache: async () => null,
    writeCache: async () => {},
    lookupPin: async () => ({ pin: "1829244ZI000091000010A", folio: "1936620000" }),
    fetchRates: async () => ({
      schoolTaxRate: 6.334,
      nonschoolTaxRate: 13.4013,
      totalTaxRate: 19.7353,
      nonAdValoremTaxes: 999,
      taxDistrict: "TA",
      justValue: 1,
      assessedValue: 1,
    }),
    resolveBill: async () => ({
      state: "ready",
      annualTax: 17000,
      monthlyTax: 1416.67,
      taxYear: 2025,
      adValoremTax: 1,
      nonAdValoremTax: 224.5,
      source: "tax-collector-bill-scrape",
      county: "hillsborough",
      parcelId: "A1936620000",
    }),
  });
  assert.equal(result.adValoremTax, 16775.01);
  assert.equal(result.nonAdValoremTax, 224.5);
  assert.equal(result.annualTax, 16999.51);
  assert.equal(result.nonAdValoremPending, false);
  assert.equal(result.source, "hillsborough-county-estimator");
  assert.match(result.sourceLabel ?? "", /low end/);
  assert.match(result.sourceLabel ?? "", /2025 bill/);
  assert.equal(result.audit?.schoolMills, 6.334);
});

test("Hillsborough does not turn a missing tax bill into zero CDD", async () => {
  const result = await getHillsboroughPurchaseTax({
    address: "100 N Tampa St, Tampa, FL 33602",
    purchasePrice: 1_000_000,
    isPrimaryResidence: true,
  }, {
    readCache: async () => null,
    writeCache: async () => {},
    lookupPin: async () => ({ pin: "1829244ZI000091000010A", folio: "1936620000" }),
    fetchRates: async () => ({
      schoolTaxRate: 6.334,
      nonschoolTaxRate: 13.4013,
      totalTaxRate: 19.7353,
      nonAdValoremTaxes: 0,
      taxDistrict: "TA",
      justValue: 1,
      assessedValue: 1,
    }),
    resolveBill: async () => ({
      state: "unavailable",
      manualEntryRequired: true,
      county: "hillsborough",
      reason: "live-bill-service-not-configured",
      operationalError: "Live property-tax bills require APIFY_TOKEN in this environment.",
    }),
  });
  assert.equal(result.adValoremTax, 15946.59);
  assert.equal(result.annualTax, null);
  assert.equal(result.nonAdValoremPending, true);
  assert.match(result.source, /unavailable$/);
  assert.match(result.operationalError ?? "", /15946\.59/);
  assert.match(result.operationalError ?? "", /APIFY_TOKEN/);
});

test("a cached Hillsborough millage is recomputed and the CDD stays flat", async () => {
  let lookups = 0;
  const now = new Date("2026-08-21T12:00:00.000Z");
  const result = await getHillsboroughPurchaseTax({
    address: "100 N Tampa St, Tampa, FL 33602",
    purchasePrice: 800_000,
    isPrimaryResidence: false,
    now,
  }, {
    now,
    lookupPin: async () => { lookups += 1; return null; },
    readCache: async () => ({
      county: "hillsborough",
      addressNormalized: "100 N TAMPA ST, TAMPA, FL 33602",
      addressDisplay: "100 N Tampa St, Tampa, FL 33602",
      parcelId: "1829244ZI000091000010A",
      folio: "1936620000",
      taxDistrict: "TA",
      homesteadAdValoremPct: 0.015,
      nonHomesteadAdValoremPct: 0.016,
      samplePrice: 1_000_000,
      totalMillage: 19.7353,
      schoolMillage: 6.334,
      nonSchoolMillage: 13.4013,
      assessmentRatio: 0.85,
      homesteadSchoolExemption: 25_000,
      homesteadNonSchoolExemption: 50_000,
      parcelSource: "hcpa-tax-estimator",
      rateYear: 2026,
      nonAdValoremAmtCents: 22_450,
      nonAdValoremLines: [],
      source: "hillsborough-county-estimator",
      expiresAt: new Date("2026-11-01T00:00:00.000Z"),
      queriedAt: "2026-08-01T00:00:00.000Z",
    }),
  });
  assert.equal(lookups, 0);
  assert.equal(result.fromGeneralCache, true);
  assert.equal(result.nonAdValoremTax, 224.5);
  assert.equal(result.adValoremTax, 13420);
  assert.equal(result.annualTax, 13644.5);
  assert.match(result.sourceLabel ?? "", /2026-08-01/);
});

test("unverified counties name why the official estimator is not shown", async () => {
  const polk = await getCountyPurchaseTax({
    county: "hernando",
    address: "45098 Hwy 54, Lakeland, FL 33809",
    purchasePrice: 400_000,
    isPrimaryResidence: true,
  });
  assert.equal(polk.annualTax, null);
  assert.match(polk.operationalError ?? "", /not passed verification/);
  assert.equal(polk.breakdown?.total.cents, null);
});

test("Pinellas live estimate ignores a higher current just value", () => {
  const purchasePrice = 400_000;
  const purchaseOnly = computePinellasAdValorem({
    purchasePrice,
    justValue: 0,
    isPrimaryResidence: true,
    billMillage: 16.543,
    billMills: BILL_MILLS,
    rateYear: 2026,
  });
  const assessorFloor = computePinellasAdValorem({
    purchasePrice,
    justValue: 500_000,
    isPrimaryResidence: true,
    billMillage: 16.543,
    billMills: BILL_MILLS,
    rateYear: 2026,
  });

  assert.equal(assessorFloor, purchaseOnly);
});

test("Pinellas millage arithmetic is isolated from the official cache", () => {
  const purchasePrice = 400_000;
  const homesteadAdValorem = computePinellasAdValorem({
    purchasePrice,
    justValue: 0,
    isPrimaryResidence: true,
    billMillage: 16.543,
    billMills: BILL_MILLS,
    rateYear: 2026,
  });
  const nonHomesteadAdValorem = computePinellasAdValorem({
    purchasePrice,
    justValue: 0,
    isPrimaryResidence: false,
    billMillage: 16.543,
    billMills: BILL_MILLS,
    rateYear: 2026,
  });
  const row: PropertyTaxCacheRow = {
    county: "pinellas",
    addressNormalized: "1678 LAGO VISTA BLVD, PALM HARBOR, FL 34685",
    addressDisplay: "1678 Lago Vista Blvd, Palm Harbor, FL 34685",
    parcelId: "042816103290001510",
    folio: "042816103290001510",
    taxDistrict: "pinellas",
    homesteadAdValoremPct: homesteadAdValorem / purchasePrice,
    nonHomesteadAdValoremPct: nonHomesteadAdValorem / purchasePrice,
    samplePrice: purchasePrice,
    totalMillage: 16.543,
    schoolMillage: 6.293,
    nonSchoolMillage: 10.25,
    assessmentRatio: 0.85,
    homesteadSchoolExemption: 25_000,
    homesteadNonSchoolExemption: 51_411,
    parcelSource: "pinellas-pa-arcgis",
    rateYear: 2026,
    nonAdValoremAmtCents: 35_336,
    nonAdValoremLines: [{ authority: "Fire Assessment", amount: 353.36 }],
    source: "pinellas-bill-live",
    expiresAt: new Date("2026-11-01T00:00:00.000Z"),
  };

  assert.equal(
    isCacheRowValid(row, purchasePrice, NOW),
    false,
  );
  assert.equal(
    computeFromCache(row, purchasePrice, true).adValoremTax,
    homesteadAdValorem,
  );
  assert.equal(
    isCacheRowValid(row, 620_000, NOW),
    false,
  );
  assert.equal(
    computeFromCache(row, 620_000, true).adValoremTax,
    computePinellasAdValorem({
      purchasePrice: 620_000,
      justValue: 0,
      isPrimaryResidence: true,
      billMillage: 16.543,
      billMills: BILL_MILLS,
      rateYear: 2026,
    }),
  );

  for (const price of [250_001, 400_000, 620_000, 777_777]) {
    for (const homestead of [true, false]) {
      assert.equal(
        computeFromCache(row, price, homestead).adValoremTax,
        computePinellasAdValorem({
          purchasePrice: price,
          justValue: price * 1.4,
          isPrimaryResidence: homestead,
          billMillage: 16.543,
          billMills: BILL_MILLS,
          rateYear: 2026,
        }),
        `${price} ${homestead ? "homestead" : "non-homestead"}`,
      );
    }
  }
});

test("Pinellas live and cache calculations agree for each exemption year", () => {
  const purchasePrice = 517_321;
  for (const rateYear of [2025, 2026]) {
    const row = {
      homesteadAdValoremPct: 0,
      nonHomesteadAdValoremPct: 0,
      nonAdValoremAmtCents: 0,
      schoolMillage: 6.293,
      nonSchoolMillage: 10.25,
      assessmentRatio: PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
      homesteadSchoolExemption: 25_000,
      homesteadNonSchoolExemption:
        totalNonSchoolHomesteadExemptionForYear(rateYear),
      rateYear,
    };
    assert.equal(
      computePinellasAdValorem({
        purchasePrice,
        justValue: purchasePrice * 1.5,
        isPrimaryResidence: true,
        billMillage: 16.543,
        billMills: BILL_MILLS,
        rateYear,
      }),
      computeFromCache(row, purchasePrice, true).adValoremTax,
      String(rateYear),
    );
  }
});

test("Hillsborough live and cache calculations agree for each exemption year", () => {
  const purchasePrice = 517_321;
  for (const rateYear of [2025, 2026]) {
    const nonSchoolExemption =
      totalNonSchoolHomesteadExemptionForYear(rateYear);
    const row = {
      homesteadAdValoremPct: 0,
      nonHomesteadAdValoremPct: 0,
      nonAdValoremAmtCents: 0,
      schoolMillage: 6.34,
      nonSchoolMillage: 11.9115,
      assessmentRatio: PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
      homesteadSchoolExemption: 25_000,
      homesteadNonSchoolExemption: nonSchoolExemption,
      rateYear,
    };
    assert.equal(
      calcAdValorem(
        purchasePrice,
        true,
        6.34,
        11.9115,
        18.2515,
        nonSchoolExemption,
      ),
      computeFromCache(row, purchasePrice, true).adValoremTax,
      String(rateYear),
    );
  }
});

test("every supported county uses the low-end purchase basis", () => {
  const counties = [
    "hillsborough",
    "pinellas",
    "manatee",
    "pasco",
    "hernando",
    "sarasota",
    "lee",
    "collier",
    "polk",
  ] as const;
  const currentParcelValues = [300_000, 450_000, 700_000];

  for (const county of counties) {
    for (const justValue of currentParcelValues) {
      assert.deepEqual(
        deriveCountyAssessmentBasis({
          county,
          purchasePrice: 500_000,
          justValue,
          assessedValue: 200_000,
          rateYear: 2026,
        }),
        {
          assessmentRatio: PURCHASE_TAX_LOW_ASSESSMENT_RATIO,
          homesteadNonSchoolExemption: 51_411,
          valueBasis: "low-end-purchase-value",
        },
        `${county} with current just value ${justValue}`,
      );
    }
  }
});

test("2026 indexed non-school homestead exemption is statewide", () => {
  const counties = [
    "hillsborough",
    "pinellas",
    "manatee",
    "pasco",
    "hernando",
    "sarasota",
    "lee",
    "collier",
    "polk",
  ] as const;
  for (const county of counties) {
    assert.equal(
      deriveCountyAssessmentBasis({
        county,
        purchasePrice: 500_000,
        rateYear: 2026,
      }).homesteadNonSchoolExemption,
      51_411,
      county,
    );
  }
});