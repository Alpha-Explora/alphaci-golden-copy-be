import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/identity-access/20260918000000_tenancy_kernel.sql',
  ),
  'utf8',
);

const extensionMigration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/identity-access/20260918000010_tenant_scope_extensions.sql',
  ),
  'utf8',
);

const ciReportsMigration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/pipelines/20260918000020_ci_run_reports_tenant_scope.sql',
  ),
  'utf8',
);

describe('tenancy migration contract', () => {
  it('creates the database-local tenancy foundation with explicit constraints and indexes', () => {
    expect(migration).toContain('CREATE SCHEMA IF NOT EXISTS tenancy;');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS tenancy.tenants');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS tenancy.tenant_memberships',
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS tenancy.tenant_units',
    );

    for (const indexName of [
      'idx_tenant_memberships_user_status',
      'idx_tenant_memberships_tenant_status',
      'idx_tenant_units_tenant_status',
      'idx_tenant_units_parent',
      'idx_workspaces_tenant_created',
      'idx_provisioned_projects_tenant_created',
    ]) {
      expect(migration).toContain(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    }

    expect(migration).toContain(
      'REFERENCES tenancy.tenants(id)\n    ON DELETE CASCADE',
    );
    expect(migration).toContain(
      'REFERENCES identity.app_users(id)\n    ON DELETE CASCADE',
    );
    expect(migration).toContain(
      'REFERENCES tenancy.tenant_units(tenant_id, id)\n    ON DELETE CASCADE',
    );
  });

  it('keeps root scope nullable, restrictive, and free of unproven backfill', () => {
    const executableSql = migration
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\r\n]*/g, '');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS tenant_id UUID NULL');
    expect(
      migration.match(/ADD COLUMN IF NOT EXISTS tenant_id UUID NULL/g),
    ).toHaveLength(2);
    expect(migration).toContain('ADD CONSTRAINT workspaces_tenant_fkey');
    expect(migration).toContain(
      'ADD CONSTRAINT provisioned_projects_tenant_fkey',
    );
    expect(migration).toContain(
      'REFERENCES tenancy.tenants(id)\n      ON DELETE RESTRICT',
    );
    expect(migration).not.toMatch(
      /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:orgs\.workspaces|projects\.provisioned_projects)\b/i,
    );
    expect(executableSql).not.toMatch(/deployment_instances/i);
    expect(executableSql).not.toMatch(
      /\bCREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+(?:saas|edu|enterprise)\b/i,
    );
  });

  it('denies direct Supabase table access until application tenant authorization is wired', () => {
    for (const table of [
      'tenancy.tenants',
      'tenancy.tenant_memberships',
      'tenancy.tenant_units',
    ]) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE ${table}\\s+ENABLE ROW LEVEL SECURITY`),
      );
      expect(migration).toContain(`REVOKE ALL ON ${table}`);
    }
  });

  it('adds nullable account-record scopes without silently backfilling legacy rows', () => {
    expect(extensionMigration).toContain(
      'ALTER TABLE workflow.workflow_generations',
    );
    expect(extensionMigration).toContain(
      'ALTER TABLE env_provisioning.provider_connections',
    );
    expect(
      extensionMigration.match(/ADD COLUMN IF NOT EXISTS tenant_id UUID NULL/g),
    ).toHaveLength(2);
    expect(extensionMigration).toContain('workflow_generations_tenant_fkey');
    expect(extensionMigration).toContain('provider_connections_tenant_fkey');
    expect(extensionMigration).toContain(
      'idx_workflow_generations_tenant_user_created',
    );
    expect(extensionMigration).toContain(
      'idx_provider_connections_tenant_user_provider',
    );

    const executableSql = extensionMigration
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\r\n]*/g, '');
    expect(executableSql).not.toMatch(
      /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:workflow\.workflow_generations|env_provisioning\.provider_connections)\b/i,
    );
  });

  it('makes CI report persistence tenant-scoped before accepting new upserts', () => {
    expect(ciReportsMigration).toContain(
      'ADD COLUMN IF NOT EXISTS tenant_id UUID NULL',
    );
    expect(ciReportsMigration).toContain('ci_run_reports_tenant_fkey');
    expect(ciReportsMigration).toContain(
      'DROP CONSTRAINT IF EXISTS ci_run_reports_unique_stage',
    );
    expect(ciReportsMigration).toContain('ci_run_reports_tenant_unique_stage');
    expect(ciReportsMigration).toContain('idx_ci_run_reports_tenant_repo_run');

    const executableSql = ciReportsMigration
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\r\n]*/g, '');
    expect(executableSql).not.toMatch(
      /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+workflow\.ci_run_reports\b/i,
    );
  });
});
