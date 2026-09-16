---
name: Database rehearsal boundaries
description: Why migration rehearsals need independent source fixtures and real SQL-to-HTTP transport.
---

Keep disposable migration rehearsals independent of project databases and exercise
the real PostgreSQL-to-PostgREST serialization boundary, not just checksum mocks.

**Why:** SQL drivers and HTTP APIs can represent the same value differently.
Date-only values in particular may become local-midnight JavaScript Dates in a
driver but plain calendar strings over HTTP. Pure checksum tests cannot prove
that an export survives this boundary. Simultaneous database claims also need
real unique indexes and locks to expose conflicts that sequential mocks miss.

**How to apply:** Use generated source fixtures and a credential-free local
cluster. Keep source DDL independent of the target migration and check it against
the application's schema; cloning the target into the source would let both
sides share the same mistake. Do not substitute project data for larger fixtures.