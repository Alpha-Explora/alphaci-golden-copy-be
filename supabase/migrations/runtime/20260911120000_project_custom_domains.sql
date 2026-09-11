-- Migration: 20260911120000_project_custom_domains
-- Description: Creates env_provisioning.project_custom_domains, the table the
--              custom-domains feature has always queried and no migration ever
--              created.
-- Notes:
--   - The API, the repository and the Hosting tab all shipped against this
--     table. Opening a project's Hosting tab returned
--     `relation "env_provisioning.project_custom_domains" does not exist`
--     every time, in production. The columns below are taken from the
--     repository's own SELECT *, INSERT and UPDATE statements rather than
--     invented, so the row it maps to CustomDomainSummary is the row it gets.
--   - `verification` holds the provider's DNS challenge records as returned,
--     so JSONB and not a child table: nothing queries inside it, the shape is
--     the provider's to change, and a challenge only means anything alongside
--     the hostname it was issued for.
--   - `misconfigured` is nullable on purpose and is NOT a boolean with a
--     default. NULL means "never checked", false means "checked and correct".
--     Defaulting it to false would claim a verification nobody performed —
--     the reading the repository's `misconfigured: boolean | null` already
--     distinguishes, and a default would quietly erase.
--   - UNIQUE on hostname: a hostname resolves to one deployment. Two projects
--     claiming the same one is a configuration error that should fail at the
--     insert rather than produce two rows that disagree about where it points.
--   - Only ONE foreign key, to the deployment target, because that is the only
--     referenced table this context owns. The schema-ownership gate refuses a
--     new cross-context reference, and records existing ones as transition
--     debt rather than something to add to.
--
--     Nothing is lost by it. project_deployment_targets already references
--     projects.provisioned_projects, so deleting a project still cascades:
--     project -> target -> domain. `project_id` is carried as a plain UUID
--     because listForProject filters on it, and `created_by` likewise, which
--     is an audit field rather than a relationship anything traverses.
-- Prereq: 20260608_env_provisioning must already be applied.

CREATE TABLE IF NOT EXISTS env_provisioning.project_custom_domains (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               UUID        NOT NULL,
  deployment_target_id     UUID        NOT NULL REFERENCES env_provisioning.project_deployment_targets(id) ON DELETE CASCADE,
  provider                 TEXT        NOT NULL CHECK (provider IN ('render', 'vercel')),
  hostname                 TEXT        NOT NULL,
  apex_domain              TEXT        NULL,
  git_branch               TEXT        NULL,
  verified                 BOOLEAN     NOT NULL DEFAULT FALSE,
  verification             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  misconfigured            BOOLEAN     NULL,
  last_checked_at          TIMESTAMPTZ NULL,
  last_error_safe_message  TEXT        NULL,
  created_by               UUID        NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_custom_domains_hostname_unique UNIQUE (hostname)
);

-- listForProject orders by git_branch then hostname, which is the only read
-- path the UI has.
CREATE INDEX IF NOT EXISTS idx_project_custom_domains_project
  ON env_provisioning.project_custom_domains (project_id, git_branch, hostname);

CREATE INDEX IF NOT EXISTS idx_project_custom_domains_target
  ON env_provisioning.project_custom_domains (deployment_target_id);
