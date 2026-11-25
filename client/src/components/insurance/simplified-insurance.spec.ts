import { expect, test, type Page, type Route } from "@playwright/test";

const ADDRESS = "1487 Fictional Harbor Lane, Tampa, FL 33602";
const USER = {
  id: "00000000-0000-4000-8000-000000000086",
  aud: "authenticated", role: "authenticated",
  email: "insurance-fixture@example.test", phone: "8135550147",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { name: "Mara Fixture" }, identities: [],
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
};
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockInsurance(page: Page, options: { unavailable?: boolean; shape?: "Hip" | "Flat" | "Gable"; swrPermit?: boolean; legacyClaims?: boolean; agentFields?: string[]; sparseReport?: boolean; missingBuild?: boolean; reportOpening?: "A" | "X" } = {}) {
  const submissions: Record<string, any>[] = [];
  const calls: string[] = [];
  let expiration: string | null = null;
  await page.clock.setFixedTime(new Date("2026-06-10T12:00:00.000Z"));
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.addInitScript(user => {
    const session = JSON.stringify({
      access_token: "fictional-insurance-token", refresh_token: "fictional-refresh-token",
      expires_in: 3600, expires_at: 4102444800, token_type: "bearer", user,
    });
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === "tateo_supabase_session" || key === "supabase.auth.token" || /^sb-.+-auth-token$/.test(key)) return session;
      return getItem.call(this, key);
    };
    localStorage.setItem("tateo_auth", "1");
  }, USER);
  // One boundary handles EVERY HTTP request. Only application source/assets
  // reach localhost. All API, Supabase, analytics, Google and other third-party
  // requests are fulfilled here or aborted, never forwarded.
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.startsWith("/auth/v1/")) return json(route, path.endsWith("/user") ? USER : { user: USER });
    if (path.startsWith("/rest/v1/")) {
      if (path.includes("/profiles") && request.method() === "GET") {
        return route.fulfill({ contentType: "application/json", headers: { "content-range": "0-0/1" }, body: JSON.stringify({ id: USER.id, name: "Mara Fixture", email: USER.email, phone: USER.phone, has_date_of_birth: true }) });
      }
      if (options.legacyClaims && path.includes("/insurance_scenarios")) return json(route, [{
        id: "fictional-legacy-claims", user_id: USER.id, address: ADDRESS,
        saved_at: "2026-06-01", policy_type: "HO3", policy_type_source: "default_rule",
        user_answer_sources: { quote_has_claims: true, quote_claim_records: [{ lossDate: "", claimDetail: "", amount: "", paid: null, priorResidence: null }] },
      }]);
      return json(route, []);
    }
    if (path.startsWith("/api/")) {
      calls.push(path);
      if (path === "/api/insurance/rebuild-rate") return options.unavailable ? json(route, { error: "Fixture rate unavailable" }, 503) : json(route, { county: "hillsborough", countyName: "Hillsborough", masonry_cost_per_sqft: 237, frame_cost_per_sqft: 999, source_note: "Fictional test rate", updated_at: "2026-06-01" });
      if (path === "/api/insurance/property-characteristics") return json(route, {
        yearBuilt: options.missingBuild ? null : 1998, squareFeetLiving: 2000, constructionLabel: "CONCRETE BLOCK", floodZone: "AE",
        fieldSources: {
          yearBuilt: { value: options.missingBuild ? null : 1998, source: "Fictional county fixture" },
          squareFeetLiving: { value: 2000, source: "Fictional county fixture" },
          constructionLabel: { value: "CONCRETE BLOCK", source: "Fictional county fixture" },
          floodZone: { value: "AE", source: "FEMA fixture, not a real lookup" },
        },
        roofPermits: [{ year: 2022, source: "Fictional permit fixture" }],
      });
      if (path === "/api/insurance/wind-evidence") return options.unavailable ? json(route, {}, 503) : json(route, {
        evidence: { version: 4, permits: { permits: options.swrPermit ? [{
          number: "FICTIONAL-SWR-87", date: "2018-05-10", description: "Installed peel-and-stick underlayment",
          source: "Fictional permit fixture", sourceUrl: "https://example.test/fictional-permit",
          classification: { kind: "roof_detail", quote: "peel-and-stick underlayment", swr: true },
        }] : [] }, coastal: { status: "outside", distanceFeet: null, source: "Fictional fixture", sourceUrl: "", reason: "Fixture only" },
          ...(options.shape ? { roof: { shape: options.shape, material: "Metal", source: "Fictional image estimate", estimated: true } } : {}) },
      });
      if (path === "/api/insurance/quote-assumptions") return json(route, { assumedCreditScore: "Excellent (no credit check performed)" });
      if (path === "/api/profile/status") return json(route, { hasDateOfBirth: true });
      if (path === "/api/profile/insurance-property") {
        if (request.method() !== "GET") expiration = request.postDataJSON().currentPolicyExpirationDate;
        return json(route, { ok: true, currentPolicyExpirationDate: expiration });
      }
      if (path === "/api/anonymous-quote/start") return json(route, { allowed: true, ...request.postDataJSON() });
      if (path === "/api/insurance/wind-report") return json(route, { reportId: "00000000-0000-4000-8000-000000000087", extracted: options.sparseReport ? { inspectionDate: "2026-05-15" } : { inspectionDate: "2026-05-15", shape: "Hip", swr: "Yes", opening: options.reportOpening ?? "A", roofToWall: "Clips", roofDeck: "B", yearBuilt: 1998, roofCovering: "Metal", productApproval: "Meets FBC 1994" } });
      if (path === "/api/insurance/qr-start") {
        submissions.push(request.postDataJSON());
        return json(route, { leadId: 87, status: "success", quoteAccessToken: "fixture-access", quoteCounter: 1, quotes: [{ siteName: "Fictional Fixture Mutual", annualPremium: 2843, monthlyPremium: 236.92, coverageA: 474000, hurricaneDeductible: "2%", aop: "$2,500", rank: 1 }] });
      }
      if (path === "/api/insurance/qr-cache") return json(route, { found: false });
      if (path === "/api/insurance/qr-agent-verification") return json(route, { fields: options.agentFields ?? [] });
      if (path === "/api/flood-zone") return json(route, { zone: "AE", source: "FEMA fixture" });
      return json(route, { ok: true });
    }
    const base = new URL(test.info().project.use.baseURL as string);
    if (url.origin === base.origin) return route.continue();
    return route.abort("blockedbyclient");
  });
  await page.goto(`/insurance?address=${encodeURIComponent(ADDRESS)}`);
  await expect(page.getByTestId("select-policy-type")).toBeVisible();
  return { submissions, calls };
}

test("first question is report availability; one editable wind list is visible", async ({ page }) => {
  const { calls } = await mockInsurance(page);
  const form = page.getByText("Do you have an existing wind mitigation report?").locator("xpath=ancestor::section[1]");
  await expect(form.getByRole("radio", { name: "No", exact: true })).toBeChecked();
  await expect(form.getByRole("radio", { name: "Yes", exact: true })).toBeVisible();
  await expect(page.getByLabel("Upload your wind mitigation report")).toHaveCount(0);
  await expect(page.getByTestId("select-wind-shape")).toBeVisible();
  await expect(page.getByTestId("select-policy-type")).toHaveValue("HO3");
  await expect(page.getByTestId("select-policy-type").locator("option")).toHaveText(["Homeowners (HO-3)", "Condo (HO-6)", "Dwelling Fire / Landlord Policy (DP-3)"]);
  await expect(page.getByTestId("select-prior-claims")).toHaveCount(0);
  await expect(page.getByTestId("confirm-square-footage")).toHaveCount(0);
  await expect(page.getByText(/We assume no insurance claims/)).toBeVisible();
  await expect.poll(() => calls.includes("/api/insurance/wind-evidence")).toBe(true);
  await expect(page.getByText(/Confirm policy type:/)).toHaveCount(0);
});

test("wind choices have exact mappings; Yes is opening confirmation and SWR respects edits", async ({ page }) => {
  await mockInsurance(page);
  const shape = page.getByTestId("select-wind-shape");
  await expect(shape.locator("option")).toHaveText(["Hip", "Flat", "Gable/Other"]);
  await expect(shape).toHaveValue("Gable");
  await expect(page.getByTestId("select-wind-allOpenings").locator("option")).toHaveText(["Yes", "No/Unsure"]);
  await page.getByTestId("select-wind-allOpenings").selectOption("all");
  await expect(page.getByText(/I confirm ALL windows/)).toHaveCount(0);
  const swr = page.getByTestId("select-wind-peelAndStick");
  await expect(page.getByTestId("input-roof-year")).toHaveValue("2022");
  await expect(swr).toHaveValue("yes");
  await swr.selectOption("no");
  await page.getByTestId("input-roof-year").fill("2025");
  await expect(swr).toHaveValue("no");
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(0);
});

test("wind list follows report order and has no duplicate roof or review selectors", async ({ page }) => {
  await mockInsurance(page);
  const table = page.getByRole("table", { name: "Roof and wind details" });
  await expect(table.getByRole("row")).toHaveCount(7);
  await expect(table.locator("label")).toHaveText([
    "Roof Covering", "Product Approval Listing", "Roof Deck Attachment", "Roof-to-Wall Attachment",
    "Roof Shape", "Secondary Water Resistance (SWR)", "All openings impact-rated or shuttered?",
  ]);
  await expect(table.getByRole("combobox")).toHaveCount(7);
  await expect(page.getByLabel("Roof type", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Assumptions we made", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Review report values", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("select-wind-material").locator("option")).toHaveText(["Shingle", "Tile", "Metal", "Built Up", "Membrane", "Rolled Roofing"]);
  await expect(page.getByTestId("select-wind-productApproval").locator("option")).toHaveText(["Meets FBC 2001", "Meets FBC 1994", "Non-FBC"]);
  await expect(page.getByTestId("select-wind-roofDeck").locator("option")).toHaveText(["Level A", "Level B", "Level C", "Reinforced Concrete Roof Deck"]);
  await expect(page.getByTestId("select-wind-roofToWall").locator("option")).toHaveText(["Toe Nails", "Clips", "Single Wraps", "Double Wraps", "Structural", "Other"]);
  for (const select of await table.getByRole("combobox").all()) {
    await expect(select.locator("option:checked")).not.toHaveText(/Unknown|Unverified|no credit/i);
    await expect(select).toHaveAttribute("aria-describedby", /-basis$/);
  }
});

test("missing build year uses labeled Level A and Toe Nails assumptions", async ({ page }) => {
  await mockInsurance(page, { missingBuild: true });
  await expect(page.getByTestId("select-wind-roofDeck")).toHaveValue("A");
  await expect(page.getByTestId("select-wind-roofToWall")).toHaveValue("Toe Nails");
  await expect(page.getByTestId("select-wind-roofDeck").locator("xpath=ancestor::*[@role='row']")).toContainText("Assumption");
  await expect(page.getByTestId("select-wind-roofToWall").locator("xpath=ancestor::*[@role='row']")).toContainText("Assumption");
  await page.getByTestId("select-wind-roofDeck").selectOption("B");
  await page.getByTestId("select-wind-roofToWall").selectOption("Structural");
  await page.getByTestId("input-year-built").fill("2005");
  await expect(page.getByTestId("select-wind-roofDeck")).toHaveValue("B");
  await expect(page.getByTestId("select-wind-roofToWall")).toHaveValue("Structural");
});

test("technical edits map into the quote request without changing other defaults", async ({ page }) => {
  const { submissions } = await mockInsurance(page);
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-property-purchase-price").fill("487300");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await page.getByTestId("select-wind-material").selectOption("Tar and Gravel");
  await page.getByTestId("select-wind-productApproval").selectOption("Non-FBC");
  await page.getByTestId("select-wind-roofDeck").selectOption("Concrete");
  await page.getByTestId("select-wind-roofToWall").selectOption("N/A");
  await page.getByTestId("select-wind-allOpenings").selectOption("all");
  const send = page.getByRole("button", { name: "Get Live Quotes", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    roofMaterial: "Tar and Gravel", roofCovering: "Non-FBC",
    aopDeductible: 2500, hurrIdx: 0, hasClaims: false,
    windAnswers: { roofCovering: "Non-FBC", roofDeck: "Concrete", roofToWall: "N/A", allOpenings: "all" },
  });
});

test("missing extracted fields stay assumptions, not invented report findings", async ({ page }) => {
  const { submissions } = await mockInsurance(page, { sparseReport: true });
  await page.getByRole("radio", { name: "Yes", exact: true }).check();
  await page.getByLabel("Upload your wind mitigation report").setInputFiles({
    name: "fictional-incomplete-report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fictional incomplete report"),
  });
  await expect(page.getByRole("status").filter({ hasText: "Draft extracted." })).toBeVisible();
  const table = page.getByRole("table", { name: "Roof and wind details" });
  await expect(table.getByText(/From your report/)).toHaveCount(0);
  await expect(table.getByText(/Assumption ·/)).toHaveCount(7);
  await expect(page.getByTestId("select-wind-productApproval")).toHaveValue("Meets FBC 2001");
  await expect(page.getByText(/Missing fields remain labeled assumptions/)).toBeVisible();
  await page.getByTestId("select-wind-shape").selectOption("Hip");
  await expect(page.getByTestId("select-wind-shape").locator("xpath=ancestor::*[@role='row']")).toContainText("From your report");
  const displayedDeck = await page.getByTestId("select-wind-roofDeck").inputValue();
  const displayedWall = await page.getByTestId("select-wind-roofToWall").inputValue();
  const displayedSwr = await page.getByTestId("select-wind-peelAndStick").inputValue();
  await page.getByRole("checkbox", { name: /I reviewed these values/ }).check();
  await expect(table.getByText(/Assumption ·/)).toHaveCount(6);
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-property-purchase-price").fill("487300");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  const send = page.getByRole("button", { name: "Get Live Quotes", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].windAnswers.report).toMatchObject({
    roofDeck: displayedDeck, roofToWall: displayedWall, swr: displayedSwr === "yes" ? "Yes" : "No",
    productApproval: "Meets FBC 2001", shape: "Hip", transcribedFromReport: true,
    opening: "Unknown",
    assumedFields: expect.arrayContaining(["roofCovering", "productApproval", "roofDeck", "roofToWall", "swr", "opening"]),
  });
  expect(submissions[0].windAnswers.report.assumedFields).not.toContain("shape");
  expect(submissions[0].windAnswers.report.opening).not.toBe("X");
  await page.getByTestId("select-wind-roofDeck").selectOption("Concrete");
  await page.getByRole("checkbox", { name: /I reviewed these values/ }).check();
  await expect(page.getByTestId("select-wind-roofDeck").locator("xpath=ancestor::*[@role='row']")).toContainText("From your report");
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].windAnswers.report.roofDeck).toBe("Concrete");
  expect(submissions[1].windAnswers.report.assumedFields).not.toContain("roofDeck");
  expect(submissions[1].windAnswers.report.assumedFields).toContain("opening");
});

test("only an actual extracted report X is preserved as X after review", async ({ page }) => {
  const { submissions } = await mockInsurance(page, { reportOpening: "X" });
  await page.getByRole("radio", { name: "Yes", exact: true }).check();
  await page.getByLabel("Upload your wind mitigation report").setInputFiles({
    name: "fictional-report-x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fictional report X"),
  });
  await expect(page.getByRole("status").filter({ hasText: "Draft extracted." })).toBeVisible();
  await expect(page.getByTestId("select-wind-allOpenings")).toHaveValue("unsure");
  await expect(page.getByTestId("select-wind-allOpenings").locator("xpath=ancestor::*[@role='row']")).toContainText("From your report");
  await page.getByRole("checkbox", { name: /I reviewed these values/ }).check();
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-property-purchase-price").fill("487300");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await page.getByRole("button", { name: "Get Live Quotes", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].windAnswers.report.opening).toBe("X");
  expect(submissions[0].windAnswers.report.assumedFields).not.toContain("opening");
});

test("permits do not silently suggest SWR and legacy claims cannot gate a quote", async ({ page }) => {
  const { submissions } = await mockInsurance(page, { swrPermit: true, legacyClaims: true });
  await page.getByTestId("input-roof-year").fill("2018");
  const swr = page.getByTestId("select-wind-peelAndStick");
  await expect(swr).toHaveValue("no");
  await expect(page.getByText(/Assumption · Assumed from 2018 roof year/)).toBeVisible();
  await expect(page.getByText("Assumption · Gable/Other planning assumption; not independently verified")).toBeVisible();
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-property-purchase-price").fill("487300");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  const send = page.getByRole("button", { name: "Get Live Quotes", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    hasClaims: false, claimRecords: [], roofShapeUserSet: false,
    secondaryWaterResistance: "No",
    windAnswers: { peelAndStick: "unsure", shape: "Not sure" },
  });
  await swr.selectOption("no");
  await expect(swr).toHaveValue("no");
  await page.getByTestId("input-roof-year").fill("2025");
  await expect(swr).toHaveValue("no");
});

test("Coverage A uses county block rate, frame discount and mixed average; manual override resets", async ({ page }) => {
  await mockInsurance(page);
  const coverage = page.getByTestId("input-coverage-a");
  await expect(coverage).toHaveCount(1);
  await expect(coverage).toHaveValue("474000");
  const construction = page.getByLabel("Construction", { exact: true });
  await construction.selectOption("2");
  await expect(coverage).toHaveValue("403000");
  await construction.selectOption("1");
  await expect(coverage).toHaveValue("438000");
  await coverage.fill("517400");
  await page.getByTestId("input-square-feet").fill("2100");
  await construction.selectOption("0");
  await expect(coverage).toHaveValue("517400");
  await page.getByRole("button", { name: "Reset to calculated rebuild cost" }).click();
  await expect(coverage).toHaveValue("498000");
  await expect(page.getByLabel("AOP deductible (all other perils)", { exact: true })).toHaveValue("2500");
  await expect(page.getByLabel("Hurricane deductible", { exact: true })).toHaveValue("0");
});

test("private extraction uses the same editable list without duplicate review selectors", async ({ page }) => {
  await mockInsurance(page);
  await page.getByRole("radio", { name: "Yes", exact: true }).check();
  const upload = page.getByLabel("Upload your wind mitigation report");
  await expect(upload).toBeEnabled();
  await upload.setInputFiles({ name: "fictional-report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fictional test document") });
  await expect(page.getByRole("status").filter({ hasText: "Draft extracted." })).toBeVisible();
  await expect(page.getByTestId("select-wind-report-shape")).toHaveCount(0);
  await expect(page.getByTestId("select-wind-shape")).toHaveValue("Hip");
  await expect(page.getByRole("table", { name: "Roof and wind details" }).getByRole("combobox")).toHaveCount(7);
  await expect(page.getByTestId("select-wind-shape").locator("xpath=ancestor::*[@role='row']")).toContainText("From your report");
  await page.getByTestId("select-wind-shape").selectOption("Flat");
  await expect(page.getByTestId("select-wind-shape")).toHaveValue("Flat");
  await expect(page.getByLabel("Report reference", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Report: inspector", { exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: /I reviewed these values/ }).check();
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await expect(upload).toHaveCount(0);
});

test("new purchase submits simplified defaults and roof material without claim or sqft gates", async ({ page }) => {
  const { submissions } = await mockInsurance(page);
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await expect(page.getByTestId("input-purchase-date")).toHaveCount(0);
  await page.getByTestId("input-property-purchase-price").fill("487300");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await page.getByTestId("select-wind-material").selectOption("Tile");
  await page.getByTestId("select-wind-shape").selectOption("Flat");
  await page.getByTestId("select-wind-allOpenings").selectOption("all");
  await page.getByTestId("select-wind-peelAndStick").selectOption("no");
  const button = page.getByRole("button", { name: "Get Live Quotes", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    policyType: "HO3", hasClaims: false, claimRecords: [], aopDeductible: 2500,
    hurrIdx: 0, roofMaterial: "Tile", roofShape: "Flat",
    roofShapeUserSet: true, roofMaterialUserSet: true,
    policyEffectiveDate: "2026-06-24",
    windAnswers: { gated: false, shape: "Flat", allOpenings: "all", openingsConfirmed: true, peelAndStick: "no" },
  });
});

test("FEMA is read-only outside assumptions and A/V notice is combined with premium", async ({ page }) => {
  await mockInsurance(page);
  await expect(page.getByTestId("text-flood-zone")).toHaveText("AE");
  await expect(page.getByTestId("text-flood-zone")).not.toHaveRole("textbox");
  const premium = page.getByTestId("estimated-annual-premium").locator("..");
  await expect(premium).toContainText("Special Flood Hazard Area");
  await expect(premium).toContainText("We can run flood through QuoteRush too.");
  await expect(premium).toContainText("can quote flood insurance separately");
  await expect(page.getByTestId("input-assumed-flood-zone")).toBeHidden();
  await page.getByText("Property assumptions and sources", { exact: true }).click();
  await page.getByTestId("input-assumed-flood-zone").fill("X");
  await expect(page.getByTestId("text-flood-zone")).toHaveText("X");
  await expect(premium).toContainText("outside high-risk zones");
});

test("optional county failure allows manual Coverage A and has a working retry", async ({ page }) => {
  const { calls } = await mockInsurance(page, { unavailable: true });
  await expect(page.getByRole("button", { name: "Retry county rate" })).toBeVisible();
  await page.getByTestId("input-coverage-a").fill("468700");
  await expect(page.getByTestId("input-coverage-a")).toHaveValue("468700");
  await page.getByRole("button", { name: "Retry county rate" }).click();
  await expect.poll(() => calls.filter(path => path === "/api/insurance/rebuild-rate").length).toBeGreaterThan(1);
  await expect(page.getByTestId("input-coverage-a")).toHaveValue("468700");
});

test("property image suggestions remain estimates and manual shape/material edits win", async ({ page }) => {
  await mockInsurance(page, { shape: "Hip" });
  await expect(page.getByTestId("select-wind-shape")).toHaveValue("Hip");
  await expect(page.getByTestId("select-wind-material")).toHaveValue("Metal");
  await expect(page.getByText("Assumption · Fictional image estimate")).toBeVisible();
  await page.getByTestId("select-wind-shape").selectOption("Gable");
  await page.getByTestId("select-wind-material").selectOption("Rubber");
  await expect(page.getByTestId("select-wind-shape")).toHaveValue("Gable");
  await expect(page.getByTestId("select-wind-material")).toHaveValue("Rubber");
});

test("existing-home carrier, expiration and optional mortgage remain available", async ({ page }) => {
  await mockInsurance(page);
  await page.getByTestId("select-new-purchase").selectOption("no");
  await expect(page.getByTestId("input-purchase-date")).toBeVisible();
  await page.getByTestId("select-currently-insured").selectOption("yes");
  await page.getByTestId("input-current-carrier").fill("Fictional Existing Carrier");
  await page.getByTestId("input-current-policy-expiration-date").fill("2026-10-21");
  await expect(page.getByTestId("input-current-carrier")).toHaveValue("Fictional Existing Carrier");
  await expect(page.getByTestId("input-current-policy-expiration-date")).toHaveValue("2026-10-21");
  await page.getByTestId("select-currently-insured").selectOption("no");
  await expect(page.getByTestId("input-current-carrier")).toHaveCount(0);
  // Owned/refi retains its inline mortgage selector. The collapsed previous
  // address editor intentionally appears only after switching to new purchase.
  await page.getByRole("combobox", { name: "Will this home have a mortgage?" }).selectOption("no");
  await page.getByTestId("select-new-purchase").selectOption("yes");
  const home = page.getByRole("region", { name: "Current home and mortgage" });
  await expect(home).toContainText("Mortgage: No");
  await home.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(home.getByLabel("Will this home have a mortgage?")).toBeVisible();
  await home.getByLabel("Will this home have a mortgage?").selectOption("yes");
  await home.getByRole("button", { name: "Done", exact: true }).click();
  await expect(home).toContainText("Mortgage: Yes");
});

test("save a fictional wind-assumptions screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mockInsurance(page);
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-property-purchase-price").fill("487300");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  await expect(page.getByRole("button", { name: "Get Live Quotes", exact: true })).toBeEnabled();
  const list = page.getByRole("table", { name: "Roof and wind details" });
  await list.scrollIntoViewIfNeeded();
  // Capture the actual rule table, without the sticky dashboard chrome covering
  // its first rows after Playwright scrolls the element into view.
  await list.locator("..").screenshot({
    path: "screenshots/wind-mit-assumptions.png",
    style: "header, nav, .sticky, .fixed { visibility: hidden !important; }",
  });
});

test("roof year stays required and accepts only whole years 2000 through 2027", async ({ page }) => {
  await mockInsurance(page);
  const year = page.getByTestId("input-roof-year");
  await expect(year).toHaveValue("2022");
  await year.fill("1999");
  await expect(page.getByText("Enter a whole year from 2000 to 2027.").first()).toBeVisible();
  await expect(year).toHaveAttribute("aria-invalid", "true");
  await year.fill("2027");
  await expect(year).toHaveAttribute("aria-invalid", "false");
  await year.fill("");
  await expect(year).toHaveAttribute("aria-invalid", "true");
});

test("simplified fields and premium fit a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockInsurance(page);
  await expect(page.getByTestId("input-coverage-a")).toHaveValue("474000");
  const fields = [
    page.getByTestId("select-policy-type"),
    page.getByTestId("input-roof-year"),
    page.getByTestId("input-coverage-a"),
    page.getByTestId("estimated-annual-premium").locator(".."),
  ];
  for (const field of fields) {
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(376);
  }
});

test("agent verification after a quote run is a short summary with a collapsed details list", async ({ page }) => {
  const agentFields = [
    "Roof covering product approval", "Roof deck attachment", "Roof-to-wall attachment",
    "Secondary water resistance", "Opening protection", "Prior insurance", "Mortgagee",
  ];
  const { submissions } = await mockInsurance(page, { agentFields });
  await page.getByTestId("select-new-purchase").selectOption("yes");
  await page.getByTestId("input-property-purchase-price").fill("487300");
  await page.getByTestId("select-ho6-residence-use").selectOption("primary");
  const button = page.getByRole("button", { name: "Get Live Quotes", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => submissions.length).toBe(1);

  const panel = page.getByTestId("agent-verification");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("agent-verification-summary")).toHaveText("An agent will verify 7 details for this quote.");
  const details = page.getByTestId("agent-verification-details");
  await expect(details).not.toHaveAttribute("open", "");
  for (const field of agentFields) await expect(panel.getByText(field, { exact: true })).toBeHidden();

  await details.getByText("See details").click();
  await expect(details).toHaveAttribute("open", "");
  for (const field of agentFields) await expect(panel.getByText(field, { exact: true })).toBeVisible();

  // Only the list collapses: licensing and not-a-binder disclosures stay
  // visible, and nothing on the page is pre-checked on the user's behalf.
  await expect(page.getByText(/License #L132640/).first()).toBeVisible();
  await expect(page.getByText(/Not a binding quote/).first()).toBeVisible();
  await expect(page.locator('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]')).toHaveCount(0);
});
