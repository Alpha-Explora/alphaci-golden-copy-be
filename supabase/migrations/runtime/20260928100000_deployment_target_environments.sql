-- Deployment targets belong to a project environment. The target key is
-- (project, environment, slot); the branch stays the environment's source
-- setting and is never used to choose a target. Legacy targets keep a NULL
-- environment_id and their existing branch-based behaviour until an operator
-- attaches them.
ALTER TABLE env_provisioning.project_deployment_targets
  ADD COLUMN IF NOT EXISTS environment_id UUID
    REFERENCES projects.project_environments(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS project_deployment_targets_environment_slot
  ON env_provisioning.project_deployment_targets (project_id, environment_id, slot)
  WHERE environment_id IS NOT NULL;

COMMENT ON COLUMN env_provisioning.project_deployment_targets.environment_id IS
  'Project environment this target deploys. NULL means the legacy branch-based path.';

-- Attach a legacy target only when the mapping cannot be a guess: exactly one
-- environment of its project uses the target's branch, and the target is the
-- only one for that project, slot, and branch.
WITH unambiguous AS (
  SELECT target.id AS target_id, environment.id AS environment_id
    FROM env_provisioning.project_deployment_targets AS target
    JOIN projects.project_environments AS environment
      ON environment.project_id = target.project_id
     AND environment.source_branch = target.branch_name
   WHERE target.environment_id IS NULL
     AND (SELECT count(*)
            FROM projects.project_environments AS other
           WHERE other.project_id = target.project_id
             AND other.source_branch = target.branch_name) = 1
     AND (SELECT count(*)
            FROM env_provisioning.project_deployment_targets AS sibling
           WHERE sibling.project_id = target.project_id
             AND sibling.slot = target.slot
             AND sibling.branch_name = target.branch_name) = 1
)
UPDATE env_provisioning.project_deployment_targets AS target
   SET environment_id = unambiguous.environment_id,
       updated_at = NOW()
  FROM unambiguous
 WHERE target.id = unambiguous.target_id
   AND NOT EXISTS (
     SELECT 1
       FROM env_provisioning.project_deployment_targets AS attached
      WHERE attached.project_id = target.project_id
        AND attached.slot = target.slot
        AND attached.environment_id = unambiguous.environment_id
   );
