-- One environment has one active host registration. Preserve the newest
-- registration if older versions created several; revoked tokens stay revoked.
LOCK TABLE env_provisioning.onprem_hosts IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY environment_id ORDER BY created_at DESC, id DESC
  ) AS position
  FROM env_provisioning.onprem_hosts
  WHERE revoked_at IS NULL
)
UPDATE env_provisioning.onprem_hosts AS host
SET revoked_at = NOW()
FROM ranked
WHERE host.id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS onprem_hosts_one_active_per_environment
  ON env_provisioning.onprem_hosts (environment_id)
  WHERE revoked_at IS NULL;
