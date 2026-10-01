-- Rollback: 20261001010000_project_requirements
-- Removes Project-scope QA runs, the coverage table and the extra requirement
-- and item columns, and restores the per-workspace checklist name index.
--
-- Fails closed. The old schema cannot hold a Project run, a functional
-- requirement, or the same checklist name in two Projects, and dropping them
-- would destroy QA history and Progress. Delete or merge those rows by hand
-- first, or keep the migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects.qa_verification_runs WHERE scope = 'project') THEN
    RAISE EXCEPTION
      'Project-scope QA runs exist; the previous schema cannot hold them. Remove them before rolling back.';
  END IF;
  IF EXISTS (SELECT 1 FROM projects.qa_checklists WHERE kind = 'functional') THEN
    RAISE EXCEPTION
      'Functional requirements exist; the previous schema cannot hold them. Remove them before rolling back.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM projects.qa_checklists
    WHERE archived_at IS NULL
    GROUP BY workspace_id, lower(name)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'The same active checklist name exists in more than one Project; the previous per-workspace name index would reject it. Rename or archive the copies before rolling back.';
  END IF;
END $$;

DROP INDEX IF EXISTS projects.uq_qa_requirements_scope_name_active;
DROP INDEX IF EXISTS projects.idx_qa_checklists_delivery_project;
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_checklists_workspace_name_active
  ON projects.qa_checklists (workspace_id, lower(name))
  WHERE archived_at IS NULL;

ALTER TABLE projects.qa_run_items
  DROP COLUMN IF EXISTS requirement_id,
  DROP COLUMN IF EXISTS requirement_name,
  DROP COLUMN IF EXISTS requirement_kind,
  DROP COLUMN IF EXISTS acceptance_criteria;

DROP TABLE IF EXISTS projects.qa_run_repositories;

DROP INDEX IF EXISTS projects.uq_qa_runs_project_scope_heads;
DROP INDEX IF EXISTS projects.idx_qa_runs_project_scope_created;
ALTER TABLE projects.qa_verification_runs
  DROP CONSTRAINT IF EXISTS qa_verification_runs_scope_shape_chk;
ALTER TABLE projects.qa_verification_runs
  DROP COLUMN IF EXISTS heads_fingerprint,
  DROP COLUMN IF EXISTS delivery_project_id,
  DROP COLUMN IF EXISTS scope;
ALTER TABLE projects.qa_verification_runs
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN commit_sha SET NOT NULL;

ALTER TABLE projects.qa_checklist_items
  DROP COLUMN IF EXISTS acceptance_criteria,
  DROP COLUMN IF EXISTS progress,
  DROP COLUMN IF EXISTS progress_by,
  DROP COLUMN IF EXISTS progress_by_login,
  DROP COLUMN IF EXISTS progress_at,
  DROP COLUMN IF EXISTS row_version,
  DROP COLUMN IF EXISTS updated_at;

ALTER TABLE projects.qa_checklists
  DROP COLUMN IF EXISTS legacy_checklist_id,
  DROP COLUMN IF EXISTS delivery_project_id,
  DROP COLUMN IF EXISTS kind;
