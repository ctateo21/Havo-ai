create table if not exists public.private_leads (
  id uuid primary key default gen_random_uuid(),
  first_name text not null, last_name text not null, email text not null,
  phone text not null, phone_verified boolean not null default false,
  address text, agent text, scenario_details text,
  marketing_consent boolean not null default false,
  consent_wording text not null, consent_version text not null,
  consent_at timestamptz not null default now(),
  consent_ip text, consent_user_agent text,
  created_at timestamptz not null default now()
);
alter table public.private_leads enable row level security;
revoke all on public.private_leads from anon, authenticated;
grant all on public.private_leads to service_role;
create table if not exists public.marketing_consent_records (
  id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id),
  phone text, consent boolean not null, wording text not null, version text not null,
  recorded_at timestamptz not null default now(), ip text, user_agent text
);
alter table public.marketing_consent_records enable row level security;
revoke all on public.marketing_consent_records from anon, authenticated;
grant all on public.marketing_consent_records to service_role;
-- Internal Zillow raw data stays saved, but is not a client-readable table.
drop policy if exists property_cache_read on public.property_cache;
revoke select on public.property_cache from anon, authenticated;
