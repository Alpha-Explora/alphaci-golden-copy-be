DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM env_provisioning.onprem_hosts WHERE machine_id IS NOT NULL AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Unassign active machines and restore explicit legacy registrations before downgrade';
  END IF;
END $$;
-- Keep revoked machine records and credential-kind history. A code rollback
-- can serve legacy registrations without removing these additive columns.
