---
name: Managed-data disaster recovery
description: Operational authority and precision constraints for a lossless return after target-only writes.
---

Canary rollback and recovery after source retirement have different authorities:
once target-only writes begin, never treat the frozen source as current.

**Why:** A rollback flag cannot reconstruct writes or deletions accepted only by
the target. Recovery must mirror deletions too, rather than resurrecting stale
source records in an upsert-only merge.

**How to apply:** Maintain a continuous operator-enforced writer freeze from
export through recovery activation. Repeated REST scans detect drift but do not
provide a cross-table snapshot; a trusted-file approval receipt does not replace
the freeze or deployment access controls.

Precision must survive before checksum computation, not just during hashing.

**Why:** Normal JSON parsing and database driver decoding can round unrestricted
JSON numbers or timestamp microseconds. Comparing two already-rounded values
can falsely approve data loss. Ordinary row JSON also hides SQL NULL versus a
JSON column containing JSON `null`; record population can silently conflate them.

**How to apply:** Use exact numeric tokens and full timestamp precision at both
data boundaries, and treat zone-less source timestamps explicitly as UTC rather
than the operator machine's timezone. Normalize only schema-declared timestamp
columns: applying date normalization to arbitrary JSON/text can approve altered
answers as if their content matched. A numeric-lossless parser is not
necessarily object-lossless: test arbitrary own keys such as `__proto__` too.
Exercise actual CLI entrypoints as well as imported functions:
top-level-await import cycles can break commands while helper tests still pass.

When strengthening forward-manifest checksums, retain the legacy verifier for
existing exports and explicitly identify the new encoding.

**Why:** Quietly changing canonicalization would invalidate existing operator-held
manifests. Supporting their verification does not restore values that were
already rounded before those files were written.

**How to apply:** Use fresh exports for a precision-guaranteed handoff, and never
process exact manifests through ordinary JSON parsing or serialization.

Forward JSON null preservation requires an explicit-cast import boundary, not
only lossless export and reconciliation.

**Why:** Ordinary record population turns an outer JSON null into SQL NULL.
Text projections distinguish the two states, but importing those projections as
ordinary JSON columns would store strings instead of their intended values.

**How to apply:** Keep schema-owned JSON text casts paired with text-projected
exports and reads; version that representation and retain legacy import paths.