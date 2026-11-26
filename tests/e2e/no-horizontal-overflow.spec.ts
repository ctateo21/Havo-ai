import { expect, test, type Page, type Route } from "./quote-access-fixture";
import { officialTaxFixture } from "./official-tax-fixture";
import { normalizeQuoteAddress } from "../../shared/quote-address";

// Every page must fit the viewport: no horizontal scroll, no sideways wobble,
// no blank strip on the right. All provider and QuoteRUSH calls are mocked.
const ADDRESS = "100 Example St, Tampa, FL 33607";
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

const PHOTO_HOST = "photos.example.test";
const PHOTOS = [1, 2, 3].map(n => `https://${PHOTO_HOST}/property-${n}.png`);
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const TEST_USER = {
  id: "00000000-0000-4000-8000-000000000390",
  aud: "authenticated",
  role: "authenticated",
  email: "overflow-browser-test@example.com",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { name: "Overflow Browser Test" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// Saved carrier quotes for ADDRESS (synthetic carriers; no live QuoteRUSH).
const SAVED_QUOTES = {
  results: [{
    addressNormalized: normalizeQuoteAddress(ADDRESS),
    policyType: "HO3",
    leadId: 1,
    completedAt: "2026-11-20T12:00:00.000Z",
    stale: false,
    bestCarrier: "Example Peninsula Mutual Insurance Company",
    bestAnnual: 2182,
    occupancy: "primary",
    quotes: [
      ["Example Peninsula Mutual Insurance Company", 2182, 181.83],
      ["Sample Coastal Casualty", 2410, 200.83],
      ["Demo Homeowners Exchange", 2675, 222.92],
    ].map(([siteName, annualPremium, monthlyPremium], i) => ({
      siteName, annualPremium, monthlyPremium, coverageA: 400_000, hurricaneDeductible: "2%",
      aop: "$2,500", quoteUrl: `https://quotes.example.test/${i + 1}`, quoteDate: "2026-11-20", rank: i + 1,
    })),
  }],
  runs: [],
};

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function installMocks(page: Page, signedIn: boolean, options: { savedQuotes?: boolean } = {}): Promise<void> {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname.startsWith("/api/property-tax/")) {
        const input = method === "POST" ? route.request().postDataJSON() : {};
        const fixture = officialTaxFixture(input.purchasePrice, input.isPrimaryResidence);
        return json(route, { ...fixture, key: url.searchParams.get("key") ?? fixture.key });
      }
      const defaults: Record<string, unknown> = {
        "/api/anonymous-quote/start": { allowed: true },
        "/api/zillow-property-lookup": {
          cached: true,
          // 2+ photos so the photo carousel (and its arrows) render.
          property: { purchasePrice: 400_000, propertyType: "SINGLE_FAMILY", hoaMonthly: 0, photos: PHOTOS, yearBuilt: 2005 },
        },
        "/api/flood-zone": { zone: "X", subtype: "minimal", requiresFloodInsurance: false },
        "/api/mortgage-rates": { conventional: 6.5, fha: 6, va: 6, usda: 6, source: "synthetic browser fixture", lastUpdated: null },
        "/api/ami": { annualAMI: 80_000, monthlyAMI: 6_667, areaName: "Synthetic test area" },
        "/api/subscription/status": { active: true, status: "browser-test" },
        "/api/insurance/my-quotes": options.savedQuotes ? SAVED_QUOTES : { results: [], runs: [] },
        "/api/insurance/shared-estimate": { estimate: null },
        "/api/profile/status": {},
      };
      // QuoteRUSH and every other server route resolve to inert fixtures.
      return json(route, defaults[url.pathname] ?? {});
    }
    if (url.pathname.startsWith("/auth/v1/")) {
      return json(route, signedIn && url.pathname.endsWith("/user") ? TEST_USER : { user: null, session: null });
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.split("/rest/v1/")[1]?.split(/[?/]/)[0];
      const profile = signedIn && table === "profiles" && method === "GET";
      if (options.savedQuotes && signedIn && table === "insurance_scenarios" && method === "GET") {
        return json(route, [{
          id: "quoted-card", user_id: TEST_USER.id, address: ADDRESS, saved_at: "2026-11-20T12:00:00.000Z",
          annual_premium: 2600, coverage_a: 400_000, policy_type: "HO3", policy_type_source: "default_rule",
          user_answer_sources: {},
        }]);
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": profile ? "0-0/1" : "*/0" },
        body: JSON.stringify(profile
          ? { id: TEST_USER.id, name: "Overflow Browser Test", email: TEST_USER.email, created_at: TEST_USER.created_at }
          : []),
      });
    }
    if (url.hostname === PHOTO_HOST) {
      return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG });
    }
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return route.continue();
    return route.abort("blockedbyclient");
  });

  if (signedIn) {
    await page.addInitScript(user => {
      const session = JSON.stringify({
        access_token: "overflow-browser-test-access-token",
        refresh_token: "overflow-browser-test-refresh-token",
        expires_in: 3600,
        expires_at: 4_102_444_800,
        token_type: "bearer",
        user,
      });
      const originalGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (key === "tateo_supabase_session" || key === "supabase.auth.token" || /^sb-.+-auth-token$/.test(key)) {
          return session;
        }
        return originalGetItem.call(this, key);
      };
      localStorage.setItem("tateo_auth", "1");
    }, TEST_USER);
  }
}

/** Fails with the widest offending elements named, so a regression points
 * straight at the component that escaped the viewport. */
async function expectFitsViewport(page: Page, label: string): Promise<void> {
  // Let late layout (images, fonts, async data) settle before measuring.
  await page.waitForTimeout(400);
  const report = await page.evaluate(() => {
    // Measure the components themselves, not the html/body overflow-x:clip
    // safety net, so a real overflow can't hide behind it.
    const unclip = document.createElement("style");
    unclip.textContent = "html,body{overflow-x:visible!important}";
    document.head.appendChild(unclip);
    const viewport = window.innerWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const rect = el.getBoundingClientRect();
      // Screen-reader-only text (1px, clipped) is not visible layout.
      if (rect.width <= 1 || rect.height <= 1) continue;
      if (rect.right <= viewport + 0.5 && rect.left >= -0.5) continue;
      // Content clipped by a scroll/clip ancestor can't widen the page.
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.overflowX !== "visible") {
          const pr = p.getBoundingClientRect();
          if (pr.right <= viewport + 0.5 && pr.left >= -0.5) { clipped = true; break; }
        }
      }
      if (clipped) continue;
      const cls = typeof el.className === "string" ? el.className.slice(0, 80) : "";
      offenders.push(`${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? ""}] .${cls} left=${Math.round(rect.left)} right=${Math.round(rect.right)}`);
      if (offenders.length >= 8) break;
    }
    const measured = {
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    };
    unclip.remove();
    return {
      ...measured,
      viewport,
      offenders,
    };
  });
  const detail = `${label} @${report.viewport}px: documentElement.scrollWidth=${report.doc} body.scrollWidth=${report.body}\n${report.offenders.join("\n")}`;
  expect(report.offenders, detail).toEqual([]);
  expect(report.doc, detail).toBeLessThanOrEqual(report.viewport);
  expect(report.body, detail).toBeLessThanOrEqual(report.viewport);
}

/** iOS Safari zooms (and slides the page sideways) when a focused field's
 * text is under 16px, so phone-width text fields must be at least 16px. */
async function expectNoZoomOnFocus(page: Page, label: string): Promise<void> {
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("input, select, textarea"))
      .filter(el => {
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        if (["checkbox", "radio", "range", "button", "submit", "file", "hidden"].includes(type)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && parseFloat(getComputedStyle(el).fontSize) < 16;
      })
      .map(el => `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.getAttribute("name") ?? ""}] ${getComputedStyle(el).fontSize}`));
  expect(small, `${label}: fields under 16px`).toEqual([]);
}

// Same guest-to-unlocked transition the other estimate suites use.
async function openUnlockedTool(page: Page, path: string, ready: () => Promise<unknown>): Promise<void> {
  await page.goto(path);
  await ready();
  await page.evaluate(() => {
    history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByPlaceholder("Enter a property address...").first().waitFor();
  await page.evaluate(target => {
    localStorage.setItem("tateo_auth", "1");
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await ready();
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("home fits the screen", async ({ page }) => {
      await installMocks(page, false);
      await page.goto("/");
      await page.getByPlaceholder("Enter a property address...").first().waitFor();
      await expectFitsViewport(page, "home");
    });

    test("purchase estimate wizard pages 1-4 fit the screen", async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await installMocks(page, false);
      const path = `/estimate?address=${encodeURIComponent(ADDRESS)}`;
      await openUnlockedTool(page, path, () => page.getByRole("button", { name: "Add Property" }).waitFor());
      await expectFitsViewport(page, "estimate page 1 (blank)");
      await page.getByRole("button", { name: "primary", exact: true }).click();
      await expectFitsViewport(page, "estimate page 1");
      if (viewport.width < 768) await expectNoZoomOnFocus(page, "estimate page 1");
      await page.getByRole("button", { name: /^Next/ }).click();
      await expectFitsViewport(page, "estimate page 2");
      await page.getByRole("button", { name: /^Next/ }).click();
      await expectFitsViewport(page, "estimate page 3");
      await page.getByRole("button", { name: /See My Estimate/ }).click();
      await expect(page.getByText("New Monthly Mortgage Payment", { exact: true })).toBeVisible();
      if (viewport.width === 390) {
        // Kept as a test artifact for before/after visual comparison. Scroll
        // fully right the way a phone swipe would, so any overflow shows.
        await page.getByRole("button", { name: "Next slide" }).first().scrollIntoViewIfNeeded().catch(() => {});
        await page.evaluate(() => window.scrollTo(document.documentElement.scrollWidth, window.scrollY));
        const shot = await page.screenshot({ fullPage: false });
        await testInfo.attach("estimate-page-4-390", { body: shot, contentType: "image/png" });
        if (process.env.OVERFLOW_SCREENSHOT_PATH) {
          await page.screenshot({ path: process.env.OVERFLOW_SCREENSHOT_PATH, fullPage: false, type: "jpeg", quality: 70 });
        }
      }
      // The photo carousel arrows must render (photos are mocked) and sit
      // inside the screen; outside the slide they widen the whole page.
      for (const name of ["Previous slide", "Next slide"]) {
        const arrow = page.getByRole("button", { name }).first();
        await expect(arrow).toBeVisible();
        const box = await arrow.boundingBox();
        expect(box, `${name} arrow`).not.toBeNull();
        expect(box!.x, `${name} arrow left edge`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${name} arrow right edge`).toBeLessThanOrEqual(viewport.width);
      }
      await expectFitsViewport(page, "estimate page 4");
      if (viewport.width < 768) await expectNoZoomOnFocus(page, "estimate page 4");
    });

    for (const [name, path] of [
      ["refinance", `/refinance?address=${encodeURIComponent(ADDRESS)}`],
      ["cash-buy", `/cash-buy?address=${encodeURIComponent(ADDRESS)}`],
      ["seller", `/seller?address=${encodeURIComponent(ADDRESS)}`],
      ["insurance", `/insurance?address=${encodeURIComponent(ADDRESS)}`],
    ] as const) {
      test(`${name} first page fits the screen`, async ({ page }) => {
        await installMocks(page, false);
        await page.goto(path);
        await page.locator("main button").first().waitFor();
        await page.waitForLoadState("networkidle");
        if (name === "insurance") {
          // Guest prompt (long label) must wrap inside the screen.
          const prompt = page.getByTestId("guest-live-quote-prompt");
          await expect(prompt).toBeVisible();
          const box = await prompt.boundingBox();
          expect(box!.x + box!.width, "guest live-quote prompt right edge").toBeLessThanOrEqual(viewport.width);
        }
        await expectFitsViewport(page, name);
        if (viewport.width < 768) await expectNoZoomOnFocus(page, name);
        // Walk any further wizard pages reachable with the mocked defaults.
        const next = page.getByRole("button", { name: /^Next\b/ }).first();
        for (let step = 2; step <= 4; step++) {
          if (!(await next.isVisible().catch(() => false)) || !(await next.isEnabled().catch(() => false))) break;
          await next.click();
          await expectFitsViewport(page, `${name} page ${step}`);
        }
      });
    }

    test("quoted dashboard insurance card is highlighted, names the winner and fits", async ({ page }) => {
      await installMocks(page, true, { savedQuotes: true });
      await page.goto("/dashboard?tab=insurance");
      const card = page.locator('[data-testid^="insurance-card-"][data-quoted="true"]').first();
      await expect(card).toBeVisible();
      await expect(card).toHaveClass(/border-yellow-300/);
      await expect(card).toHaveClass(/bg-yellow-50/);
      const winner = card.locator('[data-testid^="insurance-winner-carrier-"]');
      await expect(winner).toContainText("Example Peninsula Mutual Insurance Company");
      await expect(winner).toContainText("$2,182/yr");
      await expect(winner).toContainText("$182/mo");
      await expectFitsViewport(page, "dashboard quoted insurance card");
    });

    test("estimate-only dashboard insurance card stays plain", async ({ page }) => {
      await installMocks(page, true, { savedQuotes: true });
      await page.route("**/api/insurance/my-quotes", route => json(route, { results: [], runs: [] }));
      await page.goto("/dashboard?tab=insurance");
      const card = page.locator('[data-testid^="insurance-card-"]').first();
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-quoted", "false");
      await expect(card).not.toHaveClass(/bg-yellow-50/);
      await expect(card.locator('[data-testid^="insurance-winner-carrier-"]')).toHaveCount(0);
    });

    test("returning with saved quotes: quotes first, rating details collapsed, fits", async ({ page }) => {
      test.setTimeout(60_000);
      await installMocks(page, true, { savedQuotes: true });
      await page.goto(`/insurance?address=${encodeURIComponent(ADDRESS)}`);
      const top = page.getByTestId("saved-quotes-top");
      await expect(top).toBeVisible();
      await expect(top.getByTestId("saved-quote-results")).toContainText("Your saved carrier quotes");
      await expect(top).toContainText("Real-time carrier rates via Tateo & Co");
      await expect(page.getByTestId("saved-quote-results")).toHaveCount(1);
      const toggle = page.getByRole("button", { name: "Edit rating details" });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("insurance-rating-details")).toBeHidden();
      await expectFitsViewport(page, "insurance returning with saved quotes (collapsed)");
      await toggle.click();
      await expect(page.getByRole("button", { name: "Hide rating details" })).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("insurance-rating-details")).toBeVisible();
      await expect(page.getByText("General Insurance Estimate")).toBeVisible();
      // Re-running is available exactly as before once the details are open.
      await expect(page.getByRole("button", { name: "Get Live Quotes" })).toBeVisible();
      await expectFitsViewport(page, "insurance returning with saved quotes (expanded)");
    });

    test("no saved quotes: insurance details open with no collapse control", async ({ page }) => {
      await installMocks(page, true);
      await page.goto(`/insurance?address=${encodeURIComponent(ADDRESS)}`);
      await expect(page.getByText("General Insurance Estimate")).toBeVisible();
      await expect(page.getByTestId("insurance-rating-details")).toBeVisible();
      await expect(page.getByTestId("saved-quotes-top")).toHaveCount(0);
      await expect(page.getByTestId("toggle-rating-details")).toHaveCount(0);
    });

    test("dashboard tabs fit the screen", async ({ page }) => {
      test.setTimeout(120_000);
      await installMocks(page, true);
      for (const tab of ["purchase", "refinance", "insurance", "sellers", "cash_buy"]) {
        await page.goto(`/dashboard?tab=${tab}`);
        await page.getByRole("tablist").first().waitFor();
        await expectFitsViewport(page, `dashboard ${tab}`);
      }
      await page.goto("/dashboard", { waitUntil: "commit" });
      await page.locator("main").first().waitFor();
      await page.waitForLoadState("networkidle");
      await expectFitsViewport(page, "dashboard overview");
    });
  });
}
