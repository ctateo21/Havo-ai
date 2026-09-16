-- Durable QuoteRUSH polling and result-email delivery state.
-- Apply this migration before enabling server-owned polling.
begin;

alter table insurance_quote_cache
  add column if not exists quote_poll_attempts integer not null default 0,
  add column if not exists quote_stable_polls integer not null default 0,
  add column if not exists quote_previous_counter integer,
  add column if not exists quote_poll_claimed_at timestamp,
  add column if not exists quote_poll_lease_until timestamp,
  add column if not exists email_recipient text,
  add column if not exists email_user_id text,
  add column if not exists email_delivery_status text not null default 'pending',
  add column if not exists email_claimed_at timestamp,
  add column if not exists email_first_attempt_at timestamp,
  add column if not exists email_retry_count integer not null default 0,
  add column if not exists email_quarantine_at timestamp,
  add column if not exists email_sent_at timestamp,
  add column if not exists email_error text;

-- Existing completed rows predate result-email delivery. They have no
-- recipient and must never be picked up by the new worker.
update insurance_quote_cache
set email_delivery_status = 'skipped',
    email_error = 'legacy row has no result-email recipient'
where status = 'success'
  and email_delivery_status = 'pending'
  and email_recipient is null;

create index if not exists insurance_quote_cache_pending_poll_idx
  on insurance_quote_cache (status, triggered_at)
  where status = 'pending';

commit;