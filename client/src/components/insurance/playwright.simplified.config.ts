import { defineConfig } from "@playwright/test";

// Deliberately no webServer: the parent must start the isolated, safe server.
export default defineConfig({
  testDir: ".",
  testMatch: "simplified-insurance.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.INSURANCE_TEST_BASE_URL || "http://127.0.0.1:5000",
    headless: true,
    serviceWorkers: "block",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
});
