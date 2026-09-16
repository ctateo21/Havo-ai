-- ============================================================================
-- Tateo & Co — Supabase schema
-- Paste this entire file into Supabase Dashboard → SQL Editor → New Query → Run
-- Safe to re-run: uses `if not exists` / `or replace` everywhere.
-- ============================================================================
-- Server-managed target tables and restricted RPCs are also maintained in
-- supabase/migrations/2026_09_06_managed_database_staged_migration.sql and
-- supabase/migrations/2026_09_07_managed_database_exact_json_v2.sql.
-- Apply dated migrations incrementally when updating an existing project,
-- including the later managed-data QuoteRUSH polling upsert upgrade.

-- ----------------------------------------------------------------------------
-- 1. profiles  (1-to-1 with auth.users; stores app-level account fields)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  name         text not null,
  email        text not null,
  phone        text,
  agent        text,
  invited_user jsonb,
  created_at   timestamptz not null default now()
);

-- Borrower-level DTI figures (monthly, dollars) — prefill the refinance
-- DTI check across sessions. Additive + idempotent.
alter table public.profiles
  add column if not exists monthly_income numeric,
  add column if not exists monthly_debts  numeric;

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own"  on public.profiles;
drop policy if exists "profiles_update_own"  on public.profiles;
drop policy if exists "profiles_insert_own"  on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- Auto-create a profile row when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, phone, agent)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'agent'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. tracked_loans  (refinance dashboard)
-- ----------------------------------------------------------------------------
create table if not exists public.tracked_loans (
  id                         text primary key,
  user_id                    uuid not null references auth.users(id) on delete cascade,
  property_address           text not null,
  lender                     text,
  loan_balance               numeric not null,
  current_rate               numeric not null,
  current_pi                 numeric not null,
  monthly_payment            numeric not null,
  estimated_home_value       numeric not null,
  estimated_remaining_years  numeric not null,
  property_type              text not null default 'primary',
  added_at                   timestamptz not null default now(),
  balance_as_of              timestamptz
);

create index if not exists tracked_loans_user_idx on public.tracked_loans(user_id);

-- Additive: servicer loan/account number extracted from uploaded
-- mortgage statements. Text (preserves leading zeros and dashes).
-- loan_type: refinance program selected in the detail view
--   (va | fha | conventional | dscr | bank_statement). VA/FHA are
--   restricted client-side to primary residences.
alter table public.tracked_loans
  add column if not exists loan_number  text,
  add column if not exists loan_type    text default 'conventional',
  add column if not exists credit_score integer,
  add column if not exists va_disability boolean,
  add column if not exists current_escrow_balance numeric;

-- Additive: refinance entry methods (statement | closing_disclosure |
-- manual | free_and_clear) plus the origination details captured by the
-- Closing Disclosure / manual flows and the amortization-verification
-- state. free_and_clear rows write 0 for the NOT NULL loan columns.
-- (Mirrors supabase/migrations/2026_08_06_refinance_entry_methods.sql.)
alter table public.tracked_loans
  add column if not exists entry_method            text default 'statement',
  add column if not exists purchase_date           date,
  add column if not exists first_payment_date      date,
  add column if not exists original_purchase_price numeric,
  add column if not exists original_loan_amount    numeric,
  add column if not exists original_rate           numeric,
  add column if not exists original_term_months    integer,
  add column if not exists amortized_balance_check numeric,
  add column if not exists balance_confirmed       boolean,
  add column if not exists free_and_clear          boolean default false;

-- Persist user-selected refinance options and proposed borrowing amounts.
-- (Mirrors supabase/migrations/2026_06_15_apply_refinance_input_persistence.sql.)
alter table public.tracked_loans
  add column if not exists refi_goal                    text,
  add column if not exists finance_fees                 boolean,
  add column if not exists include_escrows              boolean,
  add column if not exists cash_out_new_loan_amount     numeric,
  add column if not exists home_equity_product          text,
  add column if not exists home_equity_borrow_amount    numeric;

-- Property-tax persistence columns (additive — set by the refinance dashboard).
alter table public.tracked_loans
  add column if not exists annual_property_tax            numeric,
  add column if not exists annual_property_tax_source     text,
  add column if not exists annual_property_tax_year       integer,
  add column if not exists annual_property_tax_queried_at timestamptz;

alter table public.tracked_loans enable row level security;
drop policy if exists "tracked_loans_owner" on public.tracked_loans;
create policy "tracked_loans_owner" on public.tracked_loans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 3. purchase_scenarios  (saved property estimates)
-- ----------------------------------------------------------------------------
create table if not exists public.purchase_scenarios (
  id                text primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  address           text not null,
  saved_at          timestamptz not null default now(),
  price             numeric,
  monthly_payment   numeric,
  down_payment      numeric,
  interest_rate     numeric,
  cash_to_close     numeric,
  dti               numeric,
  qualifies         boolean,
  down_payment_pct  numeric,
  loan_type         text
);

-- Page 3 (`/mortgage`) and Page 4 (`/estimate`) share the down-payment
-- control via these two columns:
--   down_payment_mode:   'percent' | 'amount' — UI source of truth.
--   down_payment_amount: canonical $ value (mirrors price * pct / 100
--                        in percent mode; the real input in amount mode).
alter table public.purchase_scenarios
  add column if not exists down_payment_mode   text,
  add column if not exists down_payment_amount numeric;

-- Property photos cached on the purchase scenario so the estimate page
-- can re-display them instantly on revisit without re-scraping Apify.
-- Matches the shape already used by cash_buy_scenarios / seller_scenarios:
--   primary_photo_url: first photo url (denormalized for fast list views)
--   property_photos:   full normalized photo array (jsonb)
alter table public.purchase_scenarios
  add column if not exists primary_photo_url text,
  add column if not exists property_photos   jsonb;

-- Page-4 (`/estimate`) writes these on save. Without them the upsert
-- 400s with PGRST204 "Could not find the '<col>' column of
-- 'purchase_scenarios' in the schema cache" and the draft never lands.
-- All `add column if not exists` — safe to re-run.
alter table public.purchase_scenarios
  add column if not exists property_type                  text,
  add column if not exists property_type_source           text,
  add column if not exists has_deferred_student_loans     boolean,
  add column if not exists deferred_student_loan_balance  numeric,
  add column if not exists discount_points_percent        numeric,
  add column if not exists discount_points_cost           numeric,
  add column if not exists discount_points_rate_reduction numeric,
  add column if not exists rate_before_discount_points    numeric,
  add column if not exists rate_after_discount_points     numeric;

create index if not exists purchase_scenarios_user_idx on public.purchase_scenarios(user_id);

alter table public.purchase_scenarios enable row level security;
drop policy if exists "purchase_scenarios_owner" on public.purchase_scenarios;
create policy "purchase_scenarios_owner" on public.purchase_scenarios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 4. insurance_scenarios
-- ----------------------------------------------------------------------------
create table if not exists public.insurance_scenarios (
  id              text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  address         text not null,
  saved_at        timestamptz not null default now(),
  annual_premium  numeric,
  coverage_type   text
);

create index if not exists insurance_scenarios_user_idx on public.insurance_scenarios(user_id);

alter table public.insurance_scenarios enable row level security;
drop policy if exists "insurance_scenarios_owner" on public.insurance_scenarios;
create policy "insurance_scenarios_owner" on public.insurance_scenarios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 4b. seller_scenarios  (consumer-side seller dashboard tab)
-- ----------------------------------------------------------------------------
-- Saved "what if I sold?" scenarios for homeowners considering selling. Mirrors
-- the purchase/insurance_scenarios pattern: text PK chosen client-side, owner
-- RLS, idempotent create. Net proceeds are recomputed in the UI from the
-- stored inputs — we only persist the inputs + a single derived snapshot.
create table if not exists public.seller_scenarios (
  id                       text primary key,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  full_address             text not null,
  normalized_property_key  text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  estimated_sale_price     numeric,
  mortgage_payoff          numeric,
  seller_closing_costs     numeric,
  realtor_commission       numeric,
  buyer_concessions        numeric,
  repair_budget            numeric,
  other_selling_costs      numeric,
  net_proceeds             numeric,
  status                   text not null default 'draft',
  primary_photo_url        text,
  property_photos          jsonb
);

create index if not exists seller_scenarios_user_idx on public.seller_scenarios(user_id);

-- Additive: provenance ("source") columns so the Refinance → Sell-Your-Home
-- auto-create flow can safely overwrite system-generated values without
-- ever clobbering a value the user manually edited in the Sell-Your-Home
-- detail view. NULL = "auto / overridable" (legacy rows).
--   estimated_sale_price_source : 'refinance' | 'zillow' | 'manual'
--   mortgage_payoff_source      : 'refinance_statement' | 'manual'
--   realtor_commission_source   : 'default_5_percent' | 'manual'
--   seller_closing_costs_source : 'default_percent' | 'percent_manual' | 'manual'
--                                  (legacy: 'default_1_percent')
alter table public.seller_scenarios
  add column if not exists estimated_sale_price_source text,
  add column if not exists mortgage_payoff_source      text,
  add column if not exists realtor_commission_source   text,
  add column if not exists seller_closing_costs_source text;

-- Mortgage Payoff multi-source resolution (see
-- supabase/migrations/2026_06_15_seller_mortgage_payoff_sources.sql).
--   mortgage_payoff_source now also takes 'refinance' | 'statement' |
--                                'amortized_estimate'
--   mortgage_payoff_estimate_inputs : amortization snapshot (jsonb)
--   mortgage_statement_metadata     : uploaded-statement metadata (jsonb)
alter table public.seller_scenarios
  add column if not exists mortgage_payoff_estimate_inputs jsonb default '{}'::jsonb,
  add column if not exists mortgage_statement_metadata     jsonb default '{}'::jsonb;

-- Seller closing costs are now slider-driven as a PERCENT of sale price
-- (default 1.85%). The dollar amount stays in `seller_closing_costs` and
-- is recomputed any time the sale price or this percent changes.
alter table public.seller_scenarios
  add column if not exists seller_closing_costs_percent numeric default 1.85;

-- Estimated capital-gains tax inputs + result. Additive; see
-- supabase/migrations/2026_06_15_seller_capital_gains_tax.sql.
--   primary_residence_2_of_5  : true | false | null (unanswered)
--   filing_status             : 'single' | 'married' | null
--   assume_1031_exchange      : run numbers assuming a qualifying 1031 exchange
--   capital_improvements      : added to cost basis (reduces taxable gain)
--   prior_purchase_price      : basis source (Zillow/cache or manual)
--   prior_purchase_price_source: 'zillow' | 'property_cache' | 'manual' | 'unknown'
--   estimated_taxes_due       : derived snapshot (UI always recomputes)
alter table public.seller_scenarios
  add column if not exists primary_residence_2_of_5    boolean,
  add column if not exists filing_status               text,
  add column if not exists assume_1031_exchange         boolean default false,
  add column if not exists capital_improvements         numeric default 0,
  add column if not exists prior_purchase_price         numeric,
  add column if not exists prior_purchase_price_source  text,
  add column if not exists estimated_taxes_due          numeric default 0;

alter table public.seller_scenarios enable row level security;
drop policy if exists "seller_scenarios_owner" on public.seller_scenarios;
create policy "seller_scenarios_owner" on public.seller_scenarios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 4b-cash. cash_buy_scenarios  (Cash Buy dashboard tab)
-- ----------------------------------------------------------------------------
-- Saved cash-purchase scenarios: no mortgage, no DTI, no qualification. Mirrors
-- purchase_scenarios/seller_scenarios shape (text PK chosen client-side, owner
-- RLS, idempotent create). Cash-to-close is recomputed in the UI from the
-- stored inputs — we persist a single derived snapshot for dashboard cards.
create table if not exists public.cash_buy_scenarios (
  id                          text primary key,
  user_id                     uuid not null references auth.users(id) on delete cascade,
  full_address                text not null,
  normalized_property_key     text,
  purchase_price              numeric,
  cash_to_close               numeric,
  buyer_closing_costs         numeric,
  closing_costs_percent       numeric,
  closing_costs_source        text,
  seller_concessions_mode     text,
  seller_concessions_percent  numeric,
  seller_concessions_amount   numeric,
  property_taxes              numeric,
  homeowners_insurance        numeric,
  annual_flood_ins            numeric,
  hoa_amount                  numeric,
  hoa_frequency               text,
  hoa_source                  text,
  occupancy_type              text,
  status                      text,
  primary_photo_url           text,
  property_photos             jsonb,
  zillow_cache_key            text,
  property_cache_id           text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists cash_buy_scenarios_user_idx on public.cash_buy_scenarios(user_id);

alter table public.cash_buy_scenarios enable row level security;
drop policy if exists "cash_buy_scenarios_owner" on public.cash_buy_scenarios;
create policy "cash_buy_scenarios_owner" on public.cash_buy_scenarios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 4c. listing_market_analyses  (AI-generated weekly seller listing analysis)
-- ----------------------------------------------------------------------------
-- One row per (listing_id, analysis_week_of). Generated server-side via
-- Anthropic at most once per Friday-aligned week per listing. We always read
-- the most recent row for the listing; staleness is computed off
-- next_update_due_at so the lazy refresh path can decide whether to regenerate.
create table if not exists public.listing_market_analyses (
  id                      text primary key,
  listing_id              text not null,
  user_id                 uuid not null references auth.users(id) on delete cascade,
  property_address        text not null,
  analysis_week_of        date not null,
  generated_at            timestamptz not null default now(),
  next_update_due_at      timestamptz not null,
  status                  text not null default 'draft',
  market_summary          text,
  pricing_analysis        text,
  comps_summary           text,
  online_interest_summary text,
  showing_summary         text,
  recommended_next_steps  jsonb,
  risk_flags              jsonb,
  price_review_recommended boolean,
  confidence_level        text,
  data_limitations        jsonb,
  raw_prompt              text,
  raw_anthropic_response  text,
  error_message           text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists listing_market_analyses_listing_idx
  on public.listing_market_analyses(listing_id, analysis_week_of desc);
create index if not exists listing_market_analyses_user_idx
  on public.listing_market_analyses(user_id);

alter table public.listing_market_analyses enable row level security;
drop policy if exists "listing_market_analyses_owner" on public.listing_market_analyses;
create policy "listing_market_analyses_owner" on public.listing_market_analyses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 5. questionnaire_responses  (multi-step questionnaire autosave)
-- ----------------------------------------------------------------------------
create table if not exists public.questionnaire_responses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  session_id  text not null,
  step_name   text not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  unique (session_id, step_name)
);

create index if not exists questionnaire_responses_user_idx on public.questionnaire_responses(user_id);
create index if not exists questionnaire_responses_session_idx on public.questionnaire_responses(session_id);

alter table public.questionnaire_responses enable row level security;
-- Drop any previous overly-permissive policy from earlier drafts.
drop policy if exists "questionnaire_owner_or_anon" on public.questionnaire_responses;
drop policy if exists "questionnaire_owner"        on public.questionnaire_responses;
-- Strict: only the authenticated owner can read/write their rows.
-- Anonymous (pre-signup) drafts must go through a trusted server endpoint
-- using the service-role key — never the anon key.
create policy "questionnaire_owner" on public.questionnaire_responses
  for all
  using      (auth.uid() is not null and auth.uid() = user_id)
  with check (auth.uid() is not null and auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 6. submissions  (generic form submission log)
-- ----------------------------------------------------------------------------
create table if not exists public.submissions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  kind        text not null,
  data        jsonb not null,
  status      text not null default 'pending',
  created_at  timestamptz not null default now()
);

create index if not exists submissions_user_idx on public.submissions(user_id);

alter table public.submissions enable row level security;
drop policy if exists "submissions_owner_or_anon" on public.submissions;
drop policy if exists "submissions_owner"         on public.submissions;
create policy "submissions_owner" on public.submissions
  for all
  using      (auth.uid() is not null and auth.uid() = user_id)
  with check (auth.uid() is not null and auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 7. property_cache  (Zillow-via-Apify lookups; 24h TTL handled in app code)
-- ----------------------------------------------------------------------------
-- Cache key is the normalized address or Zillow URL. Shared across all users
-- (no user_id) — Zillow data isn't user-specific, and reusing cache across
-- accounts saves Apify credits.
create table if not exists public.property_cache (
  cache_key     text primary key,
  normalized    jsonb not null,
  raw           jsonb,
  fetched_at    timestamptz not null default now()
);

create index if not exists property_cache_fetched_idx on public.property_cache(fetched_at);

alter table public.property_cache enable row level security;

-- Anyone signed in can read; writes happen server-side via the service role
-- key (which bypasses RLS), so no insert/update policy is needed here.
drop policy if exists "property_cache_read" on public.property_cache;
create policy "property_cache_read" on public.property_cache
  for select
  using (auth.uid() is not null);

-- ----------------------------------------------------------------------------
-- 8. property_tax_cache  (general multi-county purchase-estimate cache)
-- ----------------------------------------------------------------------------
create table if not exists public.property_tax_cache (
  id                           serial primary key,
  county                       text not null,
  address_normalized           text not null,
  address_display              text not null,
  parcel_id                    text,
  folio                        text,
  tax_district                 text,
  homestead_ad_valorem_pct     text not null,
  non_homestead_ad_valorem_pct text not null,
  sample_price                 integer not null default 0,
  total_millage                text,
  -- Exact arbitrary-price Florida formula inputs. Millage is mills per
  -- $1,000 of assessed value; exemptions are dollar amounts.
  school_millage               numeric,
  non_school_millage           numeric,
  assessment_ratio             numeric,
  homestead_school_exemption   numeric,
  homestead_non_school_exemption numeric,
  parcel_source                text,
  rate_year                    integer,
  non_ad_valorem_amt_cents     integer not null default 0,
  non_ad_valorem_lines         jsonb not null default '[]'::jsonb,
  source                       text not null,
  queried_at                   timestamptz not null default now(),
  expires_at                   timestamptz not null,
  constraint ptc_county_address_unique unique (county, address_normalized)
);

create index if not exists property_tax_cache_county_addr_idx
  on public.property_tax_cache (county, address_normalized);

create index if not exists property_tax_cache_expires_idx
  on public.property_tax_cache (expires_at);

-- CREATE TABLE IF NOT EXISTS does not add columns to a prior deployment.
alter table public.property_tax_cache
  add column if not exists school_millage numeric,
  add column if not exists non_school_millage numeric,
  add column if not exists assessment_ratio numeric,
  add column if not exists homestead_school_exemption numeric,
  add column if not exists homestead_non_school_exemption numeric,
  add column if not exists parcel_source text,
  add column if not exists rate_year integer;

alter table public.property_tax_cache enable row level security;
-- This shared cache is read/written only by trusted server code using the
-- service role (which bypasses RLS). No client policy is intentionally granted.

-- ----------------------------------------------------------------------------
-- 10. current_tax_bills  (actual annual owner bills, not purchase estimates)
-- ----------------------------------------------------------------------------
create table if not exists public.current_tax_bills (
  id                       serial primary key,
  county                   text not null,
  parcel_id                text,
  address_normalized       text not null,
  address_display          text not null,
  tax_year                 integer not null,
  annual_tax_cents         integer not null,
  ad_valorem_tax_cents     integer,
  non_ad_valorem_tax_cents integer,
  source                   text not null,
  entered_by_user_id       uuid,
  notes                    text,
  queried_at               timestamptz not null default now(),
  expires_at               timestamptz not null,
  constraint ctb_county_parcel_unique unique (county, parcel_id)
);

-- A manually supplied bill has no reliable parcel ID, so normalized address
-- plus year is its durable key. Parcel-backed rows keep the table constraint.
create unique index if not exists current_tax_bills_addr_year_unique_idx
  on public.current_tax_bills (county, address_normalized, tax_year)
  where parcel_id is null;

create unique index if not exists current_tax_bills_county_parcel_unique_idx
  on public.current_tax_bills (county, parcel_id);

create index if not exists current_tax_bills_expires_idx
  on public.current_tax_bills (expires_at);

alter table public.current_tax_bills enable row level security;

-- ----------------------------------------------------------------------------
-- 11. parcel_identity_cache  (durable address -> county parcel identity)
-- ----------------------------------------------------------------------------
create table if not exists public.parcel_identity_cache (
  id                 serial primary key,
  county             text not null,
  address_normalized text not null,
  address_display    text not null,
  parcel_id          text not null,
  folio              text,
  tax_district       text,
  situs_address      text,
  situs_city         text,
  just_value         numeric,
  assessed_value     numeric,
  source             text not null,
  queried_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  unique (county, address_normalized)
);

create index if not exists parcel_identity_cache_addr_idx
  on public.parcel_identity_cache (county, address_normalized);

alter table public.parcel_identity_cache enable row level security;

-- ----------------------------------------------------------------------------
-- 12. property_characteristics_cache / citizens_property_data
-- ----------------------------------------------------------------------------
-- Shared server-managed property facts. The characteristics cache expires
-- yearly; Citizens entries are a durable manual context record. RLS remains
-- enabled with no client policy: trusted server code uses the service role.
create table if not exists public.property_characteristics_cache (
  id serial primary key, address_normalized text not null unique,
  address_display text not null, county text, parcel_id text,
  latitude numeric, longitude numeric, flood_zone text, flood_zone_subtype text,
  static_bfe numeric, sfha boolean, year_built integer, year_built_effective integer,
  square_feet_living integer, square_feet_total integer, stories numeric,
  living_units integer, building_count integer, has_pool boolean,
  exterior_wall_code text, exterior_wall_label text, construction_code text,
  construction_label text, building_data_source text, flood_data_source text,
  design_wind_speed integer, windborne_debris_region boolean,
  miles_to_coast numeric, wind_data_source text, coast_data_source text,
  queried_at timestamptz not null default now(), expires_at timestamptz not null
);
create index if not exists property_characteristics_addr_idx
  on public.property_characteristics_cache (address_normalized);
alter table public.property_characteristics_cache enable row level security;

create table if not exists public.citizens_property_data (
  id serial primary key, address_normalized text not null unique,
  address_display text not null, county text, bceg text, protection_class text,
  personal_multiperil_territory text, wind_only_eligible boolean,
  wind_only_territory text, wind_borne_debris text, terrain text, flood_zone text,
  fema_flood_zone_mismatch boolean default false, entered_by text,
  entered_at timestamptz not null default now(),
  source text not null default 'citizens-manual-entry'
);
create index if not exists citizens_property_data_addr_idx
  on public.citizens_property_data (address_normalized);
alter table public.citizens_property_data enable row level security;

-- ----------------------------------------------------------------------------
-- Server-managed records migrated from DATABASE_URL
-- ----------------------------------------------------------------------------
-- Purpose-built names avoid the incompatible user-facing submissions and
-- questionnaire tables above. RLS has no browser policies: service role only.
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
  credit_score_consent_at timestamptz, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.private_insurance_properties (
  user_id text not null, address_normalized text not null,
  current_policy_expiration_date date, quote_cache_scope text not null default 'unused',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(user_id,address_normalized)
);
create table if not exists public.insurance_quote_cache (
  id bigserial primary key, address_normalized text not null, address_display text not null,
  lead_id integer, status text not null default 'pending', quotes jsonb default '[]',
  quote_counter integer default 0,
  quote_poll_attempts integer not null default 0,
  quote_stable_polls integer not null default 0,
  quote_previous_counter integer,
  quote_poll_claimed_at timestamptz,
  quote_poll_lease_until timestamptz,
  coverage_a integer default 0,
  policy_type text not null default 'HO3', cache_scope text not null default 'shared',
  property_data_snapshot jsonb default '{}', property_data_provenance jsonb default '{}',
  agency_default_snapshot jsonb default '{}', consumer_property_answers jsonb default '{}',
  quote_profile_version text not null default 'legacy-v1',
  raw_quoterush_property_data jsonb, raw_quoterush_property_data_source text,
  raw_quoterush_property_data_fetched_at timestamptz,
  raw_quoterush_property_data_expires_at timestamptz,
  assumptions jsonb default '[]', triggered_at timestamptz not null default now(),
  completed_at timestamptz, expires_at timestamptz not null,
  email_recipient text, email_user_id text,
  email_delivery_status text not null default 'pending',
  email_claimed_at timestamptz, email_first_attempt_at timestamptz,
  email_retry_count integer not null default 0,
  email_quarantine_at timestamptz, email_sent_at timestamptz,
  email_error text,
  unique(address_normalized,policy_type)
);
create index if not exists insurance_quote_cache_expires_at_idx on public.insurance_quote_cache(expires_at);
create index if not exists insurance_quote_cache_pending_poll_idx
  on public.insurance_quote_cache(status, triggered_at)
  where status = 'pending';
-- CREATE TABLE IF NOT EXISTS does not add columns to an existing deployment.
alter table public.insurance_quote_cache
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
-- Existing completed rows have no recipient and must not be picked up by the
-- server-owned result-email worker after this schema is applied.
update public.insurance_quote_cache
set email_delivery_status = 'skipped',
    email_error = 'legacy row has no result-email recipient'
where status = 'success'
  and email_delivery_status = 'pending'
  and email_recipient is null;
create table if not exists public.non_ad_valorem_cache (
  id bigserial primary key, folio text not null unique, account_number text,
  bill_year integer, status text not null default 'pending', lines jsonb default '[]',
  total_non_ad_valorem integer default 0, total_ad_valorem_cents integer,
  total_millage integer, ad_valorem_mills jsonb,
  fetched_at timestamptz not null default now(), expires_at timestamptz not null
);
create table if not exists public.ifw_activity_claims (
  dedupe_key text primary key, user_id text not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null
);
create index if not exists ifw_activity_claims_user_created_at_idx
  on public.ifw_activity_claims(user_id,created_at);
create index if not exists ifw_activity_claims_expires_at_idx
  on public.ifw_activity_claims(expires_at);
do $$ declare t text; begin foreach t in array array[
  'managed_users','managed_services','managed_submissions',
  'managed_integration_requests','managed_questionnaire_responses',
  'user_subscriptions','private_user_profiles','private_insurance_properties',
  'insurance_quote_cache','non_ad_valorem_cache','ifw_activity_claims'
] loop execute format('alter table public.%I enable row level security',t); end loop; end $$;

-- Transactional server-only RPCs (also in the dated migration).
create or replace function public.claim_ifw_activity(p_user_id text,p_dedupe_key text,p_now timestamptz,p_window_ms bigint,p_max_per_window integer)
returns text language plpgsql security definer set search_path=public as $$
declare n integer; begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id,0));
  delete from ifw_activity_claims where user_id=p_user_id and expires_at<=p_now;
  if exists(select 1 from ifw_activity_claims where dedupe_key=p_dedupe_key and expires_at>p_now) then return 'duplicate'; end if;
  select count(*) into n from ifw_activity_claims where user_id=p_user_id and created_at>p_now-(p_window_ms*interval '1 millisecond');
  if n>=p_max_per_window then return 'rate_limited'; end if;
  insert into ifw_activity_claims(dedupe_key,user_id,created_at,expires_at) values(p_dedupe_key,p_user_id,p_now,p_now+(p_window_ms*interval '1 millisecond'));
  return 'claimed'; end $$;
create or replace function public.cleanup_ifw_activity_claims(p_now timestamptz,p_batch_size integer)
returns integer language plpgsql security definer set search_path=public as $$
declare n integer; begin with d as (delete from ifw_activity_claims where ctid in (select ctid from ifw_activity_claims where expires_at<=p_now order by expires_at for update skip locked limit p_batch_size) returning 1) select count(*) into n from d; return n; end $$;
create or replace function public.claim_insurance_quote_cache(p_address_normalized text,p_policy_type text,p_values jsonb,p_now timestamptz)
returns table(claimed boolean,row_id bigint) language plpgsql security definer set search_path=public as $$
begin
  insert into insurance_quote_cache(id,address_normalized,address_display,lead_id,status,quotes,quote_counter,quote_poll_attempts,quote_stable_polls,quote_previous_counter,quote_poll_claimed_at,quote_poll_lease_until,coverage_a,policy_type,cache_scope,property_data_snapshot,property_data_provenance,agency_default_snapshot,consumer_property_answers,quote_profile_version,assumptions,triggered_at,completed_at,expires_at,email_recipient,email_user_id,email_delivery_status,email_claimed_at,email_first_attempt_at,email_retry_count,email_quarantine_at,email_sent_at,email_error)
  -- Allocate speculative insert ids; ON CONFLICT preserves the existing id.
  -- Reusing p_values.id can race on the primary key before composite conflict handling.
  values(nextval(pg_get_serial_sequence('insurance_quote_cache','id')),p_address_normalized,p_values->>'address_display',nullif(p_values->>'lead_id','')::integer,coalesce(p_values->>'status','pending'),coalesce(p_values->'quotes','[]'::jsonb),coalesce((p_values->>'quote_counter')::integer,0),coalesce((p_values->>'quote_poll_attempts')::integer,0),coalesce((p_values->>'quote_stable_polls')::integer,0),(p_values->>'quote_previous_counter')::integer,(p_values->>'quote_poll_claimed_at')::timestamptz,(p_values->>'quote_poll_lease_until')::timestamptz,coalesce((p_values->>'coverage_a')::integer,0),p_policy_type,coalesce(p_values->>'cache_scope','shared'),coalesce(p_values->'property_data_snapshot','{}'::jsonb),coalesce(p_values->'property_data_provenance','{}'::jsonb),coalesce(p_values->'agency_default_snapshot','{}'::jsonb),coalesce(p_values->'consumer_property_answers','{}'::jsonb),coalesce(p_values->>'quote_profile_version','legacy-v1'),coalesce(p_values->'assumptions','[]'::jsonb),coalesce((p_values->>'triggered_at')::timestamptz,p_now),(p_values->>'completed_at')::timestamptz,(p_values->>'expires_at')::timestamptz,p_values->>'email_recipient',p_values->>'email_user_id',coalesce(p_values->>'email_delivery_status','pending'),(p_values->>'email_claimed_at')::timestamptz,(p_values->>'email_first_attempt_at')::timestamptz,coalesce((p_values->>'email_retry_count')::integer,0),(p_values->>'email_quarantine_at')::timestamptz,(p_values->>'email_sent_at')::timestamptz,p_values->>'email_error')
  on conflict(address_normalized,policy_type) do update set
    address_display=excluded.address_display,lead_id=excluded.lead_id,status=excluded.status,quotes=excluded.quotes,quote_counter=excluded.quote_counter,quote_poll_attempts=excluded.quote_poll_attempts,quote_stable_polls=excluded.quote_stable_polls,quote_previous_counter=excluded.quote_previous_counter,quote_poll_claimed_at=excluded.quote_poll_claimed_at,quote_poll_lease_until=excluded.quote_poll_lease_until,coverage_a=excluded.coverage_a,cache_scope=excluded.cache_scope,property_data_snapshot=excluded.property_data_snapshot,property_data_provenance=excluded.property_data_provenance,agency_default_snapshot=excluded.agency_default_snapshot,consumer_property_answers=excluded.consumer_property_answers,quote_profile_version=excluded.quote_profile_version,assumptions=excluded.assumptions,triggered_at=greatest(excluded.triggered_at,insurance_quote_cache.triggered_at+interval '1 millisecond'),completed_at=excluded.completed_at,expires_at=excluded.expires_at,email_recipient=excluded.email_recipient,email_user_id=excluded.email_user_id,email_delivery_status=excluded.email_delivery_status,email_claimed_at=excluded.email_claimed_at,email_first_attempt_at=excluded.email_first_attempt_at,email_retry_count=excluded.email_retry_count,email_quarantine_at=excluded.email_quarantine_at,email_sent_at=excluded.email_sent_at,email_error=excluded.email_error
   where insurance_quote_cache.expires_at<=p_now
      or insurance_quote_cache.status in ('error','failed')
  returning true,insurance_quote_cache.id into claimed,row_id;
  if not found then select false,id into claimed,row_id from insurance_quote_cache where address_normalized=p_address_normalized and policy_type=p_policy_type; end if;
  return next;
end $$;
create or replace function public.reseed_managed_migration_sequences()
returns void language plpgsql security definer set search_path=public as $$
declare t text; seq text; n bigint; begin foreach t in array array['managed_users','managed_services','managed_submissions','managed_integration_requests','managed_questionnaire_responses','user_subscriptions','insurance_quote_cache','non_ad_valorem_cache'] loop seq:=pg_get_serial_sequence('public.'||t,'id'); if seq is not null then execute format('select coalesce(max(id),0) from public.%I',t) into n; perform setval(seq,greatest(n,1),n>0); end if; end loop; end $$;
revoke all on function public.claim_ifw_activity(text,text,timestamptz,bigint,integer) from public,anon,authenticated;
revoke all on function public.cleanup_ifw_activity_claims(timestamptz,integer) from public,anon,authenticated;
revoke all on function public.reseed_managed_migration_sequences() from public,anon,authenticated;
revoke all on function public.claim_insurance_quote_cache(text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_ifw_activity(text,text,timestamptz,bigint,integer) to service_role;
grant execute on function public.cleanup_ifw_activity_claims(timestamptz,integer) to service_role;
grant execute on function public.reseed_managed_migration_sequences() to service_role;
grant execute on function public.claim_insurance_quote_cache(text,text,jsonb,timestamptz) to service_role;

-- Forward exact-json-v2 upserts use canonical JSON text for JSON/JSONB
-- columns and reserve an outer JSON null for SQL NULL. Keep these casts
-- explicit: json_populate_record alone cannot preserve JSON null vs SQL NULL.
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

-- The API key is service-role only.  Explicit revocation is retained here so
-- rerunning this idempotent migration cannot inherit a prior broad grant.
revoke all on function public.upsert_managed_migration_rows(text, text, json)
  from public, anon, authenticated;
grant execute on function public.upsert_managed_migration_rows(text, text, json)
  to service_role;

-- Tell PostgREST to reload its schema cache so new tables are visible to the
-- REST API immediately (avoids "Could not find the table" errors).
notify pgrst, 'reload schema';

-- ============================================================================
-- Done. Verify in Supabase Dashboard → Table Editor that all tables exist
-- and that RLS is enabled (lock icon next to each table).
-- ============================================================================
