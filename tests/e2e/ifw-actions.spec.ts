import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { officialTaxFixture } from "./official-tax-fixture";
import { blockLiveNetwork } from "./mock-network";

test.beforeEach(async ({page}) => {
  await blockLiveNetwork(page);
  await page.route("**/api/property-tax/**", route => {
    const input = route.request().method()==="POST"?route.request().postDataJSON():{};
    const fixture=officialTaxFixture(input.purchasePrice,input.isPrimaryResidence);
    return route.fulfill({json:{...fixture,key:new URL(route.request().url()).searchParams.get("key")??fixture.key}});
  });
});

const TEST_USER = {
  id: "00000000-0000-4000-8000-000000000031",
  aud: "authenticated",
  role: "authenticated",
  email: "omar@tateoco.com",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { name: "Omar Andujar" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function installSignInMock(page: Page): Promise<() => number> {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = [
    base64Url({ alg: "none", typ: "JWT" }),
    base64Url({
      sub: TEST_USER.id,
      email: TEST_USER.email,
      role: "authenticated",
      aud: "authenticated",
      iat: now,
      exp: now + 3600,
    }),
    "browser-test-signature",
  ].join(".");
  let activityCount = 0;

  await page.route("**/auth/v1/token?grant_type=password", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: accessToken,
        refresh_token: "browser-test-refresh-token",
        expires_in: 3600,
        expires_at: now + 3600,
        token_type: "bearer",
        user: TEST_USER,
      }),
    }),
  );
  await page.route("**/auth/v1/user", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(TEST_USER),
    }),
  );
  await page.route("**/rest/v1/**", route => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/rest/v1/")[1]?.split("/")[0];
    const isProfileRead = table === "profiles" && route.request().method() === "GET";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": isProfileRead ? "0-0/1" : "*/0" },
      body: JSON.stringify(
        isProfileRead
          ? {
              id: TEST_USER.id,
              name: "Omar Andujar",
              email: TEST_USER.email,
              phone: null,
              agent: "Omar Andujar",
              created_at: "2026-01-01T00:00:00.000Z",
            }
          : [],
      ),
    });
  });
  await page.route("**/api/ifw/activity", route => {
    activityCount += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.route("**/api/auth/account-event", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );
  await page.route("**/api/profile/status", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hasDateOfBirth: false }),
    }),
  );

  return () => activityCount;
}

async function openGuestIfw(page: Page): Promise<void> {
  await page.goto(
    `/estimate?address=${encodeURIComponent("123 Main St, Tampa, FL 33602")}`,
  );
  await page.getByRole("button", {name:"primary",exact:true}).click();
  await page.getByRole("button", { name: /^Next/ }).click();
  await page.getByRole("button", { name: /^Next/ }).click();
  await page.getByRole("button", { name: /See My Estimate/ }).click();
  await page.getByRole("button", { name: /Initial Fees Worksheet/ }).click();
  await expect(page.getByTestId("dialog-fee-worksheet")).toBeVisible();
  const rateDisclosure = page
    .getByTestId("dialog-fee-worksheet")
    .locator("em")
    .filter({ hasText: /^\(APR \d+\.\d{3}% - includes applicable fees\)$/ });
  await expect(rateDisclosure).toHaveCount(1);
}

async function expectRateDisclosureFits(
  page: Page,
  testId: string,
): Promise<void> {
  const row = page.getByTestId(testId);
  const disclosure = row.locator("em");
  const value = row.locator(
    `[data-testid="${testId}-value"], input`,
  ).first();

  await expect(row).toBeVisible();
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toHaveText(
    /^\(APR \d+\.\d{3}% - includes applicable fees\)$/,
  );
  await expect(value).toBeVisible();

  const geometry = await row.evaluate((element, valueTestId) => {
    const disclosureElement = element.querySelector("em");
    const valueElement =
      element.querySelector(`[data-testid="${valueTestId}"]`) ??
      element.querySelector("input");
    if (!disclosureElement || !valueElement) return null;

    const rowRect = element.getBoundingClientRect();
    const disclosureRect = disclosureElement.getBoundingClientRect();
    const valueRect = valueElement.getBoundingClientRect();
    const isClippedByAncestor = (target: Element): boolean => {
      const targetRect = target.getBoundingClientRect();
      let ancestor = target.parentElement;
      while (ancestor && ancestor !== document.body) {
        const style = getComputedStyle(ancestor);
        const clipsX = ["auto", "hidden", "scroll", "clip"].includes(
          style.overflowX,
        );
        const clipsY = ["auto", "hidden", "scroll", "clip"].includes(
          style.overflowY,
        );
        if (clipsX || clipsY) {
          const ancestorRect = ancestor.getBoundingClientRect();
          if (
            (clipsX &&
              (targetRect.left < ancestorRect.left - 1 ||
                targetRect.right > ancestorRect.right + 1)) ||
            (clipsY &&
              (targetRect.top < ancestorRect.top - 1 ||
                targetRect.bottom > ancestorRect.bottom + 1))
          ) {
            return true;
          }
        }
        ancestor = ancestor.parentElement;
      }
      return false;
    };
    return {
      disclosureInside:
        disclosureRect.left >= rowRect.left - 1 &&
        disclosureRect.right <= rowRect.right + 1 &&
        disclosureRect.top >= rowRect.top - 1 &&
        disclosureRect.bottom <= rowRect.bottom + 1,
      valueInside:
        valueRect.left >= rowRect.left - 1 &&
        valueRect.right <= rowRect.right + 1,
      overlap:
        disclosureRect.left < valueRect.right &&
        disclosureRect.right > valueRect.left &&
        disclosureRect.top < valueRect.bottom &&
        disclosureRect.bottom > valueRect.top,
      clipped:
        isClippedByAncestor(disclosureElement) ||
        isClippedByAncestor(valueElement),
    };
  }, `${testId}-value`);

  expect(geometry).not.toBeNull();
  expect(geometry).toEqual({
    disclosureInside: true,
    valueInside: true,
    overlap: false,
    clipped: false,
  });
}

test("rate and APR disclosures remain readable at phone width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/estimate?address=${encodeURIComponent("123 Main St, Tampa, FL 33602")}`,
  );
  await page.getByRole("button", {name:"primary",exact:true}).click();
  await page.getByRole("button", { name: /^Next/ }).click();
  await page.getByRole("button", { name: /^Next/ }).click();

  await expectRateDisclosureFits(page, "editable-rate-disclosure");
  await page.getByRole("button", { name: /See My Estimate/ }).click();
  await page.getByRole("button", { name: /Review Your Answers/ }).click();
  await expectRateDisclosureFits(page, "purchase-summary-rate-disclosure");
  await expectRateDisclosureFits(page, "payment-card-rate-disclosure");

  await page.getByRole("button", { name: /Initial Fees Worksheet/ }).click();
  await expect(page.getByTestId("dialog-fee-worksheet")).toBeVisible();
  await expectRateDisclosureFits(page, "worksheet-rate-disclosure");
});

test("guest IFW download signs in, resumes once, and uses the signed-in officer", async ({
  page,
}) => {
  const getActivityCount = await installSignInMock(page);
  await openGuestIfw(page);

  await page.getByTestId("button-ifw-download").click();
  await page.getByRole("tab", { name: "Sign In" }).click();
  await page.locator("#si-email").fill(TEST_USER.email);
  await page.locator("#si-password").fill("browser-test-password");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe(
    "initial-fees-worksheet-123-main-st-tampa-fl-33602.pdf",
  );
  const pdfPath = await download.path();
  expect(pdfPath).not.toBeNull();
  const pdf = await readFile(pdfPath!);
  expect(pdf.includes(Buffer.from("Omar Andujar"))).toBe(true);
  expect(pdf.includes(Buffer.from("1806169"))).toBe(true);
  await expect(page.locator("#si-email")).toHaveCount(0);
  await expect.poll(getActivityCount).toBe(1);
});