-- Migration: 20260713063000_hierarchy_config_broker
--
-- Purpose: Audited metadata for the member-facing, write-only repository
-- configuration broker (variables + non-production secrets) — see
-- docs/HIERARCHY_IMPLEMENTATION_PLAN.md §1.8, §3.1 file 4, §2.2.
--
-- SECURITY-CRITICAL PROPERTY (verify this explicitly in review, this is the
-- literal db-lead acceptance check and the ciso checklist item 4 in the
-- plan): this table has NO column of any kind — plaintext, encrypted,
-- hashed, or otherwise — capable of holding a secret/variable VALUE. It
-- only ever records the variable NAME and the outcome of a write. The
-- actual value is received by the API, sealed with libsodium, sent directly
-- to GitHub's Secrets/Variables API by the backend, and never persisted by
-- AlphaCI anywhere. Do not add a value/payload/encrypted_value column to
-- this table without an explicit ciso sign-off (plan §3.2 "design deviation
-- requiring ciso sign-off").
--
-- This table IS an append-only audit log (unlike repository_assignments/
-- github_access_sync in the previous migration, which are live state). Each
-- row is a complete record of one write/delete attempt and its outcome —
-- the service layer must only ever INSERT into this table, never UPDATE or
-- DELETE a row. Enforced here by omission: RLS is deny-by-default with zero
-- policies of any kind (no SELECT/INSERT/UPDATE/DELETE policy exists for
-- anon/authenticated), and no UPDATE/DELETE policy should ever be added.
-- The backend's service-role connection bypasses RLS by design (same as
-- every other table in this codebase) — append-only-ness for the
-- service-role path is an application-layer discipline, not a DB-level
-- lock, consistent with how this codebase enforces authorization in the
-- service layer rather than in Postgres.
--
-- No FK to identity.app_users on requested_by, matching the reasoning in
-- 20260713060000_group_lifecycle.sql and 20260713061000_hierarchy_core.sql.

CREATE TABLE IF NOT EXISTS hierarchy.repository_configuration_changes (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id      UUID        NOT NULL REFERENCES hierarchy.repositories(id) ON DELETE CASCADE,
  requested_by       UUID        NULL,
  configuration_type TEXT        NOT NULL CHECK (configuration_type IN ('variable', 'secret')),
  action             TEXT        NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  variable_name      TEXT        NOT NULL,
  environment_scope  TEXT        NOT NULL CHECK (environment_scope IN ('non_production', 'production')),
  approval_state     TEXT        NOT NULL DEFAULT 'not_required'
                                 CHECK (approval_state IN ('not_required', 'pending', 'approved', 'rejected')),
  github_sync_state  TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (github_sync_state IN ('pending', 'synced', 'failed')),
  github_error       TEXT        NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "audit events by group+created_at" for the configuration slice
-- of the lead activity feed (§2.8) — joined from audit.audit_events by
-- metadata.repositoryId in the service layer, but this index covers the
-- direct GET /repositories/:repositoryId/configuration history read too.
CREATE INDEX IF NOT EXISTS idx_repository_configuration_changes_repository_created
  ON hierarchy.repository_configuration_changes (repository_id, created_at DESC);

ALTER TABLE hierarchy.repository_configuration_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hierarchy.repository_configuration_changes FROM anon, authenticated;

COMMENT ON TABLE hierarchy.repository_configuration_changes
  IS 'Append-only audit metadata for repository variable/secret writes. Structurally incapable of storing a value (name + outcome only). Service layer must only INSERT, never UPDATE/DELETE. RLS deny-by-default.';
