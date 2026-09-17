-- Migration: 20260918000000_render_dev_environment
-- Description: Admits 'dev' as a Render environment name, so the branch every
--              developer pushes to can have a service of its own.
-- Notes:
--   - The promotion flow is dev -> uat -> main, and 'test' was retired from it.
--     This column still only allowed the retired name, so creating a dev target
--     failed at the database with a check violation - after the Render service
--     had already been created, leaving a service with no row.
--   - 'test' is kept, not replaced. Existing rows carry it, and a migration
--     that invalidated stored data to tidy a vocabulary would turn a rename
--     into an outage.
--   - Widening only: every value accepted before is still accepted, so the
--     previous application build keeps working against this schema.
--   - DROP ... IF EXISTS then ADD, because Postgres has no ALTER CONSTRAINT for
--     a CHECK. The pair is re-runnable.
-- Prereq: 20260611000000_render_deployment_provisioning must already be applied.

ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_render_environment_check;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD CONSTRAINT project_deployment_targets_render_environment_check
  CHECK (
    render_environment_name IS NULL OR render_environment_name IN (
      'dev',
      'test',
      'uat',
      'production'
    )
  );
