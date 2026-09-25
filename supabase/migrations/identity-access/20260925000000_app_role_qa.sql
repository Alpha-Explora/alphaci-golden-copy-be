-- Migration: 20260925000000_app_role_qa
--
-- Purpose: add the 'qa' global app_role (QA Team persona). It is derived from
-- the GitHub org team GITHUB_TEAM_QA_SLUG (default `qa-team`) exactly like
-- 'lead' and 'member', with precedence lead > qa > member.
--
-- Authorization stance: 'qa' has NO creator or manager power. It is read-and-
-- verify only. The application code that used to test `app_role = 'member'`
-- by exclusion (groups.service.ts, groups.repository.ts) was switched to an
-- allow-list of ('admin', 'lead') in the same change, so a 'qa' user can never
-- fall into an ELSE branch that grants group-manager rights.
--
-- Constraint-name lookup: 20260713130000_user_global_app_role added the CHECK
-- inline without a name, so Postgres generated one. Guessing that name risks a
-- no-op DROP followed by a colliding ADD (see 20260714000000_role_value_rename
-- for the same problem and the same fix). The DO block finds the single-column
-- CHECK on app_users.app_role by attnum and drops it dynamically, then re-adds
-- it under an explicit name that the rollback can reference directly.
--
-- Idempotent: exits early when the current CHECK already allows 'qa'.
DO $$
DECLARE
  v_role_attnum     smallint;
  v_constraint_name text;
  v_constraint_def  text;
BEGIN
  SELECT attnum INTO v_role_attnum
  FROM pg_attribute
  WHERE attrelid = 'identity.app_users'::regclass
    AND attname = 'app_role'
    AND NOT attisdropped;

  IF v_role_attnum IS NULL THEN
    RAISE EXCEPTION 'identity.app_users.app_role column not found; aborting app_role qa migration';
  END IF;

  SELECT conname, pg_get_constraintdef(oid)
    INTO v_constraint_name, v_constraint_def
  FROM pg_constraint
  WHERE conrelid = 'identity.app_users'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[v_role_attnum];

  IF v_constraint_def IS NOT NULL AND v_constraint_def LIKE '%''qa''%' THEN
    RETURN;
  END IF;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE identity.app_users DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  ALTER TABLE identity.app_users
    ADD CONSTRAINT app_users_app_role_check
    CHECK (app_role IN ('admin', 'lead', 'qa', 'member'));
END $$;
