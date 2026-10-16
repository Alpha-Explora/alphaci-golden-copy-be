-- The machine's automatic HTTPS address (a Cloudflare quick tunnel) for one
-- assignment. Each heartbeat replaces the reports of the machine's bindings, so
-- a tunnel that stops or an assignment that leaves the machine clears its URL.
ALTER TABLE env_provisioning.onprem_hosts
  ADD COLUMN IF NOT EXISTS tunnel_status TEXT CHECK (tunnel_status IN ('starting', 'running', 'unavailable', 'failed')),
  ADD COLUMN IF NOT EXISTS tunnel_url TEXT CHECK (tunnel_url IS NULL OR tunnel_url ~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  ADD COLUMN IF NOT EXISTS tunnel_message TEXT CHECK (char_length(tunnel_message) <= 300),
  ADD COLUMN IF NOT EXISTS tunnel_reported_at TIMESTAMPTZ;
