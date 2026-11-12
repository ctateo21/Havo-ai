import { test, expect } from "@playwright/test";

test("all interest tiers retain attribution and never request payment", async ({ page }) => {
  const events: any[] = [];
  let submission: any;
  await page.route("**/api/agents/events", async route => {
    events.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/agents/interest", async route => {
    submission = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { ok: true, emailStatus: "sent" } });
  });
  await page.goto("/agents?utm_source=qa&utm_medium=email&utm_campaign=launch");
  await expect(page.getByRole("heading", { name: "Send your buyers the real number before the showing." })).toBeVisible();
  for (const tier of ["Agent", "Loan Officer", "Brokerage"]) {
    await page.getByRole("button", { name: `Start free trial — ${tier}`, exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Havo for agents isn't open yet.");
    if (tier !== "Brokerage") await page.keyboard.press("Escape");
  }
  await page.getByLabel("Full name", { exact: true }).fill("Test Agent");
  await page.getByLabel("Email", { exact: true }).fill("test@example.com");
  await page.getByLabel("Brokerage / company", { exact: true }).fill("Test Brokerage");
  await page.getByRole("combobox", { name: /Your role/ }).selectOption("broker_owner");
  await page.getByRole("combobox", { name: /Buyers per year/ }).selectOption("26_plus");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Join the interest list" }).click();
  await expect(page.getByRole("dialog")).toContainText("You're on the list.");
  expect(events.filter(v => v.eventType === "page_view")).toHaveLength(1);
  expect(events.filter(v => v.eventType === "tier_click").map(v => v.tier)).toEqual(["agent", "loan_officer", "brokerage"]);
  expect(submission).toMatchObject({ tier: "brokerage", role: "broker_owner", buyersPerYear: "26_plus", utmSource: "qa", utmMedium: "email", utmCampaign: "launch" });
  expect(events.every(v => v.sessionId === submission.sessionId)).toBeTruthy();
  await expect(page.locator('input[autocomplete^="cc-"]')).toHaveCount(0);
});

test("public admin route does not expose interest records", async ({ page }) => {
  await page.goto("/admin/agents");
  await expect(page.getByText("Administrator access required")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});
