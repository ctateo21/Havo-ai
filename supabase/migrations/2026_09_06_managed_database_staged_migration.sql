-- Canonical dated entry point for the managed DATABASE_URL migration.
-- Apply this migration before enabling any MANAGED_DATA_MODE other than source-only.
-- The idempotent table definitions and restricted RPCs are mirrored in
-- supabase/schema.sql; this additive guard also upgrades an early draft safely.
create table if not exists public.managed_users (
  id bigserial primary key, username text not null unique, password text not null,
  email text not null unique, first_name text not null, last_name text not null,
  phone text, contact_preference text default 'email',
  created_at timestamptz default now()
);
create table if not exists public.managed_services (
  id bigserial primary key, name text not null unique, display_name text not null,
  description text not null, options jsonb not null
);
create table if not exists public.managed_submissions (
  id bigserial primary key, user_id bigint, selected_services jsonb not null,
  form_data jsonb not null, status text default 'pending',
  created_at timestamptz default now()
);
create table if not exists public.managed_integration_requests (
  id bigserial primary key, submission_id bigint not null, provider text not null,
  request_data jsonb not null, response_data jsonb,
  status text default 'pending', created_at timestamptz default now()
);
create table if not exists public.managed_questionnaire_responses (
  id bigserial primary key, session_id text not null, service_type text not null,
  step_name text not null, response_data jsonb not null,
  is_completed boolean default false, created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists public.user_subscriptions (
  id bigserial primary key, user_id text not null unique, email text,
  stripe_customer_id text, stripe_subscription_id text,
  status text not null default 'inactive', current_period_end timestamptz,
  updated_at timestamptz default now()
);
create table if not exists public.private_user_profiles (
  user_id text primary key, date_of_birth date not null,
  credit_score_consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.private_insurance_properties (
  user_id text not null, address_normalized text not null,
  current_policy_expiration_date date,
  quote_cache_scope text not null default 'unused',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(user_id,address_normalized)
);
create table if not exists public.insurance_quote_cache (
  id bigserial primary key, address_normalized text not null,
  address_display text not null, lead_id integer,
  status text not null default 'pending', quotes jsonb default '[]'::jsonb,
  quote_counter integer default 0, coverage_a integer default 0,
  policy_type text not null default 'HO3',
  cache_scope text not null default 'shared',
  property_data_snapshot jsonb default '{}'::jsonb,
  property_data_provenance jsonb default '{}'::jsonb,
  agency_default_snapshot jsonb default '{}'::jsonb,
  consumer_property_answers jsonb default '{}'::jsonb,
  quote_profile_version text not null default 'legacy-v1',
  raw_quoterush_property_data jsonb,
  raw_quoterush_property_data_source text,
  raw_quoterush_property_data_fetched_at timestamptz,
  raw_quoterush_property_data_expires_at timestamptz,
  assumptions jsonb default '[]'::jsonb,
  triggered_at timestamptz not null default now(),
  completed_at timestamptz, expires_at timestamptz not null,
  unique(address_normalized,policy_type)
);
create index if not exists insurance_quote_cache_expires_at_idx
  on public.insurance_quote_cache(expires_at);
create table if not exists public.non_ad_valorem_cache (
  id bigserial primary key, folio text not null unique, account_number text,
  bill_year integer, status text not null default 'pending',
  lines jsonb default '[]'::jsonb, total_non_ad_valorem integer default 0,
  total_ad_valorem_cents integer, total_millage integer,
  ad_valorem_mills jsonb, fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table if not exists public.ifw_activity_claims (
  dedupe_key text primary key, user_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists ifw_activity_claims_user_created_at_idx
  on public.ifw_activity_claims(user_id,created_at);
create index if not exists ifw_activity_claims_expires_at_idx
  on public.ifw_activity_claims(expires_at);

alter table if exists public.managed_questionnaire_responses
  drop constraint if exists managed_questionnaire_responses_session_id_service_type_step_name_key;
alter table if exists public.private_user_profiles
  alter column created_at set default now(),
  alter column updated_at set default now();
alter table if exists public.private_insurance_properties
  alter column quote_cache_scope set default 'unused',
  alter column created_at set default now(),
  alter column updated_at set default now();
alter table if exists public.managed_users alter column created_at set default now();
alter table if exists public.managed_submissions
  alter column status set default 'pending', alter column created_at set default now();
alter table if exists public.managed_integration_requests
  alter column status set default 'pending', alter column created_at set default now();
alter table if exists public.managed_questionnaire_responses
  alter column is_completed set default false,
  alter column created_at set default now(), alter column updated_at set default now();
alter table if exists public.user_subscriptions alter column updated_at set default now();
alter table if exists public.insurance_quote_cache
  alter column status set default 'pending', alter column quotes set default '[]'::jsonb,
  alter column quote_counter set default 0, alter column coverage_a set default 0,
  alter column policy_type set default 'HO3', alter column cache_scope set default 'shared',
  alter column property_data_snapshot set default '{}'::jsonb,
  alter column property_data_provenance set default '{}'::jsonb,
  alter column agency_default_snapshot set default '{}'::jsonb,
  alter column consumer_property_answers set default '{}'::jsonb,
  alter column quote_profile_version set default 'legacy-v1',
  alter column assumptions set default '[]'::jsonb, alter column triggered_at set default now();
alter table if exists public.non_ad_valorem_cache
  alter column status set default 'pending', alter column lines set default '[]'::jsonb,
  alter column total_non_ad_valorem set default 0, alter column fetched_at set default now();
alter table if exists public.ifw_activity_claims alter column created_at set default now();

do $$ declare t text; begin foreach t in array array[
  'managed_users','managed_services','managed_submissions',
  'managed_integration_requests','managed_questionnaire_responses',
  'user_subscriptions','private_user_profiles','private_insurance_properties',
  'insurance_quote_cache','non_ad_valorem_cache','ifw_activity_claims'
] loop execute format('alter table public.%I enable row level security',t); end loop; end $$;

create or replace function public.claim_ifw_activity(
  p_user_id text, p_dedupe_key text, p_now timestamptz,
  p_window_ms bigint, p_max_per_window integer
) returns text language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id,0));
  delete from ifw_activity_claims
    where user_id=p_user_id and expires_at<=p_now;
  if exists(
    select 1 from ifw_activity_claims
      where dedupe_key=p_dedupe_key and expires_at>p_now
  ) then return 'duplicate'; end if;
  select count(*) into n from ifw_activity_claims
    where user_id=p_user_id
      and created_at>p_now-(p_window_ms*interval '1 millisecond');
  if n>=p_max_per_window then return 'rate_limited'; end if;
  insert into ifw_activity_claims(dedupe_key,user_id,created_at,expires_at)
    values(
      p_dedupe_key,p_user_id,p_now,
      p_now+(p_window_ms*interval '1 millisecond')
    );
  return 'claimed';
end $$;

create or replace function public.cleanup_ifw_activity_claims(
  p_now timestamptz, p_batch_size integer
) returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  with deleted as (
    delete from ifw_activity_claims where ctid in (
      select ctid from ifw_activity_claims
        where expires_at<=p_now
        order by expires_at
        for update skip locked
        limit p_batch_size
    ) returning 1
  )
  select count(*) into n from deleted;
  return n;
end $$;

create or replace function public.claim_insurance_quote_cache(
  p_address_normalized text, p_policy_type text,
  p_values jsonb, p_now timestamptz
) returns table(claimed boolean,row_id bigint)
language plpgsql security definer set search_path=public as $$
begin
  insert into insurance_quote_cache(
    id,address_normalized,address_display,lead_id,status,quotes,
    quote_counter,coverage_a,policy_type,cache_scope,
    property_data_snapshot,property_data_provenance,
    agency_default_snapshot,consumer_property_answers,
    quote_profile_version,assumptions,triggered_at,completed_at,expires_at
  )
  values(
    -- Always allocate the speculative insert's id. Reusing an existing id here
    -- can race on the primary key before the address/policy conflict is handled.
    -- ON CONFLICT preserves the existing row id when a stale row is reclaimed.
    nextval(pg_get_serial_sequence('insurance_quote_cache','id')),
    p_address_normalized,p_values->>'address_display',
    nullif(p_values->>'lead_id','')::integer,
    coalesce(p_values->>'status','pending'),
    coalesce(p_values->'quotes','[]'::jsonb),
    coalesce((p_values->>'quote_counter')::integer,0),
    coalesce((p_values->>'coverage_a')::integer,0),
    p_policy_type,coalesce(p_values->>'cache_scope','shared'),
    coalesce(p_values->'property_data_snapshot','{}'::jsonb),
    coalesce(p_values->'property_data_provenance','{}'::jsonb),
    coalesce(p_values->'agency_default_snapshot','{}'::jsonb),
    coalesce(p_values->'consumer_property_answers','{}'::jsonb),
    coalesce(p_values->>'quote_profile_version','legacy-v1'),
    coalesce(p_values->'assumptions','[]'::jsonb),
    coalesce((p_values->>'triggered_at')::timestamptz,p_now),
    (p_values->>'completed_at')::timestamptz,
    (p_values->>'expires_at')::timestamptz
  )
  on conflict(address_normalized,policy_type) do update set
    address_display=excluded.address_display,
    lead_id=excluded.lead_id,status=excluded.status,quotes=excluded.quotes,
    quote_counter=excluded.quote_counter,coverage_a=excluded.coverage_a,
    cache_scope=excluded.cache_scope,
    property_data_snapshot=excluded.property_data_snapshot,
    property_data_provenance=excluded.property_data_provenance,
    agency_default_snapshot=excluded.agency_default_snapshot,
    consumer_property_answers=excluded.consumer_property_answers,
    quote_profile_version=excluded.quote_profile_version,
    assumptions=excluded.assumptions,triggered_at=excluded.triggered_at,
    completed_at=excluded.completed_at,expires_at=excluded.expires_at
  where insurance_quote_cache.expires_at<=p_now
     or insurance_quote_cache.status='error'
  returning true,insurance_quote_cache.id into claimed,row_id;
  if not found then
    select false,id into claimed,row_id from insurance_quote_cache
      where address_normalized=p_address_normalized
        and policy_type=p_policy_type;
  end if;
  return next;
end $$;

create or replace function public.reseed_managed_migration_sequences()
returns void language plpgsql security definer set search_path=public as $$
declare t text; seq text; n bigint;
begin
  foreach t in array array[
    'managed_users','managed_services','managed_submissions',
    'managed_integration_requests','managed_questionnaire_responses',
    'user_subscriptions','insurance_quote_cache','non_ad_valorem_cache'
  ] loop
    seq:=pg_get_serial_sequence('public.'||t,'id');
    if seq is not null then
      execute format(
        'select coalesce(max(id),0) from public.%I',
        t
      ) into n;
      perform setval(seq,greatest(n,1),n>0);
    end if;
  end loop;
end $$;

revoke all on function public.claim_ifw_activity(
  text,text,timestamptz,bigint,integer
) from public,anon,authenticated;
revoke all on function public.cleanup_ifw_activity_claims(
  timestamptz,integer
) from public,anon,authenticated;
revoke all on function public.claim_insurance_quote_cache(
  text,text,jsonb,timestamptz
) from public,anon,authenticated;
revoke all on function public.reseed_managed_migration_sequences()
  from public,anon,authenticated;
grant execute on function public.claim_ifw_activity(
  text,text,timestamptz,bigint,integer
) to service_role;
grant execute on function public.cleanup_ifw_activity_claims(
  timestamptz,integer
) to service_role;
grant execute on function public.claim_insurance_quote_cache(
  text,text,jsonb,timestamptz
) to service_role;
grant execute on function public.reseed_managed_migration_sequences()
  to service_role;

notify pgrst, 'reload schema';