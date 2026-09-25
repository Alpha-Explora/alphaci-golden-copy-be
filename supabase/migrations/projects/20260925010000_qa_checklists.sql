-- QA checklist definitions and per-project sharing (Slice 2).
--
-- Scope: checklist definitions, their ordered items, and which projects a
-- workspace has shared a checklist to. Per-branch verification runs are a
-- later slice and are intentionally not part of this table set.
--
-- Cross-context note: workspace_id (orgs.workspaces) and the *_by / created_by
-- user columns (identity.app_users) are plain UUID columns with NO foreign
-- key. scripts/check-schema-ownership.cjs restricts the `projects` context to
-- the `projects` and `workflow` schemas only, and refuses new cross-context
-- allow-list entries — so authorization against those tables is done in the
-- application layer (QaAccessService, built on ProjectsRepository), the same
-- pattern projects.provisioned_projects.workspace_id already uses.
--
-- Cold-replay note: every constraint is written inline in its CREATE TABLE so
-- a fresh replay can never observe the table without it (a later
-- ALTER TABLE ... ADD CONSTRAINT has hidden invalid DDL behind
-- CREATE TABLE IF NOT EXISTS in this repo before).

CREATE TABLE IF NOT EXISTS projects.qa_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL CONSTRAINT qa_checklists_name_length_chk CHECK (char_length(name) BETWEEN 1 AND 200),
  description TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  archived_at TIMESTAMPTZ NULL,
  created_by UUID NOT NULL,
  updated_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial + functional, so it cannot be an inline table constraint: enforces
-- one active (non-archived) checklist per case-insensitive name per
-- workspace, while letting an archived checklist's name be reused.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_checklists_workspace_name_active
  ON projects.qa_checklists (workspace_id, lower(name))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_qa_checklists_workspace
  ON projects.qa_checklists (workspace_id, created_at DESC);

COMMENT ON TABLE projects.qa_checklists
  IS 'QA checklist definitions, created at workspace (team) scope by a lead/admin. Sharing to projects is recorded in qa_checklist_projects.';

CREATE TABLE IF NOT EXISTS projects.qa_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id UUID NOT NULL REFERENCES projects.qa_checklists(id) ON DELETE CASCADE,
  "position" INTEGER NOT NULL CONSTRAINT qa_checklist_items_position_chk CHECK ("position" >= 0),
  title TEXT NOT NULL CONSTRAINT qa_checklist_items_title_length_chk CHECK (char_length(title) BETWEEN 1 AND 300),
  description TEXT NULL,
  target_persona TEXT NOT NULL DEFAULT 'all'
    CONSTRAINT qa_checklist_items_target_persona_chk CHECK (target_persona IN ('developer', 'qa', 'all')),
  verification_type TEXT NOT NULL DEFAULT 'manual'
    CONSTRAINT qa_checklist_items_verification_type_chk CHECK (verification_type IN ('manual', 'playwright', 'unit_test', 'bruno')),
  test_identifier TEXT NULL CONSTRAINT qa_checklist_items_test_identifier_length_chk CHECK (char_length(test_identifier) <= 500),
  CONSTRAINT uq_qa_checklist_items_checklist_position UNIQUE (checklist_id, "position") DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_qa_checklist_items_checklist
  ON projects.qa_checklist_items (checklist_id, "position");

COMMENT ON TABLE projects.qa_checklist_items
  IS 'Ordered items belonging to a qa_checklists row. position is DEFERRABLE so a whole-list reorder can run as one transaction of paired UPDATEs without a transient unique violation.';

CREATE TABLE IF NOT EXISTS projects.qa_checklist_projects (
  checklist_id UUID NOT NULL REFERENCES projects.qa_checklists(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  shared_by UUID NULL,
  shared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qa_checklist_projects_pkey PRIMARY KEY (checklist_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_checklist_projects_project
  ON projects.qa_checklist_projects (project_id);

COMMENT ON TABLE projects.qa_checklist_projects
  IS 'Which provisioned_projects a workspace has shared a checklist to. Rows are only ever inserted via a workspace_id-matching SELECT (see QaChecklistsRepository), so cross-workspace sharing cannot exist at the data layer either.';

ALTER TABLE projects.qa_checklists         ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.qa_checklist_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.qa_checklist_projects ENABLE ROW LEVEL SECURITY;

-- Defense in depth: the backend connects with SUPABASE_SERVICE_ROLE_KEY
-- (BYPASSRLS), so RLS with no permissive policy already blocks anon /
-- authenticated; this closes the exposure even if RLS is ever toggled off.
REVOKE ALL ON projects.qa_checklists         FROM anon, authenticated;
REVOKE ALL ON projects.qa_checklist_items    FROM anon, authenticated;
REVOKE ALL ON projects.qa_checklist_projects FROM anon, authenticated;
