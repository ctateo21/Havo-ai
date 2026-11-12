-- Preserve legacy rows for audit; the official pipeline never reads their rates.
alter table public.property_tax_cache
  add column if not exists tax_year integer,
  add column if not exists mills_school numeric,
  add column if not exists mills_non_school numeric,
  add column if not exists mills_total numeric,
  add column if not exists exemption_schedule jsonb,
  add column if not exists nav_lines jsonb,
  add column if not exists nav_total numeric,
  add column if not exists bill_ad_valorem_total numeric,
  add column if not exists bill_combined_total numeric,
  add column if not exists bill_url text,
  add column if not exists estimator_url text,
  add column if not exists bill_source text,
  add column if not exists raw_snapshot text,
  add column if not exists bill_queried_at timestamptz,
  add column if not exists estimator_queried_at timestamptz,
  add column if not exists estimator_source text,
  add column if not exists assessment_ratio numeric;
-- New rows are parcel/year keyed, not address/price keyed. NULL legacy fields
-- also leave the old address uniqueness constraints intact for old readers.
alter table public.property_tax_cache alter column address_normalized drop not null;
alter table public.property_tax_cache alter column address_display drop not null;
alter table public.property_tax_cache alter column sample_price drop not null;
create unique index if not exists property_tax_cache_parcel_year
  on public.property_tax_cache(county,parcel_id,tax_year);
alter table public.property_tax_cache enable row level security;
revoke all on public.property_tax_cache from anon, authenticated;
grant all on public.property_tax_cache to service_role;
notify pgrst, 'reload schema';
