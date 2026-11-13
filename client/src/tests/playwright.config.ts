import { defineConfig } from "@playwright/test";
import base from "../../../playwright.config";

// Keep frontend-owned tests under client/src. The root suite remains intact.
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "anonymous-quote.browser.test.ts",
});
