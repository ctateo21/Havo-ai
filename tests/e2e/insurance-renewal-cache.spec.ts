import { expect, test, type Page, type Route } from "./quote-access-fixture";

const ADDRESS = "123 Renewal Way, Tampa, FL 33602";
const FIRST_EXPIRATION = "2026-10-15";
const SECOND_EXPIRATION = "2026-11-15";

const TEST_USER = {
  id: "00000000-0000-4000-8000-000000000055",
  aud: "authenticated",
  role: "authenticated",
  email: "renewal-browser-test@example.com",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { name: "Renewal Browser Test" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function quote(siteName: string, annualPremium: number) {
  return {
    siteName,
    annualPremium,
    monthlyPremium: annualPremium / 12,
    coverageA: 400_000,
    hurricaneDeductible: "2%",
    aop: "$2,500",
    quoteUrl: null,
    quoteDate: "2026-09-06T12:00:00.000Z",
    rank: 1,
  };
}

function cacheResponse(siteName: string, leadId: number) {
  return {
    found: true,
    status: "success",
    leadId,
    quotes: [quote(siteName, 2400)],
    quoteCounter: 1,
    coverageA: 400_000,
    expiresAt: "2026-10-06T12:00:00.000Z",
    triggeredAt: "2026-09-06T12:00:00.000Z",
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installAuthenticatedRenewalMocks(page: Page) {
  let savedExpiration: string | null = null;
  let startSubmissions = 0;

  // Keep the fixture's 30-day shared quote valid regardless of the real date.
  // setFixedTime controls Date without pausing application timers.
  await page.clock.setFixedTime(new Date("2026-09-10T12:00:00.000Z"));
  await page.addInitScript(
    ({ user, address, sharedQuote }) => {
      const session = JSON.stringify({
        access_token: "renewal-browser-test-access-token",
        refresh_token: "renewal-browser-test-refresh-token",
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
      const cacheKey =
        "qr_auto_" +
        address.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 80) +
        "_ho3";
      localStorage.setItem(cacheKey, JSON.stringify(sharedQuote));
    },
    {
      user: TEST_USER,
      address: ADDRESS,
      sharedQuote: {
        address: ADDRESS,
        policyType: "HO3",
        leadId: 501,
        status: "success",
        quotes: [quote("Shared Cache Carrier", 1800)],
        quoteCounter: 1,
        coverageA: 400_000,
        expiresAt: "2026-10-06T12:00:00.000Z",
        triggeredAt: "2026-09-06T12:00:00.000Z",
      },
    },
  );

  await page.route("**/auth/v1/user", route => fulfillJson(route, TEST_USER));
  await page.route("**/rest/v1/**", route => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/rest/v1/")[1]?.split("/")[0];
    const isProfileRead =
      table === "profiles" && route.request().method() === "GET";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": isProfileRead ? "0-0/1" : "*/0" },
      body: JSON.stringify(
        isProfileRead
          ? {
              id: TEST_USER.id,
              name: "Renewal Browser Test",
              email: TEST_USER.email,
              created_at: "2026-01-01T00:00:00.000Z",
            }
          : [],
      ),
    });
  });
  await page.route("**/api/profile/status", route =>
    fulfillJson(route, {
      hasDateOfBirth: true,
    }),
  );
  await page.route("**/api/profile/insurance-property?*", route =>
    fulfillJson(route, {
      currentPolicyExpirationDate: savedExpiration,
    }),
  );
  await page.route("**/api/profile/insurance-property", async route => {
    const body = route.request().postDataJSON() as {
      currentPolicyExpirationDate: string | null;
    };
    savedExpiration = body.currentPolicyExpirationDate;
    await fulfillJson(route, { ok: true });
  });
  await page.route("**/api/insurance/qr-cache?*", route =>
    fulfillJson(route, cacheResponse("Shared Server Carrier", 502)),
  );
  await page.route("**/api/insurance/qr-start", route => {
    startSubmissions += 1;
    return fulfillJson(route, cacheResponse("Unexpected New Carrier", 999));
  });

  return {
    getSavedExpiration: () => savedExpiration,
    getStartSubmissions: () => startSubmissions,
  };
}

test("renewal expiration persists without exposing or automatically rerunning cached quotes", async ({
  page,
}) => {
  // Keep the fixture's September quote inside its October expiry window.
  await page.clock.setFixedTime(new Date("2026-09-07T12:00:00.000Z"));
  const state = await installAuthenticatedRenewalMocks(page);
  await page.goto(`/insurance?address=${encodeURIComponent(ADDRESS)}`);

  await expect(page.getByText("Shared Cache Carrier")).toHaveCount(0);
  await page.getByTestId("select-new-purchase").selectOption("no");
  await page.getByTestId("select-currently-insured").selectOption("yes");
  await page.getByTestId("input-current-carrier").fill("Existing Carrier");

  const expiration = page.getByTestId(
    "input-current-policy-expiration-date",
  );
  await expiration.fill(FIRST_EXPIRATION);
  await expect.poll(state.getSavedExpiration).toBe(FIRST_EXPIRATION);
  await expect(page.getByText("Shared Cache Carrier")).toHaveCount(0);
  expect(state.getStartSubmissions()).toBe(0);

  await page.reload();
  await page.getByTestId("select-new-purchase").selectOption("no");
  await page.getByTestId("select-currently-insured").selectOption("yes");
  await expect(expiration).toHaveValue(FIRST_EXPIRATION);
  await expect(page.getByText("Shared Cache Carrier")).toHaveCount(0);

  await expiration.fill(SECOND_EXPIRATION);
  await expect.poll(state.getSavedExpiration).toBe(SECOND_EXPIRATION);
  await expect(page.getByText("Shared Cache Carrier")).toHaveCount(0);
  expect(state.getStartSubmissions()).toBe(0);

  await expiration.fill("");
  await expect.poll(state.getSavedExpiration).toBe(null);
  await expect(page.getByText("Shared Cache Carrier")).toHaveCount(0);
  expect(state.getStartSubmissions()).toBe(0);
});
