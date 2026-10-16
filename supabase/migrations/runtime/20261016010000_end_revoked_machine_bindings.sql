-- Revoking a machine without a replacement used to leave its environments bound,
-- so they could not be reassigned until someone unassigned them. Revocation now
-- ends those bindings in the same transaction. This ends the bindings that
-- earlier revocations left active; the revoked_at trigger releases their ports.
UPDATE env_provisioning.onprem_hosts h
   SET revoked_at = NOW()
  FROM env_provisioning.onprem_machines m
 WHERE m.id = h.machine_id
   AND m.revoked_at IS NOT NULL
   AND h.revoked_at IS NULL;
