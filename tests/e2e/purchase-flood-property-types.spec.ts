import { expect, test, type Page } from "@playwright/test";
import { officialTaxFixture } from "./official-tax-fixture";

const ADDRESS = "100 Purchase Flood Test Way, Tampa, FL 33602";
const EXCLUDED_PROPERTY_TYPES = [
  "Condominium",
  "Townhouse",
  "Villa",
  "Land",
] as const;

async function installApiMocks(page: Page): Promise<void> {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if(url.pathname.startsWith("/api/property-tax/")) {
      const input=route.request().postDataJSON();
      await route.fulfill({json:officialTaxFixture(input.purchasePrice,input.isPrimaryResidence)});
      return;
    }

    if (url.pathname === "/api/flood-zone") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          zone: "AE",
          subtype: "Special Flood Hazard Area",
          requiresFloodInsurance: true,
        }),
      });
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
            yearBuilt: 2005,
          },
        }),
      });
      return;
    }

    if (url.pathname === "/api/mortgage-rates") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conventional: 6.5,
          fha: 6.0,
          va: 6.0,
          usda: 6.0,
          source: "browser test",
          lastUpdated: null,
        }),
      });
      return;
    }

    if (url.pathname === "/api/ami") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          areaName: "Tampa-St. Petersburg-Clearwater, FL",
          annualAMI: 80_000,
          monthlyAMI: 6_667,
          source: "browser test",
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

// Match the unlocked-estimate setup used by the Google Places race coverage.
// Entering the route once before setting the local unlock ensures the module's
// initial scenario state follows the same guest-to-unlocked transition as the
// real application.
async function openUnlockedEstimate(page: Page): Promise<void> {
  const estimatePath = `/estimate?address=${encodeURIComponent(ADDRESS)}`;

  await page.goto(estimatePath);
  await page.getByRole("button", { name: "Add Property" }).waitFor();

  await page.evaluate(() => {
    history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByPlaceholder("Enter a property address...").waitFor();

  await page.evaluate(path => {
    localStorage.setItem("tateo_auth", "1");
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, estimatePath);
  await page.getByRole("button", { name: "Add Property" }).waitFor();
}

async function selectPropertyType(page: Page, propertyType: string): Promise<void> {
  await page.getByTestId("select-property-type").click();
  await page.getByRole("option", { name: propertyType, exact: true }).click();
}

async function editPurchaseDetails(page: Page): Promise<void> {
  const propertyTypeSummary = page.getByText("Property Type", { exact: true }).first();
  const reviewAnswers = page.getByRole("button", {
    name: /Review Your Answers/,
  });
  if (!(await propertyTypeSummary.isVisible())) await reviewAnswers.click();

  await propertyTypeSummary.locator("xpath=..").getByTitle("Edit").click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

function paymentAmount(page: Page) {
  return page
    .getByText("New Monthly Mortgage Payment", { exact: true })
    .locator("xpath=following-sibling::p");
}

test("purchase excludes separate flood charges for every covered property type in FEMA Zone AE", async ({ page }) => {
  test.setTimeout(60_000);
  await installApiMocks(page);
  await openUnlockedEstimate(page);
  await page.getByRole("button", {name:"primary",exact:true}).click();

  await page.getByRole("button", { name: /^Next/ }).click();
  await page.getByRole("button", { name: /^Next/ }).click();
  await expect(page.getByTestId("select-property-type")).toContainText(
    "Single Family Residence",
  );

  await page.getByRole("button", { name: /See My Estimate/ }).click();
  await expect(page.getByText("Flood Insurance", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("$167/mo", { exact: true })).toBeVisible();
  const singleFamilyPayment = await paymentAmount(page).textContent();
  expect(singleFamilyPayment).toMatch(/^\$[\d,]+$/);

  for (const propertyType of EXCLUDED_PROPERTY_TYPES) {
    await editPurchaseDetails(page);
    await selectPropertyType(page, propertyType);
    await page.getByRole("button", { name: "Done", exact: true }).click();

    await expect(page.getByTestId("note-flood-insurance-assumption")).toBeVisible();
    await expect(page.getByText("Flood Insurance", { exact: true })).toHaveCount(0);
    await expect(paymentAmount(page)).not.toHaveText(singleFamilyPayment!);

    if (propertyType === "Land") {
      await expect(page.getByTestId("note-flood-insurance-assumption")).toContainText(
        "No separate building flood premium",
      );
      await expect(page.getByTestId("note-flood-insurance-assumption")).not.toContainText(
        "HOA",
      );
    } else {
      await expect(page.getByTestId("note-flood-insurance-assumption")).toContainText(
        "Verify coverage with the HOA master policy",
      );
    }

    const floodZoneInput = page.getByText("Flood Zone", { exact: true })
      .locator("xpath=following-sibling::input");
    await expect(floodZoneInput).toHaveValue("AE");
  }

  await editPurchaseDetails(page);
  await selectPropertyType(page, "Single Family Residence");
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await expect(page.getByTestId("note-flood-insurance-assumption")).toBeHidden();
  await expect(page.getByText("Flood Insurance", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("$167/mo", { exact: true })).toBeVisible();
  await expect(paymentAmount(page)).toHaveText(singleFamilyPayment!);
});