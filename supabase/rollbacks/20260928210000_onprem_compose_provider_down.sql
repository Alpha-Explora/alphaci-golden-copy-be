-- Removes on-prem targets, which the previous provider constraint refuses.
ALTER TABLE env_provisioning.environment_deployments
  DROP COLUMN IF EXISTS delivery;

DELETE FROM env_provisioning.project_deployment_targets
 WHERE provider = 'onprem-compose';

ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_provider_check;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD CONSTRAINT project_deployment_targets_provider_check
  CHECK (provider IN ('render', 'vercel'));
