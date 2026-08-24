-- Rollback for 20260824000000_branch_scoped_env_vars.sql
--
-- LOSSY IN TWO WAYS. Read both before running it.
--
-- 1. Which branch a preview value belonged to is dropped with the column. Every
--    preview row collapses back to the single 'uat' bucket, so N branches'
--    values become one branch's values and only one survives per key.
-- 2. The forward migration already deleted the duplicate test/uat rows it
--    collapsed. Nothing here brings those back.
--
-- The forward direction is recoverable from the provider (the values live on
-- Vercel, not here — value_stored is CHECKed false); this direction is not. Run
-- it only to unblock a deployment that has to go back to the old backend, and
-- expect to re-provision afterwards.
--
-- 'uat' rather than 'test' because the old frontend rewrote test -> uat before
-- displaying it (activeEnvironment in project-env-panel.tsx), so uat is the
-- bucket the old UI could actually see.

ALTER TABLE env_provisioning.project_env_var_metadata
  DROP CONSTRAINT IF EXISTS project_env_var_metadata_lane_branch_check;

ALTER TABLE env_provisioning.project_env_var_metadata
  DROP CONSTRAINT IF EXISTS project_env_var_metadata_environment_check;

UPDATE env_provisioning.project_env_var_metadata
SET environment = 'uat',
    updated_at = NOW()
WHERE environment = 'preview';

-- Collapsing every branch into one bucket recreates duplicates on
-- (target, environment, key); keep the newest so the old UNIQUE can go back on.
DELETE FROM env_provisioning.project_env_var_metadata
WHERE id IN (
  SELECT id
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY deployment_target_id, environment, key
             ORDER BY last_provisioned_at DESC, id DESC
           ) AS rank
    FROM env_provisioning.project_env_var_metadata
  ) AS ranked
  WHERE ranked.rank > 1
);

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
