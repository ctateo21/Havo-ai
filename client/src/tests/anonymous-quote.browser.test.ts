import { expect, test, type Page } from "@playwright/test";

const ADDRESS = "7400 36th Ave N, St Petersburg, FL 33710";
const OTHER = "1800 4th Street N, St Petersburg, FL 33704";
const flows = [
  { path: "/estimate", type: "purchase", action: "purchase" },
  { path: "/cash-buy", type: "cash", action: "cash_buy" },
  { path: "/refinance", type: "refinance", action: "refinance" },
  { path: "/insurance", type: "insurance", action: "insurance" },
  { path: "/seller", type: "seller", action: "seller" },
] as const;
const user = {
  id: "00000000-0000-4000-8000-000000000091", aud: "authenticated", role: "authenticated",
  email: "anonymous-flow@example.test", email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] }, identities: [],
  user_metadata: { name: "Marisol Vega", phone: "7275550194", agent: "Team" },
  created_at: "2026-01-01T00:00:00Z",
};

type Call = { path: string; method: string; body: any; bearer?: string };

/** All provider calls, CRM, database writes and paid APIs are intercepted. */
async function fixture(page: Page, options: { signedIn?: boolean; saveFailure?: boolean; taxResult?: boolean } = {}) {
  const calls: Call[] = [];
  let claimed: string | null = null;
  let signedIn = !!options.signedIn;
  if (signedIn) await page.addInitScript(user => {
    const session = JSON.stringify({ access_token: "anonymous-flow-real-session", refresh_token: "anonymous-flow-refresh",
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user });
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key: string) {
      return key === "tateo_supabase_session" || key === "supabase.auth.token" || /^sb-.+-auth-token$/.test(key)
        ? session : original.call(this, key);
    };
  }, user);
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body: any = null;
    try { body = request.postDataJSON(); } catch { /* GET, or an asset. */ }
    const json = (value: unknown, status = 200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(value),
    });
    if (url.pathname.includes("/auth/v1/")) {
      calls.push({ path: url.pathname, method: request.method(), body });
      if (url.pathname.endsWith("/signup") || url.pathname.endsWith("/token")) {
        signedIn = true;
        return json({ access_token: "anonymous-flow-real-session", refresh_token: "anonymous-flow-refresh",
          expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user });
      }
      if (url.pathname.endsWith("/user") && signedIn) return json(user);
      return json({ message: "No session" }, 401);
    }
    if (url.pathname.includes("/rest/v1/")) {
      calls.push({ path: url.pathname, method: request.method(), body, bearer: request.headers().authorization });
      if (options.saveFailure && url.pathname.endsWith("/cash_buy_scenarios") && request.method() === "POST") {
        return json({ message: "Fixture persistence failure" }, 503);
      }
      if (url.pathname.endsWith("/profiles")) return json({
        id: user.id, name: "Marisol Vega", email: user.email, phone: "7275550194", agent: "Team",
        has_date_of_birth: true, created_at: user.created_at,
      });
      return json([]);
    }
    if (url.pathname.startsWith("/api/")) {
      calls.push({ path: url.pathname, method: request.method(), body, bearer: request.headers().authorization });
      if (url.pathname === "/api/anonymous-quote/start") {
        const key = normalize(body.address);
        if (!claimed || claimed === key || signedIn) {
          claimed ??= key;
          return json({ allowed: true, quoteType: body.quoteType, address: body.address });
        }
        return json({ code: "SIGN_UP_REQUIRED", error: "Create an account for another quote." }, 401);
      }
      const lookupAddress = body?.addressOrUrl || body?.address || body?.location || url.searchParams.get("address");
      if (!signedIn && lookupAddress && (!claimed || normalize(lookupAddress) !== claimed)) {
        return json({code:"SIGN_UP_REQUIRED"},401);
      }
      if (url.pathname === "/api/zillow-property-lookup") return json({
        cached: true, property: { address: body?.addressOrUrl || ADDRESS,
          purchasePrice: 385000, listingPrice: 385000, yearBuilt: 1958,
          hoaMonthly: 0, photos: [], propertyType: "SINGLE_FAMILY" },
      });
      if (url.pathname === "/api/insurance/property-characteristics") return json({
        yearBuilt: 1958, squareFeetLiving: 1166, constructionLabel: "CONCRETE BLOCK", floodZone: "X",
        fieldSources: Object.fromEntries(Object.entries({
          yearBuilt: 1958, squareFeetLiving: 1166, constructionLabel: "CONCRETE BLOCK", floodZone: "X",
        }).map(([name, value]) => [name, { value, source: "Florida DOR 2026",
          fetchedAt: "2026-09-10T12:00:00Z", sourceUrl: "https://example.test/source" }])),
        roofPermits: [],
      });
      if (url.pathname === "/api/insurance/rebuild-rate") return json({
        county: "pinellas", countyName: "Pinellas", frame_cost_per_sqft: 238,
        masonry_cost_per_sqft: 224, source_note: "Fixture only", updated_at: "2026-09-01",
      });
      if (url.pathname === "/api/flood-zone") return json({ zone: "X", requiresFloodInsurance: false });
      if (url.pathname === "/api/mortgage-rates") return json({ conventional: 6.82, fha: 6.17, va: 6.25 });
      if (url.pathname === "/api/ami") return json({annualAMI:80000,monthlyAMI:6667,areaName:"Synthetic test area"});
      if (url.pathname === "/api/rates") return json({ rates: [], source: "Fixture", disclaimer: "Test estimates" });
      if (url.pathname === "/api/insurance/quote-assumptions") return json({ assumedCreditScore: "Excellent" });
      if (url.pathname === "/api/property-tax/quick") return json(options.taxResult
        ? {key:"guest-tax",status:"estimate",annualTax:5890,adValorem:5890,nav:0,navPending:false,
          taxYear:2026,ratesYear:2026,sourceName:"Fixture county millage",officialState:"complete"}
        : {key:"guest-tax",status: "unavailable",officialState:"failed", reason: "Fixture — enter a manual bill." });
      if (url.pathname === "/api/profile/status") return json({ hasDateOfBirth: signedIn });
      return json({});
    }
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  return calls;
}

async function visit(page: Page, path: string, address = ADDRESS) {
  await page.goto(`${path}?address=${encodeURIComponent(address)}`);
}
async function assertSignup(page: Page) {
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Run your first quote free, no sign-up needed.", { exact: false }).last()).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("checkbox")).not.toBeChecked();
}
function anonymousWrites(calls: Call[]) {
  return calls.filter(call => /\/rest\/v1\//.test(call.path) && !["GET", "HEAD"].includes(call.method)
    || /\/api\/(?:leads|fub|insurance\/qr-start|ifw\/activity)/.test(call.path));
}

test("guest purchase reaches populated results with no denied lookup", async ({page})=>{
  const denied:string[]=[];
  page.on("response",r=>{if(r.status()===401&&new URL(r.url()).pathname.startsWith("/api/"))denied.push(new URL(r.url()).pathname);});
  const calls=await fixture(page,{taxResult:true});
  await visit(page,"/estimate");
  await page.getByRole("button",{name:"primary",exact:true}).click();
  await page.getByRole("button",{name:/^Next/}).click();
  await page.getByRole("button",{name:/^Next/}).click();
  await page.getByRole("button",{name:/See My Estimate/}).click();
  await expect(page.getByText("New Monthly Mortgage Payment",{exact:true}).locator("xpath=following-sibling::p")).toHaveText(/^\$/);
  await expect(page.getByText("$385,000",{exact:true}).first()).toBeVisible();
  expect(calls.some(c=>c.path==="/api/property-tax/quick")).toBe(true);
  expect(denied).toEqual([]);
});

test("guest insurance loads sourced estimate inputs without denied lookups",async({page})=>{
  const denied:string[]=[];
  page.on("response",r=>{if(r.status()===401&&new URL(r.url()).pathname.startsWith("/api/"))denied.push(new URL(r.url()).pathname);});
  const calls=await fixture(page);
  await visit(page,"/insurance");
  await expect(page.getByTestId("button-save-insurance")).toBeVisible();
  await expect.poll(()=>calls.some(c=>c.path==="/api/insurance/property-characteristics")).toBe(true);
  await expect(page.locator('input[value="1958"]').first()).toBeVisible();
  await expect(page.locator('input[value="1166"]').first()).toBeVisible();
  expect(denied).toEqual([]);
});

for (const flow of flows) {
  test(`${flow.type}: first calculation has no signup and starts before lookups`, async ({ page }) => {
    const calls = await fixture(page);
    await visit(page, flow.path);
    await expect(page.getByTestId(`button-save-${flow.action}`)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const start = calls.findIndex(call => call.path === "/api/anonymous-quote/start");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(calls[start].body).toEqual({ quoteType: flow.type, address: ADDRESS });
    for (const [index, call] of calls.entries()) {
      if (/property-characteristics|rebuild-rate|property-tax\/quick|zillow-property-lookup/.test(call.path)) expect(index).toBeGreaterThan(start);
    }
    await page.reload();
    await expect(page.getByTestId(`button-save-${flow.action}`)).toBeVisible();
    expect(anonymousWrites(calls)).toEqual([]);
  });

  test(`${flow.type}: another address is gated and cannot fetch its facts`, async ({ page }) => {
    const calls = await fixture(page);
    await visit(page, flow.path);
    await expect(page.getByTestId(`button-save-${flow.action}`)).toBeVisible();
    await visit(page, flow.path, OTHER);
    await assertSignup(page);
    expect(calls.some(call => /property-characteristics|property-tax\/quick|zillow-property-lookup/.test(call.path)
      && JSON.stringify(call.body).includes(OTHER))).toBe(false);
    expect(anonymousWrites(calls)).toEqual([]);
  });

  test(`${flow.type}: save, share, and PDF require an actual account`, async ({ page }) => {
    const calls = await fixture(page);
    await page.addInitScript(() => localStorage.setItem("tateo_auth", "1"));
    await visit(page, flow.path);
    for (const action of ["save", "share", "download-pdf"]) {
      await page.getByTestId(`button-${action}-${flow.action}`).click();
      await assertSignup(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    expect(anonymousWrites(calls)).toEqual([]);
  });
}

test("the first property can be explored across tools without another signup", async ({ page }) => {
  const calls = await fixture(page);
  await visit(page, "/cash-buy");
  await expect(page.getByTestId("button-save-cash_buy")).toBeVisible();
  for (const flow of flows.filter(flow => flow.type !== "cash")) {
    await visit(page, flow.path);
    await expect(page.getByTestId(`button-save-${flow.action}`)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await visit(page, "/cash-buy");
  await expect(page.getByTestId("button-save-cash_buy")).toBeVisible();
  expect(anonymousWrites(calls)).toEqual([]);
});

test("cash draft survives edits, dismissed signup, reload, and real signup saves the edited price", async ({ page }) => {
  const calls = await fixture(page);
  await visit(page, "/cash-buy");
  const price = page.getByTestId("cash-buy-purchase-price").locator("input");
  await expect(price).toHaveValue("385,000");
  await price.fill("427350");
  await price.blur();
  await page.getByTestId("button-save-cash_buy").click();
  await assertSignup(page);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(price).toHaveValue("427,350");
  expect(anonymousWrites(calls)).toEqual([]);
  await page.getByTestId("button-save-cash_buy").click();
  await page.locator("#reg-name").fill("Marisol Vega");
  await page.locator("#reg-email").fill(user.email);
  await page.locator("#reg-phone").fill("7275550194");
  await page.locator("#reg-date-of-birth").fill("1988-04-12");
  await page.locator("#reg-password").fill("Fixture-only-password-91");
  await page.locator("#reg-confirm").fill("Fixture-only-password-91");
  await page.getByRole("button", { name: "Create Account", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(price).toHaveValue("427,350");
  await expect.poll(() => calls.some(call => call.path.endsWith("/cash_buy_scenarios")
    && call.method === "POST" && JSON.stringify(call.body).includes("427350"))).toBe(true);
  const registration = calls.find(call => call.path === "/api/profile/complete-registration");
  expect(registration?.body.marketingConsent).toBe(false);
  for (const call of calls.filter(call => call.path === "/api/leads/notify-new-scenario")) {
    expect(call.bearer).toBe("Bearer anonymous-flow-real-session");
  }
});

test("purchase financial answers and page position survive reload without a profile", async ({ page }) => {
  await fixture(page);
  await visit(page, "/estimate");
  await page.getByRole("button", { name: "secondary", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.reload();
  const draft = await page.evaluate(address => ({
    inputs: JSON.parse(localStorage.getItem(`havo_quote_draft:/estimate:${address}:inputs`) || "{}"),
    step: JSON.parse(localStorage.getItem(`havo_quote_draft:/estimate:${address}:step`) || "0"),
  }), ADDRESS);
  expect(draft.inputs.occupancy).toBe("secondary");
  expect(draft.inputs.propertyUseSelected).toBe(true);
  expect(draft.step).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("insurance manual inputs survive reload; live QuoteRush always prompts before any carrier request", async ({ page }) => {
  const calls = await fixture(page);
  await visit(page, "/insurance");
  await expect(page.getByTestId("input-square-feet")).toHaveValue("1166");
  await page.getByTestId("input-square-feet").fill("1487");
  await page.reload();
  await expect(page.getByTestId("input-square-feet")).toHaveValue("1487");
  await page.getByRole("button", { name: "Get Live Quotes", exact: true }).click();
  await assertSignup(page);
  expect(anonymousWrites(calls)).toEqual([]);
});

test("refinance calculates from standalone manual/free-clear data, keeps its draft, and never saves anonymously", async ({ page }) => {
  const calls = await fixture(page);
  await visit(page, "/refinance");
  await page.getByTestId("btn-entry-free_and_clear").click();
  await expect(page.getByTestId("input-fc-address")).toHaveValue(ADDRESS);
  await page.getByTestId("input-fc-home-value").fill("483750");
  await page.getByTestId("btn-add-free-clear").click();
  await expect(page.getByText("Your refinance estimate is ready", { exact: true })).toBeVisible();
  await page.reload();
  const loans = await page.evaluate(address => JSON.parse(
    localStorage.getItem(`havo_quote_draft:/refinance:${address}:trackedLoans`) || "[]",
  ), ADDRESS);
  expect(loans).toHaveLength(1);
  expect(loans[0].estimatedHomeValue).toBe(483750);
  await expect(page.getByTestId("input-fc-home-value")).toHaveValue("483750");
  expect(anonymousWrites(calls)).toEqual([]);
});

test("showing/email contact actions cannot create an anonymous CRM lead", async ({ page }) => {
  const calls = await fixture(page);
  await visit(page, "/cash-buy");
  await page.getByTestId("button-schedule-showing").click();
  await assertSignup(page);
  expect(anonymousWrites(calls)).toEqual([]);
});

test("seller draft survives a gated action and reload", async ({ page }) => {
  const calls = await fixture(page);
  await visit(page, "/seller");
  const salePrice = page.locator('input[inputmode="decimal"]').first();
  await expect(salePrice).toHaveValue("385,000");
  await salePrice.fill("468250");
  await salePrice.blur();
  await page.getByTestId("button-share-seller").click();
  await assertSignup(page);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(salePrice).toHaveValue("468,250");
  expect(anonymousWrites(calls)).toEqual([]);
});

test("signup after leaving a quote promotes the local draft with existing account persistence", async ({ page }) => {
  const calls = await fixture(page);
  await visit(page, "/cash-buy");
  const price = page.getByTestId("cash-buy-purchase-price").locator("input");
  await expect(price).toHaveValue("385,000");
  await price.fill("429750");
  await price.blur();
  await page.goto("/");
  await page.getByRole("button", { name: "Log In / Create Account", exact: true }).click();
  await page.getByRole("tab", { name: "Create Account", exact: true }).click();
  await page.locator("#reg-name").fill("Marisol Vega");
  await page.locator("#reg-email").fill(user.email);
  await page.locator("#reg-phone").fill("7275550194");
  await page.locator("#reg-date-of-birth").fill("1988-04-12");
  await page.locator("#reg-password").fill("Fixture-only-password-91");
  await page.locator("#reg-confirm").fill("Fixture-only-password-91");
  await page.getByRole("button", { name: "Create Account", exact: true }).click();
  await expect.poll(() => calls.some(call => call.path.endsWith("/cash_buy_scenarios")
    && call.method === "POST" && JSON.stringify(call.body).includes("429750"))).toBe(true);
});

test("signed-in users can calculate across addresses and types without the anonymous quota", async ({ page }) => {
  const calls = await fixture(page, { signedIn: true });
  for (const flow of flows) {
    await visit(page, flow.path, OTHER);
    await expect(page.getByTestId(`button-save-${flow.action}`)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(calls.filter(call => call.path === "/api/anonymous-quote/start")).toEqual([]);
});

test("failed account persistence retains the anonymous draft for retry", async ({ page }) => {
  const calls = await fixture(page, { saveFailure: true });
  await visit(page, "/cash-buy");
  const price = page.getByTestId("cash-buy-purchase-price").locator("input");
  await expect(price).toHaveValue("385,000");
  await price.fill("431250");
  await price.blur();
  await page.getByTestId("button-save-cash_buy").click();
  await page.locator("#reg-name").fill("Marisol Vega");
  await page.locator("#reg-email").fill(user.email);
  await page.locator("#reg-phone").fill("7275550194");
  await page.locator("#reg-date-of-birth").fill("1988-04-12");
  await page.locator("#reg-password").fill("Fixture-only-password-91");
  await page.locator("#reg-confirm").fill("Fixture-only-password-91");
  await page.getByRole("button", { name: "Create Account", exact: true }).click();
  await expect.poll(() => calls.some(call => call.path.endsWith("/cash_buy_scenarios") && call.method === "POST")).toBe(true);
  await expect(page.getByText("Save failed", { exact: true })).toBeVisible();
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem("havo_pending_anonymous_quote_v1") || "{}"));
  expect(draft.type).toBe("cash");
  expect(draft.payload.purchasePrice).toBe(431250);
});
