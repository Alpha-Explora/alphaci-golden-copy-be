-- Immutable releases, their per-slot artifacts, per-environment deployments,
-- and the on-prem hosts that pull them. A release is registered once by CI
-- for the project's first environment; its identity never changes. Build
-- verification (the signed manifest) and each environment's deployment state
-- are separate records.
CREATE TABLE IF NOT EXISTS env_provisioning.releases (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id            UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  source_environment_id UUID        NOT NULL REFERENCES projects.project_environments(id) ON DELETE RESTRICT,
  source_branch         TEXT        NOT NULL CHECK (length(btrim(source_branch)) BETWEEN 1 AND 255),
  commit_sha            TEXT        NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  workflow_provider     TEXT        NOT NULL CHECK (workflow_provider IN ('github_actions')),
  workflow_repo         TEXT        NOT NULL CHECK (workflow_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  workflow_run_id       TEXT        NOT NULL CHECK (workflow_run_id ~ '^[0-9]{1,20}$'),
  workflow_run_url      TEXT        NOT NULL CHECK (workflow_run_url ~ '^https://'),
  verification_status   TEXT        NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified')),
  manifest              JSONB,
  manifest_sha256       TEXT        CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  signature_algorithm   TEXT,
  signature_key_id      TEXT,
  signature_value       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at           TIMESTAMPTZ,
  CONSTRAINT releases_verified_has_signed_manifest CHECK (
    (verification_status = 'verified') = (
      manifest IS NOT NULL AND manifest_sha256 IS NOT NULL
      AND signature_algorithm IS NOT NULL AND signature_key_id IS NOT NULL
      AND signature_value IS NOT NULL AND verified_at IS NOT NULL
    )
  ),
  CONSTRAINT releases_one_per_workflow_run UNIQUE (project_id, workflow_provider, workflow_repo, workflow_run_id)
);

CREATE TABLE IF NOT EXISTS env_provisioning.release_artifacts (
  release_id UUID NOT NULL REFERENCES env_provisioning.releases(id) ON DELETE CASCADE,
  slot       TEXT NOT NULL CHECK (slot IN ('backend', 'frontend', 'standalone')),
  image      TEXT NOT NULL CHECK (image ~ '^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+$'),
  digest     TEXT NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (release_id, slot)
);

CREATE TABLE IF NOT EXISTS env_provisioning.environment_deployments (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id     UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  environment_id UUID        NOT NULL REFERENCES projects.project_environments(id) ON DELETE RESTRICT,
  release_id     UUID        NOT NULL REFERENCES env_provisioning.releases(id) ON DELETE RESTRICT,
  trigger        TEXT        NOT NULL CHECK (trigger IN ('automatic', 'promotion')),
  target_ids     UUID[]      NOT NULL DEFAULT '{}',
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'deploying', 'healthy', 'failed', 'rolled_back')),
  requested_by   UUID,
  detail         TEXT        CHECK (detail IS NULL OR length(detail) <= 2000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one deployment in flight per environment.
CREATE UNIQUE INDEX IF NOT EXISTS environment_deployments_one_in_flight
  ON env_provisioning.environment_deployments (environment_id)
  WHERE status IN ('pending', 'deploying');
CREATE INDEX IF NOT EXISTS environment_deployments_by_environment
  ON env_provisioning.environment_deployments (environment_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS env_provisioning.onprem_hosts (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id     UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  environment_id UUID        NOT NULL REFERENCES projects.project_environments(id) ON DELETE RESTRICT,
  name           TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  token_prefix   TEXT        NOT NULL,
  token_sha256   TEXT        NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ
);

ALTER TABLE env_provisioning.releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_provisioning.release_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_provisioning.environment_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_provisioning.onprem_hosts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON env_provisioning.releases FROM anon, authenticated;
REVOKE ALL ON env_provisioning.release_artifacts FROM anon, authenticated;
REVOKE ALL ON env_provisioning.environment_deployments FROM anon, authenticated;
REVOKE ALL ON env_provisioning.onprem_hosts FROM anon, authenticated;

-- A registered release keeps its identity; once verified, its signed manifest
-- is fixed too. Artifacts never change after registration.
CREATE OR REPLACE FUNCTION env_provisioning.keep_release_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  signing CONSTANT text[] := ARRAY[
    'verification_status', 'manifest', 'manifest_sha256', 'signature_algorithm',
    'signature_key_id', 'signature_value', 'verified_at'
  ];
  before_row jsonb := to_jsonb(OLD);
  after_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_TABLE_NAME = 'release_artifacts' THEN
    RAISE EXCEPTION 'Release artifacts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (before_row - signing) IS DISTINCT FROM (after_row - signing) THEN
    RAISE EXCEPTION 'Release identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF before_row ->> 'verification_status' = 'verified' AND before_row IS DISTINCT FROM after_row THEN
    RAISE EXCEPTION 'A verified release manifest is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS releases_keep_immutable ON env_provisioning.releases;
CREATE TRIGGER releases_keep_immutable
  BEFORE UPDATE ON env_provisioning.releases
  FOR EACH ROW EXECUTE FUNCTION env_provisioning.keep_release_immutable();

DROP TRIGGER IF EXISTS release_artifacts_keep_immutable ON env_provisioning.release_artifacts;
CREATE TRIGGER release_artifacts_keep_immutable
  BEFORE UPDATE ON env_provisioning.release_artifacts
  FOR EACH ROW EXECUTE FUNCTION env_provisioning.keep_release_immutable();
