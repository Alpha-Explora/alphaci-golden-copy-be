-- Migration: 20260714010000_workspace_members_role_check_widen
--
-- Purpose: unblock Group invitation ACCEPT (and member role changes) without
-- running the high-blast-radius data rename in 20260714000000_role_value_rename.
--
-- Root cause (found 2026-07-14): the hierarchy/Groups code and the
-- orgs.group_invitations table were built on the NEW role vocabulary
-- ('admin','delegated_lead','member','viewer'), but the shared
-- orgs.workspace_members.role CHECK on this database is still the OLD vocabulary
-- ('owner','admin','developer','viewer'). Accepting an invitation copies the
-- invitation's role ('member') into orgs.workspace_members, which the old CHECK
-- rejects, so the request 500s ("could not be accepted").
--
-- Why widen instead of rename: on this database the stored role column is
-- non-authoritative (all authorization derives from identity.app_users.app_role
-- via CASE expressions), and the data does NOT match the rename's assumptions —
-- newer code (createGroup) already writes 'admin' for the top tier, so
-- 20260714000000's owner->admin / admin->delegated_lead remap would demote
-- existing 'admin' owners. This migration therefore only WIDENS the CHECK to a
-- superset of both vocabularies and rewrites NO rows.
--
-- Idempotent: re-running is a no-op once the CHECK already accepts both 'member'
-- and 'delegated_lead'. Dynamic constraint-name lookup mirrors the pattern in
-- 20260714000000_role_value_rename.sql (never guess Postgres's generated name).
--
-- Interaction with 20260714000000: that migration's guard skips its data remap
-- when the role CHECK already contains 'delegated_lead'. After this migration
-- runs, that guard is satisfied, so the destructive rename becomes a safe no-op
-- if it is ever applied afterward.
DO $$
DECLARE
  v_role_attnum     smallint;
  v_constraint_name text;
  v_constraint_def  text;
BEGIN
  SELECT attnum INTO v_role_attnum
  FROM pg_attribute
  WHERE attrelid = 'orgs.workspace_members'::regclass
    AND attname = 'role'
    AND NOT attisdropped;

  IF v_role_attnum IS NULL THEN
    RAISE EXCEPTION 'orgs.workspace_members.role column not found — aborting widen migration';
  END IF;

  SELECT conname, pg_get_constraintdef(oid)
    INTO v_constraint_name, v_constraint_def
  FROM pg_constraint
  WHERE conrelid = 'orgs.workspace_members'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[v_role_attnum];

  -- Already widened (accepts both new-vocab markers) — safe no-op on re-run.
  IF v_constraint_def IS NOT NULL
     AND v_constraint_def LIKE '%delegated_lead%'
     AND v_constraint_def LIKE '%member%' THEN
    RETURN;
  END IF;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE orgs.workspace_members DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  ALTER TABLE orgs.workspace_members
    ADD CONSTRAINT workspace_members_role_check
    CHECK (role IN (
      -- legacy vocabulary (pre-20260714000000 data still uses these)
      'owner', 'admin', 'developer', 'viewer',
      -- new vocabulary the hierarchy/Groups code writes
      'delegated_lead', 'member'
    ));
END $$;
