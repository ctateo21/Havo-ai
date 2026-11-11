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
} from "./property-tax-service";
import { calcAdValorem } from "./hillsborough-tax";
import { PURCHASE_TAX_LOW_ASSESSMENT_RATIO } from "@shared/property-tax-policy";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const BILL_MILLS = [
  { authority: "PINELLAS COUNTY SCHOOL", mills: 6.293 },
  { authority: "PINELLAS COUNTY GENERAL", mills: 10.25 },
];

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

test("Pinellas millage cache recomputes at arbitrary prices", () => {
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
    true,
  );
  assert.equal(
    computeFromCache(row, purchasePrice, true).adValoremTax,
    homesteadAdValorem,
  );
  assert.equal(
    isCacheRowValid(row, 620_000, NOW),
    true,
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