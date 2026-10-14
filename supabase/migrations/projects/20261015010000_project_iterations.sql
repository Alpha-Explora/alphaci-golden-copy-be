-- Project Iterations, phase 1 (ITERATIONS_PLAN.md sections 3 and 6): the unit of
-- work of a Project. Every Project requirement and every Project-scope QA run
-- belongs to exactly one Iteration; at most one Iteration per Project is
-- `active`. Phase 1 only creates the foundation: every Project gets
-- "Iteration 1" and nothing is delivered yet.
--
-- APPLY ORDER: this migration is NOT purely additive for the previously
-- deployed backend. After it runs, the old code (a) cannot create a Project run
-- (its ON CONFLICT target is the unique index swapped below) and (b) cannot
-- insert a Project requirement without iteration_id (the presence CHECK). Apply
-- it immediately before the backend that uses it deploys, after a dry run of the
-- section 3 backfill counts (one Iteration per Project, every Project
-- requirement and Project run assigned). Reads of the old code keep working
-- throughout.
--
-- Cross-context note: delivery_project_id, started_by and delivered_by are plain
-- UUIDs with NO foreign key, the same pattern as the other QA tables
-- (scripts/check-schema-ownership.cjs restricts the `projects` context to the
-- `projects` and `workflow` schemas). Only the one-time backfill below reads
-- hierarchy.delivery_projects; that is a reviewed exact-pair transition entry
-- in the gate, not a blanket exemption.
--
-- Cold-replay note: every constraint of a new object is inline in its CREATE
-- TABLE / ADD COLUMN, or guarded by a catalog lookup (the two CHECKs that can
-- only hold after the backfill), so a fresh replay and a re-run both succeed
-- without hiding invalid SQL behind IF NOT EXISTS.

-- 1. The iterations table ---------------------------------------------------
CREATE TABLE IF NOT EXISTS projects.project_iterations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_project_id UUID NOT NULL,
  number INTEGER NOT NULL
    CONSTRAINT project_iterations_number_chk CHECK (number >= 1),
  goal TEXT NULL
    CONSTRAINT project_iterations_goal_length_chk CHECK (char_length(goal) <= 120),
  status TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT project_iterations_status_chk CHECK (status IN ('active', 'delivered')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_by UUID NULL,
  started_by_login TEXT NULL,
  delivered_at TIMESTAMPTZ NULL,
  delivered_by UUID NULL,
  delivered_by_login TEXT NULL,
  -- The APPROVED run that was delivered (phase 2).
  signoff_run_id UUID NULL
    REFERENCES projects.qa_verification_runs(id) ON DELETE SET NULL,
  -- Per repository: { projectId, repoFullName, uatHeadSha, mergeSha|null,
  -- prNumber|null, how: 'merged' | 'already_in_main' } (phase 2).
  delivery_json JSONB NULL,
  CONSTRAINT project_iterations_delivered_shape_chk CHECK (
    (status = 'active' AND delivered_at IS NULL)
    OR (status = 'delivered' AND delivered_at IS NOT NULL)
  ),
  CONSTRAINT project_iterations_project_number_uq
    UNIQUE (delivery_project_id, number)
);

-- At most one active Iteration per Project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_iterations_one_active
  ON projects.project_iterations (delivery_project_id)
  WHERE status = 'active';

ALTER TABLE projects.project_iterations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON projects.project_iterations FROM anon, authenticated;

-- 2. Iteration columns ------------------------------------------------------
-- Nullable here; presence is enforced by the CHECKs in section 4, after the
-- backfill (a CHECK added with the column would reject the existing rows).
ALTER TABLE projects.qa_checklists
  ADD COLUMN IF NOT EXISTS iteration_id UUID NULL
    REFERENCES projects.project_iterations(id);

ALTER TABLE projects.qa_verification_runs
  ADD COLUMN IF NOT EXISTS iteration_id UUID NULL
    REFERENCES projects.project_iterations(id);

-- 3. Backfill ---------------------------------------------------------------
-- Iteration 1 (active) for every Project, whatever its status. A Project that
-- is gone from hierarchy but still has requirements or runs gets one too, so
-- the presence CHECKs below can hold. Re-running inserts nothing: the unique
-- (delivery_project_id, number) key absorbs it.
INSERT INTO projects.project_iterations
  (delivery_project_id, number, status, started_at)
SELECT dp.id, 1, 'active', COALESCE(dp.created_at, NOW())
  FROM hierarchy.delivery_projects dp
ON CONFLICT DO NOTHING;

INSERT INTO projects.project_iterations
  (delivery_project_id, number, status, started_at)
SELECT orphan.delivery_project_id, 1, 'active', orphan.first_seen
  FROM (
    SELECT delivery_project_id, MIN(created_at) AS first_seen
      FROM projects.qa_checklists
     WHERE delivery_project_id IS NOT NULL
     GROUP BY delivery_project_id
    UNION ALL
    SELECT delivery_project_id, MIN(created_at)
      FROM projects.qa_verification_runs
     WHERE scope = 'project' AND delivery_project_id IS NOT NULL
     GROUP BY delivery_project_id
  ) orphan
ON CONFLICT DO NOTHING;

-- Existing Project requirements and Project runs -> their Project's Iteration
-- 1. updated_at is deliberately left alone: "requirements changed since
-- sign-off" is computed from it.
UPDATE projects.qa_checklists c
   SET iteration_id = i.id
  FROM projects.project_iterations i
 WHERE c.delivery_project_id IS NOT NULL
   AND c.iteration_id IS NULL
   AND i.delivery_project_id = c.delivery_project_id
   AND i.number = 1;

UPDATE projects.qa_verification_runs r
   SET iteration_id = i.id
  FROM projects.project_iterations i
 WHERE r.scope = 'project'
   AND r.iteration_id IS NULL
   AND i.delivery_project_id = r.delivery_project_id
   AND i.number = 1;

-- 4. Presence, enforced with a CHECK (not a blanket NOT NULL: unassigned legacy
-- system checklists and repository-scope runs have no Iteration) -------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects.qa_checklists'::regclass
      AND conname = 'qa_checklists_iteration_scope_chk'
  ) THEN
    ALTER TABLE projects.qa_checklists
      ADD CONSTRAINT qa_checklists_iteration_scope_chk
      CHECK (delivery_project_id IS NULL OR iteration_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects.qa_verification_runs'::regclass
      AND conname = 'qa_verification_runs_iteration_scope_chk'
  ) THEN
    ALTER TABLE projects.qa_verification_runs
      ADD CONSTRAINT qa_verification_runs_iteration_scope_chk
      CHECK (scope <> 'project' OR iteration_id IS NOT NULL);
  END IF;
END $$;

-- 5. Index swaps (after the backfill: before it every row has a NULL iteration,
-- which would make two Projects' same-named requirements collide) -------------
-- Requirements: active names are unique per (workspace, Iteration, kind). A
-- carried-over requirement keeps its name in the next Iteration. Unassigned
-- legacy checklists (NULL Iteration) keep their one shared scope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_requirements_iteration_name_active
  ON projects.qa_checklists (
    workspace_id,
    COALESCE(iteration_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    lower(name)
  )
  WHERE archived_at IS NULL;
DROP INDEX IF EXISTS projects.uq_qa_requirements_scope_name_active;

-- Runs: one Project run per (Iteration, set of heads): the idempotency key for
-- POST create. A new Iteration gets a fresh run even on unchanged heads.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_runs_iteration_heads
  ON projects.qa_verification_runs (iteration_id, heads_fingerprint)
  WHERE scope = 'project';
DROP INDEX IF EXISTS projects.uq_qa_runs_project_scope_heads;

CREATE INDEX IF NOT EXISTS idx_qa_checklists_iteration
  ON projects.qa_checklists (iteration_id)
  WHERE iteration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qa_runs_iteration_created
  ON projects.qa_verification_runs (iteration_id, created_at DESC)
  WHERE scope = 'project';

COMMENT ON TABLE projects.project_iterations
  IS 'A Project''s unit of work (Iteration N). At most one is active; delivered ones are frozen records.';
COMMENT ON COLUMN projects.project_iterations.delivery_project_id
  IS 'hierarchy.delivery_projects.id. No FK: cross-context.';
COMMENT ON COLUMN projects.qa_checklists.iteration_id
  IS 'The Iteration a Project requirement belongs to. NULL only for unassigned legacy system checklists.';
COMMENT ON COLUMN projects.qa_verification_runs.iteration_id
  IS 'The Iteration a Project-scope run belongs to. NULL for repository-scope runs.';
