-- Migration: 20260713061000_hierarchy_core
--
-- Purpose: Phase 2/3 hierarchy nodes below a Group — Systems, Delivery
-- Projects, Repositories (see docs/HIERARCHY_IMPLEMENTATION_PLAN.md §1.4,
-- §1.5, §3.1 file 2).
--
-- Naming: the source plan's "Project" entity is named hierarchy.delivery_
-- projects (not hierarchy.projects) everywhere — the `projects` schema
-- already exists (projects.provisioned_projects) and a hierarchy.projects
-- table sitting next to it would be genuinely ambiguous in psql/migrations/
-- code. See plan §1.4 and §2.3 for the full disambiguation.
--
-- FK/attribution design: group_id / system_id / delivery_project_id are
-- structural containment FKs (ON DELETE CASCADE — deleting a parent node
-- removes its children, mirroring orgs.workspace_members.workspace_id's
-- existing CASCADE behavior). owner_id / manager_id / created_by are
-- attribution-only columns (plain UUID, NO foreign key to
-- identity.app_users) — same deliberate choice and same reasoning as
-- 20260713060000_group_lifecycle.sql: a hierarchy tree (system -> delivery
-- project -> repository -> assignments) must never be cascade-deleted just
-- because the human who happened to create/manage a node had their account
-- purged. This is a documented deviation from the plan's §1.4 prose
-- ("FKs into orgs.workspaces/identity.app_users") — the orgs.workspaces
-- half of that sentence is implemented as a real FK below; the
-- identity.app_users half is not, for the reason above.

CREATE SCHEMA IF NOT EXISTS hierarchy;

-- ─── hierarchy.systems ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hierarchy.systems (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT        NULL,
  owner_id     UUID        NULL,
  status       TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hierarchy_systems_group_status
  ON hierarchy.systems (group_id, status);

-- ─── hierarchy.delivery_projects ─────────────────────────────────────────
-- group_id is denormalized from systems.group_id on purpose: it lets every
-- delivery-project/repository-scoped authorization check join straight to
-- orgs.workspace_members without an extra hop through hierarchy.systems,
-- which is the exact hot path HierarchyAccessService.assertGroupRole hits
-- on nearly every request in §2.5/§2.6.
CREATE TABLE IF NOT EXISTS hierarchy.delivery_projects (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id    UUID        NOT NULL REFERENCES hierarchy.systems(id) ON DELETE CASCADE,
  group_id     UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT        NULL,
  manager_id   UUID        NULL,
  status       TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hierarchy_delivery_projects_system_status
  ON hierarchy.delivery_projects (system_id, status);

CREATE INDEX IF NOT EXISTS idx_hierarchy_delivery_projects_group
  ON hierarchy.delivery_projects (group_id);

-- ─── hierarchy.repositories ───────────────────────────────────────────────
-- visibility is constrained to 'private' only, matching the plan's explicit
-- "private only — enforced, not just defaulted" requirement (§2.6) at the
-- database layer as well as the service layer.
--
-- provisioned_project_id is the §1.5 mapping to the pre-existing dashboard/
-- CI-configured record. It is nullable both directions and UNIQUE (a
-- hierarchy repository maps to at most one provisioned project, and vice
-- versa). No backfill of pre-existing provisioned_projects rows happens in
-- this migration — see plan §1.5/§4, deliberately deferred.
CREATE TABLE IF NOT EXISTS hierarchy.repositories (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_project_id    UUID        NOT NULL REFERENCES hierarchy.delivery_projects(id) ON DELETE CASCADE,
  group_id               UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  name                   TEXT        NOT NULL,
  repo_full_name         TEXT        NULL,  -- e.g. "acme-org/my-service", matches existing repo_full_name convention
  github_repo_id         BIGINT      NULL,  -- GitHub numeric repository id, populated after creation
  visibility             TEXT        NOT NULL DEFAULT 'private' CHECK (visibility IN ('private')),
  created_by             UUID        NULL,
  status                 TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'archived')),
  archived_at            TIMESTAMPTZ NULL,
  provisioned_project_id UUID        NULL UNIQUE REFERENCES projects.provisioned_projects(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hierarchy_repositories_delivery_project_status
  ON hierarchy.repositories (delivery_project_id, status);

CREATE INDEX IF NOT EXISTS idx_hierarchy_repositories_group
  ON hierarchy.repositories (group_id);

-- Hot path: GET /repositories/:repositoryId resolving back to a
-- provisioned_projects row (dashboard/CI data join).
CREATE INDEX IF NOT EXISTS idx_hierarchy_repositories_provisioned_project
  ON hierarchy.repositories (provisioned_project_id)
  WHERE provisioned_project_id IS NOT NULL;

-- ─── RLS: deny-by-default on all three new tables ────────────────────────
ALTER TABLE hierarchy.systems           ENABLE ROW LEVEL SECURITY;
ALTER TABLE hierarchy.delivery_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE hierarchy.repositories      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON hierarchy.systems           FROM anon, authenticated;
REVOKE ALL ON hierarchy.delivery_projects FROM anon, authenticated;
REVOKE ALL ON hierarchy.repositories      FROM anon, authenticated;

COMMENT ON TABLE hierarchy.systems
  IS 'Business/technical system owned by one Group (orgs.workspaces kind=team). RLS deny-by-default; reachable only via the backend service-role client.';
COMMENT ON TABLE hierarchy.delivery_projects
  IS 'Delivery initiative under a System. API/DTO term is "Project" — named delivery_projects in SQL to avoid colliding with the pre-existing projects schema (projects.provisioned_projects). RLS deny-by-default.';
COMMENT ON TABLE hierarchy.repositories
  IS 'GitHub repository owned by a Delivery Project, access-controlled by AlphaCI. provisioned_project_id links to the pre-existing CI/dashboard record when one exists. RLS deny-by-default.';
