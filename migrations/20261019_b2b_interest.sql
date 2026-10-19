-- Interest-only experiment. No billing, subscriptions, or card data.
create table public.b2b_interest_signups (
  id uuid primary key,
  created_at timestamptz not null default now(),
  session_id uuid not null,
  name text not null check (length(name) between 1 and 120),
  email text not null check (length(email) between 3 and 254),
  company text not null check (length(company) between 1 and 160),
  role text not null check (role in ('realtor','loan_officer','broker_owner','insurance_agent')),
  buyers_per_year text not null check (buyers_per_year in ('1_10','11_25','26_plus')),
  tier text not null check (tier in ('agent','loan_officer','brokerage')),
  utm_source text not null default '' check (length(utm_source) <= 200),
  utm_medium text not null default '' check (length(utm_medium) <= 200),
  utm_campaign text not null default '' check (length(utm_campaign) <= 200),
  unsubscribe_token uuid not null unique default gen_random_uuid(),
  unsubscribed_at timestamptz,
  consent_at timestamptz not null default now(),
  is_test boolean not null default false,
  email_status text not null default 'pending' check (email_status in ('pending','sending','sent','failed','suppressed')),
  email_id text,
  email_error text,
  fub_status text not null default 'pending' check (fub_status in ('pending','sending','sent','failed')),
  fub_person_id bigint,
  fub_note_id bigint,
  fub_error text
);

create table public.b2b_interest_events (
  id uuid primary key,
  created_at timestamptz not null default now(),
  session_id uuid not null,
  event_type text not null check (event_type in ('page_view','tier_click','popup_submission')),
  tier text check (tier in ('agent','loan_officer','brokerage')),
  utm_source text not null default '' check (length(utm_source) <= 200),
  utm_medium text not null default '' check (length(utm_medium) <= 200),
  utm_campaign text not null default '' check (length(utm_campaign) <= 200),
  signup_id uuid references public.b2b_interest_signups(id),
  is_test boolean not null default false,
  check ((event_type = 'page_view' and tier is null and signup_id is null)
    or (event_type = 'tier_click' and tier is not null and signup_id is null)
    or (event_type = 'popup_submission' and tier is not null and signup_id is not null))
);
create index b2b_interest_events_source_date on public.b2b_interest_events(utm_source, created_at);
create index b2b_interest_signups_source_date on public.b2b_interest_signups(utm_source, created_at);
create index b2b_interest_signups_email on public.b2b_interest_signups(email);

alter table public.b2b_interest_events enable row level security;
alter table public.b2b_interest_signups enable row level security;
revoke all on public.b2b_interest_events, public.b2b_interest_signups from anon, authenticated;
grant all on public.b2b_interest_events, public.b2b_interest_signups to service_role;

-- Save the signup and its conversion event atomically; replaying a submission
-- cannot produce a second signup, conversion, email, or CRM note.
create function public.submit_b2b_interest(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare saved_id uuid;
begin
  insert into public.b2b_interest_signups
    (id, session_id, name, email, company, role, buyers_per_year, tier, utm_source, utm_medium, utm_campaign)
  values
    ((p->>'id')::uuid, (p->>'session_id')::uuid, p->>'name', lower(p->>'email'),
     p->>'company', p->>'role', p->>'buyers_per_year', p->>'tier',
     p->>'utm_source', p->>'utm_medium', p->>'utm_campaign')
  on conflict (id) do nothing returning id into saved_id;
  if saved_id is not null then
    insert into public.b2b_interest_events
      (id, session_id, event_type, tier, utm_source, utm_medium, utm_campaign, signup_id)
    values (saved_id, (p->>'session_id')::uuid, 'popup_submission', p->>'tier',
      p->>'utm_source', p->>'utm_medium', p->>'utm_campaign', saved_id);
  end if;
  return (p->>'id')::uuid;
end;
$$;
revoke all on function public.submit_b2b_interest(jsonb) from public, anon, authenticated;
grant execute on function public.submit_b2b_interest(jsonb) to service_role;

create function public.b2b_interest_results(source_filter text default null) returns jsonb
language sql stable security invoker set search_path = public as $$
  with e as (
    select * from public.b2b_interest_events where not is_test
    and (source_filter is null or utm_source = source_filter)
  ), s as (
    select * from public.b2b_interest_signups where not is_test
    and (source_filter is null or utm_source = source_filter)
  ), totals as (
    select count(*) filter (where event_type = 'page_view') as page_views,
      count(*) filter (where event_type = 'tier_click') as tier_clicks,
      count(*) filter (where event_type = 'popup_submission') as submissions from e
  )
  select jsonb_build_object(
    'pageViews', page_views, 'tierClicks', tier_clicks, 'submissions', submissions,
    'signups', (select count(*) from s),
    'clickRate', case when page_views = 0 then 0 else round(100.0*tier_clicks/page_views, 2) end,
    'tiers', (select jsonb_agg(jsonb_build_object('tier', t.tier,
      'clicks', (select count(*) from e where event_type='tier_click' and tier=t.tier),
      'signups', (select count(*) from s where tier=t.tier)))
      from (values ('agent'),('loan_officer'),('brokerage')) as t(tier)),
    'sources', (select coalesce(jsonb_agg(utm_source order by utm_source), '[]'::jsonb)
      from (select distinct utm_source from public.b2b_interest_events where not is_test) as sources)
  ) from totals;
$$;
revoke all on function public.b2b_interest_results(text) from public, anon, authenticated;
grant execute on function public.b2b_interest_results(text) to service_role;

notify pgrst, 'reload schema';
