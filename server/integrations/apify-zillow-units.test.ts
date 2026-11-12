import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNormalizedPropertyKey,
  evaluateZillowAddressMatch,
  fetchZillowProperty,
} from "./apify-zillow";

const requestedUnit =
  "501 Knights Run Avenue Unit 2111, Tampa, FL 33602, USA";

const currentRow = {
  isValid: true,
  listingAddress: {
    street: "501 KNIGHTS RUN AVENUE #2111",
    city: "Tampa",
    state: "FL",
    zipCode: "33602",
    full: "501 KNIGHTS RUN AVENUE #2111, Tampa, FL 33602",
  },
  listingPrice: {
    amount: 359_900,
    currency: "USD",
    formatted: "$359,900",
  },
  homeType: "CONDO",
  propertyUrl:
    "https://www.zillow.com/homedetails/501-Knights-Run-Ave-APT-2111-Tampa-FL-33602/2074400538_zpid/",
};

test("Zillow unit parsing handles compact queries and contradictory units", () => {
  assert.equal(evaluateZillowAddressMatch(
    "501 Knights Run Ave Apt 2111 FL 33602", currentRow,
  ).accept, true);
  assert.equal(buildNormalizedPropertyKey("501 Knights Run Ave #2111 FL 33602"),
    buildNormalizedPropertyKey(requestedUnit));
  assert.equal(evaluateZillowAddressMatch(requestedUnit, {
    ...currentRow, unitNumber: "2112",
  }).accept, false);
  assert.equal(evaluateZillowAddressMatch(
    "501 Knights Run Ave Unit 2111, Apt 2112, Tampa, FL 33602", currentRow,
  ).accept, false);
});

test("Zillow unit aliases identify the same current and legacy listing", () => {
  for (const designator of ["Unit", "Apt", "Apartment", "#"]) {
    const decision = evaluateZillowAddressMatch(
      `501 Knights Run Avenue ${designator} 2111, Tampa, FL 33602`,
      currentRow,
    );
    assert.equal(decision.accept, true, `${designator}: ${decision.reason}`);
  }

  const legacyRow = {
    address: {
      streetAddress: "501 Knights Run Ave Apt 2111",
      city: "Tampa",
      state: "FL",
      zipcode: "33602",
    },
  };
  assert.equal(
    evaluateZillowAddressMatch(
      "501 KNIGHTS RUN AVENUE apartment #2111, TAMPA, fl 33602",
      legacyRow,
    ).accept,
    true,
  );

  const directionalRow = {
    listingAddress: {
      street: "501 NORTH KNIGHTS RUN AVENUE, APT. #2111",
      city: "TAMPA",
      state: "fl",
      zipCode: "33602",
    },
  };
  assert.equal(
    evaluateZillowAddressMatch(
      "501 N. Knights Run Ave. unit 2111, Tampa, FL 33602",
      directionalRow,
    ).accept,
    true,
  );
});

test("Zillow unit matching rejects another or unverifiable residence", () => {
  const wrongUnit = {
    ...currentRow,
    listingAddress: {
      ...currentRow.listingAddress,
      street: "501 KNIGHTS RUN AVENUE #2112",
      full: "501 KNIGHTS RUN AVENUE #2112, Tampa, FL 33602",
    },
  };
  assert.equal(
    evaluateZillowAddressMatch(requestedUnit, wrongUnit).accept,
    false,
  );

  const buildingOnly = {
    listingAddress: {
      street: "501 KNIGHTS RUN AVENUE",
      city: "Tampa",
      state: "FL",
      zipCode: "33602",
    },
  };
  assert.equal(
    evaluateZillowAddressMatch(requestedUnit, buildingOnly).accept,
    false,
  );
  assert.equal(
    evaluateZillowAddressMatch(
      "501 Knights Run Avenue, Tampa, FL 33602",
      currentRow,
    ).accept,
    false,
  );

  const zipOnlyRow = {
    listingAddress: {
      city: "Tampa",
      state: "FL",
      zipCode: "33602",
    },
  };
  assert.equal(
    evaluateZillowAddressMatch(requestedUnit, zipOnlyRow).accept,
    false,
  );
});

test("Zillow unit aliases share cache keys without colliding with the building", () => {
  const aliases = ["Unit 2111", "Apt 2111", "Apartment 2111", "#2111"];
  const keys = aliases.map((unit) =>
    buildNormalizedPropertyKey(
      `501 Knights Run Avenue ${unit}, Tampa, FL 33602`,
    ),
  );

  assert.ok(keys[0]);
  assert.equal(new Set(keys).size, 1);
  assert.notEqual(
    keys[0],
    buildNormalizedPropertyKey(
      "501 Knights Run Avenue, Tampa, FL 33602",
    ),
  );
  assert.notEqual(
    keys[0],
    buildNormalizedPropertyKey(
      "501 Knights Run Avenue Apt 2112, Tampa, FL 33602",
    ),
  );
});

test("unit lookup canonicalizes actor queries and stops after an accepted row", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.APIFY_TOKEN;
  const queries: string[] = [];
  process.env.APIFY_TOKEN = "test-token";
  (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    queries.push(body.addresses[0]);
    return new Response(JSON.stringify([currentRow]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const property = await fetchZillowProperty(requestedUnit);

    assert.equal(queries.length, 1);
    assert.match(queries[0], /\bApt\s+#?2111\b/i);
    assert.doesNotMatch(queries[0], /\bUSA\b/i);
    assert.equal(property.listingPrice, 359_900);
    assert.equal(property.propertyType, "Condo");
    assert.equal(property.zillowUrl, currentRow.propertyUrl);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = originalToken;
  }
});

test("a rejected unit row triggers one bounded hash-alias retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.APIFY_TOKEN;
  const queries: string[] = [];
  process.env.APIFY_TOKEN = "test-token";
  (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    queries.push(body.addresses[0]);
    return new Response(
      JSON.stringify(queries.length === 1
        ? [{
            ...currentRow,
            listingAddress: {
              ...currentRow.listingAddress,
              street: "501 KNIGHTS RUN AVENUE #2112",
              full: "501 KNIGHTS RUN AVENUE #2112, Tampa, FL 33602",
            },
          }]
        : [currentRow]),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const property = await fetchZillowProperty(requestedUnit);

    assert.equal(queries.length, 2);
    assert.match(queries[0], /\bApt\s+#?2111\b/i);
    assert.doesNotMatch(queries[0], /\bUSA\b/i);
    assert.match(queries[1], /#2111\b/);
    assert.equal(property.listingPrice, 359_900);
    assert.equal(property.zillowUrl, currentRow.propertyUrl);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = originalToken;
  }
});