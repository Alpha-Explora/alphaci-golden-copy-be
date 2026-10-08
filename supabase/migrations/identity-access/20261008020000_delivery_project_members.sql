-- Migration: 20261008020000_delivery_project_members
--
-- Purpose: Project (hierarchy delivery project) membership. A team lead or
-- admin adds QA Team people and Developers to a Project. Developers get
-- GitHub write on every repository of the Project through the existing
-- per-repository assignment machinery (hierarchy.repository_assignments); QA
-- members only matter inside ALPHACI (visibility, notifications) and never
-- produce a GitHub grant.
--
-- member_kind is derived by the service from the person's global app_role at
-- add time (member -> developer, qa -> qa). Leads and admins are never
-- members: they already see every Project of the team.
--
-- Removal is a state change (status = 'removed'), not a delete, so the row
-- keeps who added the person and when. Re-adding flips the same row back to
-- 'active' (UNIQUE (delivery_project_id, user_id)).
--
-- No FK to identity.app_users on user_id/added_by, matching
-- 20260713061000_hierarchy_core.sql and the assignments table.
--
-- Idempotent and cold-replay valid: depends only on hierarchy.delivery_projects.

CREATE TABLE IF NOT EXISTS hierarchy.delivery_project_members (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_project_id UUID        NOT NULL
                                  REFERENCES hierarchy.delivery_projects(id) ON DELETE CASCADE,
  user_id             UUID        NOT NULL,
  member_kind         TEXT        NOT NULL
                                  CHECK (member_kind IN ('developer', 'qa')),
  status              TEXT        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'removed')),
  added_by            UUID        NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_project_id, user_id)
);

-- Hot path: "active members of a Project" (list + new-repository fan-out).
CREATE INDEX IF NOT EXISTS idx_delivery_project_members_project_active
  ON hierarchy.delivery_project_members (delivery_project_id, member_kind)
  WHERE status = 'active';

-- Hot path: "Projects a person belongs to" and the team-removal cascade.
CREATE INDEX IF NOT EXISTS idx_delivery_project_members_user_active
  ON hierarchy.delivery_project_members (user_id)
  WHERE status = 'active';

ALTER TABLE hierarchy.delivery_project_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hierarchy.delivery_project_members FROM anon, authenticated;

-- hierarchy.repositories.origin: whether ALPHACI itself created the GitHub
-- repository ('created') or an existing org repository was attached to a
-- Project through Setup ('attached'). Automatic GitHub grants (creator and
-- Project Developers) are made ONLY on 'created' repositories: attaching an
-- existing repository must never hand the attacher or the Project's
-- Developers Write on it. Existing rows default to 'attached' (safe: no
-- discriminator exists for history); a lead grants those per repository.
ALTER TABLE hierarchy.repositories
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'attached'
  CHECK (origin IN ('created', 'attached'));

COMMENT ON TABLE hierarchy.delivery_project_members
  IS 'People a lead/admin added to a Project (delivery project): developer (GitHub write on every repository of the Project via repository_assignments) or qa (ALPHACI-only, no GitHub grant). RLS deny-by-default.';
