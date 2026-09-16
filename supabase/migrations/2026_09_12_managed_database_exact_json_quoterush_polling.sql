-- Upgrade the exact-json-v2 managed-data upsert RPC after the durable
-- QuoteRUSH polling/email columns are installed.
--
-- Keep 2026_09_07_managed_database_exact_json_v2.sql unchanged: projects may
-- already have applied it, and this dated replacement is the safe incremental
-- upgrade for existing targets. Every managed column is listed explicitly so
-- a transfer cannot silently reset worker state to a column default.
alter table if exists public.insurance_quote_cache
  add column if not exists quote_poll_claimed_at timestamptz,
  add column if not exists quote_poll_lease_until timestamptz,
  add column if not exists email_first_attempt_at timestamptz,
  add column if not exists email_retry_count integer not null default 0,
  add column if not exists email_quarantine_at timestamptz;

create or replace function public.upsert_managed_migration_rows(
  p_target text,
  p_primary_key text,
  p_rows json
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_target = 'managed_users' and p_primary_key = 'id' then
    insert into public.managed_users (
      id, username, password, email, first_name, last_name, phone,
      contact_preference, created_at
    )
    select native.id, native.username, native.password, native.email,
      native.first_name, native.last_name, native.phone,
      native.contact_preference, native.created_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.managed_users, item.value
    ) as native
    on conflict (id) do update set
      username = excluded.username,
      password = excluded.password,
      email = excluded.email,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      phone = excluded.phone,
      contact_preference = excluded.contact_preference,
      created_at = excluded.created_at;
    return;
  end if;

  if p_target = 'managed_services' and p_primary_key = 'id' then
    insert into public.managed_services (
      id, name, display_name, description, options
    )
    select native.id, native.name, native.display_name, native.description,
      (item.value ->> 'options')::jsonb
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.managed_services, item.value
    ) as native
    on conflict (id) do update set
      name = excluded.name,
      display_name = excluded.display_name,
      description = excluded.description,
      options = excluded.options;
    return;
  end if;

  if p_target = 'managed_submissions' and p_primary_key = 'id' then
    insert into public.managed_submissions (
      id, user_id, selected_services, form_data, status, created_at
    )
    select native.id, native.user_id,
      (item.value ->> 'selected_services')::jsonb,
      (item.value ->> 'form_data')::jsonb,
      native.status, native.created_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.managed_submissions, item.value
    ) as native
    on conflict (id) do update set
      user_id = excluded.user_id,
      selected_services = excluded.selected_services,
      form_data = excluded.form_data,
      status = excluded.status,
      created_at = excluded.created_at;
    return;
  end if;

  if p_target = 'managed_integration_requests' and p_primary_key = 'id' then
    insert into public.managed_integration_requests (
      id, submission_id, provider, request_data, response_data, status, created_at
    )
    select native.id, native.submission_id, native.provider,
      (item.value ->> 'request_data')::jsonb,
      (item.value ->> 'response_data')::jsonb,
      native.status, native.created_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.managed_integration_requests, item.value
    ) as native
    on conflict (id) do update set
      submission_id = excluded.submission_id,
      provider = excluded.provider,
      request_data = excluded.request_data,
      response_data = excluded.response_data,
      status = excluded.status,
      created_at = excluded.created_at;
    return;
  end if;

  if p_target = 'managed_questionnaire_responses' and p_primary_key = 'id' then
    insert into public.managed_questionnaire_responses (
      id, session_id, service_type, step_name, response_data, is_completed,
      created_at, updated_at
    )
    select native.id, native.session_id, native.service_type, native.step_name,
      (item.value ->> 'response_data')::jsonb,
      native.is_completed, native.created_at, native.updated_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.managed_questionnaire_responses, item.value
    ) as native
    on conflict (id) do update set
      session_id = excluded.session_id,
      service_type = excluded.service_type,
      step_name = excluded.step_name,
      response_data = excluded.response_data,
      is_completed = excluded.is_completed,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;
    return;
  end if;

  if p_target = 'user_subscriptions' and p_primary_key = 'user_id' then
    insert into public.user_subscriptions (
      id, user_id, email, stripe_customer_id, stripe_subscription_id, status,
      current_period_end, updated_at
    )
    select native.id, native.user_id, native.email, native.stripe_customer_id,
      native.stripe_subscription_id, native.status, native.current_period_end,
      native.updated_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.user_subscriptions, item.value
    ) as native
    on conflict (user_id) do update set
      id = excluded.id,
      email = excluded.email,
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      updated_at = excluded.updated_at;
    return;
  end if;

  if p_target = 'private_user_profiles' and p_primary_key = 'user_id' then
    insert into public.private_user_profiles (
      user_id, date_of_birth, credit_score_consent_at, created_at, updated_at
    )
    select native.user_id, native.date_of_birth, native.credit_score_consent_at,
      native.created_at, native.updated_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.private_user_profiles, item.value
    ) as native
    on conflict (user_id) do update set
      date_of_birth = excluded.date_of_birth,
      credit_score_consent_at = excluded.credit_score_consent_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;
    return;
  end if;

  if p_target = 'private_insurance_properties' and
     p_primary_key = 'user_id,address_normalized' then
    insert into public.private_insurance_properties (
      user_id, address_normalized, current_policy_expiration_date,
      quote_cache_scope, created_at, updated_at
    )
    select native.user_id, native.address_normalized,
      native.current_policy_expiration_date, native.quote_cache_scope,
      native.created_at, native.updated_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.private_insurance_properties, item.value
    ) as native
    on conflict (user_id, address_normalized) do update set
      current_policy_expiration_date = excluded.current_policy_expiration_date,
      quote_cache_scope = excluded.quote_cache_scope,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;
    return;
  end if;

  if p_target = 'insurance_quote_cache' and
     p_primary_key = 'address_normalized,policy_type' then
    insert into public.insurance_quote_cache (
      id, address_normalized, address_display, lead_id, status, quotes,
      quote_counter, quote_poll_attempts, quote_stable_polls,
      quote_previous_counter, quote_poll_claimed_at, quote_poll_lease_until,
      coverage_a, policy_type, cache_scope,
      property_data_snapshot, property_data_provenance, agency_default_snapshot,
      consumer_property_answers, quote_profile_version, raw_quoterush_property_data,
      raw_quoterush_property_data_source, raw_quoterush_property_data_fetched_at,
      raw_quoterush_property_data_expires_at, assumptions, triggered_at,
      completed_at, expires_at, email_recipient, email_user_id,
      email_delivery_status, email_claimed_at, email_first_attempt_at,
      email_retry_count, email_quarantine_at, email_sent_at, email_error
    )
    select native.id, native.address_normalized, native.address_display,
      native.lead_id, native.status,
      (item.value ->> 'quotes')::jsonb,
      native.quote_counter, native.quote_poll_attempts, native.quote_stable_polls,
      native.quote_previous_counter, native.quote_poll_claimed_at,
      native.quote_poll_lease_until, native.coverage_a, native.policy_type,
      native.cache_scope,
      (item.value ->> 'property_data_snapshot')::jsonb,
      (item.value ->> 'property_data_provenance')::jsonb,
      (item.value ->> 'agency_default_snapshot')::jsonb,
      (item.value ->> 'consumer_property_answers')::jsonb,
      native.quote_profile_version,
      (item.value ->> 'raw_quoterush_property_data')::jsonb,
      native.raw_quoterush_property_data_source,
      native.raw_quoterush_property_data_fetched_at,
      native.raw_quoterush_property_data_expires_at,
      (item.value ->> 'assumptions')::jsonb,
      native.triggered_at, native.completed_at, native.expires_at,
      native.email_recipient, native.email_user_id,
      native.email_delivery_status, native.email_claimed_at,
      native.email_first_attempt_at, native.email_retry_count,
      native.email_quarantine_at, native.email_sent_at, native.email_error
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.insurance_quote_cache, item.value
    ) as native
    on conflict (address_normalized, policy_type) do update set
      id = excluded.id,
      address_display = excluded.address_display,
      lead_id = excluded.lead_id,
      status = excluded.status,
      quotes = excluded.quotes,
      quote_counter = excluded.quote_counter,
      quote_poll_attempts = excluded.quote_poll_attempts,
      quote_stable_polls = excluded.quote_stable_polls,
      quote_previous_counter = excluded.quote_previous_counter,
      quote_poll_claimed_at = excluded.quote_poll_claimed_at,
      quote_poll_lease_until = excluded.quote_poll_lease_until,
      coverage_a = excluded.coverage_a,
      cache_scope = excluded.cache_scope,
      property_data_snapshot = excluded.property_data_snapshot,
      property_data_provenance = excluded.property_data_provenance,
      agency_default_snapshot = excluded.agency_default_snapshot,
      consumer_property_answers = excluded.consumer_property_answers,
      quote_profile_version = excluded.quote_profile_version,
      raw_quoterush_property_data = excluded.raw_quoterush_property_data,
      raw_quoterush_property_data_source = excluded.raw_quoterush_property_data_source,
      raw_quoterush_property_data_fetched_at = excluded.raw_quoterush_property_data_fetched_at,
      raw_quoterush_property_data_expires_at = excluded.raw_quoterush_property_data_expires_at,
      assumptions = excluded.assumptions,
      triggered_at = excluded.triggered_at,
      completed_at = excluded.completed_at,
      expires_at = excluded.expires_at,
      email_recipient = excluded.email_recipient,
      email_user_id = excluded.email_user_id,
      email_delivery_status = excluded.email_delivery_status,
      email_claimed_at = excluded.email_claimed_at,
      email_first_attempt_at = excluded.email_first_attempt_at,
      email_retry_count = excluded.email_retry_count,
      email_quarantine_at = excluded.email_quarantine_at,
      email_sent_at = excluded.email_sent_at,
      email_error = excluded.email_error;
    return;
  end if;

  if p_target = 'non_ad_valorem_cache' and p_primary_key = 'folio' then
    insert into public.non_ad_valorem_cache (
      id, folio, account_number, bill_year, status, lines,
      total_non_ad_valorem, total_ad_valorem_cents, total_millage,
      ad_valorem_mills, fetched_at, expires_at
    )
    select native.id, native.folio, native.account_number, native.bill_year,
      native.status, (item.value ->> 'lines')::jsonb,
      native.total_non_ad_valorem, native.total_ad_valorem_cents,
      native.total_millage, (item.value ->> 'ad_valorem_mills')::jsonb,
      native.fetched_at, native.expires_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.non_ad_valorem_cache, item.value
    ) as native
    on conflict (folio) do update set
      id = excluded.id,
      account_number = excluded.account_number,
      bill_year = excluded.bill_year,
      status = excluded.status,
      lines = excluded.lines,
      total_non_ad_valorem = excluded.total_non_ad_valorem,
      total_ad_valorem_cents = excluded.total_ad_valorem_cents,
      total_millage = excluded.total_millage,
      ad_valorem_mills = excluded.ad_valorem_mills,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at;
    return;
  end if;

  if p_target = 'ifw_activity_claims' and p_primary_key = 'dedupe_key' then
    insert into public.ifw_activity_claims (
      dedupe_key, user_id, created_at, expires_at
    )
    select native.dedupe_key, native.user_id, native.created_at, native.expires_at
    from json_array_elements(coalesce(p_rows, '[]'::json)) as item(value)
    cross join lateral json_populate_record(
      null::public.ifw_activity_claims, item.value
    ) as native
    on conflict (dedupe_key) do update set
      user_id = excluded.user_id,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at;
    return;
  end if;

  raise exception 'Unknown managed migration target';
end;
$$;

revoke all on function public.upsert_managed_migration_rows(text, text, json)
  from public, anon, authenticated;
grant execute on function public.upsert_managed_migration_rows(text, text, json)
  to service_role;

notify pgrst, 'reload schema';