-- Runtime owns machine credentials. Workspace UUIDs are checked through Identity's port.
CREATE TABLE IF NOT EXISTS env_provisioning.onprem_workspace_lifecycle (
  workspace_id UUID PRIMARY KEY,
  deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS env_provisioning.onprem_machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES env_provisioning.onprem_workspace_lifecycle(workspace_id),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'ubuntu')),
  agent_version TEXT CHECK (length(agent_version) <= 80),
  token_prefix TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  checks JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checks) = 'array')
);
CREATE INDEX IF NOT EXISTS onprem_machines_workspace ON env_provisioning.onprem_machines(workspace_id, created_at);
CREATE TABLE IF NOT EXISTS env_provisioning.onprem_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES env_provisioning.onprem_workspace_lifecycle(workspace_id),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'ubuntu')),
  code_sha256 TEXT NOT NULL UNIQUE CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  request_id UUID NOT NULL,
  replaces_machine_id UUID REFERENCES env_provisioning.onprem_machines(id),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  consumed_at TIMESTAMPTZ,
  machine_id UUID REFERENCES env_provisioning.onprem_machines(id),
  UNIQUE(workspace_id, request_id)
);
CREATE INDEX IF NOT EXISTS onprem_enrollments_pending ON env_provisioning.onprem_enrollments(workspace_id, expires_at) WHERE consumed_at IS NULL;
ALTER TABLE env_provisioning.onprem_workspace_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_provisioning.onprem_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_provisioning.onprem_enrollments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON env_provisioning.onprem_workspace_lifecycle, env_provisioning.onprem_machines, env_provisioning.onprem_enrollments FROM anon, authenticated;
