-- Rollback for 20260824000000_branch_scoped_env_vars.sql
--
-- This rollback fails closed when the active data contains any preview row.
-- The old schema has no column in which to preserve preview branch identity,
-- so automatically mapping even one row to uat would silently discard which
-- branch produced the value. Resolve the data with an approved backup or
-- re-provision plan before retrying.
--
-- 'uat' rather than 'test' because the old frontend rewrote test -> uat before
-- displaying it (activeEnvironment in project-env-panel.tsx), so uat is the
-- bucket the old UI could actually see.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM env_provisioning.project_env_var_metadata
    WHERE environment = 'preview'
  ) THEN
    RAISE EXCEPTION
      'Rollback refused: preview branch identity would be discarded; restore from backup or re-provision preview values before retrying';
  END IF;
END
$$;

ALTER TABLE env_provisioning.project_env_var_metadata
  DROP CONSTRAINT IF EXISTS project_env_var_metadata_lane_branch_check;

ALTER TABLE env_provisioning.project_env_var_metadata
  DROP CONSTRAINT IF EXISTS project_env_var_metadata_environment_check;

UPDATE env_provisioning.project_env_var_metadata
SET environment = 'uat',
    updated_at = NOW()
WHERE environment = 'preview';

ALTER TABLE env_provisioning.project_env_var_metadata
  DROP CONSTRAINT IF EXISTS project_env_var_metadata_target_lane_branch_key_key;

ALTER TABLE env_provisioning.project_env_var_metadata
  ADD CONSTRAINT project_env_var_metadata_deployment_target_id_environment_k_key
  UNIQUE (deployment_target_id, environment, key);

ALTER TABLE env_provisioning.project_env_var_metadata
  ADD CONSTRAINT project_env_var_metadata_environment_check
  CHECK (environment IN ('test', 'uat', 'production'));

ALTER TABLE env_provisioning.project_env_var_metadata
  DROP COLUMN IF EXISTS git_branch;

DROP INDEX IF EXISTS env_provisioning.idx_project_env_var_metadata_active;
CREATE INDEX IF NOT EXISTS idx_project_env_var_metadata_active
  ON env_provisioning.project_env_var_metadata (
    project_id, deployment_target_id, environment, status
  )
  WHERE removed_at IS NULL;

DROP INDEX IF EXISTS env_provisioning.idx_project_env_var_metadata_project;
CREATE INDEX IF NOT EXISTS idx_project_env_var_metadata_project
  ON env_provisioning.project_env_var_metadata (
    project_id, deployment_target_id, environment
  );

COMMIT;
