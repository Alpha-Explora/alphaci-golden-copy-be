import type { DatabaseService } from '#kernel/db/database.service';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import { CiRunReportsRepository } from './ci-run-reports.repository';

describe('CiRunReportsRepository', () => {
  const context: TenantContext = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    membershipRole: 'member',
    deploymentMode: 'hosted',
  };

  const tenantContext: TenantContextPort = {
    current: () => context,
    require: () => context,
    set: jest.fn(),
    clear: jest.fn(),
  };

  it('keeps token-authenticated report ingestion worker-global', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
    const repository = new CiRunReportsRepository(database);

    await expect(
      repository.upsertDeploymentGlobal({
        userId: 'user-1',
        tenantId: context.tenantId,
        repoFullName: 'tone/orders-api',
        branch: 'main',
        commitSha: 'sha-1',
        runId: 42,
        stage: 'quality',
        status: 'success',
        results: {},
        friendlyMessages: [],
      }),
    ).resolves.toBeUndefined();
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workflow.ci_run_reports'),
      expect.any(Array),
    );
  });

  it('scopes repository report reads through the validated project tenant', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
    const repository = new CiRunReportsRepository(database, tenantContext);

    await repository.findRecentByRepo('tone/orders-api', 20, 5);

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM projects.provisioned_projects AS project'),
      ['tone/orders-api', 20, 5, '11111111-1111-4111-8111-111111111111'],
    );
  });

  it('scopes user report reads through the validated project tenant', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
    const repository = new CiRunReportsRepository(database, tenantContext);

    await repository.findRecentByUser('user-1', 30, 2);

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('project.tenant_id = $4::uuid'),
      ['user-1', 30, 2, '11111111-1111-4111-8111-111111111111'],
    );
  });

  it('fails closed for request reads without tenant context', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
    const repository = new CiRunReportsRepository(database);

    await expect(repository.findRecentByUser('user-1')).rejects.toThrow(
      TenantContextRequiredError,
    );
    expect(database.query).not.toHaveBeenCalled();
  });
});
