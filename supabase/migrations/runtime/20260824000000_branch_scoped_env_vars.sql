-- ─── Branch-scoped environment variables ─────────────────────────────────────
-- Replaces the fixed test → uat → production ladder with the two lanes a
-- hosting provider actually has:
--
--   production   the lane the provider's production branch deploys to. Carries
--                no branch of its own: Vercel keys production variables by
--                `target: ['production']` and resolves the branch from the
--                project's own production-branch setting.
--   preview      keyed by one specific git branch, so every branch gets its own
--                set of values.
--
-- WHY THIS IS NOT A COSMETIC RENAME
--
-- The old model could not express per-branch values at all, and it silently
-- lost data. `test` and `uat` BOTH mapped to Vercel's single `preview` target
-- with no gitBranch (see VERCEL_TARGET_BY_ENV in vercel-env.client.ts), and
-- Vercel's upsert key is (key, target, gitBranch). So provisioning one key for
-- `test` and then for `uat` wrote ONE provider record — the second overwrote
-- the first — while this table recorded two rows pretending otherwise. Deleting
-- either one deleted the shared provider record.
--
-- Collapsing a test row and a uat row for the same key is therefore not data
-- loss: those two rows always described a single provider record. The backfill
-- keeps the most recently provisioned of the pair, which is the one Vercel
-- actually still held.
--
-- NOT ADDITIVE — READ BEFORE APPLYING
--
-- `20260702000100_app_users_is_internal.sql` records that this database was
-- once shared with the external (sold) platform, and additive-only was the rule
-- that followed from it. This migration cannot honour that rule: the old
-- UNIQUE (deployment_target_id, environment, key) is precisely what makes two
-- branches unable to hold the same key, so it has to go. Any deployment still
-- sharing this database must ship the matching backend first, because
-- `ON CONFLICT (deployment_target_id, environment, key)` stops resolving the
-- moment that constraint is replaced.
--
-- Rollback: rollbacks/20260824000000_branch_scoped_env_vars_down.sql.

ALTER TABLE env_provisioning.project_env_var_metadata
  ADD COLUMN IF NOT EXISTS git_branch TEXT NULL;

-- Dropped before the backfill so the UPDATE below is allowed to write
-- 'preview'; the narrowed replacement goes back on at the end.
ALTER TABLE env_provisioning.project_env_var_metadata
  DROP CONSTRAINT IF EXISTS project_env_var_metadata_environment_check;

-- Legacy test/uat rows become preview rows on the branch their target tracks.
-- project_deployment_targets.branch_name is NOT NULL, so every row can be
-- placed and none is left stranded.
UPDATE env_provisioning.project_env_var_metadata AS metadata
SET environment = 'preview',
    git_branch = target.branch_name,
    updated_at = NOW()
FROM env_provisioning.project_deployment_targets AS target
WHERE target.id = metadata.deployment_target_id
  AND metadata.environment IN ('test', 'uat');

-- Production rows keep their lane and stay branchless.
UPDATE env_provisioning.project_env_var_metadata
SET git_branch = NULL
WHERE environment = 'production';

-- Collapse the test/uat pairs that just landed on the same branch. Keeps the
-- newest by last_provisioned_at, with id as a deterministic tie-break so the
-- result does not depend on physical row order. Deletion rather than
-- removed_at: the replacement UNIQUE below is total, so a soft-removed
-- duplicate would still collide with the row that survived.
DELETE FROM env_provisioning.project_env_var_metadata
WHERE id IN (
  SELECT id
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY deployment_target_id, environment, git_branch, key
             ORDER BY last_provisioned_at DESC, id DESC
           ) AS rank
    FROM env_provisioning.project_env_var_metadata
  ) AS ranked
  WHERE ranked.rank > 1
);

ALTER TABLE env_provisioning.project_env_var_metadata
  DROP CONSTRAINT IF EXISTS project_env_var_metadata_deployment_target_id_environment_k_key;

-- NULLS NOT DISTINCT (PostgreSQL 15+; this project is on 17.6) so the branchless
-- production rows still collide with each other on (target, key). Under the
-- default NULLS DISTINCT they would not, and a project could accumulate
-- unlimited duplicate production values for one key.
ALTER TABLE env_provisioning.project_env_var_metadata
  ADD CONSTRAINT project_env_var_metadata_target_lane_branch_key_key
  UNIQUE NULLS NOT DISTINCT (deployment_target_id, environment, git_branch, key);

ALTER TABLE env_provisioning.project_env_var_metadata
  ADD CONSTRAINT project_env_var_metadata_environment_check
  CHECK (environment IN ('production', 'preview'));

-- The lane and the branch are not independent: production has no branch of its
-- own, and a preview row without one would be the old ladder's ambiguity coming
-- back. Enforced here rather than trusted to the application.
ALTER TABLE env_provisioning.project_env_var_metadata
  ADD CONSTRAINT project_env_var_metadata_lane_branch_check
  CHECK (
    (environment = 'production' AND git_branch IS NULL)
    OR (environment = 'preview' AND git_branch IS NOT NULL AND git_branch <> '')
  );

-- Lookups are per target and lane, and the preview lane is always filtered by
-- branch, so the branch belongs in the index rather than as a filter after it.
DROP INDEX IF EXISTS env_provisioning.idx_project_env_var_metadata_active;
CREATE INDEX IF NOT EXISTS idx_project_env_var_metadata_active
  ON env_provisioning.project_env_var_metadata (
    project_id, deployment_target_id, environment, git_branch, status
  )
  WHERE removed_at IS NULL;

DROP INDEX IF EXISTS env_provisioning.idx_project_env_var_metadata_project;
CREATE INDEX IF NOT EXISTS idx_project_env_var_metadata_project
  ON env_provisioning.project_env_var_metadata (
    project_id, deployment_target_id, environment, git_branch
  );

COMMENT ON COLUMN env_provisioning.project_env_var_metadata.environment IS
  'Deployment lane: production (the provider''s production branch, branchless here) or preview (scoped to git_branch).';

COMMENT ON COLUMN env_provisioning.project_env_var_metadata.git_branch IS
  'Git branch this value applies to. NULL for the production lane, where the provider resolves the branch from its own production-branch setting. Required and non-empty for preview.';
