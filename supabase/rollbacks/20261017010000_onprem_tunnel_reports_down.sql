-- Tunnel reports are recreated by the next heartbeat, so dropping them loses
-- nothing a machine cannot report again.
ALTER TABLE env_provisioning.onprem_hosts
  DROP COLUMN IF EXISTS tunnel_reported_at,
  DROP COLUMN IF EXISTS tunnel_message,
  DROP COLUMN IF EXISTS tunnel_url,
  DROP COLUMN IF EXISTS tunnel_status;
