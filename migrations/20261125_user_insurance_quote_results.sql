-- Saved live-carrier quote results, owned by one authenticated user.
-- Lives in the Replit-managed app database next to insurance_quote_cache.
-- Additive and idempotent. Not applied automatically; see the PR notes.
create table if not exists user_insurance_quote_results (
  user_id text not null,
  address_normalized text not null,
  policy_type text not null,
  lead_id integer,
  quotes jsonb not null default '[]'::jsonb,
  best_carrier text,
  best_annual numeric,
  completed_at timestamp,
  -- Pre-quote Havo estimate inputs/outputs. Never name, email, phone, or DOB.
  estimate_snapshot jsonb,
  -- The in-flight run's snapshot; promoted only when that run succeeds.
  pending_estimate_snapshot jsonb,
  pending_started_at timestamp,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  primary key (user_id, address_normalized, policy_type)
);
