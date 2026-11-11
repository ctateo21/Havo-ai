import { expect, test, type Page, type Route } from "@playwright/test";

const ADDRESS = "100 Flood Test Way, Tampa, FL 33602";

async function selectPropertyType(page: Page, propertyType: string) {
  await page.getByTestId("select-cash-property-type").click();
  await page.getByRole("option", { name: propertyType, exact: true }).click();
}

function fulfillFloodZone(route: Route) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      zone: "AE",
      subtype: "Special Flood Hazard Area",
      requiresFloodInsurance: true,
    }),
  });
}

async function installCashBuyApiMocks(
  page: Page,
  floodHandler: (route: Route) => Promise<void>,
) {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/flood-zone") {
      await floodHandler(route);
      return;
    }
    if (url.pathname === "/api/zillow-property-lookup") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cached: true,
          property: {
            purchasePrice: 400_000,
            propertyType: "SINGLE_FAMILY",
            hoaMonthly: 0,
            photos: [],
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
}

test("cash buy suppresses saved or manual flood premiums for excluded property types", async ({ page }) => {
  await installCashBuyApiMocks(page, fulfillFloodZone);
  await page.goto(`/cash-buy?address=${encodeURIComponent(ADDRESS)}`);

  const floodLabel = page.getByText("Annual Flood Insurance", { exact: true });
  await expect(floodLabel).toBeVisible();
  const floodInput = floodLabel.locator("xpath=../following-sibling::div//input");
  await expect(floodInput).toHaveValue("2,000");

  for (const propertyType of ["Condominium", "Townhouse", "Villa", "Land"]) {
    await floodInput.fill("4800");
    await expect(floodInput).toHaveValue("4800");

    await selectPropertyType(page, propertyType);
    await expect(floodLabel).toBeHidden();
    await expect(page.getByTestId("cash-flood-assumption-note")).toBeVisible();

    if (propertyType === "Land") {
      await expect(page.getByTestId("cash-flood-assumption-note")).toContainText(
        "not an HOA or master-policy assumption",
      );
    } else {
      await expect(page.getByTestId("cash-flood-assumption-note")).toContainText(
        "Verify coverage with the HOA master policy",
      );
    }

    await selectPropertyType(page, "Single Family Residence");
    await expect(floodLabel).toBeVisible();
    await expect(floodInput).toHaveValue("2,000");
  }
});

test("a late FEMA response cannot restore a separate condo flood charge", async ({ page }) => {
  let releaseFlood!: () => void;
  const floodGate = new Promise<void>(resolve => {
    releaseFlood = resolve;
  });

  await installCashBuyApiMocks(page, async route => {
    await floodGate;
    await fulfillFloodZone(route);
  });
  await page.goto(`/cash-buy?address=${encodeURIComponent(ADDRESS)}`);

  await selectPropertyType(page, "Condominium");
  releaseFlood();

  const note = page.getByTestId("cash-flood-assumption-note");
  await expect(note).toContainText("FEMA flood-zone risk is unchanged: Zone AE");
  await expect(page.getByText("Annual Flood Insurance", { exact: true })).toBeHidden();

  await selectPropertyType(page, "Single Family Residence");
  const floodLabel = page.getByText("Annual Flood Insurance", { exact: true });
  await expect(floodLabel).toBeVisible();
  await expect(floodLabel.locator("xpath=../following-sibling::div//input")).toHaveValue("2,000");
});