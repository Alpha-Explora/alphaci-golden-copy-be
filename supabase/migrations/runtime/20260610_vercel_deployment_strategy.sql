BEGIN;

ALTER TABLE env_provisioning.provider_connections
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE env_provisioning.provider_connections
SET metadata = jsonb_build_object(
  'accountType', 'legacy',
  'requiresReconnect', true
)
WHERE provider = 'vercel'
  AND metadata = '{}'::jsonb;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD COLUMN IF NOT EXISTS deployment_strategy TEXT,
  ADD COLUMN IF NOT EXISTS provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE env_provisioning.project_deployment_targets
SET deployment_strategy = CASE
  WHEN provider = 'vercel' AND ownership_mode = 'flowci_managed' THEN 'vercel_git_connected'
  WHEN provider = 'vercel' AND ownership_mode = 'byo' THEN 'vercel_ci_pushed'
  ELSE 'provider_native'
END
WHERE deployment_strategy IS NULL;

ALTER TABLE env_provisioning.project_deployment_targets
  ALTER COLUMN deployment_strategy SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_deployment_targets_strategy_check'
      AND conrelid = 'env_provisioning.project_deployment_targets'::regclass
  ) THEN
    ALTER TABLE env_provisioning.project_deployment_targets
      ADD CONSTRAINT project_deployment_targets_strategy_check
      CHECK (deployment_strategy IN ('provider_native', 'vercel_git_connected', 'vercel_ci_pushed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_project_deployment_targets_strategy
  ON env_provisioning.project_deployment_targets (deployment_strategy);

COMMIT;
