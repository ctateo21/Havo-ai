# Quote-cache compatibility gate

The active preview routing was verified as `source-only`: the managed PostgreSQL
database owns quote runs. The shared Supabase cache is a legacy address-only
table, not the fully provisioned managed-data target. Its claim RPC is absent.

The Supabase answer-identity migration is additive. It preserves old rows and
uniqueness, adds nullable ownership/hash fields plus default policy/scope, and
denies direct client access. It does not switch database routing or claim that
the legacy target is ready to become authoritative.

## Prepared managed-database stage — not applied

Use `docs/managed-quote-cache-additive.sql` against the
managed development database only after explicit application approval.
It deliberately does not reference Supabase roles.
The four ownership/hash fields are additive and can be introduced without
removing the old version's unique key.

## Remaining rollout requirement

Do not remove legacy uniqueness while an old application version can still read
address-only results. Multiple answer variants need either a versioned cache
table isolated from the old application, or a coordinated cutover after all
writers/readers are on the answer-bound contract. Existing records must remain
private and retained. Prepare and validate that stage before enabling paid
multi-answer runs; do not silently switch to Supabase or drop an index.

The approved rate/audit/import/flood tables do not depend on this cutover.
No managed database mutation or application publication was performed here.
