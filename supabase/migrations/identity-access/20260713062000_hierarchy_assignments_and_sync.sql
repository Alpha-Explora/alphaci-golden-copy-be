-- Migration: 20260713062000_hierarchy_assignments_and_sync
--
-- Purpose: Phase 3 repository-assignment state machine and its GitHub
-- verification/sync bookkeeping (see docs/HIERARCHY_IMPLEMENTATION_PLAN.md
-- §1.6, §3.1 file 3).
--
-- The desired_state x effective_state -> status state machine is enforced
-- by the service layer (HierarchyAccessService / github-sync.service.ts),
-- not by a DB trigger — this keeps the transition logic auditable and
-- testable in plain TypeScript, matching how the rest of this codebase does
-- authorization/state in the service layer rather than in Postgres. This
-- migration only provides the CHECK-constrained columns and the indexes the
-- state machine and its hot-path reads depend on.
--
-- These two tables are LIVE STATE, not audit-log tables — rows are expected
-- to be UPDATEd repeatedly as GitHub sync progresses (retry_count, sync_state,
-- desired_state/effective_state/status transitions). The immutable audit
-- trail for these transitions lives in audit.audit_events via the
-- hierarchy.assignment.* event codes (plan §2.2), not in these tables.
--
-- access_level is constrained to 'write' only — the only level the source
-- plan defines this session (§2.6: "the only level source plan defines;
-- field exists for future extension, not selectable by callers"). Adding a
-- 'read' tier later is a non-breaking CHECK-constraint widening, not a
-- destructive change.
--
-- No FK to identity.app_users on user_id/assigned_by, matching the same
-- reasoning documented in 20260713060000_group_lifecycle.sql and
-- 20260713061000_hierarchy_core.sql.

-- ─── hierarchy.repository_assignments ────────────────────────────────────
-- UNIQUE (repository_id, user_id): one assignment row per user per
-- repository — history is preserved via state transitions on that single
-- row, not by inserting a new row per assignment/removal cycle. This
-- matches the plan's explicit instruction (§3.1 file 3) and the DELETE
-- endpoint semantics in §2.6 ("does not hard-delete the row").
CREATE TABLE IF NOT EXISTS hierarchy.repository_assignments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id   UUID        NOT NULL REFERENCES hierarchy.repositories(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL,
  access_level    TEXT        NOT NULL DEFAULT 'write' CHECK (access_level IN ('write')),
  desired_state   TEXT        NOT NULL DEFAULT 'assigned'
                              CHECK (desired_state IN ('assigned', 'unassigned')),
  effective_state TEXT        NOT NULL DEFAULT 'unknown'
                              CHECK (effective_state IN ('unknown', 'pending', 'active', 'revoking', 'revoked', 'failed')),
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'active', 'revoked', 'failed')),
  assigned_by     UUID        NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repository_id, user_id)
);

-- Hot path: "assignments by repository" — lead assignment list / access-status
-- view (§2.6 GET /repositories/:repositoryId/assignments, /access-status).
CREATE INDEX IF NOT EXISTS idx_repository_assignments_repository_status
  ON hierarchy.repository_assignments (repository_id, status);

-- Hot path: "assignments by user" — GET /me/assigned-repositories.
-- Deliberately widened from the plan's literal `WHERE status = 'active'`
-- suggestion to also cover 'pending': the endpoint this index powers
-- explicitly returns status IN ('active','pending') per §2.6, so a
-- status='active'-only partial index would miss half its own hot path.
CREATE INDEX IF NOT EXISTS idx_repository_assignments_user_active_pending
  ON hierarchy.repository_assignments (user_id)
  WHERE status IN ('active', 'pending');

-- ─── hierarchy.github_access_sync ────────────────────────────────────────
-- One row per assignment (1:1, enforced by the UNIQUE assignment_id FK).
CREATE TABLE IF NOT EXISTS hierarchy.github_access_sync (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id         UUID        NOT NULL UNIQUE
                                    REFERENCES hierarchy.repository_assignments(id) ON DELETE CASCADE,
  github_team_id        TEXT        NULL,
  github_team_slug      TEXT        NULL,
  sync_state            TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (sync_state IN ('pending', 'syncing', 'verified', 'failed', 'drift_detected')),
  verification_result   JSONB       NULL,
  retry_count           INTEGER     NOT NULL DEFAULT 0,
  last_error            TEXT        NULL,
  last_synced_at        TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: admin/lead "failed synchronizations" view (plan §1.6 retry/backoff
-- section, §3.1 file 3's explicit index requirement).
CREATE INDEX IF NOT EXISTS idx_github_access_sync_failed_drift
  ON hierarchy.github_access_sync (sync_state)
  WHERE sync_state IN ('failed', 'drift_detected');

-- ─── RLS: deny-by-default on both new tables ─────────────────────────────
ALTER TABLE hierarchy.repository_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hierarchy.github_access_sync     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON hierarchy.repository_assignments FROM anon, authenticated;
REVOKE ALL ON hierarchy.github_access_sync     FROM anon, authenticated;

COMMENT ON TABLE hierarchy.repository_assignments
  IS 'Member (role wire value: developer) <-> repository grant with a desired_state/effective_state/status state machine (plan §1.6). Status is set explicitly by the service layer, never a DB trigger. RLS deny-by-default.';
COMMENT ON TABLE hierarchy.github_access_sync
  IS 'One row per repository_assignments row: GitHub sync/verification state, retry bookkeeping. No secret/credential values stored here. RLS deny-by-default.';
