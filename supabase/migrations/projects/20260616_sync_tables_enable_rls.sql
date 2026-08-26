-- Enable Row Level Security on the project sync tables.
--
-- Why: both tables were created without RLS, so the public Supabase keys
-- (anon / authenticated) could read and write every user's sync rows directly,
-- bypassing the NestJS authorization layer. This is the same exposure class as
-- the documented ci_run_reports issue.
--
-- Approach: deny-by-default. The backend connects with SUPABASE_SERVICE_ROLE_KEY
-- (see src/supabase/supabase.service.ts), and the service_role has the BYPASSRLS
-- attribute, so enabling RLS WITHOUT any permissive policy leaves the backend
-- unaffected while fully blocking the anon / authenticated roles. No end user
-- ever connects to Postgres directly — all access is mediated by the API's
-- SessionAuthGuard + workspace-membership checks — so no auth.uid()-based owner
-- policy is required (this app uses its own session cookies, not Supabase Auth,
-- so auth.uid() is always NULL here).

ALTER TABLE projects.project_dashboard_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.project_sync_findings        ENABLE ROW LEVEL SECURITY;

-- Defense in depth: explicitly strip any table-level grants the public roles may
-- have inherited. RLS already blocks them, but removing the grants closes the
-- exposure even if RLS is ever toggled off again.
REVOKE ALL ON projects.project_dashboard_snapshots FROM anon, authenticated;
REVOKE ALL ON projects.project_sync_findings        FROM anon, authenticated;

COMMENT ON TABLE projects.project_dashboard_snapshots
  IS 'RLS enabled (deny-by-default). Reachable only via the backend service-role client; anon/authenticated are blocked. Authorization is enforced in the API layer.';
COMMENT ON TABLE projects.project_sync_findings
  IS 'RLS enabled (deny-by-default). Reachable only via the backend service-role client; anon/authenticated are blocked. Authorization is enforced in the API layer.';
