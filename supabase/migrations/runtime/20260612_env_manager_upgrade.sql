ALTER TABLE env_provisioning.project_env_var_metadata
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_project_env_var_metadata_active
  ON env_provisioning.project_env_var_metadata (project_id, deployment_target_id, environment, status)
  WHERE removed_at IS NULL;
