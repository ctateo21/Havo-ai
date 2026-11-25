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
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  primary key (user_id, address_normalized, policy_type)
);

alter table public.user_insurance_quote_results enable row level security;
revoke all on public.user_insurance_quote_results from anon, authenticated;

commit;
