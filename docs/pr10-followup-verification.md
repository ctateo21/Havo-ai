# PR #10 follow-up verification — 2026-11-12

No merge or publish. No paid QuoteRUSH calls or actual result emails.

## Supabase application receipt

Project: `bsbdyjafmilkbzpmfwsd`. Each file was applied once. None was edited
after application. Versions below are Supabase's UTC migration timestamps.

| File | Version / UTC applied time | Changes |
|---|---|---|
| `supabase/migrations/2026_11_12_insurance_rebuild_rates.sql` | 20261112221811 / 22:18:11 | Created `rebuild_cost_rates`, `rebuild_cost_rate_audit`, audit function/trigger; added `field_sources` and `roof_permits` to `property_characteristics_cache`. |
| `supabase/migrations/2026_11_12_private_insurance_import_jobs.sql` | 20261112221814 / 22:18:14 | Created `insurance_quote_import_jobs`. |
| `supabase/migrations/2026_11_12_insurance_flood_rechecks.sql` | 20261112222430 / 22:24:30 | Created `insurance_flood_rechecks` and restricted `record_insurance_flood_result` RPC. |
| `supabase/migrations/2026_11_12_insurance_quote_answer_identity.sql` | 20261112222933 / 22:29:33 | Applied an additive compatibility revision of the previously unapplied file: ownership/hash fields, default policy/scope and additional composite unique index; retained existing primary/address-only constraints. |

### Columns
- `rebuild_cost_rates`: county_slug, county_name, county_fips, supported,
  frame_cost_per_sqft, masonry_cost_per_sqft, source_note, updated_by, updated_at.
- `rebuild_cost_rate_audit`: id, county_slug, field, old_value, new_value,
  changed_by, changed_at. Trigger `rebuild_rate_audit` records changed rate/note
  fields through `audit_rebuild_rate_change`.
- `insurance_quote_import_jobs`: cache_id, generation, owner_user_id, params,
  callback_token, status, claimed_at, created_at.
- `insurance_flood_rechecks`: address_normalized, address_display, county,
  latitude, longitude, state, started_at, next_attempt_at, attempts, lease_token,
  result, updated_at.
- Existing quote cache gained owner_user_id, answer_hash, run_had_claims,
  callback_token_hash, policy_type and cache_scope.

### Verified at 22:34:37 UTC / 5:34:37 PM Eastern
- 67 counties; 9 supported; all 67 frame/masonry rate pairs NULL.
- Audit rows: 0. Import jobs: 0. Flood recheck jobs: 2.
- RLS enabled on all five new/modified insurance tables.
- Zero PUBLIC grants; anon SELECT/INSERT/UPDATE/DELETE denied; ordinary
  authenticated SELECT denied. New tables have no client-allowing RLS policies.
  Only service-role access is granted. No admin account flag was changed.
- Existing quote-cache primary key and address-only uniqueness retained.

## Admin page

Preview:
https://839b6774-423a-4a66-91ad-31125383b5ad-00-38rmz7p2kvleg.picard.replit.dev/admin/rebuild-cost-rates

Production route after a future approved publish:
https://havofl.com/admin/rebuild-cost-rates

This PR is not published; the production URL does not imply that the new page is
already available live. Signed-in users can reach the page through the insurance
panel's “Rebuild rates (admin only)” link. Server GET/PATCH use
`requireInterestAdmin`: validate the Supabase Bearer session, then require the
email in the server's admin allowlist (`LEADERBOARD_TEAM` admins plus configured
`MARKET_ANALYSIS_ADMIN_EMAILS`). Christian's existing `christian@tateoco.com`
account is already allowlisted and was confirmed to exist. No added role needed.
Non-admins receive 403 even if they navigate directly.

## Live FEMA results

Both were fetched from
https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28
and persisted in the shared property-characteristics cache.

| Address | Zone | Subtype | SFHA | BFE | Queried UTC / Eastern |
|---|---|---|---|---|---|
| 7400 36th Ave N, St. Petersburg, FL 33710 | X | AREA OF MINIMAL FLOOD HAZARD | false | null | 22:27:50.247 / 5:27:50 PM |
| 3102 W Nassau St, Tampa, FL 33607 | X | AREA OF MINIMAL FLOOD HAZARD | false | null | 22:27:50.161 / 5:27:50 PM |

Each federal service receives at most three attempts with 20-second timeouts;
the two inter-attempt waits are 1 and 3 seconds. Three attempts means two retry
delays, not an extra fourth attempt. Unsuccessful addresses are durably retried
after 2, 10 and 30 minutes, then hourly, through 24 hours. A temporary outage
shows “Checking FEMA flood map…” and does not prevent quoting without a zone.

Pinellas's supplied services were inspected. FEMASupportData lists elevation
certificates, boundaries, address labels and parcels; FEMASupportPar exposes no
layers. Neither supplied a verified effective flood-hazard polygon layer.
Therefore no parcel layer was falsely labeled FEMA effective data. The adapter
supports a verified county endpoint and that fallback is tested with fixtures,
but no unverified county endpoint is enabled in production configuration.

## Remaining quote-cache rollout gate

See `quote-cache-compatible-upgrade.md`. The managed database remains the active
quote source. Its compatible upgrade is prepared, not applied. Do not remove old
cache uniqueness or claim multi-answer paid quoting is operational until the
separate compatible rollout is validated and explicitly applied.
