import type { DatabaseService } from '#kernel/db/database.service.js';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { WorkspacesRepository } from '#modules/identity-access/workspaces/infrastructure/workspaces.repository.js';
import { ProjectsRepository } from '#modules/projects/infrastructure/projects.repository.js';

function makeContext(initialTenantId: string): {
  context: TenantContextPort;
  selectTenant: (tenantId: string) => void;
} {
  let tenantId = initialTenantId;
  const context: TenantContext = {
    tenantId: initialTenantId,
    userId: 'user-1',
    membershipRole: 'member',
    deploymentMode: 'hosted',
  };

  return {
    context: {
      current: () => ({ ...context, tenantId }),
      require: () => ({ ...context, tenantId }),
      set: (next) => {
        tenantId = next.tenantId;
      },
      clear: () => {
        tenantId = '';
      },
    },
    selectTenant: (nextTenantId) => {
      tenantId = nextTenantId;
    },
  };
}

describe('workspace/project tenant isolation contract', () => {
  it('carries the active tenant into workspace membership reads', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const { context, selectTenant } = makeContext('tenant-a');
    const repository = new WorkspacesRepository(
      { query } as unknown as DatabaseService,
      context,
    );

    await repository.listForUser('user-1');
    expect(query.mock.calls[0][0]).toContain('workspace.tenant_id = $2::uuid');
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'tenant-a']);

    selectTenant('tenant-b');
    await repository.listForUser('user-1');
    expect(query.mock.calls[1][1]).toEqual(['user-1', 'tenant-b']);
  });

  it('adds the active tenant to project visibility and destructive predicates', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const { context } = makeContext('tenant-a');
    const repository = new ProjectsRepository(
      { query } as unknown as DatabaseService,
      context,
    );

    await repository.listByUser('user-1', 25);
    expect(query.mock.calls[0][0]).toContain('pp.tenant_id = $3::uuid');
    expect(query.mock.calls[0][1]).toEqual(['user-1', 25, 'tenant-a']);

    await repository.deleteByIdAndUser('project-1', 'user-1');
    expect(query.mock.calls[1][0]).toContain('tenant_id = $4::uuid');
    expect(query.mock.calls[1][1][3]).toBe('tenant-a');
  });

  it('fails closed when a tenant-owned repository has no validated context', async () => {
    const query = jest.fn();
    const emptyContext: TenantContextPort = {
      current: () => null,
      require: () => {
        throw new Error('no validated context');
      },
      set: jest.fn(),
      clear: jest.fn(),
    };

    const repository = new ProjectsRepository(
      { query } as unknown as DatabaseService,
      emptyContext,
    );

    await expect(repository.listByUser('user-1')).rejects.toThrow(
      'no validated context',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
