-- Migration: 20260918000010_tenant_scope_extensions
--
-- Extend the additive tenancy kernel to legacy account-owned records that do
-- not have a project/workspace foreign key. The columns stay nullable: old
-- rows are not assigned by edition, user email, or database location.
--
-- The explicit operator path is:
--   npm run db:backfill-tenant-scope -- --tenant-id ... --deployment-mode ...
--     --provider-connection-id ... --workflow-generation-id ... --apply
--
-- Until that mapping is applied, request-facing reads intentionally exclude
-- NULL tenant_id rows. This is safer than guessing a tenant for credentials
-- or generated workflow history.

ALTER TABLE workflow.workflow_generations
  ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;

ALTER TABLE env_provisioning.provider_connections
  ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'workflow.workflow_generations'::regclass
      AND conname = 'workflow_generations_tenant_fkey'
  ) THEN
    ALTER TABLE workflow.workflow_generations
      ADD CONSTRAINT workflow_generations_tenant_fkey
      FOREIGN KEY (tenant_id)
      REFERENCES tenancy.tenants(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'env_provisioning.provider_connections'::regclass
      AND conname = 'provider_connections_tenant_fkey'
  ) THEN
    ALTER TABLE env_provisioning.provider_connections
      ADD CONSTRAINT provider_connections_tenant_fkey
      FOREIGN KEY (tenant_id)
      REFERENCES tenancy.tenants(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_workflow_generations_tenant_user_created
  ON workflow.workflow_generations (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_connections_tenant_user_provider
  ON env_provisioning.provider_connections (tenant_id, user_id, provider, status);

COMMENT ON COLUMN workflow.workflow_generations.tenant_id IS
  'Nullable tenant scope for generated workflow history. Legacy rows remain NULL until an explicit operator mapping proves ownership.';

COMMENT ON COLUMN env_provisioning.provider_connections.tenant_id IS
  'Nullable tenant scope for provider credentials. Legacy rows remain NULL until an explicit operator mapping proves ownership; request reads exclude NULL rows.';
