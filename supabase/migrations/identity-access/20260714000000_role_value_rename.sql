-- Migration: 20260714000000_role_value_rename
--
-- Purpose: rename stored orgs.workspace_members.role wire values to match the
-- product's already-shipped display labels (GROUP_ROLE_LABELS in
-- modules/hierarchy/hierarchy.types.ts / lib/api/hierarchy-contracts.ts):
--   owner -> admin, admin -> delegated_lead, developer -> member, viewer unchanged.
-- See docs/ROLE_VALUE_RENAME_PLAN.md for full context, especially:
--   §1 — why this is HIGH BLAST RADIUS: orgs.workspace_members.role is the
--        SAME shared column used by the pre-existing Workspaces / Projects /
--        Env-provisioning features, not just the new Groups/Hierarchy
--        feature. A personal workspace's 'owner' becomes 'admin' too.
--   §5 — deployment safety: the stored value and the code that reads/writes
--        it must change together. DO NOT apply this migration to prod until
--        the corresponding backend/frontend code (plan §3.2/§3.3) is merged
--        and ready to deploy in the same window (maintenance window,
--        recommended for this internal tool per plan §5 — pending explicit
--        user go-ahead). See docs/ROLE_RENAME_SCHEMA_CHANGES_FOR_APPROVAL.md
--        for the approval summary.
--
-- Confirmed value mapping (plan §2.1, CONFIRMED 2026-07-14 — this supersedes
-- an earlier draft of this same file that used 'lead' as the top-tier stored
-- value; the user explicitly chose 'admin' instead):
--   owner -> admin, admin -> delegated_lead, developer -> member, viewer -> viewer.
--
-- ⚠️ 'admin' is now OVERLOADED across two unrelated systems:
--   - orgs.workspace_members.role = 'admin'  → the TOP membership tier for a
--     workspace/Group (old 'owner'), product label "Lead". This table.
--   - identity.platform_admins.role = 'admin' → the platform-wide support/
--     oversight tier, completely separate table/column, UNTOUCHED by this
--     migration. See plan §1's explicit callout: do NOT touch
--     identity.platform_admins.
-- The display label for the top workspace tier is still "Lead" — only the
-- stored/API string changed from the originally-planned 'lead' to 'admin'.
-- The former second-tier value 'admin' (delegated manager) moved to
-- 'delegated_lead' to make room, so there is no collision WITHIN this
-- column — but readers of this migration must not assume 'admin' here means
-- the same thing as identity.platform_admins.role = 'admin'.
--
-- Scope deviation from the plan's literal §3.1 draft: the plan's draft SQL
-- also alters orgs.group_invitations in this same file. That table is
-- introduced by 20260713060000_group_lifecycle.sql, which has NOT shipped to
-- prod as of this writing (2026-07-14) — it is still in the same
-- pre-approval batch as this migration. Rather than create
-- group_invitations with the OLD vocabulary here and immediately re-alter
-- it in the same deploy, 20260713060000_group_lifecycle.sql's CHECK
-- constraint was edited in place to use the NEW vocabulary directly
-- ('delegated_lead', 'member', 'viewer' — no 'admin'/top-tier value,
-- ownership is never invited directly, unchanged from the plan's original
-- intent). See that file's updated comments for detail. This migration
-- therefore only needs to handle the ALREADY-LIVE orgs.workspace_members
-- table.
--
-- Constraint-name lookup (why a DO block instead of a guessed DROP
-- CONSTRAINT name): plan §3.1 explicitly flags the risk of guessing
-- Postgres's auto-generated CHECK constraint name — a wrong guess either
-- no-ops the DROP (constraint survives, the later ADD then collides with
-- the still-live old CHECK) or, worse, silently fails to remove the old
-- vocabulary's constraint. Instead of guessing, this migration looks up the
-- real constraint by finding the single-column CHECK constraint on
-- orgs.workspace_members whose conkey matches the 'role' column's attnum
-- via pg_attribute + pg_constraint, then drops it dynamically with
-- EXECUTE format(...). This mirrors the DO-block precedent already used in
-- this repo for the same class of problem
-- (20260610_vercel_deployment_strategy.sql's guarded ADD CONSTRAINT).
--
-- ⚠️ Idempotency guard is NOT optional here, unlike a typical rename. Because
-- 'admin' is reused (old second tier -> new top tier), a naive re-run of
-- "UPDATE ... WHERE role = 'admin'" after this migration already succeeded
-- would match the NEW top-tier rows (former owners) and wrongly demote them
-- to 'delegated_lead' — silent data corruption on a retried deploy step.
-- Everything below therefore runs inside ONE DO block that first checks
-- whether the CHECK constraint already reflects the new vocabulary (using
-- 'delegated_lead' as a marker string that only ever appears in the NEW
-- definition, never the old one) and exits immediately if so, before any
-- UPDATE runs. This makes the whole migration a true no-op on re-run rather
-- than relying on each statement being independently idempotent.
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
    RAISE EXCEPTION 'orgs.workspace_members.role column not found — aborting role rename migration';
  END IF;

  SELECT conname, pg_get_constraintdef(oid)
    INTO v_constraint_name, v_constraint_def
  FROM pg_constraint
  WHERE conrelid = 'orgs.workspace_members'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[v_role_attnum];

  -- Already applied — the current CHECK already speaks the new vocabulary.
  -- Skip everything below so re-running this file is a safe no-op.
  IF v_constraint_def IS NOT NULL AND v_constraint_def LIKE '%delegated_lead%' THEN
    RETURN;
  END IF;

  -- 1) Drop the existing CHECK constraint, whatever it's actually named.
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE orgs.workspace_members DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  -- 2) Remap existing data. No `kind = ...` filter: role is a SHARED column
  -- across personal AND team workspaces (plan §1). Every row with a
  -- matching old value is remapped regardless of workspace kind, preserving
  -- exact row counts — each UPDATE only changes the role column in place,
  -- never inserts or deletes rows.
  --
  -- STATEMENT ORDER IS LOAD-BEARING within this block: because the new
  -- top-tier value 'admin' collides with the OLD second-tier value 'admin',
  -- these three UPDATEs are not order-independent. Moving old-'admin' rows
  -- to 'delegated_lead' FIRST (while 'admin' still unambiguously means the
  -- old second tier) means that by the time 'owner' rows are moved into
  -- 'admin', no row can still match the old meaning of 'admin'. Do not
  -- reorder.
  UPDATE orgs.workspace_members SET role = 'delegated_lead' WHERE role = 'admin';
  UPDATE orgs.workspace_members SET role = 'admin'          WHERE role = 'owner';
  UPDATE orgs.workspace_members SET role = 'member'         WHERE role = 'developer';
  -- 'viewer' is unchanged by design (plan §2.1) — no UPDATE needed.

  -- 3) Re-add the CHECK with the new vocabulary, under an explicit,
  -- predictable name — no future lookup will be needed to reference it
  -- again (the rollback and any later migration can just use this name).
  ALTER TABLE orgs.workspace_members
    ADD CONSTRAINT workspace_members_role_check
    CHECK (role IN ('admin', 'delegated_lead', 'member', 'viewer'));
END $$;
