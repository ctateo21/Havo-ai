import { expect, test, type Page } from "./quote-access-fixture";

const USER_ID = "00000000-0000-4000-8000-000000000031";
const ADDRESS_A = "200 Sample Ave, Tampa, FL 33607, USA";
const ADDRESS_B = "100 Example St, Tampa, FL 33607, USA";

/** Minimal Places Data API mock: one pending prediction/detail per call. */
async function installPlacesMock(page: Page) {
  await page.addInitScript(() => {
    const predictionRequests: Array<{ input: string; resolve: (v: unknown) => void; resolved: boolean }> = [];
    const detailRequests: Array<{ placeId: string; address: string; place: Record<string, unknown>; resolve: () => void; resolved: boolean }> = [];
    class AutocompleteSessionToken {}
    const createPrediction = (address: string, placeId: string) => ({
      text: { text: address },
      placeId,
      toPlace() {
        const place: Record<string, unknown> = { id: placeId, formattedAddress: undefined, addressComponents: [] };
        place.fetchFields = () => new Promise<void>(resolve => {
          detailRequests.push({ placeId, address, place, resolve, resolved: false });
        });
        return place;
      },
    });
    (window as any).__placesMock = {
      predictionRequests,
      detailRequests,
      resolvePredictions(input: string, choices: Array<{ address: string; placeId: string }>) {
        const request = predictionRequests.find(r => r.input === input && !r.resolved);
        if (!request) throw new Error(`No pending prediction request for ${input}`);
        request.resolved = true;
        request.resolve({ suggestions: choices.map(c => ({ placePrediction: createPrediction(c.address, c.placeId) })) });
      },
      resolveDetails(placeId: string) {
        const request = detailRequests.find(r => r.placeId === placeId && !r.resolved);
        if (!request) throw new Error(`No pending detail request for ${placeId}`);
        request.resolved = true;
        request.place.formattedAddress = request.address;
        request.resolve();
      },
    };
    (window as any).google = {
      maps: {
        places: {},
        importLibrary: async () => ({
          AutocompleteSessionToken,
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: ({ input }: { input: string }) =>
              new Promise(resolve => predictionRequests.push({ input, resolve, resolved: false })),
          },
        }),
      },
    };
  });
}

/** Signed-in session plus one saved insurance card for address A. */
async function installSignedInUserWithSavedCard(page: Page) {
  await page.addInitScript(({ userId }) => {
    const user = {
      id: userId, aud: "authenticated", role: "authenticated", email: "browser-test@example.com",
      email_confirmed_at: "2026-01-01T00:00:00.000Z", phone: "",
      app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { name: "Browser Test" },
      identities: [], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    };
    const session = JSON.stringify({
      access_token: "browser-test-access-token", refresh_token: "browser-test-refresh-token",
      expires_in: 3600, expires_at: 4102444800, token_type: "bearer", user,
    });
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === "tateo_supabase_session" || key === "supabase.auth.token" || /^sb-.+-auth-token$/.test(key)) return session;
      return originalGetItem.call(this, key);
    };
    localStorage.setItem("tateo_auth", "1");
  }, { userId: USER_ID });

  await page.route("**/rest/v1/**", route => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/rest/v1/")[1]?.split("/")[0];
    const method = route.request().method();
    if (table === "profiles" && method === "GET") {
      return route.fulfill({
        status: 200, contentType: "application/json", headers: { "content-range": "0-0/1" },
        body: JSON.stringify({ id: USER_ID, name: "Browser Test", email: "browser-test@example.com", phone: null, agent: null, invited_user: null, created_at: "2026-01-01T00:00:00.000Z" }),
      });
    }
    if (table === "insurance_scenarios" && method === "GET") {
      return route.fulfill({
        status: 200, contentType: "application/json", headers: { "content-range": "0-0/1" },
        body: JSON.stringify([{
          id: "saved-card-a", user_id: USER_ID, address: ADDRESS_A, saved_at: "2026-11-01T00:00:00.000Z",
          policy_type: "HO3", policy_type_source: "default_rule",
          user_answer_sources: {
            roof_year: 2004, roof_year_source: "manual",
            year_built: 1971, property_characteristics_year_built_source: "manual",
          },
        }]),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "*/0" }, body: "[]" });
  });
}

async function mockApi(page: Page) {
  const characteristicsRequests: string[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/insurance/property-characteristics") {
      const requested = url.searchParams.get("address") ?? "";
      characteristicsRequests.push(requested);
      const isB = requested === ADDRESS_B;
      return route.fulfill({
        json: {
          yearBuilt: isB ? 2015 : 1971,
          squareFeetLiving: isB ? 1850 : 1200,
          constructionLabel: "CONCRETE BLOCK",
          floodZone: "X",
          fieldSources: {},
          roofPermits: isB ? [{ year: 2021, source: "County permit (test)" }] : [],
        },
      });
    }
    if (url.pathname === "/api/insurance/my-quotes") return route.fulfill({ json: { results: [] } });
    if (url.pathname === "/api/ami") return route.fulfill({ status: 503, json: { error: "Disabled in browser tests" } });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return characteristicsRequests;
}

async function pickSuggestion(page: Page, typed: string, address: string, placeId: string) {
  const input = page.getByPlaceholder("Enter a property address...");
  await input.fill(typed);
  await expect.poll(() => page.evaluate(v => (window as any).__placesMock.predictionRequests.some((r: { input: string }) => r.input === v), typed)).toBe(true);
  await page.evaluate(({ v, a, id }) => (window as any).__placesMock.resolvePredictions(v, [{ address: a, placeId: id }]), { v: typed, a: address, id: placeId });
  await page.getByRole("option", { name: address }).click();
  return input;
}

test.beforeEach(async ({ page }) => {
  await installPlacesMock(page);
  await installSignedInUserWithSavedCard(page);
});

test("Add Insurance Property opens the newly selected address and looks up its county records", async ({ page }) => {
  const characteristicsRequests = await mockApi(page);
  await page.goto("/dashboard?tab=insurance");
  await expect(page.getByText(ADDRESS_A).first()).toBeVisible();

  await page.getByTestId("add-insurance-property").click();
  await pickSuggestion(page, "100 Exam", ADDRESS_B, "place-b");
  // The user clicks Analyze before Google returns place details.
  await page.getByRole("button", { name: "Analyze" }).click();
  await page.evaluate(() => (window as any).__placesMock.resolveDetails("place-b"));

  await expect.poll(() => new URL(page.url()).pathname).toBe("/insurance");
  await expect.poll(() => new URL(page.url()).searchParams.get("address")).toBe(ADDRESS_B);
  await expect.poll(() => characteristicsRequests).toContain(ADDRESS_B);
  expect(characteristicsRequests).not.toContain(ADDRESS_A);
  await expect(page.getByTestId("input-roof-year")).toHaveValue("2021");
  await expect(page.getByText(ADDRESS_A)).toHaveCount(0);
});

test("Analyze with typed text and no suggestion picked opens exactly what was typed", async ({ page }) => {
  const characteristicsRequests = await mockApi(page);
  await page.goto("/dashboard?tab=insurance");
  await expect(page.getByText(ADDRESS_A).first()).toBeVisible();
  await page.getByTestId("add-insurance-property").click();
  await page.getByPlaceholder("Enter a property address...").fill(ADDRESS_B);
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("address")).toBe(ADDRESS_B);
  await expect.poll(() => characteristicsRequests).toContain(ADDRESS_B);
  expect(characteristicsRequests).not.toContain(ADDRESS_A);
});

test("re-adding a previously deleted address opens it, not the remaining saved card", async ({ page }) => {
  // The user deleted address B from the Insurance tab earlier on this device.
  await page.addInitScript(({ userId }) => {
    localStorage.setItem(`dashboard:insurance-dismissed:${userId}`,
      JSON.stringify(["100|example street||33607|fl", "100 example st, tampa, fl 33607, usa"]));
  }, { userId: USER_ID });
  const characteristicsRequests = await mockApi(page);
  await page.goto("/dashboard?tab=insurance");
  await expect(page.getByText(ADDRESS_A).first()).toBeVisible();

  await page.getByTestId("add-insurance-property").click();
  await pickSuggestion(page, "100 Exam", ADDRESS_B, "place-b");
  await page.evaluate(() => (window as any).__placesMock.resolveDetails("place-b"));

  await expect.poll(() => new URL(page.url()).pathname).toBe("/insurance");
  await expect.poll(() => characteristicsRequests).toContain(ADDRESS_B);
  // Give any redirect a chance to happen before asserting it did not.
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).searchParams.get("address")).toBe(ADDRESS_B);
  expect(characteristicsRequests).not.toContain(ADDRESS_A);
  await expect(page.getByTestId("input-roof-year")).toHaveValue("2021");
});
