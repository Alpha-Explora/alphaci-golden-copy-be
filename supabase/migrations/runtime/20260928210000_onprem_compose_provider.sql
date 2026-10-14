-- On-prem hosts become a deployment provider. A target on one is only a
-- record: the host pulls its environment's signed releases and reports back.
ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_provider_check;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD CONSTRAINT project_deployment_targets_provider_check
  CHECK (provider IN ('render', 'vercel', 'onprem-compose'));

-- Who carries a deployment out: the generated workflow, or the environment's
-- host. Fixed when the deployment is created, so a CI token can never report
-- a host's deployment and a host never sees a workflow's.
ALTER TABLE env_provisioning.environment_deployments
  ADD COLUMN IF NOT EXISTS delivery TEXT NOT NULL DEFAULT 'workflow'
    CONSTRAINT environment_deployments_delivery_check
    CHECK (delivery IN ('workflow', 'host'));
