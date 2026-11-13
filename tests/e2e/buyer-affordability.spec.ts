import { expect, test, type Page, type Route } from "./quote-access-fixture";
import { calculateBuyerAffordability } from "../../client/src/lib/buyer-affordability";

const TEST_USER = {
  id: "00000000-0000-4000-8000-000000000077",
  aud: "authenticated",
  role: "authenticated",
  email: "affordability-browser-test@example.com",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { name: "Affordability Browser Test" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function currency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installAuthenticatedEmptyDashboard(page: Page): Promise<void> {
  await page.addInitScript((user) => {
    const session = JSON.stringify({
      access_token: "affordability-browser-test-access-token",
      refresh_token: "affordability-browser-test-refresh-token",
      expires_in: 3600,
      expires_at: 4_102_444_800,
      token_type: "bearer",
      user,
    });
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      if (
        key === "tateo_supabase_session" ||
        key === "supabase.auth.token" ||
        /^sb-.+-auth-token$/.test(key)
      ) {
        return session;
      }
      return originalGetItem.call(this, key);
    };
    localStorage.setItem("tateo_auth", "1");
  }, TEST_USER);

  await page.route("**/auth/v1/user", route => fulfillJson(route, TEST_USER));
  await page.route("**/rest/v1/**", route => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/rest/v1/")[1]?.split(/[?/]/)[0];
    const isProfileRead = table === "profiles" && route.request().method() === "GET";
    const isProfileSave = table === "profiles" && route.request().method() === "PATCH";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": isProfileRead || isProfileSave ? "0-0/1" : "*/0" },
      body: JSON.stringify(
        isProfileRead
          ? {
              id: TEST_USER.id,
              name: "Affordability Browser Test",
              email: TEST_USER.email,
              created_at: TEST_USER.created_at,
            }
          : isProfileSave
            ? { id: TEST_USER.id }
            : [],
      ),
    });
  });
  await page.route("**/api/**", route => fulfillJson(route, {}));
}

test.beforeEach(async ({ page }) => {
  await installAuthenticatedEmptyDashboard(page);
  await page.goto("/dashboard?tab=purchase");
  await expect(page.getByTestId("buyer-affordability-calculator")).toBeVisible();
});

test("empty Purchase dashboard calculates and updates an affordability range", async ({ page }) => {
  const expected = calculateBuyerAffordability(8_000, 500);
  expect(expected).not.toBeNull();

  await page.getByTestId("affordability-income").fill("8000");
  await page.getByTestId("affordability-debts").fill("500");

  await expect(page.getByTestId("housing-budget-range")).toHaveText("$2,940–$3,420");
  await expect(page.getByTestId("purchase-price-range")).toHaveText(
    `${currency(expected!.purchasePriceLow)}–${currency(expected!.purchasePriceHigh)}`,
  );
  await page.screenshot({
    path: "screenshots/buyer-affordability-programs.png",
    fullPage: true,
  });
  await page.getByTestId("save-affordability-inputs").click();
  await expect(page.getByTestId("affordability-save-status")).toContainText("saved to your profile");

  const firstLow = expected!.purchasePriceLow;
  const firstHigh = expected!.purchasePriceHigh;
  await page.getByTestId("affordability-debts").fill("2500");
  const withMoreDebt = calculateBuyerAffordability(8_000, 2_500)!;
  expect(withMoreDebt.purchasePriceLow).toBeLessThan(firstLow);
  expect(withMoreDebt.purchasePriceHigh).toBeLessThan(firstHigh);
  await expect(page.getByTestId("purchase-price-range")).toHaveText(
    `${currency(withMoreDebt.purchasePriceLow)}–${currency(withMoreDebt.purchasePriceHigh)}`,
  );

  await page.getByTestId("affordability-income").fill("");
  await expect(page.getByTestId("affordability-results")).toHaveCount(0);
});

test("program selector changes planning math and explains program rules", async ({ page }) => {
  await page.getByTestId("affordability-income").fill("8000");
  await page.getByTestId("affordability-debts").fill("500");
  await expect(page.getByTestId("affordability-assumptions")).toContainText("43%–49% total DTI");
  await expect(page.getByTestId("affordability-assumptions")).not.toContainText("28%");

  await page.getByTestId("affordability-program-fha").click();
  await expect(page.getByTestId("housing-budget-range")).toHaveText("$3,100–$3,900");
  await expect(page.getByTestId("affordability-assumptions")).toContainText("45%–55% total DTI");
  await expect(page.getByTestId("affordability-assumptions")).toContainText("1.75% upfront MIP");

  await page.getByTestId("affordability-program-va").click();
  await expect(page.getByTestId("affordability-results")).toHaveCount(0);
  await expect(page.getByTestId("affordability-assumptions")).toContainText(
    "No automatic income-based range or fixed mandatory DTI cap",
  );
  await expect(page.getByTestId("affordability-assumptions")).toContainText(
    "funding fee is excluded",
  );
  await page.getByTestId("va-budget-low").fill("2500");
  await page.getByTestId("va-budget-high").fill("2000");
  await expect(page.getByRole("alert")).toContainText("Low budget cannot be greater");
  await expect(page.getByTestId("affordability-results")).toHaveCount(0);
  await page.getByTestId("va-budget-high").fill("3000");
  await expect(page.getByTestId("housing-budget-range")).toHaveText("$2,500–$3,000");
  await expect(page.getByTestId("va-actual-dti")).toContainText("This is not a VA cap");

  expect(await page.evaluate((id) =>
    localStorage.getItem(`buyer-affordability-program:${id}`), TEST_USER.id)).toBe("va");
});

test("calculator does not cause horizontal overflow at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId("affordability-income").fill("8000");
  await page.getByTestId("affordability-debts").fill("500");
  await page.getByTestId("affordability-program-va").click();
  await page.getByTestId("va-budget-low").fill("2000");
  await page.getByTestId("va-budget-high").fill("2500");
  await expect(page.getByTestId("affordability-results")).toBeVisible();

  const dimensions = await page.getByTestId("buyer-affordability-calculator").evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      left: bounds.left,
      right: bounds.right,
      client: element.clientWidth,
      content: element.scrollWidth,
    };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.client);
});