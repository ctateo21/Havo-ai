import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath) {
  try { executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); } catch { /* Playwright's installed browser is used. */ }
}
// Deliberately no webServer: this focused suite never starts/restarts the workflow.
export default defineConfig({
  testDir: ".", testMatch: "insurance.browser.test.ts", workers: 1,
  outputDir: "/tmp/havo-insurance-browser-results",
  use: { baseURL: "http://127.0.0.1:5000", headless: true, launchOptions: { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } },
});
