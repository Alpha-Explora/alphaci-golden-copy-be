-- Migration: 20260918000020_ci_run_reports_tenant_scope
--
-- CI reports are tenant-owned even though bearer-authenticated workflow
-- ingestion is a deployment-global worker path. The old uniqueness key used
-- only the GitHub repository name, run id, and stage; repository names may be
-- reused by separate tenants, so that key could overwrite or expose another
-- tenant's report.
--
-- Existing rows remain NULL until an operator explicitly maps them. Tenant
-- reads exclude NULL rows, and the new nullable-key index preserves legacy
-- rows without guessing their ownership.

ALTER TABLE workflow.ci_run_reports
  ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'workflow.ci_run_reports'::regclass
      AND conname = 'ci_run_reports_tenant_fkey'
  ) THEN
    ALTER TABLE workflow.ci_run_reports
      ADD CONSTRAINT ci_run_reports_tenant_fkey
      FOREIGN KEY (tenant_id)
      REFERENCES tenancy.tenants(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

ALTER TABLE workflow.ci_run_reports
  DROP CONSTRAINT IF EXISTS ci_run_reports_unique_stage;

CREATE UNIQUE INDEX IF NOT EXISTS ci_run_reports_tenant_unique_stage
  ON workflow.ci_run_reports (tenant_id, repo_full_name, run_id, stage);

CREATE INDEX IF NOT EXISTS idx_ci_run_reports_tenant_repo_run
  ON workflow.ci_run_reports (tenant_id, repo_full_name, run_id);

COMMENT ON COLUMN workflow.ci_run_reports.tenant_id IS
  'Nullable tenant scope for CI reports. Legacy rows remain NULL until an explicit operator mapping proves ownership; tenant-facing reads exclude NULL rows.';
