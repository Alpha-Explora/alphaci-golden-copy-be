-- Migration: 20260713060000_group_lifecycle
--
-- Purpose: Phase 2 of the AlphaCI hierarchy/access plan (see
-- docs/HIERARCHY_IMPLEMENTATION_PLAN.md §3.1 file 1, §1.1-§1.2).
--
-- "Group" is a PRODUCT LABEL on the existing orgs.workspaces table where
-- kind = 'team' — this migration does not create a new Group entity table.
-- It only (a) adds lifecycle/attribution columns to the two tables that
-- already back workspaces, and (b) adds the one genuinely new table this
-- phase requires: pending/accepted/declined/revoked/expired invitations.
--
-- ADDITIVE ONLY:
--   - orgs.workspaces.kind CHECK ('personal','team') is UNCHANGED.
--   - orgs.workspace_members.role CHECK ('owner','admin','developer','viewer')
--     is UNCHANGED. Every existing membership row keeps working exactly as
--     today; the personal-workspace flow does not read any column below.
--   - Every existing row defaults to status='active' / member_status='active',
--     so current behavior for existing workspaces/members is unaffected.
--
-- Design note on FK style for the new *_by / invited_user_id columns: this
-- migration deliberately does NOT add a foreign key to identity.app_users on
-- any of these columns, matching the existing orgs.workspaces.owner_user_id
-- and orgs.workspace_members.user_id columns (both plain UUID, no FK — see
-- 20260614_workspaces_audit_notifications.sql). This is a conscious deviation
-- from the newer provisioned_projects/platform_admins convention of
-- FK ... ON DELETE CASCADE to identity.app_users, because a hard user-account
-- purge (identity.purge_expired_archived_accounts) must never cascade-delete
-- Group membership/invitation history — the source plan (§4.5-§4.6) requires
-- historical activity and audit trail to remain visible after a member is
-- removed or a Group is archived.

-- ─── orgs.workspaces: Group profile + archive lifecycle ─────────────────────
ALTER TABLE orgs.workspaces
  ADD COLUMN IF NOT EXISTS description   TEXT        NULL,
  ADD COLUMN IF NOT EXISTS business_unit TEXT        NULL,
  ADD COLUMN IF NOT EXISTS status        TEXT        NOT NULL DEFAULT 'active'
                                          CHECK (status IN ('active', 'archived')),
  ADD COLUMN IF NOT EXISTS archived_at   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS archived_by   UUID        NULL;

-- ─── orgs.workspace_members: invitation-aware membership lifecycle ──────────
ALTER TABLE orgs.workspace_members
  ADD COLUMN IF NOT EXISTS member_status   TEXT        NOT NULL DEFAULT 'active'
                                            CHECK (member_status IN ('invited', 'active', 'removed')),
  ADD COLUMN IF NOT EXISTS invited_by      UUID        NULL,
  ADD COLUMN IF NOT EXISTS invited_at      TIMESTAMPTZ NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS removed_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS removed_by      UUID        NULL,
  ADD COLUMN IF NOT EXISTS removal_reason  TEXT        NULL;

-- Hot path: "active membership lookup" for a given workspace/Group
-- (powers assertGroupRole / assertActiveRepositoryAssignment-style checks).
CREATE INDEX IF NOT EXISTS idx_workspace_members_active
  ON orgs.workspace_members (workspace_id)
  WHERE member_status = 'active';

-- ─── orgs.group_invitations: new table, invitation lifecycle only ──────────
-- role excludes 'admin' (the new top-tier value, old 'owner') on purpose —
-- ownership only ever changes via the /groups/:groupId/transfer endpoint
-- (source plan §2.4), never an invite.
--
-- Vocabulary note (added 2026-07-14, updated 2026-07-14 for the confirmed
-- mapping correction — see docs/ROLE_VALUE_RENAME_PLAN.md §2.1): this CHECK
-- is authored directly with the POST-RENAME role vocabulary
-- ('delegated_lead', 'member', 'viewer' — the plan's §2.1 signed-off mapping
-- of the old 'admin'/'developer'/'viewer') even though the matching rename
-- of the already-live orgs.workspace_members.role column happens in a
-- separate migration (20260714000000_role_value_rename.sql). This table is
-- new and has not shipped to prod yet, so there is no old-vocabulary data to
-- migrate here — authoring it with the final vocabulary up front avoids
-- creating it with 'admin'/'developer' only to immediately re-alter it in
-- the same release. See 20260714000000_role_value_rename.sql's header for
-- the full reasoning, INCLUDING the important note that 'admin' is now
-- overloaded: it means the top workspace-membership tier in
-- orgs.workspace_members.role (old 'owner'), but that value never appears
-- in THIS table's CHECK — group_invitations never grants the owner-
-- equivalent role, so no ambiguity is introduced here.
CREATE TABLE IF NOT EXISTS orgs.group_invitations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  invited_user_id UUID        NOT NULL,
  invited_by      UUID        NOT NULL,
  role            TEXT        NOT NULL CHECK (role IN ('delegated_lead', 'member', 'viewer')),
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at    TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NULL
);

-- Hot path: "GET /groups/invitations/:invitationId/accept|decline" callers
-- and a user's own pending-invitation inbox.
CREATE INDEX IF NOT EXISTS idx_group_invitations_invitee_status
  ON orgs.group_invitations (invited_user_id, status);

-- Hot path: "GET /groups/:groupId/invitations" (lead/admin invitation list).
CREATE INDEX IF NOT EXISTS idx_group_invitations_workspace_status
  ON orgs.group_invitations (workspace_id, status);

-- Defense-in-depth beyond the plan's literal minimum: prevent two concurrent
-- pending invitations for the same person in the same Group (the service
-- layer should already guard this, but a partial unique index makes it
-- impossible to race past that check).
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_invitations_pending_invitee
  ON orgs.group_invitations (workspace_id, invited_user_id)
  WHERE status = 'pending';

-- ─── RLS: deny-by-default on the new table, matching every table added
-- since 20260616/20260617 in this codebase. The backend's service-role
-- connection has BYPASSRLS, so this has zero effect on the API; it only
-- blocks the anon/authenticated Supabase keys from reading or writing
-- invitations directly. orgs.workspaces / orgs.workspace_members already
-- have RLS enabled as of 20260617_enable_rls_exposed_tables.sql — unchanged
-- here.
ALTER TABLE orgs.group_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON orgs.group_invitations FROM anon, authenticated;

COMMENT ON TABLE orgs.group_invitations
  IS 'Group (orgs.workspaces kind=team) invitation lifecycle. RLS deny-by-default; reachable only via the backend service-role client. Authorization enforced in the API layer.';
