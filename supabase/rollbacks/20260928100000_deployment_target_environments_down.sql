DROP INDEX IF EXISTS env_provisioning.project_deployment_targets_environment_slot;
ALTER TABLE env_provisioning.project_deployment_targets
  DROP COLUMN IF EXISTS environment_id;
