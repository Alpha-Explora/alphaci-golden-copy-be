import { DatabaseService } from '#kernel/db/database.service';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { EnvVarsRepository } from './env-vars.repository';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const makeDatabaseService = (query: jest.Mock) =>
  ({ query }) as unknown as DatabaseService;

const makeTenantContext = (tenantId = TENANT_A): TenantContextPort => {
  const context: TenantContext = {
    tenantId,
    userId: USER_ID,
    membershipRole: 'member',
    deploymentMode: 'hosted',
  };
  return {
    current: () => context,
    require: () => context,
    set: jest.fn(),
    clear: jest.fn(),
  };
};

describe('EnvVarsRepository', () => {
  it('persists env metadata without env values', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new EnvVarsRepository(
      makeDatabaseService(query),
      makeTenantContext(),
    );
    await repository.upsertEnvMetadataBatch({
      projectId: 'project-1',
      deploymentTargetId: 'target-1',
      lane: 'preview',
      gitBranch: 'feat/checkout',
      provider: 'render',
      provisionedBy: USER_ID,
      entries: [
        { key: 'DATABASE_URL', status: 'provisioned', errorSummary: null },
      ],
    });
    const call = query.mock.calls[0] as [string, unknown[]];
    const queryText = String(call?.[0] ?? '');
    const queryValues = call?.[1] ?? [];
    expect(queryText).toContain(
      'INSERT INTO env_provisioning.project_env_var_metadata',
    );
    expect(queryText).toContain('project.tenant_id = $10::uuid');
    expect(queryValues).toContain('DATABASE_URL');
    expect(queryValues).toContain(TENANT_A);
    expect(queryValues).not.toContain('postgres://secret');
  });

  it('filters removed metadata from active env metadata lists', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new EnvVarsRepository(
      makeDatabaseService(query),
      makeTenantContext(),
    );
    await repository.listEnvMetadata('project-1');
    const queryText = String(query.mock.calls[0]?.[0] ?? '');
    expect(queryText).toContain('removed_at IS NULL');
    expect(queryText).toContain('project.tenant_id = $2::uuid');
    expect(query.mock.calls[0]?.[1]).toEqual(['project-1', TENANT_A]);
  });

  it('lists env metadata only for projects owned by the user', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new EnvVarsRepository(
      makeDatabaseService(query),
      makeTenantContext(),
    );
    await repository.listEnvMetadataForUser('project-1', USER_ID);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN projects.provisioned_projects AS project'),
      ['project-1', USER_ID, TENANT_A],
    );
    const queryText = String(query.mock.calls[0]?.[0] ?? '');
    expect(queryText).toContain('metadata.project_id = $1');
    expect(queryText).toContain('project.user_id = $2');
    expect(queryText).toContain('project.tenant_id = $3::uuid');
    expect(queryText).toContain('orgs.workspace_members');
    expect(queryText).toContain(
      "member.role IN ('admin', 'delegated_lead', 'member', 'viewer')",
    );
    expect(queryText).toContain('metadata.removed_at IS NULL');
  });

  it('counts existing active env keys for a target and environment', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ existing_count: '2' }],
    });
    const repository = new EnvVarsRepository(
      makeDatabaseService(query),
      makeTenantContext(),
    );
    await expect(
      repository.countExistingActiveKeys({
        deploymentTargetId: 'target-1',
        lane: 'preview',
        gitBranch: 'feat/checkout',
        keys: ['API_URL', 'DATABASE_URL', 'NEW_KEY'],
      }),
    ).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('key = ANY($4::text[])'),
      [
        'target-1',
        'preview',
        'feat/checkout',
        ['API_URL', 'DATABASE_URL', 'NEW_KEY'],
        TENANT_A,
      ],
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $5::uuid',
    );
  });

  it('marks env metadata removed without deleting the row', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'meta-1',
          project_id: 'project-1',
          deployment_target_id: 'target-1',
          environment: 'test',
          key: 'DATABASE_URL',
          provider: 'render',
          value_stored: false,
          last_provisioned_at: '2026-06-12T00:00:00.000Z',
          last_provisioned_by: USER_ID,
          status: 'provisioned',
          error_summary: null,
          removed_at: '2026-06-12T01:00:00.000Z',
        },
      ],
    });
    const repository = new EnvVarsRepository(
      makeDatabaseService(query),
      makeTenantContext(),
    );
    await expect(
      repository.markEnvMetadataRemoved('meta-1', USER_ID, null),
    ).resolves.toMatchObject({
      id: 'meta-1',
      key: 'DATABASE_URL',
      removedAt: '2026-06-12T01:00:00.000Z',
    });
    const call = query.mock.calls[0] as [string, unknown[]];
    const queryText = String(call?.[0] ?? '');
    expect(queryText).toContain('SET removed_at = NOW()');
    expect(queryText).toContain('orgs.workspace_members');
    expect(queryText).toContain(
      "member.role IN ('admin', 'delegated_lead', 'member')",
    );
    expect(queryText).toContain('project.tenant_id = $4::uuid');
    expect(queryText).not.toContain('DELETE FROM');
    expect(call?.[1]).toEqual(['meta-1', USER_ID, null, TENANT_A]);
  });

  it('keeps a tenant A context from reading or mutating tenant B metadata', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repository = new EnvVarsRepository(
      makeDatabaseService(query),
      makeTenantContext(),
    );
    await expect(
      repository.listEnvMetadataForUser('tenant-b-project', USER_ID),
    ).resolves.toEqual([]);
    await expect(
      repository.markEnvMetadataRemoved('tenant-b-metadata', USER_ID, null),
    ).resolves.toBeNull();
    expect(query.mock.calls[0]?.[1]).toEqual([
      'tenant-b-project',
      USER_ID,
      TENANT_A,
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      'tenant-b-metadata',
      USER_ID,
      null,
      TENANT_A,
    ]);
  });

  it('fails closed before querying when the validated tenant context is absent', async () => {
    const query = jest.fn();
    const noContext: TenantContextPort = {
      current: () => null,
      require: () => {
        throw new TenantContextRequiredError();
      },
      set: jest.fn(),
      clear: jest.fn(),
    };
    const repository = new EnvVarsRepository(
      makeDatabaseService(query),
      noContext,
    );
    await expect(repository.listEnvMetadata('project-1')).rejects.toThrow(
      TenantContextRequiredError,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
