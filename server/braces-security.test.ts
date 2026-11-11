import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const guardedPackage = "@dieub/braces-depth-guard";
const guardedVersion = "3.0.3-pn.3";

test("every locked braces copy uses the pinned depth-guard backport", () => {
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path.endsWith("node_modules/braces"),
  );
  assert.ok(copies.length > 0, "Expected braces in the Tailwind dependency tree");
  for (const [path, entry] of copies) {
    const pkg = entry as { name: string; version: string };
    assert.equal(pkg.name, guardedPackage, path);
    assert.equal(pkg.version, guardedVersion, path);
  }
});

// Resolve from the actual consumers: a safe root copy must not mask a vulnerable
// nested copy. Run hostile patterns in a child with a timeout to isolate crashes.
for (const consumer of ["chokidar", "micromatch"]) {
  const consumerRequire = createRequire(require.resolve(consumer));
  const bracesPath = consumerRequire.resolve("braces");

  test(`${consumer} rejects deep patterns and ASTs without stack exhaustion`, () => {
    const result = spawnSync(
      process.execPath,
      ["-e", `
        const assert = require("node:assert/strict");
        const braces = require(${JSON.stringify(bracesPath)});
        const patterns = [
          "{".repeat(4000) + "a,b" + "}".repeat(4000),
          "(".repeat(4000) + "a" + ")".repeat(4000),
          "{(".repeat(2000) + "a,b" + ")}".repeat(2000),
          "{".repeat(4000) + "a",
        ];
        for (const pattern of patterns) {
          assert.ok(pattern.length < 10000);
          for (const method of ["parse", "compile", "expand", "stringify", "create"]) {
            assert.throws(() => braces[method](pattern), /exceeds max depth/);
          }
          assert.throws(() => braces(pattern), /exceeds max depth/);
          assert.throws(() => braces([pattern], { expand: true }), /exceeds max depth/);
          for (const maxDepth of [Infinity, NaN, 100000]) {
            assert.throws(() => braces.compile(pattern, { maxDepth }), /exceeds max depth/);
          }
        }
        for (const method of ["compile", "expand", "stringify"]) {
          const root = { type: "root", nodes: [] };
          let node = root;
          for (let i = 0; i < 4000; i++) {
            const child = { type: "brace", nodes: [], parent: node };
            node.nodes.push(child);
            node = child;
          }
          assert.throws(() => braces[method](root), /exceeds max depth/);
        }
      `],
      { timeout: 15_000, encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
  });

  test(`${consumer} retains normal brace expansion and compilation`, () => {
    const braces = consumerRequire("braces");
    assert.deepEqual(braces.expand("src/{client,server}/{a,b}.ts"), [
      "src/client/a.ts", "src/client/b.ts",
      "src/server/a.ts", "src/server/b.ts",
    ]);
    assert.deepEqual(braces.expand("file-{01..03}.ts"), [
      "file-01.ts", "file-02.ts", "file-03.ts",
    ]);
    assert.equal(braces.compile("*.{ts,tsx}"), "*.(ts|tsx)");
    assert.equal(braces.stringify(braces.parse("src/{a,b}.ts")), "src/{a,b}.ts");
    assert.deepEqual(braces.expand(String.raw`\{a,b\}`), ["{a,b}"]);
  });
}

test("micromatch still handles Tailwind-style content globs", () => {
  const micromatch = require("micromatch");
  assert.deepEqual(
    micromatch(
      ["client/src/App.tsx", "client/src/lib/a.ts", "client/src/style.css"],
      ["client/src/**/*.{ts,tsx}"],
    ),
    ["client/src/App.tsx", "client/src/lib/a.ts"],
  );
});
