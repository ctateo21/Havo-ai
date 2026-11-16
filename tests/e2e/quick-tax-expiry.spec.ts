import {test,expect} from "./quote-access-fixture";
import {blockLiveNetwork} from "./mock-network";

test("expired official jobs restart at most twice and retain the estimate",async({page})=>{
  await blockLiveNetwork(page);
  let quick=0,polls=0;
  await page.route("**/api/property-tax/quick",async route=>{
    quick++;
    await route.fulfill({json:{key:`expired-${quick}`,status:"estimate",annualTax:6000,
      adValorem:5900,nav:100,officialState:"pending",label:"Estimated fixture"}});
  });
  await page.route("**/api/property-tax/official-status?*",async route=>{
    polls++;
    await route.fulfill({status:404,json:{error:"Lookup expired"}});
  });
  await page.goto("/estimate?address="+encodeURIComponent("3102 W Nassau St, Tampa, FL 33607"));
  await page.getByRole("button",{name:"primary",exact:true}).click();
  await expect.poll(()=>polls,{timeout:20000}).toBe(3);
  expect(quick).toBe(3); // initial request + two recovery requests
  await page.waitForTimeout(3500);
  expect(polls).toBe(3);
  expect(quick).toBe(3);
  await page.getByRole("button",{name:/^Next/}).click();
  await page.getByRole("button",{name:/^Next/}).click();
  await page.getByRole("button",{name:/See My Estimate/}).click();
  const row=page.getByTestId("property-tax-row").first();
  await expect(row).toContainText("$500.00/mo");
  await expect(row).toContainText("Estimated");
  await expect(row).not.toContainText("updating");
  await row.getByRole("button").first().click();
  await expect(row).toContainText("Official verification is temporarily unavailable.");
  await expect(row).toContainText("$6,000.00/yr");
});
