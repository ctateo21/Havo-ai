-- PREPARED ONLY: not applied. Managed PostgreSQL, not Supabase.
-- Retains existing rows, grants and legacy uniqueness.
BEGIN;
ALTER TABLE public.insurance_quote_cache
 ADD COLUMN IF NOT EXISTS owner_user_id text,
 ADD COLUMN IF NOT EXISTS answer_hash text,
 ADD COLUMN IF NOT EXISTS run_had_claims boolean,
 ADD COLUMN IF NOT EXISTS callback_token_hash text,
 ADD COLUMN IF NOT EXISTS policy_type text NOT NULL DEFAULT 'HO3',
 ADD COLUMN IF NOT EXISTS cache_scope text NOT NULL DEFAULT 'shared';
CREATE UNIQUE INDEX IF NOT EXISTS insurance_quote_cache_answer_identity_idx
 ON public.insurance_quote_cache(address_normalized,policy_type,cache_scope);
COMMIT;
-- This additive stage alone does not permit multiple answer variants while
-- legacy uniqueness remains. See quote-cache-compatible-upgrade.md.
