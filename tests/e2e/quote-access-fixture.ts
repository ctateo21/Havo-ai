import {test as base,expect} from "@playwright/test";

// Existing page suites mock account/network data. Keep the new access request
// in that same fixture boundary; the anonymous-access suite exercises denial
// and the server unit suite exercises signed-cookie enforcement separately.
export const test=base.extend<{quoteAccessFixture:void}>({
  quoteAccessFixture:[async({page},use)=>{
    await page.route("**/api/anonymous-quote/start",async route=>{
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({allowed:true,...route.request().postDataJSON()})});
    });
    await use();
  },{auto:true}],
});
export {expect};
export type {Page,Route,Locator} from "@playwright/test";
