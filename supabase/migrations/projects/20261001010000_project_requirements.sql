-- Project requirements: Project-owned functional/system requirements, item
-- acceptance criteria and Progress, and Project-level QA runs.
--
-- Additive: the code deployed before this change keeps working against this
-- schema (every new column has a default or is nullable, and the only
-- constraints loosened are NOT NULL columns of runs that do not exist yet).
-- Apply it BEFORE the backend that uses it deploys, then run it once more
-- after the deploy: the backfill in section 4 is idempotent and catches
-- checklists shared by the old code in between.
--
-- Cross-context note: delivery_project_id is a plain UUID with NO foreign key,
-- same pattern as workspace_id (scripts/check-schema-ownership.cjs restricts
-- the `projects` context to the `projects` and `workflow` schemas). Only the
-- one-time backfill below reads hierarchy.*; that is a reviewed exact-pair
-- transition entry in the gate, not a blanket exemption.
--
-- Cold-replay note: every constraint is inline in its ADD COLUMN / CREATE
-- TABLE, or guarded by a catalog lookup, so a fresh replay and a re-run both
-- succeed without hiding invalid SQL behind IF NOT EXISTS.

-- 1. Requirements -------------------------------------------------------
ALTER TABLE projects.qa_checklists
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'system'
    CONSTRAINT qa_checklists_kind_chk CHECK (kind IN ('functional', 'system')),
  ADD COLUMN IF NOT EXISTS delivery_project_id UUID NULL
    CONSTRAINT qa_checklists_functional_scope_chk
      CHECK (kind <> 'functional' OR delivery_project_id IS NOT NULL),
  ADD COLUMN IF NOT EXISTS legacy_checklist_id UUID NULL
    REFERENCES projects.qa_checklists(id) ON DELETE SET NULL;

-- Names are unique per (workspace, Project scope, kind), so the same
-- checklist name can exist in two Projects. NULL scope = "unassigned". This
-- must precede the backfill: copies repeat the original's name.
DROP INDEX IF EXISTS projects.uq_qa_checklists_workspace_name_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_requirements_scope_name_active
  ON projects.qa_checklists (
    workspace_id,
    COALESCE(delivery_project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    lower(name)
  )
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_qa_checklists_delivery_project
  ON projects.qa_checklists (delivery_project_id)
  WHERE delivery_project_id IS NOT NULL;

-- 2. Items: acceptance criteria + Progress track ---------------------------
ALTER TABLE projects.qa_checklist_items
  ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT NULL
    CONSTRAINT qa_checklist_items_acceptance_criteria_length_chk
      CHECK (char_length(acceptance_criteria) <= 4000),
  ADD COLUMN IF NOT EXISTS progress TEXT NOT NULL DEFAULT 'todo'
    CONSTRAINT qa_checklist_items_progress_chk
      CHECK (progress IN ('todo', 'in_progress', 'done')),
  ADD COLUMN IF NOT EXISTS progress_by UUID NULL,
  ADD COLUMN IF NOT EXISTS progress_by_login TEXT NULL,
  ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 3. Runs: Project scope ---------------------------------------------------
ALTER TABLE projects.qa_verification_runs
  ALTER COLUMN project_id DROP NOT NULL,
  ALTER COLUMN commit_sha DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'repository'
    CONSTRAINT qa_verification_runs_scope_chk CHECK (scope IN ('repository', 'project')),
  ADD COLUMN IF NOT EXISTS delivery_project_id UUID NULL,
  -- sha256 hex of the sorted "<provisioned_project_id>:<head_sha>" lines.
  ADD COLUMN IF NOT EXISTS heads_fingerprint TEXT NULL
    CONSTRAINT qa_verification_runs_heads_fingerprint_chk
      CHECK (heads_fingerprint ~ '^[0-9a-f]{64}$');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects.qa_verification_runs'::regclass
      AND conname = 'qa_verification_runs_scope_shape_chk'
  ) THEN
    ALTER TABLE projects.qa_verification_runs
      ADD CONSTRAINT qa_verification_runs_scope_shape_chk CHECK (
        (scope = 'repository' AND project_id IS NOT NULL AND commit_sha IS NOT NULL)
        OR
        (scope = 'project' AND delivery_project_id IS NOT NULL
           AND project_id IS NULL AND heads_fingerprint IS NOT NULL)
      );
  END IF;
END $$;

-- One run per (Project, set of heads): the idempotency key for POST create.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_runs_project_scope_heads
  ON projects.qa_verification_runs (delivery_project_id, heads_fingerprint)
  WHERE scope = 'project';
CREATE INDEX IF NOT EXISTS idx_qa_runs_project_scope_created
  ON projects.qa_verification_runs (delivery_project_id, created_at DESC)
  WHERE scope = 'project';

CREATE TABLE IF NOT EXISTS projects.qa_run_repositories (
  run_id UUID NOT NULL REFERENCES projects.qa_verification_runs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  head_sha TEXT NOT NULL
    CONSTRAINT qa_run_repositories_head_sha_chk
    CHECK (head_sha ~ '^[0-9a-f]{40}$' OR head_sha ~ '^[0-9a-f]{64}$'),
  CONSTRAINT qa_run_repositories_pkey PRIMARY KEY (run_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_qa_run_repositories_project
  ON projects.qa_run_repositories (project_id);

ALTER TABLE projects.qa_run_items
  ADD COLUMN IF NOT EXISTS requirement_id UUID NULL
    REFERENCES projects.qa_checklists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requirement_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS requirement_kind TEXT NULL
    CONSTRAINT qa_run_items_requirement_kind_chk
      CHECK (requirement_kind IN ('functional', 'system')),
  ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT NULL;

ALTER TABLE projects.qa_run_repositories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON projects.qa_run_repositories FROM anon, authenticated;

-- 4. Backfill: each shared system checklist -> one system requirement per
-- Project its shared repositories belong to. The original row is assigned to
-- the first Project (keeps its id, so old runs stay linked); other Projects
-- get a copy. Unshared checklists are untouched (delivery_project_id NULL =
-- "unassigned"). qa_checklist_projects is left as-is (legacy, read by the
-- deployed code until it is replaced). Re-running copies nothing twice.
DO $$
DECLARE
  pair RECORD;
  v_current UUID;
  v_name TEXT;
  v_copy_id UUID;
BEGIN
  FOR pair IN
    SELECT DISTINCT c.id AS checklist_id, dp.id AS dp_id, dp.created_at AS dp_created
    FROM projects.qa_checklists c
    JOIN projects.qa_checklist_projects s ON s.checklist_id = c.id
    JOIN hierarchy.repositories hr
      ON hr.provisioned_project_id = s.project_id AND hr.status <> 'archived'
    JOIN hierarchy.delivery_projects dp
      ON dp.id = hr.delivery_project_id
     AND dp.status = 'active'
     AND dp.group_id = c.workspace_id
    WHERE c.archived_at IS NULL
      AND c.kind = 'system'
      AND c.legacy_checklist_id IS NULL
    ORDER BY c.id, dp.created_at, dp.id
  LOOP
    SELECT delivery_project_id, name INTO v_current, v_name
      FROM projects.qa_checklists WHERE id = pair.checklist_id;

    IF v_current = pair.dp_id THEN
      CONTINUE;
    END IF;

    IF v_current IS NULL THEN
      UPDATE projects.qa_checklists
         SET delivery_project_id = pair.dp_id, updated_at = NOW()
       WHERE id = pair.checklist_id AND delivery_project_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM projects.qa_checklists x
           WHERE x.delivery_project_id = pair.dp_id AND x.kind = 'system'
             AND x.archived_at IS NULL AND lower(x.name) = lower(v_name));
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM projects.qa_checklists x
      WHERE x.legacy_checklist_id = pair.checklist_id
        AND x.delivery_project_id = pair.dp_id
    ) THEN
      CONTINUE;
    END IF;

    v_copy_id := NULL;
    INSERT INTO projects.qa_checklists
      (workspace_id, name, description, version, kind, delivery_project_id,
       legacy_checklist_id, created_by, created_at)
    SELECT workspace_id, name, description, 1, 'system', pair.dp_id,
           id, created_by, created_at
      FROM projects.qa_checklists WHERE id = pair.checklist_id
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_copy_id;

    IF v_copy_id IS NOT NULL THEN
      INSERT INTO projects.qa_checklist_items
        (checklist_id, "position", title, description, target_persona,
         verification_type, test_identifier)
      SELECT v_copy_id, "position", title, description, target_persona,
             verification_type, test_identifier
        FROM projects.qa_checklist_items WHERE checklist_id = pair.checklist_id;
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN projects.qa_checklists.kind
  IS 'functional = Feature with User stories; system = flat checklist.';
COMMENT ON COLUMN projects.qa_checklists.delivery_project_id
  IS 'Owning Project (hierarchy.delivery_projects.id). No FK: cross-context. NULL = unassigned legacy system checklist.';
COMMENT ON TABLE projects.qa_run_repositories
  IS 'uat head SHA of each repository captured when a Project run started.';
