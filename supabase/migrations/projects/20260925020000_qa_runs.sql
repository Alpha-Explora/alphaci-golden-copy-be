-- QA verification runs and the feedback loop (Slice 3).
--
-- Scope: per-(checklist, branch, commit) verification runs snapshotted from a
-- projects.qa_checklists definition (Slice 2), the ordered run items QA/dev
-- work through, an append-only event history per item, and sign-off records.
--
-- Cross-context note: user id columns (created_by, actor_user_id, signed_by,
-- fix_requested_by, verified_by) are plain UUID with NO foreign key, same
-- pattern as 20260925010000_qa_checklists.sql — scripts/check-schema-ownership.cjs
-- restricts the `projects` context to the `projects` and `workflow` schemas
-- only, so authorization/identity lookups are done in the application layer
-- (QaAccessService / ProjectsRepository), not via a cross-schema FK here.
--
-- Cold-replay note: every constraint is written inline in its CREATE TABLE so
-- a fresh replay can never observe a table without it (see the note in
-- 20260925010000_qa_checklists.sql on why: a later ALTER TABLE ... ADD
-- CONSTRAINT behind CREATE TABLE IF NOT EXISTS has hidden invalid DDL in this
-- repo before).

CREATE TABLE IF NOT EXISTS projects.qa_verification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  checklist_id UUID NOT NULL REFERENCES projects.qa_checklists(id) ON DELETE RESTRICT,
  checklist_version INTEGER NOT NULL,
  checklist_name TEXT NOT NULL,
  branch TEXT NOT NULL CONSTRAINT qa_verification_runs_branch_length_chk CHECK (char_length(branch) BETWEEN 1 AND 255),
  -- A short (SHA-1, 40 hex chars) or long (SHA-256, 64 hex chars) commit hash.
  -- GitHub itself is still SHA-1-only today; the 64-char branch is accepted so
  -- this constraint does not need a migration the day GitHub moves.
  commit_sha TEXT NOT NULL
    CONSTRAINT qa_verification_runs_commit_sha_chk
    CHECK (commit_sha ~ '^[0-9a-f]{40}$' OR commit_sha ~ '^[0-9a-f]{64}$'),
  commit_source TEXT NOT NULL
    CONSTRAINT qa_verification_runs_commit_source_chk CHECK (commit_source IN ('deployment', 'branch_head')),
  status TEXT NOT NULL DEFAULT 'open'
    CONSTRAINT qa_verification_runs_status_chk CHECK (status IN ('open', 'signed_off')),
  created_by UUID NOT NULL,
  created_by_login TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The idempotency key POST create relies on: INSERT ... ON CONFLICT DO
  -- NOTHING then SELECT, so a concurrent double-create of the same
  -- (checklist, branch, commit) always converges on one row.
  CONSTRAINT uq_qa_verification_runs_project_checklist_branch_commit
    UNIQUE (project_id, checklist_id, branch, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_qa_verification_runs_project_branch
  ON projects.qa_verification_runs (project_id, branch, created_at DESC);

COMMENT ON TABLE projects.qa_verification_runs
  IS 'A QA pass of one checklist against one (branch, commit) of a project. checklist_version/checklist_name are a frozen label; the actual items are snapshotted into qa_run_items.';

CREATE TABLE IF NOT EXISTS projects.qa_run_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES projects.qa_verification_runs(id) ON DELETE CASCADE,
  -- The checklist item this was snapshotted from. SET NULL (not RESTRICT) so
  -- a later checklist edit (Slice 2's replaceItems deletes and re-inserts
  -- qa_checklist_items) can never be blocked by a historical run holding a
  -- reference to it.
  source_item_id UUID NULL REFERENCES projects.qa_checklist_items(id) ON DELETE SET NULL,
  -- The same source item's row in the newest earlier run of this (project,
  -- checklist, branch) — how QaRunItem.previous is resolved. Self-referencing
  -- FK is safe here: the table is fully defined by the time this constraint
  -- is evaluated, which is standard for a same-table reference in Postgres.
  prior_run_item_id UUID NULL REFERENCES projects.qa_run_items(id) ON DELETE SET NULL,
  -- Snapshot columns: same shape and CHECKs as qa_checklist_items, frozen at
  -- run-creation time so editing the checklist afterward never rewrites a
  -- run already in progress.
  "position" INTEGER NOT NULL CONSTRAINT qa_run_items_position_chk CHECK ("position" >= 0),
  title TEXT NOT NULL CONSTRAINT qa_run_items_title_length_chk CHECK (char_length(title) BETWEEN 1 AND 300),
  description TEXT NULL,
  target_persona TEXT NOT NULL
    CONSTRAINT qa_run_items_target_persona_chk CHECK (target_persona IN ('developer', 'qa', 'all')),
  verification_type TEXT NOT NULL
    CONSTRAINT qa_run_items_verification_type_chk CHECK (verification_type IN ('manual', 'playwright', 'unit_test', 'bruno')),
  test_identifier TEXT NULL CONSTRAINT qa_run_items_test_identifier_length_chk CHECK (char_length(test_identifier) <= 500),
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT qa_run_items_status_chk
    CHECK (status IN ('pending', 'in_progress', 'passed', 'failed', 'blocked', 'returned_to_dev')),
  notes TEXT NULL,
  defect_severity TEXT NULL
    CONSTRAINT qa_run_items_defect_severity_chk CHECK (defect_severity IN ('blocker', 'major', 'minor')),
  reproduction_steps TEXT NULL,
  fix_requested_at TIMESTAMPTZ NULL,
  fix_requested_by UUID NULL,
  fix_requested_by_login TEXT NULL,
  fix_note TEXT NULL,
  verified_by UUID NULL,
  verified_by_login TEXT NULL,
  verified_at TIMESTAMPTZ NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A failed or returned-to-dev item must carry a reason. 'blocked' is
  -- deliberately excluded: a blocker can exist with no QA verdict yet (e.g.
  -- an environment outage), so it is not forced to have one.
  CONSTRAINT qa_run_items_severity_required_chk
    CHECK (status NOT IN ('failed', 'returned_to_dev') OR defect_severity IS NOT NULL),
  -- A verifier is set if and only if the item has left the not-yet-verified
  -- states. Keeps QaChecklistsService/QaRunsService's "clear on
  -- pending/in_progress, set on everything else" rule enforced at the data
  -- layer too, not just in application code.
  CONSTRAINT qa_run_items_verifier_presence_chk
    CHECK ((status IN ('pending', 'in_progress')) = (verified_by IS NULL)),
  CONSTRAINT uq_qa_run_items_run_position UNIQUE (run_id, "position")
);

CREATE INDEX IF NOT EXISTS idx_qa_run_items_run_status
  ON projects.qa_run_items (run_id, status);

COMMENT ON TABLE projects.qa_run_items
  IS 'One checklist item as tested within a specific run. Snapshotted at run creation; prior_run_item_id chains it to the same source checklist item in the previous run of this (project, checklist, branch), when one exists.';

CREATE TABLE IF NOT EXISTS projects.qa_run_item_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_item_id UUID NOT NULL REFERENCES projects.qa_run_items(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES projects.qa_verification_runs(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  actor_login TEXT NOT NULL,
  event_type TEXT NOT NULL
    CONSTRAINT qa_run_item_events_event_type_chk CHECK (event_type IN ('status_changed', 'fix_requested', 'edited')),
  from_status TEXT NULL
    CONSTRAINT qa_run_item_events_from_status_chk
    CHECK (from_status IN ('pending', 'in_progress', 'passed', 'failed', 'blocked', 'returned_to_dev')),
  to_status TEXT NULL
    CONSTRAINT qa_run_item_events_to_status_chk
    CHECK (to_status IN ('pending', 'in_progress', 'passed', 'failed', 'blocked', 'returned_to_dev')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_run_item_events_item_created
  ON projects.qa_run_item_events (run_item_id, created_at);

COMMENT ON TABLE projects.qa_run_item_events
  IS 'Append-only audit trail per run item: every status transition, fix request, and field edit. Never updated or deleted once written.';

CREATE TABLE IF NOT EXISTS projects.qa_run_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES projects.qa_verification_runs(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL
    CONSTRAINT qa_run_signoffs_verdict_chk CHECK (verdict IN ('APPROVED', 'REJECTED', 'CONDITIONAL')),
  summary TEXT NULL,
  conditions TEXT NULL,
  CONSTRAINT qa_run_signoffs_conditional_requires_conditions_chk
    CHECK (verdict <> 'CONDITIONAL' OR length(btrim(coalesce(conditions, ''))) > 0),
  signed_by UUID NOT NULL,
  signed_by_login TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A frozen copy of the QaRun response (status already 'signed_off') at the
  -- moment of sign-off, for the export slice — so a later checklist/run edit
  -- can never retroactively change what a signed-off report says.
  report_json JSONB NOT NULL,
  superseded_at TIMESTAMPTZ NULL,
  superseded_by UUID NULL
);

-- Only one ACTIVE (non-superseded) signoff per run — enforces "reopen before
-- you can sign off again" at the data layer, not just in application code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_run_signoffs_run_active
  ON projects.qa_run_signoffs (run_id)
  WHERE superseded_at IS NULL;

COMMENT ON TABLE projects.qa_run_signoffs
  IS 'Sign-off history for a run. At most one row per run has superseded_at IS NULL (the active signoff); reopen() supersedes it rather than deleting it, preserving the full sign-off/reopen history.';

ALTER TABLE projects.qa_verification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.qa_run_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.qa_run_item_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.qa_run_signoffs      ENABLE ROW LEVEL SECURITY;

-- Defense in depth: the backend connects with SUPABASE_SERVICE_ROLE_KEY
-- (BYPASSRLS), so RLS with no permissive policy already blocks anon /
-- authenticated; this closes the exposure even if RLS is ever toggled off.
REVOKE ALL ON projects.qa_verification_runs FROM anon, authenticated;
REVOKE ALL ON projects.qa_run_items         FROM anon, authenticated;
REVOKE ALL ON projects.qa_run_item_events   FROM anon, authenticated;
REVOKE ALL ON projects.qa_run_signoffs      FROM anon, authenticated;
