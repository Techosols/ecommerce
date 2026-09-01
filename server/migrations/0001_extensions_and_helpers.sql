-- 0001_extensions_and_helpers.sql
-- Phase 0. Extensions and the shared helpers every later migration relies on.
-- Forward-only. Never edit a migration that has been applied (§4.4).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email/slug/code columns

-- Maintains updated_at on any table that attaches the trigger (§4.1 rule 6).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'BEFORE UPDATE trigger function; keeps updated_at accurate without application help.';
