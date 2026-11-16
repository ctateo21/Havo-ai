import { expect, test, type Page } from "@playwright/test";

const ADDRESS = "7400 36th Ave N, St Petersburg, FL 33710";
async function readyLiveQuote(page:Page){
  await expect(page.getByTestId("input-square-feet")).toHaveValue("1166");
  await page.getByTestId("select-policy-type").selectOption("HO3");
  await page.getByTestId("select-prior-claims").selectOption("no");
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-purchase-date").fill("2027-01-15");
  await page.getByTestId("input-property-purchase-price").fill("385000");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await page.getByTestId("input-roof-year").fill("2018");
  await page.getByTestId("confirm-square-footage").check();
}
test("missing contact prompts before carrier import; details can be saved",async({page})=>{
  await fixture(page,{rate:250});
  await page.route("**/api/insurance/qr-start",route=>route.fulfill({status:428,json:{code:"CONTACT_REQUIRED"}}));
  await readyLiveQuote(page);
  await page.getByRole("button",{name:"Get Live Quotes",exact:true}).click();
  await expect(page.getByRole("dialog")).toContainText("Contact details required");
  await page.getByLabel("First and last name",{exact:true}).fill("Test Buyer");
  await page.getByLabel("Phone",{exact:true}).fill("2025550123");
  await page.getByRole("button",{name:"Save contact details"}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("an unconfirmed import stops pending polling with agent-review copy",async({page})=>{
  await fixture(page,{rate:250});
  await page.route("**/api/insurance/qr-start",route=>route.fulfill({json:{status:"pending",quoteAccessToken:"test-access"}}));
  await page.route("**/api/insurance/qr-cache?**",route=>route.fulfill({json:{found:true,status:"error",quotes:[]}}));
  await readyLiveQuote(page);
  await page.getByRole("button",{name:"Get Live Quotes",exact:true}).click();
  await expect(page.getByText("Our Havo team will finish your quotes. Carrier submission could not be confirmed; no carrier results are available. Our team will reach out — or call/email us.")).toBeVisible({timeout:20000});
  await expect(page.getByText("Working…",{exact:true})).toHaveCount(0);
});
const user = {
  id: "00000000-0000-4000-8000-000000000082", aud: "authenticated", role: "authenticated",
  email: "insurance-facts@example.test", email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { name: "Insurance Facts Test" }, identities: [], created_at: "2026-01-01T00:00:00Z",
};
async function fixture(page: Page, options: { rate?: number; profileFailure?: boolean; floodFailure?: boolean; noConstruction?: boolean; assumedConstruction?: boolean; assumedPolicy?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown> | null; access?: string }[] = [];
  await page.addInitScript(({ user, address }) => {
    const session = JSON.stringify({ access_token: "insurance-test-token", refresh_token: "insurance-test-refresh", expires_at: 4102444800, expires_in: 3600, token_type: "bearer", user });
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key: string) {
      return key === "tateo_supabase_session" || key === "supabase.auth.token" || /^sb-.+-auth-token$/.test(key) ? session : original.call(this, key);
    };
    localStorage.setItem("tateo_auth", "1");
    localStorage.setItem("qr_auto_" + address.toLowerCase().replace(/\s+/g, "_").slice(0, 80) + "_ho3", JSON.stringify({
      status: "success", leadId: 444, expiresAt: "2099-01-01", quotes: [{ siteName: "Other Borrower's Private Carrier", annualPremium: 1000 }],
    }));
  }, { user, address: ADDRESS });
  // Every API/external request is mocked or aborted. No provider/paid calls.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.includes("/auth/v1/user")) return json(user);
    if (url.pathname.includes("/rest/v1/")) {
      const profile = url.pathname.includes("/profiles");
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": profile ? "0-0/1" : "*/0" }, body: JSON.stringify(profile ? { id: user.id, name: "Insurance Facts Test", email: user.email, has_date_of_birth: true, created_at: user.created_at } : options.assumedPolicy && url.pathname.includes("/insurance_scenarios") ? [{ id: "assumed-policy", user_id: user.id, address: ADDRESS, saved_at: "2026-09-10", policy_type: "HO3", policy_type_source: "default_rule", user_answer_sources: {} }] : []) });
    }
    if (url.pathname.startsWith("/api/")) {
      calls.push({ path: url.pathname, body: route.request().postData() ? route.request().postDataJSON() : null, access: route.request().headers()["x-quote-access"] });
      if (url.pathname === "/api/profile/status") return json({ hasDateOfBirth: true });
      if (url.pathname === "/api/insurance/property-characteristics") return options.profileFailure ? json({ error: "Unavailable" }, 503) : json({
        yearBuilt: 1958, squareFeetLiving: 1166, constructionLabel: options.noConstruction ? null : "CONCRETE BLOCK", floodZone: "X",
        queriedAt: "2026-09-10T12:00:00Z",
        fieldSources: Object.fromEntries(Object.entries({ yearBuilt: 1958, squareFeetLiving: 1166, ...(!options.noConstruction ? { constructionLabel: "CONCRETE BLOCK" } : {}), floodZone: "X" }).map(([name, value]) => [name, { value, source: name === "floodZone" ? "FEMA National Flood Hazard Layer" : name === "constructionLabel" && options.assumedConstruction ? "Assumed — confirm" : "Florida DOR 2026", fetchedAt: "2026-09-10T12:00:00Z", sourceUrl: "https://example.test/source" }])),
        roofPermits: [{ year: 2018, source: "County roof permit" }],
      });
      if (url.pathname === "/api/flood-zone") return options.floodFailure ? json({ error: "FEMA failed" }, 503) : json({ zone: "X", queriedAt: "2026-09-10T12:00:00Z" });
      if (url.pathname === "/api/insurance/rebuild-rate") return json({ county: "pinellas", countyName: "Pinellas", frame_cost_per_sqft: options.rate ?? null, masonry_cost_per_sqft: options.rate ?? null, source_note: "County rate test source", updated_at: "2026-09-01" });
      if (url.pathname === "/api/insurance/qr-start") return json({ quoteAccessToken: "run-secret-82", fromCache: true, leadId: 82, status: "success", quoteCounter: 2, quotes: [
        { siteName: "Higher Premium Carrier", annualPremium: 2860, monthlyPremium: 238.33, coverageA: 1, returnedCoverageA: 294000, rank: 1 },
        { siteName: "Lower Premium Carrier", annualPremium: 2184, monthlyPremium: 182, coverageA: 1, returnedCoverageA: 292000, rank: 2 },
      ] });
      if (url.pathname === "/api/insurance/qr-cache") return json({ found: true, status: "success", quotes: [{ siteName: "Unknown Answers Shared Carrier", annualPremium: 1000 }] });
      return json({});
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return route.abort();
    return route.continue();
  });
  await page.goto(`/insurance?address=${encodeURIComponent(ADDRESS)}&price=456789`);
  return calls;
}

async function completeAnswers(page: Page, answerPolicy = true) {
  await expect(page.getByTestId("input-square-feet")).toHaveValue("1166");
  if (answerPolicy) await page.getByTestId("select-policy-type").selectOption("HO3");
  await page.getByTestId("select-prior-claims").selectOption("no");
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-purchase-date").fill("2027-01-15");
  await page.getByTestId("input-property-purchase-price").fill("385000");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await page.getByTestId("input-roof-year").fill("2018");
  await page.getByTestId("confirm-square-footage").check();
}

for (const mode of ["missing", "assumed"] as const) {
  test(`${mode} construction with configured rates stays blank until explicitly selected or confirmed`, async ({ page }) => {
    await fixture(page, { rate: 250, noConstruction: mode === "missing", assumedConstruction: mode === "assumed" });
    await expect(page.getByTestId("input-square-feet")).toHaveValue("1166");
    await expect(page.getByRole("combobox", { name: "Construction Type", exact: true })).toHaveValue("0");
    await page.getByTestId("confirm-square-footage").check();
    await expect(page.getByTestId("input-coverage-a")).toHaveValue("");
    await expect(page.getByText("Assumed — confirm. Select or confirm construction before estimating Coverage A.")).toBeVisible();
    if (mode === "missing") await page.getByRole("combobox", { name: "Construction Type", exact: true }).selectOption("2");
    else await page.getByRole("button", { name: "Confirm construction type: Concrete Block", exact: true }).click();
    await expect(page.getByTestId("input-coverage-a")).toHaveValue("292000");
    await expect(page.getByText(/1,166 confirmed sq. ft. ×/)).toContainText("Not an appraisal — your carrier may adjust Coverage A.");
  });
}

test("the default policy requires an explicit answer and missing or zero carrier coverage is unavailable", async ({ page }) => {
  await fixture(page, { rate: 250, assumedPolicy: true });
  await page.route("**/api/insurance/qr-start", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    quoteAccessToken: "coverage-check-token", fromCache: true, leadId: 83, quoteCounter: 2, quotes: [
      { siteName: "Zero Coverage Carrier", annualPremium: 2184, monthlyPremium: 182, returnedCoverageA: 0, coverageA: 400000 },
      { siteName: "Missing Coverage Carrier", annualPremium: 2860, monthlyPremium: 238.33, coverageA: 400000 },
    ],
  }) }));
  await expect(page.getByRole("button", { name: "Confirm policy type: HO3", exact: true })).toBeVisible();
  await completeAnswers(page, false);
  const send = page.getByRole("button", { name: "Get Live Quotes", exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole("button", { name: "Confirm policy type: HO3", exact: true }).click();
  await expect(send).toBeEnabled();
  await send.click();
  for (const carrier of ["Zero Coverage Carrier", "Missing Coverage Carrier"]) {
    const details = page.getByText(carrier, { exact: true }).locator("..");
    await expect(details).toContainText("Coverage A: Unavailable");
    await expect(details).not.toContainText("Coverage A: $0");
  }
});

test("sourced St Petersburg facts never fabricate roof, confirmation, or market-value coverage", async ({ page }) => {
  const calls = await fixture(page);
  await expect(page.getByTestId("input-year-built")).toHaveValue("1958");
  await expect(page.getByTestId("input-square-feet")).toHaveValue("1166");
  await expect(page.getByText("Florida DOR 2026", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("text-flood-zone")).toHaveValue("X");
  await expect(page.getByText("FEMA National Flood Hazard Layer", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("confirm-square-footage")).not.toBeChecked();
  await expect(page.getByTestId("input-roof-year")).toHaveValue("");
  await expect(page.getByTestId("input-coverage-a")).toHaveValue("");
  await expect(page.getByTestId("estimated-annual-premium")).toHaveText("—");
  await page.getByTestId("confirm-square-footage").check();
  await expect(page.getByTestId("input-coverage-a")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Get Live Quotes", exact: true })).toBeDisabled();
  await expect(page.getByText("Other Borrower's Private Carrier")).toHaveCount(0);
  await expect(page.getByText("Unknown Answers Shared Carrier")).toHaveCount(0);
  expect(calls.some(c => c.path === "/api/insurance/qr-cache" || c.path === "/api/insurance/qr-start")).toBe(false);
  await page.getByTestId("input-roof-year").fill("2018.5");
  await expect(page.locator("#roof-year-error")).toHaveText("Enter a whole year from 2000 to 2027.");
  await page.getByRole("button", { name: /Use 2018/ }).click();
  await expect(page.getByTestId("input-roof-year")).toHaveValue("2018");
});

test("only confirmed living area computes Coverage A; manual value stays locked", async ({ page }) => {
  await fixture(page, { rate: 250 });
  await expect(page.getByTestId("input-square-feet")).toHaveValue("1166");
  await expect(page.getByTestId("input-coverage-a")).toHaveValue("");
  await page.getByTestId("confirm-square-footage").check();
  await expect(page.getByTestId("input-coverage-a")).toHaveValue("292000");
  await expect(page.getByText(/1,166 confirmed sq. ft. ×/)).toContainText("County rate test source");
  await page.getByTestId("input-coverage-a").fill("315000");
  await page.getByTestId("input-square-feet").fill("1281");
  await expect(page.getByTestId("confirm-square-footage")).not.toBeChecked();
  await page.getByTestId("confirm-square-footage").check();
  await expect(page.getByTestId("input-coverage-a")).toHaveValue("315000");
});

test("HTTP profile failure falls back to FEMA; failed FEMA permits explicit unknown", async ({ page }) => {
  const calls = await fixture(page, { profileFailure: true, floodFailure: true });
  await expect(page.getByText("Checking FEMA flood map…")).toBeVisible();
  await expect(page.getByTestId("input-year-built")).toHaveValue("");
  await expect(page.getByTestId("input-roof-year")).toHaveValue("");
  await page.getByLabel("I don't know my flood zone — ask my agent to verify.").check();
  await expect(page.getByTestId("text-flood-zone")).toBeDisabled();
  expect(calls.some(c => c.path === "/api/flood-zone")).toBe(true);
});

test("complete answers send confirmation and assumed credit; only server-validated results hydrate", async ({ page }) => {
  const calls = await fixture(page, { rate: 250 });
  await expect(page.getByTestId("input-square-feet")).toHaveValue("1166");
  await page.getByTestId("select-policy-type").selectOption("HO3");
  await page.getByTestId("select-prior-claims").selectOption("no");
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-purchase-date").fill("2027-01-15");
  await page.getByTestId("input-property-purchase-price").fill("385000");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await page.getByTestId("input-roof-year").fill("2018");
  await page.getByTestId("confirm-square-footage").check();
  await page.getByLabel("I don't know my flood zone — ask my agent to verify.").check();
  const send = page.getByRole("button", { name: "Get Live Quotes", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText("Lower Premium Carrier")).toBeVisible();
  const start = calls.find(c => c.path === "/api/insurance/qr-start")?.body;
  expect(start).toMatchObject({ yearBuilt: 1958, roofYear: 2018, sqFt: 1166, sqFtConfirmed: true, floodZone: "", floodZoneUnknown: true, coverageA: 292000, assumedCredit: "Excellent (no credit check performed)" });
  await expect(page.getByText("$292,000", { exact: false }).last()).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text.indexOf("Lower Premium Carrier")).toBeLessThan(text.indexOf("Higher Premium Carrier"));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => calls.find(call => call.path === "/api/insurance/qr-refresh")?.access).toBe("run-secret-82");
  expect(await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes("run-secret-82")))).toBe(false);
  await page.getByTestId("input-coverage-a").fill("300000");
  await expect(page.getByText("Lower Premium Carrier")).toHaveCount(0);
});

test("carrier reads use ten-second intervals and stop at six minutes without declaring failure", async ({ page }) => {
  await page.clock.install();
  const calls = await fixture(page, { rate: 250 });
  let polls = 0;
  await page.route("**/api/insurance/qr-start", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ quoteAccessToken: "poll-run-secret", status: "pending", leadId: 82, expectedCarriers: 14, respondedCarriers: 0 }) }));
  await page.route("**/api/insurance/qr-quotes", route => {
    polls++;
    expect(route.request().headers()["x-quote-access"]).toBe("poll-run-secret");
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "pending", quoteCounter: 0, expectedCarriers: 14, respondedCarriers: 3, quotes: [] }) });
  });
  await page.getByTestId("select-policy-type").selectOption("HO3");
  await page.getByTestId("select-prior-claims").selectOption("no");
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-purchase-date").fill("2027-01-15");
  await page.getByTestId("input-property-purchase-price").fill("385000");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await page.getByTestId("input-roof-year").fill("2018");
  await page.getByTestId("confirm-square-footage").check();
  await page.getByRole("button", { name: "Get Live Quotes", exact: true }).click();
  await expect(page.getByText(/Carriers quoting 0 of 14/)).toBeVisible();
  await page.clock.runFor(9000);
  expect(polls).toBe(0);
  await page.clock.runFor(1100);
  await expect.poll(() => polls).toBe(1);
  await expect(page.getByText(/Carriers quoting 3 of 14/)).toBeVisible();
  await page.clock.fastForward(350000);
  await expect(page.getByText(/Still working — we'll email your top 3/)).toBeVisible();
  const atTimeout = polls;
  await page.clock.runFor(30000);
  expect(polls).toBe(atTimeout);
  expect(calls.some(call => call.path === "/api/insurance/qr-cache")).toBe(false);
});

test("pending-without-lead uses its run token and never persists or reuses access after answers change", async ({ page }) => {
  await page.clock.install();
  await fixture(page, { rate: 250 });
  let cacheReads = 0;
  await page.route("**/api/insurance/qr-start", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "pending", quoteAccessToken: "pending-private-secret" }) }));
  await page.route("**/api/insurance/qr-cache?*", route => {
    cacheReads++;
    expect(route.request().headers()["x-quote-access"]).toBe("pending-private-secret");
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ found: true, status: "pending", expectedCarriers: 11, respondedCarriers: 2 }) });
  });
  await page.getByTestId("select-policy-type").selectOption("HO3");
  await page.getByTestId("select-prior-claims").selectOption("no");
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-purchase-date").fill("2027-01-15");
  await page.getByTestId("input-property-purchase-price").fill("385000");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await page.getByTestId("input-roof-year").fill("2018");
  await page.getByTestId("confirm-square-footage").check();
  await page.getByRole("button", { name: "Get Live Quotes", exact: true }).click();
  await expect(page.getByText(/Carriers quoting · 0 quotes received/)).toBeVisible();
  await expect(page.getByText(/of N/)).toHaveCount(0);
  await page.clock.runFor(10100);
  await expect.poll(() => cacheReads).toBe(1);
  await expect(page.getByText(/Carriers quoting 2 of 11/)).toBeVisible();
  await page.getByTestId("input-coverage-a").fill("310000");
  await page.clock.runFor(30000);
  expect(cacheReads).toBe(1);
  await expect(page.getByRole("button", { name: "Get Live Quotes", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes("pending-private-secret")))).toBe(false);
});

test("admin rates sort supported first, save null explicitly, and retain errors and edits", async ({ page }) => {
  await fixture(page);
  const rates = [
    { county_slug: "alachua", county_name: "Alachua", county_fips: "12001", supported: false, frame_cost_per_sqft: null, masonry_cost_per_sqft: null, source_note: "", updated_at: null },
    { county_slug: "pinellas", county_name: "Pinellas", county_fips: "12103", supported: true, frame_cost_per_sqft: 250, masonry_cost_per_sqft: 275, source_note: "Published county rate", updated_at: "2026-09-01" },
    { county_slug: "hillsborough", county_name: "Hillsborough", county_fips: "12057", supported: true, frame_cost_per_sqft: 225, masonry_cost_per_sqft: 240, source_note: "County source", updated_at: "2026-09-01" },
  ];
  let failSave = false;
  let patch: Record<string, unknown> | undefined;
  await page.route("**/api/admin/rebuild-cost-rates**", route => {
    if (route.request().method() === "PATCH") {
      patch = route.request().postDataJSON();
      if (failSave) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Rate update failed; try again." }) });
      const row = rates.find(rate => route.request().url().endsWith(rate.county_slug))!;
      Object.assign(row, patch);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ rate: row }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ rates }) });
  });
  await page.goto("/admin/rebuild-cost-rates");
  await expect(page.getByLabel("Pinellas frame cost per square foot")).toHaveValue("250");
  expect(await page.locator("form h2").allTextContents()).toEqual(["Hillsborough", "Pinellas", "Alachua"]);
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Pinellas", exact: true }) });
  await page.getByLabel("Pinellas frame cost per square foot").fill("");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("Saved.");
  expect(patch?.frame_cost_per_sqft).toBe(null);
  failSave = true;
  await page.getByLabel("Pinellas masonry cost per square foot").fill("285");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Rate update failed; try again.");
  await expect(page.getByLabel("Pinellas masonry cost per square foot")).toHaveValue("285");
});

test("admin denial never renders rate editors", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/admin/rebuild-cost-rates", route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Forbidden" }) }));
  await page.goto("/admin/rebuild-cost-rates");
  await expect(page.getByRole("heading", { name: "Administrator access required" })).toBeVisible();
  await expect(page.locator("form")).toHaveCount(0);
});
