import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
) as { packages: Record<string, { version?: string }> };

// Cover every package family in the dependency remediation, including nested
// copies. Removed dependencies need not be reintroduced just to satisfy a test.
// These are security floors, not substitutes for a current vulnerability scan.
const minimumVersions: Record<string, string> = {
  "@babel/core": "7.29.6",
  "@babel/helpers": "7.26.10",
  "@opentelemetry/core": "2.8.0",
  axios: "1.20.0",
  "body-parser": "1.20.8",
  "brace-expansion": "2.1.7",
  browserslist: "4.29.4",
  dompurify: "3.4.17",
  "drizzle-orm": "0.45.4",
  esbuild: "0.25.0",
  fflate: "0.4.9",
  "follow-redirects": "1.16.1",
  "form-data": "4.0.6",
  glob: "10.5.0",
  lodash: "4.18.1",
  minimatch: "9.0.9",
  multer: "2.4.0",
  nanoid: "3.3.20",
  "on-headers": "1.1.0",
  "path-to-regexp": "0.1.13",
  picomatch: "2.3.2",
  postcss: "8.5.31",
  "postcss-selector-parser": "7.1.6",
  protobufjs: "7.6.5",
  "proxy-addr": "2.0.8",
  qs: "6.16.1",
  rollup: "4.64.10",
  undici: "7.30.1",
  vite: "6.4.4",
  ws: "8.22.0",
  yaml: "2.9.1",
};

function atLeast(actual: string, minimum: string): boolean {
  // Do not accept prereleases as security fixes.
  assert.match(actual, /^\d+\.\d+\.\d+$/);
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (actualParts[i] !== minimumParts[i]) {
      return actualParts[i] > minimumParts[i];
    }
  }
  return true;
}

test("the lockfile contains no downgraded copies of remediated packages", () => {
  let checked = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = path.split("node_modules/").at(-1)!;
    const minimum = minimumVersions[name];
    if (!minimum) continue;
    assert.ok(entry.version, `Missing version for ${path}`);
    assert.ok(
      atLeast(entry.version, minimum),
      `${path}: ${entry.version} is below the security floor ${minimum}`,
    );
    checked++;
  }
  assert.ok(checked >= 25, "Expected the application's dependency lockfile");
});

test("package manifest and lockfile agree on direct dependency ranges", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const root = lock.packages[""] as Record<string, unknown>;
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    assert.deepEqual(root[section], manifest[section], section);
  }
});
