import type { DatabaseService } from '#kernel/db/database.service';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { DeploymentTargetsRepository } from './deployment-targets.repository';

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

const makeRow = (overrides = {}) => ({
  id: 'target-1',
  project_id: 'project-1',
  slot: 'backend',
  ownership_mode: 'byo',
  provider: 'render',
  provider_connection_id: 'connection-1',
  provider_project_id: 'srv-1',
  provider_project_name: 'orders-api-test',
  repo_full_name: 'tone/orders-api',
  branch_name: 'test',
  root_directory: '.',
  build_command: 'npm run build',
  start_command: 'npm run start:prod',
  render_service_type: 'web_service',
  render_instance_type: 'free',
  render_region: 'singapore',
  render_environment_name: 'test',
  docker_context: null,
  dockerfile_path: null,
  image_url: null,
  environment_map: { NODE_ENV: 'test' },
  deployment_strategy: 'render_existing_service',
  provider_metadata: { dashboardUrl: 'https://dashboard.render.com' },
  status: 'active',
  ...overrides,
});

describe('DeploymentTargetsRepository', () => {
  let query: jest.Mock;
  let repository: DeploymentTargetsRepository;
  let tenantContext: TenantContextPort;

  beforeEach(() => {
    query = jest.fn();
    tenantContext = makeTenantContext();
    repository = new DeploymentTargetsRepository(
      makeDatabaseService(query),
      tenantContext,
    );
  });

  it('creates deployment target metadata with JSON defaults', async () => {
    query.mockResolvedValueOnce({ rows: [makeRow()] });

    await expect(
      repository.createDeploymentTarget({
        projectId: 'project-1',
        slot: 'backend',
        ownershipMode: 'byo',
        provider: 'render',
        providerConnectionId: 'connection-1',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        repoFullName: 'tone/orders-api',
        branchName: 'test',
      }),
    ).resolves.toMatchObject({
      id: 'target-1',
      projectId: 'project-1',
      environmentMap: { NODE_ENV: 'test' },
      deploymentStrategy: 'render_existing_service',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO env_provisioning.project_deployment_targets',
      ),
      expect.arrayContaining(['project-1', 'backend', 'byo', 'render']),
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $23::uuid',
    );
    expect(query.mock.calls[0]?.[1]).toContain(TENANT_A);
  });

  it('throws when create returns no target row', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.createDeploymentTarget({
        projectId: 'project-1',
        slot: 'backend',
        ownershipMode: 'byo',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        repoFullName: 'tone/orders-api',
        branchName: 'test',
      }),
    ).rejects.toThrow('INSERT returned no row');
  });

  it('lists deployment targets with safe summary defaults', async () => {
    query.mockResolvedValueOnce({
      rows: [
        makeRow({
          provider_connection_id: null,
          environment_map: null,
          deployment_strategy: null,
          provider_metadata: null,
        }),
      ],
    });

    await expect(
      repository.listDeploymentTargets('project-1'),
    ).resolves.toEqual([
      expect.objectContaining({
        providerConnectionId: null,
        environmentMap: {},
        deploymentStrategy: 'provider_native',
        providerMetadata: {},
      }),
    ]);
  });

  it('updates provider metadata and status', async () => {
    query.mockResolvedValueOnce({
      rows: [makeRow({ provider_metadata: { synced: true } })],
    });

    await expect(
      repository.updateProviderMetadata('target-1', { synced: true }, 'active'),
    ).resolves.toMatchObject({
      providerMetadata: { synced: true },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET provider_metadata = $2'),
      ['target-1', '{"synced":true}', 'active', TENANT_A],
    );
  });

  it('throws when provider metadata update returns no row', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.updateProviderMetadata('target-1', { synced: true }),
    ).rejects.toThrow('UPDATE returned no row');
  });

  it('updates user-owned target metadata only when fields are supplied', async () => {
    query.mockResolvedValueOnce({
      rows: [makeRow({ branch_name: 'uat', root_directory: 'apps/api' })],
    });

    await expect(
      repository.updateDeploymentTargetMetadataForUser(
        'project-1',
        'target-1',
        'user-1',
        { branchName: 'uat', rootDirectory: 'apps/api' },
      ),
    ).resolves.toMatchObject({
      branchName: 'uat',
      rootDirectory: 'apps/api',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'UPDATE env_provisioning.project_deployment_targets',
      ),
      expect.arrayContaining(['project-1', 'target-1', 'user-1']),
    );
    const queryText = String(query.mock.calls[0]?.[0] ?? '');
    expect(queryText).toContain('orgs.workspace_members');
    expect(queryText).toContain(
      "member.role IN ('admin', 'delegated_lead', 'member')",
    );
    expect(queryText).toContain('project.tenant_id = $18::uuid');
    expect(query.mock.calls[0]?.[1]).toContain(TENANT_A);
  });

  it('returns null when metadata update does not match a user target', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.updateDeploymentTargetMetadataForUser(
        'project-1',
        'target-1',
        'user-2',
        {},
      ),
    ).resolves.toBeNull();
  });

  it('deletes a user-owned deployment target and reports whether a row changed', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'target-1' }] });

    await expect(
      repository.deleteDeploymentTargetForUser(
        'project-1',
        'target-1',
        'user-1',
      ),
    ).resolves.toBe(true);
    const queryText = String(query.mock.calls[0]?.[0] ?? '');
    expect(queryText).toContain('orgs.workspace_members');
    expect(queryText).toContain(
      "member.role IN ('admin', 'delegated_lead', 'member')",
    );
    expect(queryText).toContain('project.tenant_id = $4::uuid');
    expect(query.mock.calls[0]?.[1]).toContain(TENANT_A);
  });

  it('finds a deployment target for the owning user', async () => {
    query.mockResolvedValueOnce({ rows: [makeRow()] });

    await expect(
      repository.findDeploymentTargetForUser('target-1', 'user-1'),
    ).resolves.toMatchObject({
      id: 'target-1',
      providerProjectName: 'orders-api-test',
    });
    const queryText = String(query.mock.calls[0]?.[0] ?? '');
    expect(queryText).toContain('orgs.workspace_members');
    expect(queryText).toContain(
      "member.role IN ('admin', 'delegated_lead', 'member')",
    );
    expect(queryText).toContain('p.tenant_id = $3::uuid');
    expect(query.mock.calls[0]?.[1]).toContain(TENANT_A);
  });

  it('returns null when a target is not visible to the user', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.findDeploymentTargetForUser('target-1', 'user-2'),
    ).resolves.toBeNull();
  });

  it('keeps a tenant A context from reading or mutating tenant B targets', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(
      repository.listDeploymentTargets('tenant-b-project'),
    ).resolves.toEqual([]);
    await expect(
      repository.deleteDeploymentTargetForUser(
        'tenant-b-project',
        'tenant-b-target',
        USER_ID,
      ),
    ).resolves.toBe(false);

    expect(query.mock.calls[0]?.[1]).toEqual(['tenant-b-project', TENANT_A]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      'tenant-b-project',
      'tenant-b-target',
      USER_ID,
      TENANT_A,
    ]);
  });

  it('fails closed before querying when the validated tenant context is absent', async () => {
    const noContext: TenantContextPort = {
      current: () => null,
      require: () => {
        throw new TenantContextRequiredError();
      },
      set: jest.fn(),
      clear: jest.fn(),
    };
    const noContextRepository = new DeploymentTargetsRepository(
      makeDatabaseService(query),
      noContext,
    );

    await expect(
      noContextRepository.listDeploymentTargets('project-1'),
    ).rejects.toThrow(TenantContextRequiredError);
    expect(query).not.toHaveBeenCalled();
  });
});
