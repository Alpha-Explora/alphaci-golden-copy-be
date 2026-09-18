-- Migration: 20260918000000_tenancy_kernel
--
-- Additive tenancy foundation for the existing identity-access boundary.
--
-- The database is the physical deployment boundary in this phase: a hosted
-- database may contain multiple tenants, while Enterprise provisioning must
-- bind one tenant to its dedicated database. Edition schemas and a
-- product-level deployment_instances table are deliberately out of scope.
--
-- Existing workspace/project rows are not backfilled here. Their tenant_id
-- columns remain nullable until an explicit provisioning/backfill operation
-- can prove the tenant identity for each selected row.

CREATE SCHEMA IF NOT EXISTS tenancy;

CREATE TABLE IF NOT EXISTS tenancy.tenants (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  kind        TEXT        NOT NULL DEFAULT 'customer'
                          CHECK (kind IN ('customer', 'institution', 'enterprise')),
  status      TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenants_slug_check
    CHECK (
      slug = LOWER(slug)
      AND slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
    ),
  CONSTRAINT tenants_name_check CHECK (LENGTH(BTRIM(name)) > 0),
  CONSTRAINT tenants_slug_key UNIQUE (slug)
);

COMMENT ON TABLE tenancy.tenants IS
  'Database-local tenant root. Hosted databases may contain multiple tenants; Enterprise provisioning binds one tenant to its dedicated database. Edition selection is not a schema concern.';

CREATE TABLE IF NOT EXISTS tenancy.tenant_memberships (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID        NOT NULL,
  user_id     UUID        NOT NULL,
  role        TEXT        NOT NULL DEFAULT 'member'
                          CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status      TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_memberships_tenant_fkey
    FOREIGN KEY (tenant_id)
    REFERENCES tenancy.tenants(id)
    ON DELETE CASCADE,
  CONSTRAINT tenant_memberships_user_fkey
    FOREIGN KEY (user_id)
    REFERENCES identity.app_users(id)
    ON DELETE CASCADE,
  CONSTRAINT tenant_memberships_tenant_user_key UNIQUE (tenant_id, user_id)
);

COMMENT ON TABLE tenancy.tenant_memberships IS
  'Tenant authorization membership. Deleting a tenant removes its memberships; deleting an identity removes only that identity''s memberships.';

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user_status
  ON tenancy.tenant_memberships (user_id, status, tenant_id);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant_status
  ON tenancy.tenant_memberships (tenant_id, status, user_id);

CREATE TABLE IF NOT EXISTS tenancy.tenant_units (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID        NOT NULL,
  parent_unit_id UUID       NULL,
  slug          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  kind          TEXT        NOT NULL DEFAULT 'unit'
                            CHECK (kind IN ('unit', 'campus', 'lab')),
  status        TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'archived')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_units_tenant_fkey
    FOREIGN KEY (tenant_id)
    REFERENCES tenancy.tenants(id)
    ON DELETE CASCADE,
  CONSTRAINT tenant_units_parent_fkey
    FOREIGN KEY (tenant_id, parent_unit_id)
    REFERENCES tenancy.tenant_units(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT tenant_units_parent_not_self_check
    CHECK (parent_unit_id IS NULL OR parent_unit_id <> id),
  CONSTRAINT tenant_units_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT tenant_units_tenant_slug_key UNIQUE (tenant_id, slug),
  CONSTRAINT tenant_units_name_check CHECK (LENGTH(BTRIM(name)) > 0)
);

COMMENT ON TABLE tenancy.tenant_units IS
  'Optional tenant-local hierarchy for institution campuses, labs, or other units. Parent deletion cascades through structural child units.';

CREATE INDEX IF NOT EXISTS idx_tenant_units_tenant_status
  ON tenancy.tenant_units (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_units_parent
  ON tenancy.tenant_units (tenant_id, parent_unit_id)
  WHERE parent_unit_id IS NOT NULL;

-- Existing roots expand safely: NULL means legacy/unclassified until an
-- explicit provisioning or backfill operation supplies a proven tenant.
ALTER TABLE orgs.workspaces
  ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;

ALTER TABLE projects.provisioned_projects
  ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'orgs.workspaces'::regclass
      AND conname = 'workspaces_tenant_fkey'
  ) THEN
    ALTER TABLE orgs.workspaces
      ADD CONSTRAINT workspaces_tenant_fkey
      FOREIGN KEY (tenant_id)
      REFERENCES tenancy.tenants(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'projects.provisioned_projects'::regclass
      AND conname = 'provisioned_projects_tenant_fkey'
  ) THEN
    ALTER TABLE projects.provisioned_projects
      ADD CONSTRAINT provisioned_projects_tenant_fkey
      FOREIGN KEY (tenant_id)
      REFERENCES tenancy.tenants(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_created
  ON orgs.workspaces (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provisioned_projects_tenant_created
  ON projects.provisioned_projects (tenant_id, created_at DESC);

COMMENT ON COLUMN orgs.workspaces.tenant_id IS
  'Nullable tenancy expansion column. Existing rows remain NULL until an explicit operation proves their tenant identity; this migration performs no backfill.';

COMMENT ON COLUMN projects.provisioned_projects.tenant_id IS
  'Nullable tenancy expansion column. Existing rows remain NULL until an explicit operation proves their tenant identity; this migration performs no backfill.';

-- These tables are reachable through the backend service role only. Keep the
-- Supabase anon/authenticated roles deny-by-default while application-level
-- tenant authorization is introduced in a later phase.
ALTER TABLE tenancy.tenants           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.tenant_units      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON tenancy.tenants            FROM anon, authenticated;
REVOKE ALL ON tenancy.tenant_memberships FROM anon, authenticated;
REVOKE ALL ON tenancy.tenant_units       FROM anon, authenticated;
