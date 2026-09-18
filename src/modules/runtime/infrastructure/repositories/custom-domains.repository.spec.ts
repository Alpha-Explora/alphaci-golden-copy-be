import type { DatabaseService } from '#kernel/db/database.service';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { CustomDomainsRepository } from './custom-domains.repository';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

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

const makeRow = (overrides = {}) => ({
  id: 'domain-1',
  project_id: 'project-1',
  deployment_target_id: 'target-1',
  provider: 'render',
  hostname: 'api.example.com',
  apex_domain: 'example.com',
  git_branch: 'main',
  verified: false,
  verification: [],
  misconfigured: null,
  last_checked_at: null,
  last_error_safe_message: null,
  created_at: '2026-06-12T00:00:00.000Z',
  updated_at: '2026-06-12T00:00:00.000Z',
  ...overrides,
});

const makeRepository = (query: jest.Mock, tenantId = TENANT_A) =>
  new CustomDomainsRepository(
    { query } as unknown as DatabaseService,
    makeTenantContext(tenantId),
  );

describe('CustomDomainsRepository', () => {
  it('lists custom domains through the tenant-scoped project', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [makeRow()] });
    const repository = makeRepository(query);

    await expect(repository.listForProject('project-1')).resolves.toMatchObject(
      [{ id: 'domain-1', projectId: 'project-1' }],
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN projects.provisioned_projects AS project'),
      ['project-1', TENANT_A],
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $2::uuid',
    );
  });

  it('scopes domain lookup by the selected tenant', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [makeRow()] });
    const repository = makeRepository(query);

    await expect(repository.findById('domain-1')).resolves.toMatchObject({
      id: 'domain-1',
    });
    expect(query.mock.calls[0]?.[1]).toEqual(['domain-1', TENANT_A]);
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $2::uuid',
    );
  });

  it('guards domain inserts with both the project and deployment target tenant scope', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [makeRow()] });
    const repository = makeRepository(query);

    await expect(
      repository.insert({
        projectId: 'project-1',
        deploymentTargetId: 'target-1',
        provider: 'render',
        hostname: 'api.example.com',
        apexDomain: 'example.com',
        gitBranch: 'main',
        verified: false,
        verification: [],
        misconfigured: null,
        createdBy: USER_ID,
      }),
    ).resolves.toMatchObject({ id: 'domain-1' });

    expect(query.mock.calls[0]?.[1]).toEqual([
      'project-1',
      'target-1',
      'render',
      'api.example.com',
      'example.com',
      'main',
      false,
      '[]',
      null,
      USER_ID,
      TENANT_A,
    ]);
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $11::uuid',
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'target.project_id = project.id',
    );
  });

  it('scopes domain state updates and deletes', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [makeRow({ verified: true })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const repository = makeRepository(query);

    await expect(
      repository.updateState({
        id: 'domain-1',
        verified: true,
        verification: [],
        misconfigured: false,
        lastErrorSafeMessage: null,
      }),
    ).resolves.toMatchObject({ verified: true });
    await expect(repository.deleteById('domain-1')).resolves.toBe(false);

    expect(query.mock.calls[0]?.[1]).toEqual([
      'domain-1',
      true,
      '[]',
      false,
      null,
      TENANT_A,
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual(['domain-1', TENANT_A]);
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $6::uuid',
    );
    expect(String(query.mock.calls[1]?.[0] ?? '')).toContain(
      'project.tenant_id = $2::uuid',
    );
  });

  it('keeps a tenant A context from reading or mutating tenant B domains', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repository = makeRepository(query);

    await expect(repository.findById('tenant-b-domain')).resolves.toBeNull();
    await expect(repository.deleteById('tenant-b-domain')).resolves.toBe(false);

    expect(query.mock.calls[0]?.[1]).toEqual(['tenant-b-domain', TENANT_A]);
    expect(query.mock.calls[1]?.[1]).toEqual(['tenant-b-domain', TENANT_A]);
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
    const repository = new CustomDomainsRepository(
      { query } as unknown as DatabaseService,
      noContext,
    );

    await expect(repository.listForProject('project-1')).rejects.toThrow(
      TenantContextRequiredError,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
