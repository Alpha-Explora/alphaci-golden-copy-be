-- Preserve revoked credentials and consumed codes across rollback/reapply.
-- Disabling the feature is the application rollback. Dropping credential state
-- would permit an old installer or enrollment to regain authority.
UPDATE env_provisioning.onprem_machines SET revoked_at = COALESCE(revoked_at, NOW());
UPDATE env_provisioning.onprem_enrollments SET expires_at = LEAST(expires_at, NOW());
