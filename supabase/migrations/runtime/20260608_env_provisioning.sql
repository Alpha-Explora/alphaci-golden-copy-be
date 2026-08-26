-- Migration: env_provisioning
-- Stores provider connections, deployment targets, and metadata-only env var state.

CREATE SCHEMA IF NOT EXISTS env_provisioning;

CREATE TABLE IF NOT EXISTS env_provisioning.provider_connections (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN ('render', 'vercel')),
  label            TEXT        NOT NULL,
  encrypted_token  TEXT        NOT NULL,
  token_last_four  TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_user_provider
  ON env_provisioning.provider_connections (user_id, provider, status);

CREATE TABLE IF NOT EXISTS env_provisioning.project_deployment_targets (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                 UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  slot                       TEXT        NOT NULL CHECK (slot IN ('backend', 'frontend', 'standalone')),
  ownership_mode             TEXT        NOT NULL CHECK (ownership_mode IN ('byo', 'flowci_managed')),
  provider                   TEXT        NOT NULL CHECK (provider IN ('render', 'vercel')),
  provider_connection_id     UUID        NULL REFERENCES env_provisioning.provider_connections(id) ON DELETE SET NULL,
  provider_project_id        TEXT        NOT NULL,
  provider_project_name      TEXT        NOT NULL,
  repo_full_name             TEXT        NOT NULL,
  branch_name                TEXT        NOT NULL,
  root_directory             TEXT        NULL,
  build_command              TEXT        NULL,
  start_command              TEXT        NULL,
  environment_map            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status                     TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'missing', 'failed')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_deployment_targets_project
  ON env_provisioning.project_deployment_targets (project_id, status);

CREATE TABLE IF NOT EXISTS env_provisioning.project_env_var_metadata (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  deployment_target_id  UUID        NOT NULL REFERENCES env_provisioning.project_deployment_targets(id) ON DELETE CASCADE,
  environment           TEXT        NOT NULL CHECK (environment IN ('test', 'uat', 'production')),
  key                   TEXT        NOT NULL,
  provider              TEXT        NOT NULL CHECK (provider IN ('render', 'vercel')),
  value_stored          BOOLEAN     NOT NULL DEFAULT false CHECK (value_stored = false),
  last_provisioned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_provisioned_by   UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  status                TEXT        NOT NULL CHECK (status IN ('provisioned', 'failed')),
  error_summary         TEXT        NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deployment_target_id, environment, key)
);

CREATE INDEX IF NOT EXISTS idx_project_env_var_metadata_project
  ON env_provisioning.project_env_var_metadata (project_id, deployment_target_id, environment);

CREATE OR REPLACE FUNCTION env_provisioning.set_env_provisioning_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_connections_updated_at ON env_provisioning.provider_connections;
CREATE TRIGGER trg_provider_connections_updated_at
  BEFORE UPDATE ON env_provisioning.provider_connections
  FOR EACH ROW EXECUTE FUNCTION env_provisioning.set_env_provisioning_updated_at();

DROP TRIGGER IF EXISTS trg_project_deployment_targets_updated_at ON env_provisioning.project_deployment_targets;
CREATE TRIGGER trg_project_deployment_targets_updated_at
  BEFORE UPDATE ON env_provisioning.project_deployment_targets
  FOR EACH ROW EXECUTE FUNCTION env_provisioning.set_env_provisioning_updated_at();

DROP TRIGGER IF EXISTS trg_project_env_var_metadata_updated_at ON env_provisioning.project_env_var_metadata;
CREATE TRIGGER trg_project_env_var_metadata_updated_at
  BEFORE UPDATE ON env_provisioning.project_env_var_metadata
  FOR EACH ROW EXECUTE FUNCTION env_provisioning.set_env_provisioning_updated_at();
