import { expect, test, type Page, type Route } from "./quote-access-fixture";
import { blockLiveNetwork } from "./mock-network";

test.beforeEach(async ({page}) => { await blockLiveNetwork(page); });

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
      annualTax?: number | null;
      source?: string;
      parcelId?: string;
      taxDistrict?: string;
      millageRate?: number;
      nonAdValoremPending?: boolean;
      useFallback?: boolean;
      key?: string;
      status?: "estimate" | "area_estimate" | "rough_estimate" | "official" | "unavailable";
      officialState?: "pending" | "complete" | "failed";
      nav?: number | null;
      navPending?: boolean;
      label?: string;
      reason?: string;
    };

type PendingRoute = {
  route: Route;
  finish: () => void;
  key?: string;
};

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function fulfillTax(route: Route, reply: Exclude<TaxReply, {defer:true}>, key: string) {
  const annual = typeof reply.annualTax === "number" ? reply.annualTax : null;
  const status = reply.status ?? (annual === null || reply.useFallback ? "unavailable" : "official");
  const source = { name:"Synthetic Collier County Property Appraiser Tax Estimator",url:"https://www.collierappraiser.com/",
    fetchedAt:"2026-11-12T12:00:00Z",taxYear:2026,parcelId:reply.parcelId??"COL-TEST" };
  const nav = reply.nav ?? (status === "official" ? 0 : null);
  const av = annual === null ? null : Math.round((annual - (nav ?? 0))*100)/100;
  await fulfillJson(route, {
    ...reply, key:reply.key??key,status,annualTax:annual,monthlyTax:annual===null?null:annual/12,
    adValorem:av,nav,navPending:reply.navPending??nav===null,taxYear:2026,ratesYear:2026,
    district:reply.taxDistrict??"Synthetic Naples district",sourceName:source.name,sourceUrl:source.url,
    label:reply.label??(status==="official"?"Official county purchase-estimator":"Estimated from synthetic district millage"),
    reason:reply.reason??(status==="unavailable"?"Official county figure unavailable.":undefined),
    officialState:reply.officialState??(status==="official"?"complete":status==="unavailable"?"failed":"pending"),
    ...(status==="official"&&annual!==null ? {breakdown:{
      adValorem:{cents:Math.round(av!*100),source},
      nonAdValorem:{cents:Math.round((nav??0)*100),source:{...source,name:"Synthetic Collier County Tax Collector",url:"https://county-taxes.net/fl-collier/property-tax"}},
      total:{cents:Math.round(annual*100)},warnings:[],
    }}:{}),
  });
}

async function installCashBuyMocks(
  page: Page,
  options: {
    zillowPending?: boolean;
    zillowPrice?: number;
    taxReplies?: TaxReply[];
    officialReplies?: Exclude<TaxReply, {defer:true}>[];
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
  let officialRequests = 0;
  const officialReplies = [...(options.officialReplies??[])];

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

  await page.route("**/api/property-tax/quick", route => {
    taxRequests += 1;
    const reply = taxReplies.shift() ?? { useFallback: true };
    if ("defer" in reply) {
      return new Promise<void>(finish => {
        pendingTaxes.push({ route, finish, key:`mock-tax-${taxRequests}` });
      });
    }
    return fulfillTax(route, reply, `mock-tax-${taxRequests}`);
  });
  await page.route("**/api/property-tax/official-status?**", route => {
    officialRequests += 1;
    return fulfillTax(route, officialReplies.shift()??{useFallback:true}, new URL(route.request().url()).searchParams.get("key")!);
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
    getOfficialRequests: () => officialRequests,
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
      await fulfillTax(pending.route, body, pending.key!);
      pending.finish();
    },
  };
}

async function openCashBuy(page: Page, address = COLLier_ADDRESS, expanded = true): Promise<void> {
  await page.goto(`/cash-buy?address=${encodeURIComponent(address)}`);
  await expect(page.getByTestId("cash-buy-property-taxes")).toBeVisible();
  await page.getByTestId("select-cash-occupancy").click();
  await page.getByRole("option",{name:"Primary Residence",exact:true}).click();
  if(expanded) await expandTax(page);
}

function taxRow(page: Page) {
  return page.getByTestId("cash-buy-property-taxes");
}

function taxInput(page: Page) {
  return taxRow(page).locator("input");
}

async function expandTax(page: Page) {
  const toggle = taxRow(page).getByRole("button", {name:/Property Taxes/});
  if(await toggle.getAttribute("aria-expanded")==="false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded","true");
}

test("blank use is unavailable and only primary sends homestead",async({page})=>{
  const state=await installCashBuyMocks(page,{taxReplies:Array.from({length:3},()=>({annualTax:4321,source:"county-estimator"}))});
  const flags:boolean[]=[];
  page.on("request",req=>{if(req.url().endsWith("/api/property-tax/quick"))flags.push(req.postDataJSON().isPrimaryResidence);});
  await page.goto(`/cash-buy?address=${encodeURIComponent(COLLier_ADDRESS)}`);
  await expandTax(page);
  await expect(taxRow(page)).toContainText("Select Property Use");
  await expect(taxInput(page)).toHaveValue("");
  expect(state.getTaxRequests()).toBe(0);
  for(const label of ["Investment","Primary Residence","Secondary Home"]){
    await page.getByTestId("select-cash-occupancy").click();
    await page.getByRole("option",{name:label,exact:true}).click();
    await expect.poll(()=>flags.length).toBe(["Investment","Primary Residence","Secondary Home"].indexOf(label)+1);
  }
  expect(flags).toEqual([false,true,false]);
});

test("unavailable components do not produce a numeric monthly total",async({page})=>{
  await installCashBuyMocks(page,{taxReplies:[{useFallback:true}]});await openCashBuy(page);
  await expect(page.getByText("Unavailable — property tax missing",{exact:true})).toBeVisible();
  await expect(taxInput(page)).toHaveValue("");
});

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
  await expect(taxRow(page).getByText("Official",{exact:true})).toBeVisible();
  await expect(taxRow(page)).toContainText("$4,321.00/yr");
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page)).toContainText("county purchase-estimator");
});

test("leaves an unavailable official estimate for manual entry", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{ useFallback: true }],
  });
  await openCashBuy(page);

  await expect.poll(state.getTaxRequests).toBe(1);
  await expect(taxRow(page)).toContainText("Official county figure unavailable");
  await expect(taxRow(page)).toContainText("No fallback rate has been substituted");
  await expect(taxInput(page)).toHaveValue("");
});

test("manual tax edits survive a pending parcel response", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{ defer: true }],
  });
  await openCashBuy(page);
  await expect.poll(state.getTaxRequests).toBe(1);
  await expect(taxRow(page)).toContainText("Checking property tax sources");

  await taxInput(page).fill("12000");
  // Manual bill editing stays independent of the background tax job.
  await expect(taxInput(page)).toHaveValue("12000");
  await expect(taxRow(page)).toContainText("Your bill");

  await state.resolveTax({
    annualTax: 4_321,
    source: "county-estimator",
    parcelId: "COL-LATE",
  });
  await expect(taxInput(page)).toHaveValue("12000");
  await expect(taxRow(page)).toContainText("Your bill");
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
  await expect(taxRow(page)).toContainText("Your bill");
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
  // The changed tuple stays unavailable until its own response resolves;
  // the old result cannot win.
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page)).toContainText("Checking property tax sources");

  await state.resolveTax({
    annualTax: 6_789,
    source: "county-estimator",
  });
  await expect(taxRow(page)).toContainText("$6,789.00/yr");
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page).getByText("Official",{exact:true})).toBeVisible();
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
  // The changed tuple stays unavailable until its own response resolves.
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page)).toContainText("Checking property tax sources");

  await state.resolveTax({
    annualTax: 7_654,
    source: "county-estimator",
  });
  await expect(taxRow(page)).toContainText("$7,654.00/yr");
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page).getByText("Official",{exact:true})).toBeVisible();
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
  await expect(taxRow(page).getByText("Official",{exact:true})).toBeVisible();
  await state.resolveZillow();

  await expect(taxRow(page)).toContainText("$4,321.00/yr");
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page).getByText("Official",{exact:true})).toBeVisible();
});

test("keeps an official tax while closing-cost controls change", async ({ page }) => {
  const state = await installCashBuyMocks(page, {
    taxReplies: [{ annualTax: 4_321, source: "county-estimator" }],
  });
  await openCashBuy(page);
  await expect.poll(state.getTaxRequests).toBe(1);
  await expect(taxRow(page).getByText("Official",{exact:true})).toBeVisible();

  await page.getByTestId("cash-buy-closing-percent").locator("input").fill("3");
  await expect(taxRow(page)).toContainText("$4,321.00/yr");
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page).getByText("Official",{exact:true})).toBeVisible();
  await page.getByTestId("btn-closing-mode-dollar").click();
  await page.getByTestId("cash-buy-closing-dollar").locator("input").fill("20000");
  await expect(taxRow(page)).toContainText("$4,321.00/yr");
  await expect(taxInput(page)).toHaveValue("");
  await expect(taxRow(page).getByText("Official",{exact:true})).toBeVisible();
});

test("quick tax journey verifies officially, retains estimates on failure, and uses a compact keyboard-accessible row", async ({page}) => {
  await page.clock.install();
  const state = await installCashBuyMocks(page, {
    taxReplies:[
      {status:"estimate",annualTax:4321.17,nav:null,navPending:true,officialState:"pending",label:"Estimated from synthetic 2026 district millage"},
      {status:"area_estimate",annualTax:4321.17,nav:null,navPending:true,officialState:"pending",label:"Area estimate from synthetic 2026 district millage"},
    ],
    officialReplies:[
      {status:"official",annualTax:4625.53,nav:304.36,navPending:false,officialState:"complete"},
      {status:"unavailable",annualTax:null,officialState:"failed",reason:"Fixture collector timed out"},
    ],
  });
  await openCashBuy(page,COLLier_ADDRESS,false);
  const row = taxRow(page);
  const toggle = row.getByRole("button",{name:/Property Taxes/});
  await expect(row).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-expanded","false");
  await expect(toggle).toContainText("$360.10/mo");
  await expect(toggle).toContainText("Est. · updating");
  await expect(taxInput(page)).toHaveCount(0);
  await expect(page.getByText("Monthly carrying cost (estimate)",{exact:true}).locator("xpath=..")).not.toContainText("Unavailable");

  const insuranceRow = page.getByTestId("cash-buy-homeowners-insurance");
  const taxBounds = await toggle.boundingBox();
  const insuranceBounds = await insuranceRow.getByRole("button",{name:/Homeowners Insurance/}).boundingBox();
  expect(taxBounds).not.toBeNull();
  expect(insuranceBounds).not.toBeNull();
  expect(Math.abs(taxBounds!.height-insuranceBounds!.height)).toBeLessThanOrEqual(1);
  expect(taxBounds!.height).toBeLessThanOrEqual(58);

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded","true");
  await expect(taxInput(page)).toBeVisible();
  await expect(row).toContainText("Pending");
  await expect(row.getByRole("link",{name:/Synthetic Collier/})).toHaveAttribute("href","https://www.collierappraiser.com/");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded","false");
  await expect(taxInput(page)).toHaveCount(0);

  await page.clock.runFor(3000);
  await expect.poll(state.getOfficialRequests).toBe(1);
  await expect(toggle).toContainText("$385.46/mo");
  await expect(row.getByText("Official",{exact:true})).toBeVisible();
  await toggle.press("Enter");
  await expect(row).toContainText("$4,625.53/yr");
  await expect(row).toContainText("$304.36/yr");
  await expect(row).toContainText("COL-TEST");
  await expect(row.getByRole("link",{name:"Synthetic Collier County Tax Collector"})).toHaveAttribute("href","https://county-taxes.net/fl-collier/property-tax");
  await expect(taxInput(page)).toHaveValue("");

  await row.getByRole("button",{name:"Refresh official county data"}).click();
  await expect.poll(state.getTaxRequests).toBe(2);
  await expect(toggle).toContainText("$360.10/mo");
  await expect(toggle).toContainText("Est. · updating");
  await page.clock.runFor(3000);
  await expect.poll(state.getOfficialRequests).toBe(2);
  await expect(toggle).toContainText("$360.10/mo");
  await expect(row.getByText("Estimated",{exact:true})).toBeVisible();
  await expect(row).toContainText("Fixture collector timed out");
  await expect(row).toContainText("Official verification did not complete");
  await expect(row).toContainText("Pending");
  await expect(row.getByText("Official",{exact:true})).toHaveCount(0);
  await expect(page.getByText("Monthly carrying cost (estimate)",{exact:true}).locator("xpath=..")).not.toContainText("Unavailable");
  await taxInput(page).fill("0");
  await expect(toggle).toContainText("$0.00/mo");
  await expect(toggle).toContainText("Your bill");
  await page.clock.runFor(180_000);
  expect(state.getOfficialRequests()).toBe(2);
  await expect(taxInput(page)).toHaveValue("0");
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
    occupancy_type_source: "manual",
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
  await page.route("**/api/property-tax/quick", route => {
    taxRequests += 1;
    return fulfillTax(route, {
      annualTax: 4_321,
      source: "county-estimator",
    }, "saved-manual-lookup");
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
  await expect(taxRow(page)).toBeVisible();
  await expandTax(page);
  await expect(taxRow(page).getByText("Annual property taxes",{exact:true})).toBeVisible();
  await expect(taxInput(page)).toHaveValue("12000");
  await expect(taxRow(page)).toContainText("Your bill");
  // Saved photos are present, but the legacy row has no exact Zillow year;
  // the completion path still runs and must not overwrite manual taxes.
  await expect.poll(() => zillowRequests).toBe(1);
  await expect.poll(() => taxRequests).toBe(0);
});