-- ─── Custom domains on deployment targets ────────────────────────────────────
-- A custom hostname attached to a deployment target, plus whatever the provider
-- said has to be true at DNS for it to serve.
--
-- Deliberately NOT runtime_domains.domain_records, which arrived with the GCP
-- expand-contract migration: that table foreign-keys to
-- runtime_deployments.deployment_targets, whose provider column is CHECKed to
-- 'gcp'. The Vercel and Render targets this product actually creates live in
-- env_provisioning.project_deployment_targets, so a domain row has to hang off
-- that table or it can never reference a real target.
--
-- No DNS records are stored as product knowledge. `verification` holds the
-- challenge the provider itself returned (Vercel: a TXT name/value pair), so
-- the UI repeats the provider's instructions rather than hardcoding an apex IP
-- that changes without notice.

CREATE TABLE IF NOT EXISTS env_provisioning.project_custom_domains (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  deployment_target_id    UUID        NOT NULL REFERENCES env_provisioning.project_deployment_targets(id) ON DELETE CASCADE,
  provider                TEXT        NOT NULL CHECK (provider IN ('render', 'vercel')),
  hostname                TEXT        NOT NULL,
  apex_domain             TEXT        NULL,
  -- Pins the domain to one branch. Vercel's add-domain call takes gitBranch,
  -- so a branch can carry its own hostname exactly as it carries its own
  -- environment variables. NULL means the production domain.
  git_branch              TEXT        NULL CHECK (git_branch IS NULL OR git_branch <> ''),
  verified                BOOLEAN     NOT NULL DEFAULT false,
  -- The provider's own challenge list, stored verbatim. Never synthesised.
  verification            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- NULL until the configuration has been checked at least once; the provider
  -- reports it separately from verification and the two can disagree.
  misconfigured           BOOLEAN     NULL,
  last_checked_at         TIMESTAMPTZ NULL,
  last_error_safe_message TEXT        NULL,
  created_by              UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A hostname resolves to one place. The providers enforce this too — Vercel
  -- 409s a domain already assigned elsewhere — but a local constraint means a
  -- duplicate fails before a remote call is spent on it.
  UNIQUE (hostname)
);

CREATE INDEX IF NOT EXISTS idx_project_custom_domains_target
  ON env_provisioning.project_custom_domains (deployment_target_id, verified);

CREATE INDEX IF NOT EXISTS idx_project_custom_domains_project
  ON env_provisioning.project_custom_domains (project_id);

DROP TRIGGER IF EXISTS trg_project_custom_domains_updated_at
  ON env_provisioning.project_custom_domains;
CREATE TRIGGER trg_project_custom_domains_updated_at
  BEFORE UPDATE ON env_provisioning.project_custom_domains
  FOR EACH ROW EXECUTE FUNCTION env_provisioning.set_env_provisioning_updated_at();

-- Matches the posture of every other table in this schema: reachable only by
-- the backend's service role, never by PostgREST.
ALTER TABLE env_provisioning.project_custom_domains ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN env_provisioning.project_custom_domains.verification IS
  'Verification challenges exactly as the provider returned them (Vercel: [{type,domain,value,reason}]). Repeated to the user as DNS instructions; never generated locally.';

COMMENT ON COLUMN env_provisioning.project_custom_domains.git_branch IS
  'Branch this hostname serves. NULL for the production domain.';
