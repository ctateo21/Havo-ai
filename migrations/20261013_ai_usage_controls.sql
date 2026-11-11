-- Replit-managed PostgreSQL (DATABASE_URL), NOT Supabase or NEON_DATABASE_URL.
BEGIN;
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  user_id text NOT NULL,
  day date NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('document','market')),
  attempts integer NOT NULL DEFAULT 0,
  successes integer NOT NULL DEFAULT 0,
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  reported_cost_usd numeric NOT NULL DEFAULT 0,
  unknown_cost_attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, purpose)
);
CREATE INDEX IF NOT EXISTS ai_usage_daily_day_idx ON ai_usage_daily(day);
CREATE TABLE IF NOT EXISTS ai_usage_leases (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON ai_usage_daily, ai_usage_leases FROM PUBLIC;
COMMIT;
