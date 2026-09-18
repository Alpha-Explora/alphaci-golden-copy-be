import type { DatabaseService } from '#kernel/db/database.service.js';
import {
  TenantProvisioningConflictError,
  TenantScopeConflictError,
  type LegacyScopeSelection,
} from '../contracts/tenant-provisioning.contract.js';
import { TenancyRepository } from './tenancy.repository.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const WORKFLOW_GENERATION_ID = '55555555-5555-4555-8555-555555555555';
const PROVIDER_CONNECTION_ID = '66666666-6666-4666-8666-666666666666';
const CI_RUN_REPORT_ID = '77777777-7777-4777-8777-777777777777';

const selection: LegacyScopeSelection = {
  kind: 'explicit-ids',
  workspaceIds: [WORKSPACE_ID],
  projectIds: [PROJECT_ID],
  workflowGenerationIds: [WORKFLOW_GENERATION_ID],
  providerConnectionIds: [PROVIDER_CONNECTION_ID],
  ciRunReportIds: [CI_RUN_REPORT_ID],
};

function makeDatabase(
  activeMemberships: string[] = [USER_ID],
  activeTenantIds: string[] = [TENANT_ID],
): {
  database: DatabaseService;
  client: { query: jest.Mock };
} {
  const client = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('FROM tenancy.tenants')) {
        return {
          rows: sql.includes('FOR UPDATE')
            ? activeTenantIds.map((id) => ({ id }))
            : [{ id: TENANT_ID }],
        };
      }
      if (sql.includes('FROM projects.provisioned_projects')) {
        return {
          rows: [
            {
              id: PROJECT_ID,
              tenant_id: null,
              workspace_tenant_id: null,
            },
          ],
        };
      }
      if (sql.includes('FROM orgs.workspaces AS workspace')) {
        return {
          rows: [{ id: WORKSPACE_ID, tenant_id: null }],
        };
      }
      if (sql.includes('FROM workflow.workflow_generations')) {
        return {
          rows: [
            {
              id: WORKFLOW_GENERATION_ID,
              tenant_id: null,
              user_id: USER_ID,
            },
          ],
        };
      }
      if (sql.includes('FROM env_provisioning.provider_connections')) {
        return {
          rows: [
            {
              id: PROVIDER_CONNECTION_ID,
              tenant_id: null,
              user_id: USER_ID,
            },
          ],
        };
      }
      if (sql.includes('FROM workflow.ci_run_reports')) {
        return {
          rows: [
            {
              id: CI_RUN_REPORT_ID,
              tenant_id: null,
              user_id: USER_ID,
            },
          ],
        };
      }
      if (sql.includes('FROM tenancy.tenant_memberships')) {
        return {
          rows: activeMemberships.map((userId) => ({ user_id: userId })),
        };
      }
      throw new Error(`Unexpected tenancy SQL: ${sql}`);
    }),
  };
  const database = {
    query: jest.fn(),
    withTransaction: jest.fn(
      async (fn: (transactionClient: typeof client) => Promise<unknown>) =>
        fn(client),
    ),
  } as unknown as DatabaseService;

  return { database, client };
}

function input(dryRun = true) {
  return {
    tenantId: TENANT_ID,
    deploymentMode: 'hosted' as const,
    selection,
    dryRun,
  };
}

describe('TenancyRepository.provisionTenant', () => {
  it('serializes Enterprise provisioning and rejects an existing active tenant', async () => {
    const { database, client } = makeDatabase([USER_ID], [TENANT_ID]);
    const repository = new TenancyRepository(database);

    await expect(
      repository.provisionTenant({
        tenantId: '88888888-8888-4888-8888-888888888888',
        name: 'Second Enterprise tenant',
        slug: 'second-enterprise-tenant',
        kind: 'enterprise',
        deploymentMode: 'enterprise',
        initialMembership: { userId: USER_ID, role: 'owner' },
      }),
    ).rejects.toThrow(TenantProvisioningConflictError);

    expect(client.query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(
      client.query.mock.calls.some(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('INSERT INTO tenancy.tenants'),
      ),
    ).toBe(false);
  });
});

describe('TenancyRepository.backfillWorkspaceScope', () => {
  it('dry-runs explicit workspace, project, workflow, and provider row IDs for an active account member', async () => {
    const { database, client } = makeDatabase();
    const repository = new TenancyRepository(database);

    await expect(repository.backfillWorkspaceScope(input())).resolves.toEqual({
      tenantId: TENANT_ID,
      dryRun: true,
      workspacesSelected: 1,
      projectsSelected: 1,
      workspacesWouldChange: 1,
      projectsWouldChange: 1,
      workspacesUpdated: 0,
      projectsUpdated: 0,
      workflowGenerationsSelected: 1,
      providerConnectionsSelected: 1,
      ciRunReportsSelected: 1,
      workflowGenerationsWouldChange: 1,
      providerConnectionsWouldChange: 1,
      ciRunReportsWouldChange: 1,
      workflowGenerationsUpdated: 0,
      providerConnectionsUpdated: 0,
      ciRunReportsUpdated: 0,
    });

    const membershipCall = client.query.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM tenancy.tenant_memberships'),
    );
    expect(membershipCall?.[1]).toEqual([TENANT_ID, [USER_ID]]);

    const workflowCall = client.query.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM workflow.workflow_generations'),
    );
    expect(workflowCall?.[1]).toEqual([[WORKFLOW_GENERATION_ID]]);

    const providerCall = client.query.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM env_provisioning.provider_connections'),
    );
    expect(providerCall?.[1]).toEqual([[PROVIDER_CONNECTION_ID]]);
    expect(
      client.query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE '),
      ),
    ).toBe(false);
  });

  it('rejects account-owned row IDs when their owner is not an active tenant member', async () => {
    const { database, client } = makeDatabase([]);
    const repository = new TenancyRepository(database);

    await expect(repository.backfillWorkspaceScope(input())).rejects.toThrow(
      TenantScopeConflictError,
    );
    expect(
      client.query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE '),
      ),
    ).toBe(false);
  });
});
