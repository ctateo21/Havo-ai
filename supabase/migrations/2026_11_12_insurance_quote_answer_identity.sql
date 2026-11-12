-- REVIEW ONLY. Apply to the active source and target databases only after approval.
BEGIN;
ALTER TABLE public.insurance_quote_cache
 ADD COLUMN owner_user_id text,
 ADD COLUMN answer_hash text,
 ADD COLUMN run_had_claims boolean,
 ADD COLUMN callback_token_hash text;
ALTER TABLE public.insurance_quote_cache DROP CONSTRAINT IF EXISTS insurance_quote_cache_address_policy_unique;
ALTER TABLE public.insurance_quote_cache ADD CONSTRAINT insurance_quote_cache_address_policy_scope_unique
 UNIQUE(address_normalized,policy_type,cache_scope);
-- Preserve the installed atomic RPC's existing generation and delivery semantics.
DO $$
DECLARE definition text;
BEGIN
 IF to_regprocedure('public.claim_insurance_quote_cache(text,text,jsonb,timestamptz)') IS NOT NULL THEN
  definition:=pg_get_functiondef('public.claim_insurance_quote_cache(text,text,jsonb,timestamptz)'::regprocedure);
  IF position('email_sent_at,email_error' in definition)=0 OR position('on conflict(address_normalized,policy_type)' in definition)=0 THEN
   RAISE EXCEPTION 'Unexpected quote claim RPC definition; review migration before proceeding';
  END IF;
  definition:=replace(definition,'email_sent_at,email_error','email_sent_at,email_error,owner_user_id,answer_hash,run_had_claims,callback_token_hash');
  definition:=replace(definition,'p_values->>''email_error''','p_values->>''email_error'', p_values->>''owner_user_id'', p_values->>''answer_hash'', (p_values->>''run_had_claims'')::boolean, p_values->>''callback_token_hash''');
  definition:=replace(definition,'on conflict(address_normalized,policy_type)','on conflict(address_normalized,policy_type,cache_scope)');
  definition:=replace(definition,'email_error=excluded.email_error','email_error=excluded.email_error, owner_user_id=excluded.owner_user_id, answer_hash=excluded.answer_hash, run_had_claims=excluded.run_had_claims, callback_token_hash=excluded.callback_token_hash');
  definition:=replace(definition,'and policy_type=p_policy_type;','and policy_type=p_policy_type and cache_scope=p_values->>''cache_scope'';');
  EXECUTE definition;
 END IF;
END $$;
COMMIT;
