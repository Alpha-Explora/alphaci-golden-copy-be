-- Migration: 20260713130000_user_global_app_role
--
-- Purpose: introduce a single GLOBAL role per user that governs hierarchy
-- capabilities everywhere, replacing per-group role management. Roles are
-- assigned centrally in the Admin Console; the Groups tab only displays them.
--
--   'admin'  — full override (platform admin powers, archive any group)
--   'lead'   — may create/manage groups, systems, projects, repos; invite;
--              assign members to repositories
--   'member' — default; may only access repositories they are assigned to
--
-- The pre-existing orgs.workspace_members.role column stays in place (it still
-- records who belongs to which group) but is no longer the source of truth for
-- authorization — the access layer derives the effective role from app_role.
-- Additive and idempotent: every existing user defaults to 'member'.
ALTER TABLE identity.app_users
  ADD COLUMN IF NOT EXISTS app_role TEXT NOT NULL DEFAULT 'member'
    CHECK (app_role IN ('admin', 'lead', 'member'));

CREATE INDEX IF NOT EXISTS idx_app_users_app_role
  ON identity.app_users (app_role);
