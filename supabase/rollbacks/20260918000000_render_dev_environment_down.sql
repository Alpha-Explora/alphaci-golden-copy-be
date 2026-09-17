-- Rollback: 20260918000000_render_dev_environment
-- Restores the previous environment vocabulary.
--
-- Refuses to run while a row still uses 'dev': narrowing a CHECK that stored
-- data violates fails at the ALTER anyway, and failing with a sentence beats
-- failing with a constraint name. Delete or re-point those targets first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM env_provisioning.project_deployment_targets
    WHERE render_environment_name = 'dev'
  ) THEN
    RAISE EXCEPTION
      'Deployment targets still use the dev Render environment; re-point or remove them before narrowing this constraint.';
  END IF;
END $$;

ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_render_environment_check;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD CONSTRAINT project_deployment_targets_render_environment_check
  CHECK (
    render_environment_name IS NULL OR render_environment_name IN (
      'test',
      'uat',
      'production'
    )
  );
