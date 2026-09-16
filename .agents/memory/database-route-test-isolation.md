---
name: Database route-test isolation
description: Why managed-database route tests that use local HTTP belong in a separate test file from global fetch-mocking suites.
---

Keep managed-database route integration tests that make real local HTTP requests in a separate test file from unit suites that replace `globalThis.fetch`.

**Why:** Node's top-level tests can overlap. A local route test sharing a process with QuoteRUSH transport tests had its HTTP calls intercepted by concurrent global fetch mocks, leaving the worker unable to finish reliably.

**How to apply:** Give database-backed HTTP route tests their own `*.test.ts` file and close both the HTTP server and database pool in awaited test cleanup hooks.