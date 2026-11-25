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
  -- Pre-quote estimate vs. lowest carrier quote (data capture only).
  -- quote_delta = lowest_annual - estimate_annual;
  -- quote_delta_pct = quote_delta / estimate_annual (null when estimate is missing or 0).
  estimate_annual numeric,
  lowest_annual numeric,
  quote_delta numeric,
  quote_delta_pct numeric,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  primary key (user_id, address_normalized, policy_type)
);

-- Additive columns, safe if the table already exists.
alter table user_insurance_quote_results add column if not exists estimate_annual numeric;
alter table user_insurance_quote_results add column if not exists lowest_annual numeric;
alter table user_insurance_quote_results add column if not exists quote_delta numeric;
alter table user_insurance_quote_results add column if not exists quote_delta_pct numeric;
