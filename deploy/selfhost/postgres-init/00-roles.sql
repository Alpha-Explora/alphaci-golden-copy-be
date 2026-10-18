-- Supabase-compatible roles that the migration tree references.
--
-- The migrations revoke browser-client access with `REVOKE ... FROM anon,
-- authenticated`. Supabase provides both roles; a plain PostgreSQL server does
-- not, and the replay fails on the first such statement. These roles are
-- NOLOGIN, so they cannot connect; they only need to exist so the REVOKE
-- statements can name them.
--
-- Shared by two callers:
--   * the self-hosted Postgres container, via /docker-entrypoint-initdb.d
--   * the migration runner (src/scripts/selfhost-migrations.ts), which runs this
--     file before any migration on every start
--
-- Idempotent: each role is created only when it is missing, so it is a no-op on
-- Supabase and on a database where it already ran.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;
