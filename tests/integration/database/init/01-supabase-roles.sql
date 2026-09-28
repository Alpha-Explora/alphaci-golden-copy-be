-- The migrations revoke browser-client access using the standard Supabase
-- roles. Plain PostgreSQL fixtures need these role names to exercise that SQL.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
