-- Migration: 20260713120000_enable_rls_auth_session_handoffs
--
-- Purpose: close the RLS gap flagged by the Supabase security advisor.
-- identity.auth_session_handoffs was created with RLS DISABLED, leaving it
-- fully readable/writable by the anon and authenticated Supabase roles.
-- Every other identity.* table in this codebase is deny-by-default with RLS
-- enabled since 20260617_enable_rls_exposed_tables.sql; this brings the
-- handoff table in line.
--
-- Zero API impact: the backend reaches this table only through the
-- service-role connection, which has BYPASSRLS. Enabling RLS with no
-- permissive policy blocks anon/authenticated (the intended posture) while
-- leaving the service-role path untouched.
ALTER TABLE identity.auth_session_handoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.auth_session_handoffs FROM anon, authenticated;
