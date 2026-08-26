-- Migration: 20260601_github_installations
-- Purpose: Store GitHub App installations linked by users, plus their
--          individual repository grants so the Create Project wizard can
--          offer repos from GitHub App access rather than OAuth token scope.
--
-- Run in the Supabase SQL editor (or via supabase db push on a local stack).

-- ─── github_installations ────────────────────────────────────────────────────
-- One row per GitHub App installation.  A user may have multiple installations
-- (e.g. personal account + one or more organisations).

CREATE TABLE IF NOT EXISTS github_installations (
  id                   BIGSERIAL PRIMARY KEY,
  installation_id      BIGINT        NOT NULL,
  user_id              TEXT          NOT NULL,          -- matches session user.id
  account_login        TEXT,                            -- GitHub login of the installed account
  account_id           BIGINT,                         -- GitHub numeric account id
  repository_selection TEXT          NOT NULL DEFAULT 'selected' CHECK (repository_selection IN ('all', 'selected')),
  repos_linked         INTEGER       NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT github_installations_installation_id_key UNIQUE (installation_id)
);

CREATE INDEX IF NOT EXISTS idx_github_installations_user_id
  ON github_installations (user_id);

-- ─── github_installation_repos ───────────────────────────────────────────────
-- One row per repository granted under a GitHub App installation.
-- Populated asynchronously (webhook or on-demand API call).

CREATE TABLE IF NOT EXISTS github_installation_repos (
  id               BIGSERIAL PRIMARY KEY,
  installation_id  BIGINT  NOT NULL REFERENCES github_installations (installation_id) ON DELETE CASCADE,
  repo_full_name   TEXT    NOT NULL,    -- e.g. "acme-org/my-service"
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT github_installation_repos_unique UNIQUE (installation_id, repo_full_name)
);

CREATE INDEX IF NOT EXISTS idx_github_installation_repos_installation_id
  ON github_installation_repos (installation_id);
