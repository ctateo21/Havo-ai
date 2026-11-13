import { expect, test, type Locator, type Page } from "./quote-access-fixture";

type PredictionChoice = {
  address: string;
  placeId: string;
};

for (const path of ["/insurance", "/estimate", "/refinance"]) {
  test(`guest entry ${path} suggests addresses before starting a quote`, async ({ page }) => {
    await installGooglePlacesMock(page);
    let starts = 0;
    await page.route("**/api/anonymous-quote/start", async route => {
      starts++;
      await route.fulfill({ json: { allowed: true } });
    });
    await page.goto(path);
    const input = page.getByRole("combobox", { name: "Florida property address" });
    await input.fill("7400 36th");
    await waitForPredictionRequest(page, "7400 36th");
    const address = "7400 36th Ave N, St. Petersburg, FL 33710, USA";
    await resolvePredictions(page, "7400 36th", [{address, placeId:"guest-property"}]);
    await page.getByRole("option", {name:address}).click();
    await waitForDetailRequest(page, "guest-property");
    await resolveDetails(page, "guest-property", address);
    await expect(input).toHaveValue(address);
    expect(starts).toBe(0);
    await page.getByRole("button", {name:"Start my quote"}).click();
    await expect.poll(() => starts).toBeGreaterThan(0);
    await expectAddressInUrl(page, address);
  });
}

async function installGooglePlacesMock(page: Page) {
  await page.addInitScript(() => {
    type PredictionRequest = {
      input: string;
      tokenId: number;
      resolve: (value: unknown) => void;
      resolved: boolean;
    };
    type DetailRequest = {
      placeId: string;
      address: string;
      place: Record<string, unknown>;
      resolve: () => void;
      resolved: boolean;
    };

    let nextTokenId = 0;
    const predictionRequests: PredictionRequest[] = [];
    const detailRequests: DetailRequest[] = [];

    class AutocompleteSessionToken {
      readonly id = ++nextTokenId;
    }

    const createPrediction = (address: string, placeId: string) => ({
      text: { text: address },
      placeId,
      toPlace() {
        const place: Record<string, unknown> = {
          id: placeId,
          formattedAddress: undefined,
          addressComponents: [
            { longText: address.split(" ")[0], shortText: address.split(" ")[0], types: ["street_number"] },
            { longText: address.split(",")[0].replace(/^\S+\s+/, ""), shortText: address.split(",")[0].replace(/^\S+\s+/, ""), types: ["route"] },
            { longText: "Tampa", shortText: "Tampa", types: ["locality"] },
            { longText: "Florida", shortText: "FL", types: ["administrative_area_level_1"] },
            { longText: "33602", shortText: "33602", types: ["postal_code"] },
          ],
          location: {
            lat: () => 27.9506,
            lng: () => -82.4572,
          },
        };
        place.fetchFields = () =>
          new Promise<void>((resolve) => {
            detailRequests.push({
              placeId,
              address,
              place,
              resolve,
              resolved: false,
            });
          });
        return place;
      },
    });

    const mock = {
      predictionRequests,
      detailRequests,
      resolvePredictions(input: string, choices: Array<{ address: string; placeId: string }>) {
        const request = predictionRequests.find(
          candidate => candidate.input === input && !candidate.resolved,
        );
        if (!request) throw new Error(`No pending prediction request for "${input}"`);
        request.resolved = true;
        request.resolve({
          suggestions: choices.map(choice => ({
            placePrediction: createPrediction(choice.address, choice.placeId),
          })),
        });
      },
      resolveDetails(placeId: string, formattedAddress?: string) {
        const request = detailRequests.find(
          candidate => candidate.placeId === placeId && !candidate.resolved,
        );
        if (!request) throw new Error(`No pending detail request for "${placeId}"`);
        request.resolved = true;
        request.place.formattedAddress = formattedAddress || request.address;
        request.resolve();
      },
    };

    (window as any).__placesMock = mock;
    (window as any).google = {
      maps: {
        places: {},
        importLibrary: async (library: string) => {
          if (library !== "places") throw new Error(`Unexpected Google library: ${library}`);
          return {
            AutocompleteSessionToken,
            AutocompleteSuggestion: {
              fetchAutocompleteSuggestions: ({
                input,
                sessionToken,
              }: {
                input: string;
                sessionToken: AutocompleteSessionToken;
              }) =>
                new Promise(resolve => {
                  predictionRequests.push({
                    input,
                    tokenId: sessionToken.id,
                    resolve,
                    resolved: false,
                  });
                }),
            },
          };
        },
      },
    };
  });

  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/anonymous-quote/start") return route.fulfill({json:{allowed:true}});
    if (url.pathname === "/api/ami") {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Disabled in browser tests" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
}

async function waitForPredictionRequest(page: Page, input: string, count = 1) {
  await expect
    .poll(() =>
      page.evaluate(
        value =>
          (window as any).__placesMock.predictionRequests.filter(
            (request: { input: string }) => request.input === value,
          ).length,
        input,
      ),
    )
    .toBeGreaterThanOrEqual(count);
}

async function predictionToken(page: Page, input: string) {
  return page.evaluate(
    value => {
      const requests = (window as any).__placesMock.predictionRequests.filter(
        (request: { input: string }) => request.input === value,
      );
      return requests[requests.length - 1]?.tokenId as number | undefined;
    },
    input,
  );
}

async function resolvePredictions(
  page: Page,
  input: string,
  choices: PredictionChoice[],
) {
  await page.evaluate(
    ({ inputValue, nextChoices }) =>
      (window as any).__placesMock.resolvePredictions(inputValue, nextChoices),
    { inputValue: input, nextChoices: choices },
  );
}

async function waitForDetailRequest(page: Page, placeId: string) {
  await expect
    .poll(() =>
      page.evaluate(
        id =>
          (window as any).__placesMock.detailRequests.some(
            (request: { placeId: string }) => request.placeId === id,
          ),
        placeId,
      ),
    )
    .toBe(true);
}

async function resolveDetails(page: Page, placeId: string, formattedAddress: string) {
  await page.evaluate(
    ({ id, address }) => (window as any).__placesMock.resolveDetails(id, address),
    { id: placeId, address: formattedAddress },
  );
}

async function expectAddressInUrl(page: Page, expectedAddress: string) {
  await expect
    .poll(() => new URL(page.url()).searchParams.get("address"))
    .toBe(expectedAddress);
}

async function openUnlockedEstimate(page: Page, seedAddress: string) {
  await installAuthenticatedUser(page);
  const estimatePath = `/estimate?address=${encodeURIComponent(seedAddress)}`;

  await page.goto(estimatePath);
  await page.getByRole("button", { name: "Add Property" }).waitFor();

  // A real mocked session replaces the retired localStorage-only unlock.
  // Signed-in home redirects to the dashboard, so no guest-home detour.
}

async function expectSessionAbandoned(
  page: Page,
  input: Locator,
  abandon: () => Promise<void>,
  prefix: string,
) {
  const pendingInput = `${prefix} pending`;
  const nextInput = `${prefix} next`;

  await input.fill(pendingInput);
  await waitForPredictionRequest(page, pendingInput);
  const firstToken = await predictionToken(page, pendingInput);

  await abandon();
  await resolvePredictions(page, pendingInput, [
    { address: `100 ${prefix} Old St, Tampa, FL 33602`, placeId: `${prefix}-old` },
  ]);
  await expect(page.getByRole("option")).toHaveCount(0);

  await input.fill(nextInput);
  await waitForPredictionRequest(page, nextInput);
  const secondToken = await predictionToken(page, nextInput);

  expect(firstToken).toBeDefined();
  expect(secondToken).toBeDefined();
  expect(secondToken).not.toBe(firstToken);
}

async function expectVisibleSessionAbandoned(
  page: Page,
  input: Locator,
  abandon: () => Promise<void>,
  prefix: string,
) {
  const pendingInput = `${prefix} visible`;
  const nextInput = `${prefix} next`;
  const visibleAddress = `100 ${prefix} Old St, Tampa, FL 33602`;

  await input.fill(pendingInput);
  await waitForPredictionRequest(page, pendingInput);
  const firstToken = await predictionToken(page, pendingInput);
  await resolvePredictions(page, pendingInput, [
    { address: visibleAddress, placeId: `${prefix}-visible` },
  ]);
  await expect(page.getByRole("option", { name: visibleAddress })).toBeVisible();

  await abandon();
  await expect(page.getByRole("option")).toHaveCount(0);

  await input.fill(nextInput);
  await waitForPredictionRequest(page, nextInput);
  const secondToken = await predictionToken(page, nextInput);

  expect(firstToken).toBeDefined();
  expect(secondToken).toBeDefined();
  expect(secondToken).not.toBe(firstToken);
}

async function installAuthenticatedUser(page: Page) {
  await page.addInitScript(() => {
    const user = {
      id: "00000000-0000-4000-8000-000000000030",
      aud: "authenticated",
      role: "authenticated",
      email: "browser-test@example.com",
      email_confirmed_at: "2026-01-01T00:00:00.000Z",
      phone: "",
      app_metadata: {
        provider: "email",
        providers: ["email"],
      },
      user_metadata: {
        name: "Browser Test",
      },
      identities: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const session = JSON.stringify({
      access_token: "browser-test-access-token",
      refresh_token: "browser-test-refresh-token",
      expires_in: 3600,
      expires_at: 4102444800,
      token_type: "bearer",
      user,
    });
    const originalGetItem = Storage.prototype.getItem;

    Storage.prototype.getItem = function (key: string) {
      const matchesSessionKey =
        key === "tateo_supabase_session" ||
        key === "supabase.auth.token" ||
        /^sb-.+-auth-token$/.test(key);
      if (matchesSessionKey) return session;
      return originalGetItem.call(this, key);
    };
    localStorage.setItem("tateo_auth", "1");
  });

  await page.route("**/rest/v1/**", route => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/rest/v1/")[1]?.split("/")[0];
    const isProfileRead = table === "profiles" && route.request().method() === "GET";
    const body = isProfileRead
      ? {
          id: "00000000-0000-4000-8000-000000000030",
          name: "Browser Test",
          email: "browser-test@example.com",
          phone: null,
          agent: null,
          invited_user: null,
          created_at: "2026-01-01T00:00:00.000Z",
          monthly_income: null,
          monthly_debts: null,
        }
      : [];

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "content-range": isProfileRead ? "0-0/1" : "*/0",
      },
      body: JSON.stringify(body),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await installGooglePlacesMock(page);
});

for (const [typedAddress, label] of [
  ["123 Main St Unit 2", "Unit"],
  ["123 Main St Apt 2", "Apt"],
  ["123 Main St #2", "hash"],
] as const) {
  test(`homepage preserves a ${label} unit while querying and selecting its base address`, async ({
    page,
  }) => {
    const queryAddress = "123 Main St";
    const googleAddress = "123 Main St, Tampa, FL 33602";
    const canonicalAddress = "123 Main St Unit 2, Tampa, FL 33602";
    const placeId = `main-st-${label.toLowerCase()}`;

    await page.goto("/");
    const input = page.getByPlaceholder("Enter a property address...");
    await input.fill(typedAddress);
    await waitForPredictionRequest(page, queryAddress);
    await resolvePredictions(page, queryAddress, [
      { address: googleAddress, placeId },
    ]);

    const option = page.getByRole("option", {
      name: /123 Main St Unit 2, Tampa, FL 33602/,
    });
    await expect(option).toBeVisible();
    await option.click();
    await waitForDetailRequest(page, placeId);
    await resolveDetails(page, placeId, googleAddress);

    await expectAddressInUrl(page, canonicalAddress);
  });
}

test("homepage strips a unit suffix from a complete address and restores it after selection", async ({
  page,
}) => {
  const typedAddress = "123 Main St, Tampa, FL 33602 #2";
  const queryAddress = "123 Main St, Tampa, FL 33602";
  const canonicalAddress = "123 Main St Unit 2, Tampa, FL 33602";

  await page.goto("/");
  const input = page.getByPlaceholder("Enter a property address...");
  await input.fill(typedAddress);
  await waitForPredictionRequest(page, queryAddress);
  await resolvePredictions(page, queryAddress, [
    { address: queryAddress, placeId: "complete-main-st" },
  ]);

  const option = page.getByRole("option", {
    name: /123 Main St Unit 2, Tampa, FL 33602/,
  });
  await expect(option).toBeVisible();
  await option.click();
  await waitForDetailRequest(page, "complete-main-st");
  await resolveDetails(page, "complete-main-st", queryAddress);

  await expectAddressInUrl(page, canonicalAddress);
});

test("unit-only edits reuse the active Google typing session", async ({
  page,
}) => {
  const queryAddress = "123 Main St";

  await page.goto("/");
  const input = page.getByPlaceholder("Enter a property address...");
  await input.fill("123 Main St Unit 2");
  await waitForPredictionRequest(page, queryAddress);
  const unit2Token = await predictionToken(page, queryAddress);

  await input.fill("123 Main St Unit 3");
  await waitForPredictionRequest(page, queryAddress, 2);
  const unit3Token = await predictionToken(page, queryAddress);

  expect(unit2Token).toBeDefined();
  expect(unit3Token).toBe(unit2Token);
});

test("stale unit details cannot replace a later unit selection", async ({
  page,
}) => {
  const queryAddress = "123 Main St";
  const googleAddress = "123 Main St, Tampa, FL 33602";
  const unit2Address = "123 Main St Unit 2, Tampa, FL 33602";
  const unit3Address = "123 Main St Unit 3, Tampa, FL 33602";

  await page.goto("/");
  const input = page.getByPlaceholder("Enter a property address...");

  await input.fill("123 Main St Unit 2");
  await waitForPredictionRequest(page, queryAddress);
  await resolvePredictions(page, queryAddress, [
    { address: googleAddress, placeId: "main-st-unit-2" },
  ]);
  await page.getByRole("option", { name: /123 Main St Unit 2,/ }).click();
  await waitForDetailRequest(page, "main-st-unit-2");

  await input.fill("123 Main St Unit 3");
  await waitForPredictionRequest(page, queryAddress, 2);
  await resolvePredictions(page, queryAddress, [
    { address: googleAddress, placeId: "main-st-unit-3" },
  ]);
  await page.getByRole("option", { name: /123 Main St Unit 3,/ }).click();
  await waitForDetailRequest(page, "main-st-unit-3");

  await resolveDetails(page, "main-st-unit-3", googleAddress);
  await expectAddressInUrl(page, unit3Address);

  await resolveDetails(page, "main-st-unit-2", googleAddress);
  await expectAddressInUrl(page, unit3Address);
  expect(new URL(page.url()).searchParams.get("address")).not.toBe(
    unit2Address,
  );
});

test("homepage mouse selection ignores reordered predictions and stale place details", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByPlaceholder("Enter a property address...");

  await input.fill("Older prediction");
  await waitForPredictionRequest(page, "Older prediction");
  await input.fill("New prediction");
  await waitForPredictionRequest(page, "New prediction");

  const firstSelected = "111 New Choice St, Tampa, FL 33602";
  await resolvePredictions(page, "New prediction", [
    { address: firstSelected, placeId: "new-choice" },
  ]);
  await expect(page.getByRole("option", { name: firstSelected })).toBeVisible();

  await resolvePredictions(page, "Older prediction", [
    { address: "999 Stale Result Rd, Tampa, FL 33602", placeId: "stale-result" },
  ]);
  await expect(page.getByRole("option", { name: firstSelected })).toBeVisible();
  await expect(page.getByRole("option", { name: /Stale Result/ })).toHaveCount(0);

  await page.getByRole("option", { name: firstSelected }).click();
  await waitForDetailRequest(page, "new-choice");

  await input.fill("Latest selection");
  await waitForPredictionRequest(page, "Latest selection");
  const latestAddress = "222 Latest Ave, Tampa, FL 33602";
  await resolvePredictions(page, "Latest selection", [
    { address: latestAddress, placeId: "latest-choice" },
  ]);
  await page.getByRole("option", { name: latestAddress }).click();
  await waitForDetailRequest(page, "latest-choice");

  await resolveDetails(page, "latest-choice", latestAddress);
  await expectAddressInUrl(page, latestAddress);

  await resolveDetails(page, "new-choice", firstSelected);
  await expectAddressInUrl(page, latestAddress);
});

test("estimate keyboard selection auto-adds only the latest property", async ({ page }) => {
  const seedAddress = "10 Seed St, Tampa, FL 33602";
  await openUnlockedEstimate(page, seedAddress);

  await page.getByRole("button", { name: "Add Property" }).click();
  const input = page.getByPlaceholder("123 Main St, City, State…");

  await input.fill("First keyboard");
  await waitForPredictionRequest(page, "First keyboard");
  const firstAddress = "333 First Keyboard St, Tampa, FL 33602";
  await resolvePredictions(page, "First keyboard", [
    { address: firstAddress, placeId: "first-keyboard" },
  ]);
  await input.press("ArrowDown");
  await input.press("Enter");
  await waitForDetailRequest(page, "first-keyboard");

  await input.fill("Latest keyboard");
  await waitForPredictionRequest(page, "Latest keyboard");
  const latestAddress = "444 Latest Keyboard Ave, Tampa, FL 33602";
  await resolvePredictions(page, "Latest keyboard", [
    { address: latestAddress, placeId: "latest-keyboard" },
  ]);
  await input.press("ArrowDown");
  await input.press("Enter");
  await waitForDetailRequest(page, "latest-keyboard");

  await page.evaluate(address => {
    localStorage.setItem(
      "havo_free_address",
      address.trim().toLowerCase().replace(/\s+/g, " "),
    );
  }, latestAddress);
  await resolveDetails(page, "latest-keyboard", latestAddress);
  await expectAddressInUrl(page, latestAddress);
  await expect(
    page.locator('[title="Drag to reorder"]').filter({ hasText: "444 Latest Keyboard" }),
  ).toBeVisible();

  await resolveDetails(page, "first-keyboard", firstAddress);
  await expectAddressInUrl(page, latestAddress);
  await expect(
    page.locator('[title="Drag to reorder"]').filter({ hasText: "333 First Keyboard" }),
  ).toHaveCount(0);
});

test("clearing abandons the active suggestion session", async ({ page }) => {
  await page.goto("/");
  const input = page.getByPlaceholder("Enter a property address...");
  await expectSessionAbandoned(page, input, () => input.fill(""), "Clear");
});

test("blurring abandons the active suggestion session", async ({ page }) => {
  await page.goto("/");
  const input = page.getByPlaceholder("Enter a property address...");
  const pendingInput = "Blur pending";
  const nextInput = "Blur next";

  await input.fill(pendingInput);
  await waitForPredictionRequest(page, pendingInput);
  const firstToken = await predictionToken(page, pendingInput);
  await resolvePredictions(page, pendingInput, [
    { address: "100 Blur Old St, Tampa, FL 33602", placeId: "blur-old" },
  ]);
  await expect(page.getByRole("option", { name: /Blur Old/ })).toBeVisible();

  await input.blur();
  await expect(page.getByRole("option")).toHaveCount(0);

  await input.fill(nextInput);
  await waitForPredictionRequest(page, nextInput);
  const secondToken = await predictionToken(page, nextInput);
  expect(secondToken).not.toBe(firstToken);
});

test("Escape abandons a session while predictions are still pending", async ({ page }) => {
  await page.goto("/");
  const input = page.getByPlaceholder("Enter a property address...");
  await expectSessionAbandoned(page, input, () => input.press("Escape"), "Escape");
});

test("Escape also closes the estimate dialog while abandoning its pending session", async ({
  page,
}) => {
  await openUnlockedEstimate(page, "20 Dialog Seed St, Tampa, FL 33602");
  await page.getByRole("button", { name: "Add Property" }).click();
  const input = page.getByPlaceholder("123 Main St, City, State…");

  await input.fill("Dialog pending");
  await waitForPredictionRequest(page, "Dialog pending");
  await input.press("Escape");
  await expect(page.getByRole("heading", { name: "Add New Property" })).toHaveCount(0);

  await resolvePredictions(page, "Dialog pending", [
    { address: "500 Stale Dialog St, Tampa, FL 33602", placeId: "stale-dialog" },
  ]);
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("insurance add-property dialog abandons sessions and commits only the latest selected address", async ({
  page,
}) => {
  const seedAddress = "30 Insurance Seed St, Tampa, FL 33602";
  await installAuthenticatedUser(page);
  await page.goto(`/insurance?address=${encodeURIComponent(seedAddress)}`);
  await page.getByTitle("Compare another property").click();

  const dialog = page.getByRole("dialog", { name: "Add New Property" });
  const input = dialog.getByPlaceholder("123 Main St, City, State…");
  await expect(dialog).toBeVisible();

  await expectVisibleSessionAbandoned(
    page,
    input,
    () => input.fill(""),
    "Insurance clear",
  );
  await expectVisibleSessionAbandoned(
    page,
    input,
    () => input.blur(),
    "Insurance blur",
  );

  await input.fill("Insurance escape pending");
  await waitForPredictionRequest(page, "Insurance escape pending");
  await input.press("Escape");
  await expect(dialog).toHaveCount(0);
  await resolvePredictions(page, "Insurance escape pending", [
    {
      address: "100 Insurance Escape Old St, Tampa, FL 33602",
      placeId: "insurance-escape-old",
    },
  ]);
  await expect(page.locator(".google-places-suggestions [role=option]")).toHaveCount(0);

  await page.getByTitle("Compare another property").click();
  await expect(dialog).toBeVisible();
  const reopenedInput = dialog.getByPlaceholder("123 Main St, City, State…");

  await reopenedInput.fill("Insurance older prediction");
  await waitForPredictionRequest(page, "Insurance older prediction");
  await reopenedInput.fill("Insurance newer prediction");
  await waitForPredictionRequest(page, "Insurance newer prediction");

  const firstSelected = "555 Insurance First St, Tampa, FL 33602";
  await resolvePredictions(page, "Insurance newer prediction", [
    { address: firstSelected, placeId: "insurance-first" },
  ]);
  await expect(page.getByRole("option", { name: firstSelected })).toBeVisible();
  await resolvePredictions(page, "Insurance older prediction", [
    {
      address: "999 Insurance Stale Result Rd, Tampa, FL 33602",
      placeId: "insurance-stale-result",
    },
  ]);
  await expect(page.getByRole("option", { name: firstSelected })).toBeVisible();
  await expect(page.getByRole("option", { name: /Insurance Stale Result/ })).toHaveCount(0);

  await page.getByRole("option", { name: firstSelected }).click();
  await waitForDetailRequest(page, "insurance-first");

  await reopenedInput.fill("Insurance latest selection");
  await waitForPredictionRequest(page, "Insurance latest selection");
  const latestAddress = "666 Insurance Latest Ave, Tampa, FL 33602";
  await resolvePredictions(page, "Insurance latest selection", [
    { address: latestAddress, placeId: "insurance-latest" },
  ]);
  await page.getByRole("option", { name: latestAddress }).click();
  await waitForDetailRequest(page, "insurance-latest");

  await resolveDetails(page, "insurance-latest", latestAddress);
  await expect(reopenedInput).toHaveValue(latestAddress);
  await resolveDetails(page, "insurance-first", firstSelected);
  await expect(reopenedInput).toHaveValue(latestAddress);

  await dialog.getByRole("button", { name: "Add Property" }).click();
  await expectAddressInUrl(page, latestAddress);
  await expect(dialog).toHaveCount(0);
});

test("dashboard property search abandons sessions and navigates only to the latest selected address", async ({
  page,
}) => {
  await installAuthenticatedUser(page);
  await page.goto("/dashboard?tab=purchase");

  await page.getByRole("heading", { name: "My Dashboard" }).waitFor();
  const input = page.getByPlaceholder("Enter a property address...");

  await expectVisibleSessionAbandoned(
    page,
    input,
    () => input.fill(""),
    "Dashboard clear",
  );
  await expectVisibleSessionAbandoned(
    page,
    input,
    () => input.blur(),
    "Dashboard blur",
  );
  await expectVisibleSessionAbandoned(
    page,
    input,
    () => input.press("Escape"),
    "Dashboard escape",
  );

  await input.fill("Dashboard older prediction");
  await waitForPredictionRequest(page, "Dashboard older prediction");
  await input.fill("Dashboard newer prediction");
  await waitForPredictionRequest(page, "Dashboard newer prediction");

  const firstSelected = "777 Dashboard First St, Tampa, FL 33602";
  await resolvePredictions(page, "Dashboard newer prediction", [
    { address: firstSelected, placeId: "dashboard-first" },
  ]);
  await expect(page.getByRole("option", { name: firstSelected })).toBeVisible();
  await resolvePredictions(page, "Dashboard older prediction", [
    {
      address: "999 Dashboard Stale Result Rd, Tampa, FL 33602",
      placeId: "dashboard-stale-result",
    },
  ]);
  await expect(page.getByRole("option", { name: firstSelected })).toBeVisible();
  await expect(page.getByRole("option", { name: /Dashboard Stale Result/ })).toHaveCount(0);

  await page.getByRole("option", { name: firstSelected }).click();
  await waitForDetailRequest(page, "dashboard-first");

  await input.fill("Dashboard latest selection");
  await waitForPredictionRequest(page, "Dashboard latest selection");
  const latestAddress = "888 Dashboard Latest Ave, Tampa, FL 33602";
  await resolvePredictions(page, "Dashboard latest selection", [
    { address: latestAddress, placeId: "dashboard-latest" },
  ]);
  await page.getByRole("option", { name: latestAddress }).click();
  await waitForDetailRequest(page, "dashboard-latest");

  await resolveDetails(page, "dashboard-latest", latestAddress);
  await expectAddressInUrl(page, latestAddress);
  expect(new URL(page.url()).searchParams.get("from")).toBe("dashboard");

  await resolveDetails(page, "dashboard-first", firstSelected);
  await expectAddressInUrl(page, latestAddress);
  expect(new URL(page.url()).searchParams.get("from")).toBe("dashboard");
});