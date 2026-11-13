import type { Page } from "@playwright/test";

/** Register first so individual fixture routes can override it. Never reach a provider. */
export async function blockLiveNetwork(page: Page) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      const defaults: Record<string, unknown> = {
        "/api/zillow-property-lookup": { property: null },
        "/api/flood-zone": { zone: "X", subtype: "minimal", requiresFloodInsurance: false },
        "/api/mortgage-rates": { conventional: 6.5, fha: 6, va: 6, usda: 6, source: "synthetic browser fixture" },
        "/api/ami": { annualAMI: 80000, monthlyAMI: 6667, areaName: "Synthetic test area" },
        "/api/subscription/status": { active: true, status: "browser-test" },
      };
      await route.fulfill({ json: defaults[url.pathname] ?? {} });
    } else if (url.pathname.startsWith("/rest/v1/")) {
      await route.fulfill({ json: [] });
    } else if (url.pathname.startsWith("/auth/v1/")) {
      await route.fulfill({ json: { user: null, session: null } });
    } else if (["localhost", "127.0.0.1"].includes(url.hostname)) {
      await route.continue(); // Only the running app's source and static assets.
    } else {
      await route.abort("blockedbyclient");
    }
  });
}
