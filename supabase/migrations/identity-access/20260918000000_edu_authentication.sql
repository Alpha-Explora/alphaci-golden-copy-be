-- Migration: edu_authentication
-- Purpose: Add the isolated EDU identity, lab, membership, and Supabase
-- subject-binding tables used by the EDU auth vertical slice.
--
-- Passwords and recovery tokens remain in Supabase Auth. These tables store
-- only the application subject binding and authorization state required by the
-- Golden Copy session. No SaaS/Enterprise provider or workspace rows are used.

BEGIN;

ALTER TABLE identity.user_identities
  DROP CONSTRAINT IF EXISTS user_identities_provider_check;

ALTER TABLE identity.user_identities
  ADD CONSTRAINT user_identities_provider_check
  CHECK (provider IN ('email', 'google', 'github', 'supabase'));

CREATE TABLE IF NOT EXISTS identity.edu_labs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  github_org_name TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT edu_labs_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT edu_labs_github_org_not_blank CHECK (length(btrim(github_org_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS edu_labs_name_ci_unique
  ON identity.edu_labs (lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS edu_labs_github_org_ci_unique
  ON identity.edu_labs (lower(github_org_name));

CREATE TABLE IF NOT EXISTS identity.edu_profiles (
  user_id           UUID PRIMARY KEY REFERENCES identity.app_users(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  normalized_email  TEXT NOT NULL,
  full_name         TEXT NOT NULL,
  role              TEXT NOT NULL
                    CHECK (role IN ('STUDENT', 'TEACHER', 'ADMIN', 'SUPER_ADMIN')),
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  home_lab_id       UUID NULL REFERENCES identity.edu_labs(id) ON DELETE SET NULL,
  github_user_id    TEXT NULL,
  github_login      TEXT NULL,
  github_avatar_url TEXT NULL,
  github_profile_url TEXT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT edu_profiles_email_not_blank CHECK (length(btrim(email)) > 0),
  CONSTRAINT edu_profiles_full_name_not_blank CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT edu_profiles_normalized_email_unique UNIQUE (normalized_email),
  CONSTRAINT edu_profiles_github_user_unique UNIQUE (github_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS edu_profiles_github_login_ci_unique
  ON identity.edu_profiles (lower(github_login))
  WHERE github_login IS NOT NULL;

CREATE INDEX IF NOT EXISTS edu_profiles_role_status_idx
  ON identity.edu_profiles (role, status);

CREATE TABLE IF NOT EXISTS identity.edu_lab_memberships (
  user_id    UUID NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  lab_id     UUID NOT NULL REFERENCES identity.edu_labs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, lab_id)
);

CREATE INDEX IF NOT EXISTS edu_lab_memberships_lab_user_idx
  ON identity.edu_lab_memberships (lab_id, user_id);

ALTER TABLE identity.edu_labs ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.edu_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.edu_lab_memberships ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON identity.edu_labs FROM anon, authenticated;
REVOKE ALL ON identity.edu_profiles FROM anon, authenticated;
REVOKE ALL ON identity.edu_lab_memberships FROM anon, authenticated;

COMMIT;
