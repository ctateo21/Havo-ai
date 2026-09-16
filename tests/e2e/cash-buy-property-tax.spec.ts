import { expect, test, type Page, type Route } from "@playwright/test";

const COLLier_ADDRESS = "100 Test Ave, Naples, FL 34102";
const TEST_USER = {
  id: "00000000-0000-4000-8000-000000000069",
  aud: "authenticated",
  role: "authenticated",
  email: "cash-buy-browser-test@example.com",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { name: "Cash Buy Browser Test" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

type TaxReply =
  | { defer: true }
  | {
      annualTax?: number;
      source?: string;
      parcelId?: string;
      taxDistrict?: string;
      millageRate?: number;
      nonAdValoremPending?: boolean;
      useFallback?: boolean;
    };

type PendingRoute = {
  route: Route;
  finish: () => void;
};

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installCashBuyMocks(
  page: Page,
  options: {
    zillowPending?: boolean;
    zillowPrice?: number;
    taxReplies?: TaxReply[];
  } = {},
) {
  const pendingZillow: PendingRoute[] = [];
  const pendingTaxes: PendingRoute[] = [];
  const taxReplies = [...(options.taxReplies ?? [{
    annualTax: 4_321,
    source: "county-estimator",
    parcelId: "COL-TEST-1",
  }])];
  let zillowRequests = 0;
  let taxRequests = 0;

  await page.route("**/api/zillow-property-lookup", route => {
    zillowRequests += 1;
    const body = {
      property: {
        purchasePrice: options.zillowPrice ?? 500_000,
        listingPrice: options.zillowPrice ?? 500_000,
        photos: ["https://example.com/cash-buy-test.jpg"],
        yearBuilt: 2020,
        propertyType: "Single Family Residence",
      },
      cached: false,
    };
    if (options.zillowPending) {
      return new Promise<void>(finish => {
        pendingZillow.push({ route, finish });
      });
    }
    return fulfillJson(route, body);
  });

  await page.route("**/api/property-tax/county", route => {
    taxRequests += 1;
    const reply = taxReplies.shift() ?? { useFallback: true };
    if ("defer" in reply) {
      return new Promise<void>(finish => {
        pendingTaxes.push({ route, finish });
      });
    }
    return fulfillJson(route, reply);
  });

  await page.route("**/api/flood-zone**", route =>
    fulfillJson(route, {
      zone: "X",
      subtype: "minimal",
      requiresFloodInsurance: false,
    }),
  );
  await page.route("**/api/subscription/status**", route =>
    fulfillJson(route, { active: true, status: "browser-test" }),
  );

  return {
    getZillowRequests: () => zillowRequests,
    getTaxRequests: () => taxRequests,
    async resolveZillow() {
      const pending = pendingZillow.shift();
      if (!pending) throw new Error("No pending Zillow request");
      await fulfillJson(pending.route, {
        property: {
          purchasePrice: options.zillowPrice ?? 500_000,
          listingPrice: options.zillowPrice ?? 500_000,
          photos: ["https://example.com/cash-buy-test.jpg"],
          yearBuilt: 2020,
          propertyType: "Single Family Residence",
        },
        cached: false,
      });
      pending.finish();
    },
    async resolveTax(body: TaxReply) {
      const pending = pendingTaxes.shift();
      if (!pending) throw new Error("No pending tax request");
      if ("defer" in body) throw new Error("A deferred tax response needs a result");
      await fulfillJson(pending.route, body);
      pending.finish();
    },
  };
}

async function openCashBuy(page: Page, address = COLLier_ADDRESS): Promise<void> {
  await page.goto(`/cash-buy?address=${encodeURIComponent(address)}`);
  await expect(page.getByTestId("cash-buy-property-taxes")).toBeVisible();
}

function taxRow(page: Page) {
  return page.getByTestId("cash-buy-property-taxes");
}

function taxInput(page: Page) {
  return taxRow(page).locator("input");
}

test("shows an official Collier purchase-estimator result and badge", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{
      annualTax: 4_321,
      source: "county-estimator",
      parcelId: "COL-VERIFIED",
      taxDistrict: "Naples",
    }],
  });
  await openCashBuy(page);

  await expect.poll(state.getTaxRequests).toBe(1);
  await expect(taxRow(page)).toContainText("Official estimate");
  await expect(taxInput(page)).toHaveValue("4,321");
  await expect(taxRow(page)).toContainText("county purchase-estimator");
});

test("leaves an unavailable official estimate for manual entry", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{ useFallback: true }],
  });
  await openCashBuy(page);

  await expect.poll(state.getTaxRequests).toBe(1);
  await expect(taxRow(page)).toContainText("Official unavailable");
  await expect(taxRow(page)).toContainText("No formula estimate is shown");
  await expect(taxInput(page)).toHaveValue("");
});

test("manual tax edits survive a pending parcel response", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{ defer: true }],
  });
  await openCashBuy(page);
  await expect.poll(state.getTaxRequests).toBe(1);
  await expect(taxRow(page)).toContainText("Looking up parcel");

  await taxInput(page).fill("12000");
  // NumRow intentionally keeps the raw edit while the input is focused.
  await expect(taxInput(page)).toHaveValue("12000");
  await expect(taxRow(page)).toContainText("Manual");

  await state.resolveTax({
    annualTax: 4_321,
    source: "county-estimator",
    parcelId: "COL-LATE",
  });
  await expect(taxInput(page)).toHaveValue("12000");
  await expect(taxRow(page)).toContainText("Manual");
});

test("manual tax edits survive Zillow price hydration", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    zillowPending: true,
    taxReplies: [{ defer: true }],
  });
  await openCashBuy(page);

  // Zillow has not supplied a price yet, but the draft's tax field is still
  // editable. This reproduces a saved/manual-value hydration race.
  await taxInput(page).fill("12000");
  await expect(taxInput(page)).toHaveValue("12000");
  await state.resolveZillow();

  await expect.poll(state.getTaxRequests).toBe(0);
  await expect(taxInput(page)).toHaveValue("12000");
  await expect(taxRow(page)).toContainText("Manual");
});

test("ignores a stale tax response after the purchase price changes", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{ defer: true }, { defer: true }],
  });
  await openCashBuy(page);
  await expect.poll(state.getTaxRequests).toBe(1);

  await page.getByTestId("cash-buy-purchase-price").locator("input").fill("600000");
  await expect.poll(state.getTaxRequests).toBe(2);
  await state.resolveTax({
    annualTax: 4_321,
    source: "county-estimator",
  });
  // The official-only policy leaves the changed request unavailable until
  // the second official response resolves; the old result cannot win.
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page)).toContainText("Looking up parcel");

  await state.resolveTax({
    annualTax: 6_789,
    source: "county-estimator",
  });
  await expect(taxInput(page)).toHaveValue("6,789");
  await expect(taxRow(page)).toContainText("Official estimate");
});

test("ignores a stale tax response after property use changes", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{ defer: true }, { defer: true }],
  });
  await openCashBuy(page);
  await expect.poll(state.getTaxRequests).toBe(1);

  await page.getByTestId("select-cash-occupancy").click();
  await page.getByRole("option", { name: "Investment" }).click();
  await expect.poll(state.getTaxRequests).toBe(2);
  await state.resolveTax({
    annualTax: 4_321,
    source: "county-estimator",
  });
  // The official-only policy leaves the changed request unavailable until
  // the second official response resolves.
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page)).toContainText("Looking up parcel");

  await state.resolveTax({
    annualTax: 7_654,
    source: "county-estimator",
  });
  await expect(taxInput(page)).toHaveValue("7,654");
  await expect(taxRow(page)).toContainText("Official estimate");
});

test("keeps an official tax after same-price Zillow hydration", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    zillowPending: true,
    taxReplies: [{ defer: true }],
  });
  await openCashBuy(page);

  // Seed the same price while Zillow is pending so the official response can
  // arrive first. Zillow's later photo/year hydration must not demote it.
  await page.getByTestId("cash-buy-purchase-price").locator("input").fill("500000");
  await expect.poll(state.getTaxRequests).toBe(1);
  await state.resolveTax({ annualTax: 4_321, source: "county-estimator" });
  await expect(taxRow(page)).toContainText("Official estimate");
  await state.resolveZillow();

  await expect(taxInput(page)).toHaveValue("4,321");
  await expect(taxRow(page)).toContainText("Official estimate");
});

test("keeps an official tax while closing-cost controls change", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{ annualTax: 4_321, source: "county-estimator" }],
  });
  await openCashBuy(page);
  await expect.poll(state.getTaxRequests).toBe(1);
  await expect(taxRow(page)).toContainText("Official estimate");

  await page.getByTestId("cash-buy-closing-percent").locator("input").fill("3");
  await expect(taxInput(page)).toHaveValue("4,321");
  await expect(taxRow(page)).toContainText("Official estimate");
  await page.getByTestId("btn-closing-mode-dollar").click();
  await page.getByTestId("cash-buy-closing-dollar").locator("input").fill("20000");
  await expect(taxInput(page)).toHaveValue("4,321");
  await expect(taxRow(page)).toContainText("Official estimate");
});

test("preserves a saved manual tax after reload and skips late hydration lookups", async ({
  page,
}) => {
  const savedAddress = "200 Saved Way, Naples, FL 34102";
  const savedId = "cash-buy-saved-manual-69";
  const savedScenario = {
    id: savedId,
    full_address: savedAddress,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    purchase_price: 500_000,
    purchase_price_source: "user",
    occupancy_type: "primary",
    property_taxes: 12_000,
    property_taxes_source: "manual",
    homeowners_insurance: 4_000,
    hoa_amount: 0,
    hoa_frequency: "monthly",
    hoa_source: "unknown",
    buyer_closing_costs: 10_000,
    closing_costs_percent: 2,
    closing_costs_source: "default_percent",
    property_photos: ["https://example.com/saved-cash-buy.jpg"],
    insurance_factors: {
      regionKey: "swfl",
      roofIdx: 1,
      windIdx: 1,
      hurrIdx: 0,
      constIdx: 0,
      yearIdx: 0,
      claimsIdx: 0,
    },
  };
  const now = Math.floor(Date.now() / 1000);
  await page.addInitScript(
    ({ user, scenario, accessNow }) => {
      localStorage.setItem(
        "tateo_supabase_session",
        JSON.stringify({
          access_token: "cash-buy-browser-access-token",
          refresh_token: "cash-buy-browser-refresh-token",
          expires_in: 3600,
          expires_at: accessNow + 3600,
          token_type: "bearer",
          user,
        }),
      );
      localStorage.setItem("tateo_auth", "1");
      (window as any).__savedCashBuy = scenario;
    },
    { user: TEST_USER, scenario: savedScenario, accessNow: now },
  );

  let zillowRequests = 0;
  let taxRequests = 0;
  await page.route("**/auth/v1/user", route => fulfillJson(route, TEST_USER));
  await page.route("**/rest/v1/**", route => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/rest/v1/")[1]?.split("/")[0];
    if (table === "profiles" && route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/1" },
        body: JSON.stringify({
          id: TEST_USER.id,
          name: TEST_USER.user_metadata.name,
          email: TEST_USER.email,
          created_at: TEST_USER.created_at,
        }),
      });
    }
    if (table === "cash_buy_scenarios" && route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/1" },
        body: JSON.stringify([savedScenario]),
      });
    }
    return fulfillJson(route, []);
  });
  await page.route("**/api/zillow-property-lookup", route => {
    zillowRequests += 1;
    return fulfillJson(route, { property: null });
  });
  await page.route("**/api/property-tax/county", route => {
    taxRequests += 1;
    return fulfillJson(route, {
      annualTax: 4_321,
      source: "county-estimator",
    });
  });
  await page.route("**/api/flood-zone**", route =>
    fulfillJson(route, {
      zone: "X",
      subtype: "minimal",
      requiresFloodInsurance: false,
    }),
  );
  await page.route("**/api/subscription/status**", route =>
    fulfillJson(route, { active: true, status: "browser-test" }),
  );

  await page.goto(
    `/cash-buy?address=${encodeURIComponent(savedAddress)}&id=${savedId}`,
  );
  await expect(page.getByText("Annual Property Taxes")).toBeVisible();
  await expect(taxInput(page)).toHaveValue("12,000");
  await expect(taxRow(page)).toContainText("Manual");
  // Saved photos are present, but the legacy row has no exact Zillow year;
  // the completion path still runs and must not overwrite manual taxes.
  await expect.poll(() => zillowRequests).toBe(1);
  await expect.poll(() => taxRequests).toBe(0);
});