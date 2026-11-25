-- Pending Christian approval. Do NOT apply automatically.
-- Supabase mirror of the app-database table migrations/20261125_user_insurance_quote_results.sql,
-- for the staged managed-data move. The live app currently reads and writes
-- this table in the Replit-managed app database (same as insurance_quote_cache).
-- Server-only: RLS on, no anon/authenticated policies; the server uses the
-- service role.
begin;

create table if not exists public.user_insurance_quote_results (
  user_id text not null,
  address_normalized text not null,
  policy_type text not null,
  lead_id integer,
  quotes jsonb not null default '[]'::jsonb,
  best_carrier text,
  best_annual numeric,
  completed_at timestamp,
  estimate_snapshot jsonb,
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
alter table public.user_insurance_quote_results add column if not exists estimate_annual numeric;
alter table public.user_insurance_quote_results add column if not exists lowest_annual numeric;
alter table public.user_insurance_quote_results add column if not exists quote_delta numeric;
alter table public.user_insurance_quote_results add column if not exists quote_delta_pct numeric;

alter table public.user_insurance_quote_results enable row level security;
revoke all on public.user_insurance_quote_results from anon, authenticated;

commit;
