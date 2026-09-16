import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateZillowAddressMatch,
  fetchZillowProperty,
  pickPhotos,
} from "./apify-zillow";

test("Zillow photo extraction supports top-level actor fields", () => {
  assert.deepEqual(
    pickPhotos({
      photos: [
        "https://photos.example/one.jpg",
        { url: "https://photos.example/two.jpg" },
      ],
      imgSrc: "https://photos.example/one.jpg",
    }),
    [
      "https://photos.example/one.jpg",
      "https://photos.example/two.jpg",
    ],
  );
});

test("Zillow photo extraction supports bounded nested actor wrappers", () => {
  assert.deepEqual(
    pickPhotos({
      data: {
        result: {
          property: {
            mediaContents: [
              {
                images: [
                  {
                    mixedSources: {
                      jpeg: [{ url: "https://photos.example/nested.jpg" }],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    }),
    ["https://photos.example/nested.jpg"],
  );
});

test("Zillow current actor response shape normalizes through the full lookup flow", async () => {
  const listingPhotos = Array.from(
    { length: 18 },
    (_, index) => `https://photos.example/palmetto-${index + 1}.jpg`,
  );
  const row = {
    isValid: true,
    listingAddress: {
      street: "112 Palmetto Dunes CIR",
      city: "Naples",
      state: "FL",
      zipCode: "34113",
      full: "112 Palmetto Dunes CIR, Naples, FL 34113",
    },
    listingPrice: {
      amount: 525_000,
      currency: "USD",
      formatted: "$525,000",
    },
    lastSoldPrice: 547_500,
    homeType: "SINGLE_FAMILY",
    yearBuilt: 1998,
    bedrooms: 3,
    bathrooms: 2,
    livingArea: 1_950,
    listingPhotos,
    mainImage: "https://photos.example/palmetto-main.jpg",
    propertyUrl: "https://www.zillow.com/homedetails/palmetto/",
    description: "Updated electrical and newer roof.",
  };
  const wrongProperty = {
    ...row,
    listingAddress: {
      ...row.listingAddress,
      street: "114 Palmetto Dunes CIR",
      full: "114 Palmetto Dunes CIR, Naples, FL 34113",
    },
  };

  const originalFetch = globalThis.fetch;
  const originalToken = process.env.APIFY_TOKEN;
  process.env.APIFY_TOKEN = "test-token";
  let requestCount = 0;
  (globalThis as any).fetch = async () => {
    requestCount++;
    return new Response(JSON.stringify([wrongProperty, row]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const normalized = await fetchZillowProperty(
      "112 Palmetto Dunes Circle, Naples, FL 34113",
    );

    assert.equal(requestCount, 1);
    assert.equal(
      normalized.address,
      "112 Palmetto Dunes CIR, Naples, FL 34113",
    );
    assert.equal(normalized.zillowUrl, row.propertyUrl);
    assert.equal(normalized.listingPrice, 525_000);
    assert.equal(normalized.purchasePrice, 525_000);
    // The current response has no Zestimate; listing price must not be
    // silently re-labelled as a Zestimate.
    assert.equal(normalized.zestimate, null);
    assert.equal(normalized.propertyType, "Single Family");
    assert.equal(normalized.yearBuilt, 1998);
    assert.equal(normalized.bedrooms, 3);
    assert.equal(normalized.bathrooms, 2);
    assert.equal(normalized.squareFeet, 1_950);
    assert.equal(normalized.photos.length, 19);
    assert.equal(
      normalized.photos[0],
      "https://photos.example/palmetto-main.jpg",
    );
    assert.deepEqual(normalized.photos.slice(1), listingPhotos);
    assert.equal(normalized.googleCity, "Naples");
    assert.equal(normalized.zillowCity, "Naples");
    assert.equal(normalized.cityMismatch, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = originalToken;
  }
});

test("Zillow current actor addresses retain strict unit matching", () => {
  const row = {
    listingAddress: {
      street: "112 Palmetto Dunes CIR Unit 2",
      city: "Naples",
      state: "FL",
      zipCode: "34113",
      full: "112 Palmetto Dunes CIR Unit 2, Naples, FL 34113",
    },
  };

  const wrongUnit = evaluateZillowAddressMatch(
    "112 Palmetto Dunes Circle Unit 1, Naples, FL 34113",
    row,
  );
  assert.equal(wrongUnit.accept, false);
  assert.equal(wrongUnit.reason, "street name mismatch");
});
