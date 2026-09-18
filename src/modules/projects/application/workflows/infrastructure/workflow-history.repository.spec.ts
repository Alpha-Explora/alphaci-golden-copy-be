import { WorkflowHistoryRepository } from './workflow-history.repository';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';

describe('WorkflowHistoryRepository', () => {
  const context: TenantContext = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    membershipRole: 'member',
    deploymentMode: 'hosted',
  };

  const makeTenantContext = (): TenantContextPort => ({
    current: () => context,
    require: () => context,
    set: jest.fn(),
    clear: jest.fn(),
  });

  it('writes workflow history through the database service', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const repository = new WorkflowHistoryRepository(
      databaseService as never,
      makeTenantContext(),
    );

    await repository.create({
      userId: 'user-1',
      templateId: 'nestjs-be',
      templateName: 'NestJS Backend',
      stack: 'nestjs',
      serviceName: 'payments-api',
      outputFileName: 'payments-api-nestjs-be.yml',
      sourceWorkflowFile: '/templates/workflow.yml',
      sourcePropertiesFile: '/templates/properties.json',
      lineCount: 20,
      yaml: 'name: payments-api',
      sha256: 'hash',
    });

    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workflow_generations'),
      expect.arrayContaining([
        'tenant-1',
        'user-1',
        'nestjs-be',
        'payments-api',
      ]),
    );
  });

  it('reads only history owned by the validated tenant', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const repository = new WorkflowHistoryRepository(
      databaseService as never,
      makeTenantContext(),
    );

    await repository.listByUser('user-1', 10);

    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = $2::uuid'),
      ['user-1', 'tenant-1', 10],
    );
  });

  it('fails closed when no tenant context is available', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const repository = new WorkflowHistoryRepository(databaseService as never);

    await expect(repository.listByUser('user-1')).rejects.toThrow(
      TenantContextRequiredError,
    );
    expect(databaseService.query).not.toHaveBeenCalled();
  });
});
