-- Durable QuoteRUSH polling and result-email delivery state.
-- Run this in the managed Supabase SQL editor before server polling is enabled.
begin;

alter table if exists public.insurance_quote_cache
  add column if not exists quote_poll_attempts integer not null default 0,
  add column if not exists quote_stable_polls integer not null default 0,
  add column if not exists quote_previous_counter integer,
  add column if not exists quote_poll_claimed_at timestamptz,
  add column if not exists quote_poll_lease_until timestamptz,
  add column if not exists email_recipient text,
  add column if not exists email_user_id text,
  add column if not exists email_delivery_status text not null default 'pending',
  add column if not exists email_claimed_at timestamptz,
  add column if not exists email_first_attempt_at timestamptz,
  add column if not exists email_retry_count integer not null default 0,
  add column if not exists email_quarantine_at timestamptz,
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_error text;

update public.insurance_quote_cache
set email_delivery_status = 'skipped',
    email_error = 'legacy row has no result-email recipient'
where status = 'success'
  and email_delivery_status = 'pending'
  and email_recipient is null;

create index if not exists insurance_quote_cache_pending_poll_idx
  on public.insurance_quote_cache(status, triggered_at)
  where status = 'pending';

-- Keep stale/error reclaim atomic while preserving server-only delivery
-- metadata across a target-native claim.
create or replace function public.claim_insurance_quote_cache(
  p_address_normalized text, p_policy_type text,
  p_values jsonb, p_now timestamptz
) returns table(claimed boolean,row_id bigint)
language plpgsql security definer set search_path=public as $$
begin
  insert into insurance_quote_cache(
    id,address_normalized,address_display,lead_id,status,quotes,
    quote_counter,quote_poll_attempts,quote_stable_polls,
    quote_previous_counter,quote_poll_claimed_at,quote_poll_lease_until,
    coverage_a,policy_type,cache_scope,
    property_data_snapshot,property_data_provenance,
    agency_default_snapshot,consumer_property_answers,
    quote_profile_version,assumptions,triggered_at,completed_at,expires_at,
    email_recipient,email_user_id,email_delivery_status,email_claimed_at,
    email_first_attempt_at,email_retry_count,email_quarantine_at,
    email_sent_at,email_error
  )
  values(
    nextval(pg_get_serial_sequence('insurance_quote_cache','id')),
    p_address_normalized,p_values->>'address_display',
    nullif(p_values->>'lead_id','')::integer,
    coalesce(p_values->>'status','pending'),
    coalesce(p_values->'quotes','[]'::jsonb),
    coalesce((p_values->>'quote_counter')::integer,0),
    coalesce((p_values->>'quote_poll_attempts')::integer,0),
    coalesce((p_values->>'quote_stable_polls')::integer,0),
    (p_values->>'quote_previous_counter')::integer,
    (p_values->>'quote_poll_claimed_at')::timestamptz,
    (p_values->>'quote_poll_lease_until')::timestamptz,
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
    (p_values->>'expires_at')::timestamptz,
    p_values->>'email_recipient',
    p_values->>'email_user_id',
    coalesce(p_values->>'email_delivery_status','pending'),
    (p_values->>'email_claimed_at')::timestamptz,
    (p_values->>'email_first_attempt_at')::timestamptz,
    coalesce((p_values->>'email_retry_count')::integer,0),
    (p_values->>'email_quarantine_at')::timestamptz,
    (p_values->>'email_sent_at')::timestamptz,
    p_values->>'email_error'
  )
  on conflict(address_normalized,policy_type) do update set
    address_display=excluded.address_display,
    lead_id=excluded.lead_id,status=excluded.status,quotes=excluded.quotes,
    quote_counter=excluded.quote_counter,
    quote_poll_attempts=excluded.quote_poll_attempts,
    quote_stable_polls=excluded.quote_stable_polls,
    quote_previous_counter=excluded.quote_previous_counter,
    quote_poll_claimed_at=excluded.quote_poll_claimed_at,
    quote_poll_lease_until=excluded.quote_poll_lease_until,
    coverage_a=excluded.coverage_a,cache_scope=excluded.cache_scope,
    property_data_snapshot=excluded.property_data_snapshot,
    property_data_provenance=excluded.property_data_provenance,
    agency_default_snapshot=excluded.agency_default_snapshot,
    consumer_property_answers=excluded.consumer_property_answers,
    quote_profile_version=excluded.quote_profile_version,
    assumptions=excluded.assumptions,
    triggered_at=greatest(
      excluded.triggered_at,
      insurance_quote_cache.triggered_at + interval '1 millisecond'
    ),
    completed_at=excluded.completed_at,expires_at=excluded.expires_at,
    email_recipient=excluded.email_recipient,
    email_user_id=excluded.email_user_id,
    email_delivery_status=excluded.email_delivery_status,
    email_claimed_at=excluded.email_claimed_at,
    email_first_attempt_at=excluded.email_first_attempt_at,
    email_retry_count=excluded.email_retry_count,
    email_quarantine_at=excluded.email_quarantine_at,
    email_sent_at=excluded.email_sent_at,
    email_error=excluded.email_error
  where insurance_quote_cache.expires_at<=p_now
     or insurance_quote_cache.status in ('error','failed')
  returning true,insurance_quote_cache.id into claimed,row_id;
  if not found then
    select false,id into claimed,row_id from insurance_quote_cache
      where address_normalized=p_address_normalized
        and policy_type=p_policy_type;
  end if;
  return next;
end $$;

revoke all on function public.claim_insurance_quote_cache(
  text,text,jsonb,timestamptz
) from public,anon,authenticated;
grant execute on function public.claim_insurance_quote_cache(
  text,text,jsonb,timestamptz
) to service_role;

notify pgrst, 'reload schema';
commit;