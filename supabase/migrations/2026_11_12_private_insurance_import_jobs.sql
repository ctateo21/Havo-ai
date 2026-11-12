-- REVIEW ONLY: requires Christian's approval before applying.
BEGIN;
CREATE TABLE public.insurance_quote_import_jobs (
 cache_id bigint PRIMARY KEY, generation timestamptz NOT NULL, owner_user_id text NOT NULL,
 params jsonb NOT NULL, callback_token text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','submitted','manual-review')),
 claimed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.insurance_quote_import_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.insurance_quote_import_jobs FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.insurance_quote_import_jobs TO service_role;
COMMENT ON TABLE public.insurance_quote_import_jobs IS 'Private durable import outbox. Never expose, log or mirror to browsers. DOB is loaded from private profile at execution, never persisted here. Ambiguous imports require manual reconciliation, never reimport.';
COMMIT;
