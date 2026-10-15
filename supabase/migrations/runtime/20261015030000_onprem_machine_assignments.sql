ALTER TABLE env_provisioning.onprem_hosts
  ADD COLUMN IF NOT EXISTS machine_id UUID REFERENCES env_provisioning.onprem_machines(id),
  ADD COLUMN IF NOT EXISTS assignment_config JSONB,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE env_provisioning.onprem_hosts ALTER COLUMN token_prefix DROP NOT NULL, ALTER COLUMN token_sha256 DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='env_provisioning.onprem_hosts'::regclass AND conname='onprem_hosts_credential_kind') THEN
    ALTER TABLE env_provisioning.onprem_hosts ADD CONSTRAINT onprem_hosts_credential_kind CHECK (
      (machine_id IS NULL AND token_prefix IS NOT NULL AND token_sha256 IS NOT NULL AND assignment_config IS NULL)
      OR (machine_id IS NOT NULL AND token_prefix IS NULL AND token_sha256 IS NULL AND assignment_config IS NOT NULL AND request_id IS NOT NULL)
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS onprem_hosts_machine ON env_provisioning.onprem_hosts(machine_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS onprem_hosts_request ON env_provisioning.onprem_hosts(project_id,environment_id,request_id) WHERE request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS env_provisioning.onprem_port_reservations (
  machine_id UUID NOT NULL REFERENCES env_provisioning.onprem_machines(id),
  host_port INTEGER NOT NULL CHECK (host_port BETWEEN 1 AND 65535),
  host_id UUID NOT NULL REFERENCES env_provisioning.onprem_hosts(id) ON DELETE CASCADE,
  PRIMARY KEY(machine_id,host_port)
);
CREATE INDEX IF NOT EXISTS onprem_ports_host ON env_provisioning.onprem_port_reservations(host_id);
ALTER TABLE env_provisioning.onprem_port_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON env_provisioning.onprem_port_reservations FROM anon,authenticated;
CREATE OR REPLACE FUNCTION env_provisioning.release_onprem_ports() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN DELETE FROM env_provisioning.onprem_port_reservations WHERE host_id=NEW.id; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS onprem_ports_release ON env_provisioning.onprem_hosts;
CREATE TRIGGER onprem_ports_release AFTER UPDATE OF revoked_at ON env_provisioning.onprem_hosts FOR EACH ROW EXECUTE FUNCTION env_provisioning.release_onprem_ports();
