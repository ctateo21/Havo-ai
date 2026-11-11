# Dependency security maintenance

The application keeps Express 4, Tailwind 3, React 18, and Zod 3 to avoid
unrelated framework migrations. Vite 6 includes security fixes unavailable in
Vite 5 and supports the existing Node 20 runtime.

## Targeted overrides

- `@esbuild-kit/core-utils > esbuild` → `^0.25.12`: the latest stable Drizzle Kit still
  includes the deprecated `@esbuild-kit/esm-loader` / `core-utils` chain,
  which pins esbuild 0.18. This override replaces only vulnerable esbuild
  versions, leaving newer versions used by tsx alone.
- `postcss-selector-parser` → `^7.1.6`: the latest Tailwind 3 and typography
  plugin still request vulnerable parser versions. The production stylesheet
  build and browser tests exercise compatibility with parser 7.

Recheck upstream dependencies before removing either override. Do not accept
`npm audit fix --force` recommendations that downgrade Drizzle Kit or the
typography plugin to obsolete versions.

## Known upstream issue outside the original remediation list

As of 2026-10-19, `braces@3.0.3` has an unpatched stack-exhaustion issue
(`GHSA-vfj7-8cjw-p6xm`). Tailwind 3 brings it in through chokidar and
micromatch. The latest braces release is still 3.0.3.

This remains visible in audits; it is not suppressed or marked fixed.
The affected dependency chain processes repository-controlled build/watch
patterns, not application request input. Do not pass untrusted patterns into
these build tools. Recheck for a patched upstream release; a Tailwind 4
migration is a separate change and should not be hidden in a dependency fix.

## Verification

Run `npm audit` and the platform dependency scan for current advisories.
The lockfile security-floor regression test is included in `npm run test:unit`;
it checks nested copies as well as direct packages, but does not replace an
up-to-date audit.

Also run `npm run build`, `npm test`, and
`npm run test:managed-data-rehearsal`. No database migration or production
schema change is required for these dependency updates.
