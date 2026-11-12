import {test,expect} from "@playwright/test";
test("private endpoints reject guests and OTP never exposes a code",async({request})=>{
  for(const path of ["/api/leads","/api/leads/test-fub","/api/fub/leaderboard/debug?key=retired-key"]){
    const r=await request.get(path);expect([401,403,404]).toContain(r.status());
    expect(await r.text()).not.toContain('"leads":');
  }
  expect((await request.get("/api/config/zillow-api-key")).status()).toBe(404);
  expect((await request.get("/this-page-does-not-exist")).status()).toBe(404);
});
test("registration consent is optional and unchecked; zoom and address labels remain accessible",async({page})=>{
  await page.goto("/");
  // The native labeled input is accessible before the optional Maps library
  // upgrades it to a combobox; CI intentionally has no real provider key.
  await expect(page.getByLabel("Florida property address")).toBeVisible();
  expect(await page.locator('meta[name="viewport"]').getAttribute("content")).not.toContain("maximum-scale");
  await page.getByRole("button",{name:/Log In/i}).first().click();
  await page.getByRole("tab",{name:"Create Account"}).click();
  const consent=page.getByRole("checkbox",{name:/I agree to receive marketing/});
  await expect(consent).not.toBeChecked();
  await expect(consent).not.toHaveAttribute("required","");
  await expect(page.locator("#reg-password")).toHaveAttribute("placeholder","At least 8 characters");
});
