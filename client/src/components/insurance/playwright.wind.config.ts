import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

// Requires the parent's safe server. This configuration never starts a server.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();

export default defineConfig({
  testDir: ".",
  testMatch: ["simplified-insurance.spec.ts", "insurance.browser.test.ts"],
  outputDir: "./browser-results",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:5000",
    headless: true,
    serviceWorkers: "block",
    launchOptions: {
      executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
});
