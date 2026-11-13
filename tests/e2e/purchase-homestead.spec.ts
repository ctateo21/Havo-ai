import {test,expect} from "./quote-access-fixture";
import {blockLiveNetwork} from "./mock-network";
test("blank property use blocks tax lookup; explicit selections send the right flag",async({page})=>{
  const flags:boolean[]=[];
  await blockLiveNetwork(page);
  await page.route("**/api/property-tax/quick",async route=>{
    const input=route.request().postDataJSON();
    flags.push(input.isPrimaryResidence);
    await route.fulfill({json:{key:`synthetic-${flags.length}`,status:"unavailable",annualTax:null,officialState:"failed",reason:"County unavailable in this browser fixture"}});
  });
  await page.goto("/estimate?address="+encodeURIComponent("3102 W Nassau St, Tampa, FL 33607"));
  await expect(page.getByRole("button",{name:/^Next/})).toBeDisabled();
  await expect(page.getByText("Select Property Use to calculate property tax.").first()).toBeVisible();
  expect(flags).toEqual([]);
  for(const [use,flag] of [["primary",true],["investment",false],["secondary",false]] as const){
    await page.getByRole("button",{name:use,exact:true}).click();
    await expect.poll(()=>flags.at(-1)).toBe(flag);
    await expect(page.getByRole("button",{name:/^Next/})).toBeEnabled();
  }
});
