-- Rollback: 20260925000000_app_role_qa
-- Restores the three-value app_role vocabulary.
--
-- Refuses to run while any user still holds 'qa': narrowing a CHECK that
-- stored data violates fails at the ALTER anyway, and failing with a sentence
-- beats failing with a constraint name. Re-assign those users first (a
-- GitHub-sourced 'qa' becomes 'member' on the next sync once the application
-- code no longer knows the qa team).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity.app_users WHERE app_role = 'qa') THEN
    RAISE EXCEPTION
      'Users still hold the qa app_role; re-assign them before narrowing this constraint.';
  END IF;
END $$;

ALTER TABLE identity.app_users
  DROP CONSTRAINT IF EXISTS app_users_app_role_check;

ALTER TABLE identity.app_users
  ADD CONSTRAINT app_users_app_role_check
  CHECK (app_role IN ('admin', 'lead', 'member'));
