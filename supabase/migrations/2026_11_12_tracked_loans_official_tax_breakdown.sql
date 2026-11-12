ALTER TABLE public.tracked_loans
  ADD COLUMN IF NOT EXISTS annual_property_tax_breakdown jsonb;
