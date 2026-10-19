-- Shared database rate limits apply across server instances. The two experiment
-- tables remain the only new tables; no IP addresses or browser fingerprints.
create function public.record_b2b_interest_event(p jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('b2b-event:' || (p->>'session_id'), 0));
  if exists(select 1 from public.b2b_interest_events where id=(p->>'id')::uuid) then return; end if;
  if (select count(*) from public.b2b_interest_events
      where session_id=(p->>'session_id')::uuid and created_at > now()-interval '10 minutes') >= 300 then
    raise exception 'Event rate limit reached';
  end if;
  insert into public.b2b_interest_events
    (id,session_id,event_type,tier,utm_source,utm_medium,utm_campaign)
  values ((p->>'id')::uuid,(p->>'session_id')::uuid,p->>'event_type',p->>'tier',
    p->>'utm_source',p->>'utm_medium',p->>'utm_campaign');
end;
$$;
revoke all on function public.record_b2b_interest_event(jsonb) from public, anon, authenticated;
grant execute on function public.record_b2b_interest_event(jsonb) to service_role;

create or replace function public.submit_b2b_interest(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare saved_id uuid;
begin
  -- The experiment has tiny writes. A shared lock makes rate checks atomic
  -- for both email and session while ensuring retry IDs stay idempotent.
  perform pg_advisory_xact_lock(hashtextextended('b2b-interest-submit', 0));
  if exists(select 1 from public.b2b_interest_signups where id=(p->>'id')::uuid) then
    if not exists(select 1 from public.b2b_interest_signups
      where id=(p->>'id')::uuid and email=lower(p->>'email')
      and session_id=(p->>'session_id')::uuid and tier=p->>'tier') then
      raise exception using errcode='22023', message='Submission ID conflict';
    end if;
    return (p->>'id')::uuid;
  end if;
  if (select count(*) from public.b2b_interest_signups
      where email=lower(p->>'email') and created_at > now()-interval '1 hour') >= 3
    or (select count(*) from public.b2b_interest_signups
      where session_id=(p->>'session_id')::uuid and created_at > now()-interval '1 hour') >= 5 then
    raise exception 'Signup rate limit reached';
  end if;
  insert into public.b2b_interest_signups
    (id, session_id, name, email, company, role, buyers_per_year, tier, utm_source, utm_medium, utm_campaign)
  values
    ((p->>'id')::uuid, (p->>'session_id')::uuid, p->>'name', lower(p->>'email'),
     p->>'company', p->>'role', p->>'buyers_per_year', p->>'tier',
     p->>'utm_source', p->>'utm_medium', p->>'utm_campaign')
  returning id into saved_id;
  insert into public.b2b_interest_events
    (id, session_id, event_type, tier, utm_source, utm_medium, utm_campaign, signup_id)
  values (saved_id, (p->>'session_id')::uuid, 'popup_submission', p->>'tier',
    p->>'utm_source', p->>'utm_medium', p->>'utm_campaign', saved_id);
  return saved_id;
end;
$$;
notify pgrst, 'reload schema';
