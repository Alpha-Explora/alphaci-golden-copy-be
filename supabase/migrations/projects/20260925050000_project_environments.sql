-- Project-owned ordered environment identities. Legacy projects are backfilled
-- only when exactly one configured target points at a branch and a Render
-- target explicitly marks that branch as production. Projects with multiple
-- targets remain on the legacy path until their target mapping is explicit.
-- `main` and `production` are
-- excluded because earlier code derived those labels from the branch name.
-- Projects with several branches also remain on the legacy path because this
-- schema has no authoritative environment order for them.
CREATE TABLE IF NOT EXISTS projects.project_environments (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id    UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  slug          TEXT        NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name  TEXT        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  position      INTEGER     NOT NULL CHECK (position >= 0),
  source_branch TEXT        NOT NULL CHECK (length(btrim(source_branch)) BETWEEN 1 AND 255),
  role          TEXT        NOT NULL CHECK (role IN ('production', 'non_production')),
  auto_deploy   BOOLEAN     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_environments_auto_deploy_position_check
    CHECK (auto_deploy = (position = 0)),
  CONSTRAINT project_environments_project_slug_unique UNIQUE (project_id, slug),
  CONSTRAINT project_environments_project_position_unique UNIQUE (project_id, position)
);

ALTER TABLE projects.project_environments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON projects.project_environments FROM anon, authenticated;

CREATE UNIQUE INDEX IF NOT EXISTS project_environments_one_production
  ON projects.project_environments (project_id)
  WHERE role = 'production';

CREATE INDEX IF NOT EXISTS project_environments_project_order
  ON projects.project_environments (project_id, position);

COMMENT ON TABLE projects.project_environments IS
  'Project-owned ordered environment identities. Legacy branch deployment continues until a project is explicitly mapped.';
COMMENT ON COLUMN projects.project_environments.auto_deploy IS
  'Read-only projection of position zero; only the first configured environment is auto-deployable.';

WITH target_summary AS (
  SELECT target.project_id,
         COUNT(DISTINCT target.branch_name) AS branch_count,
         MIN(target.branch_name) AS only_branch,
         BOOL_OR(
           target.provider = 'render'
           AND target.render_environment_name = 'production'
           AND target.branch_name NOT IN ('main', 'production')
         ) AS has_explicit_production_target
    FROM env_provisioning.project_deployment_targets AS target
   GROUP BY target.project_id
  HAVING COUNT(*) = 1
     AND COUNT(DISTINCT target.branch_name) = 1
     AND BOOL_OR(
       target.provider = 'render'
       AND target.render_environment_name = 'production'
       AND target.branch_name NOT IN ('main', 'production')
     )
),
slugged AS (
  SELECT project_id,
         only_branch AS source_branch,
         RTRIM(LEFT(
           NULLIF(BTRIM(REGEXP_REPLACE(LOWER(only_branch), '[^a-z0-9]+', '-', 'g'), '-'), ''),
           48
         ), '-') AS slug
    FROM target_summary
)
INSERT INTO projects.project_environments (
  project_id, slug, display_name, position, source_branch, role, auto_deploy
)
SELECT project_id,
       COALESCE(slug, 'production'),
       source_branch,
       0,
       source_branch,
       'production',
       true
  FROM slugged
ON CONFLICT (project_id, slug) DO NOTHING;
