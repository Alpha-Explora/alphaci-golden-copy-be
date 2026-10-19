import { ProjectProvisioningApplicationService } from './project-provisioning-application.service';
import { ProjectProvisioningSupport } from './project-provisioning.support';
import { MultiRepositoryProjectProvisioner } from './multi-repository-project.provisioner';
import { WorkspaceGateService } from './workspace-gate.service';
import type { CreateProjectDto } from '../../api/dto/create-project.dto';
import type { CreateProjectResponse } from './projects.service.types';

/*
 * A two-repository project with its own environments is two project rows,
 * each with its own environments and one slot. Host assignment after create
 * must run for both rows, give each row only its own slot of an explicit
 * config, and name the repository in what it reports.
 */
describe('Host assignment after creating a two-repository project', () => {
  const listProjectEnvironments = jest.fn();
  const assignProvisionedEnvironment = jest.fn();
  const ensureAutomaticAssignment = jest.fn();
  let createPair: jest.SpyInstance;
  const pair = {
    id: 'backend-project',
    secondaryProjectId: 'frontend-project',
    status: 'provisioned',
  } as CreateProjectResponse;

  beforeEach(() => {
    jest
      .spyOn(ProjectProvisioningSupport.prototype, 'assertWithinQuota')
      .mockResolvedValue(undefined);
    jest
      .spyOn(
        ProjectProvisioningSupport.prototype,
        'assertProjectNameAvailableForCreate',
      )
      .mockResolvedValue(undefined);
    jest
      .spyOn(WorkspaceGateService.prototype, 'resolveWorkspaceIdForCreate')
      .mockResolvedValue('workspace');
    jest
      .spyOn(
        ProjectProvisioningSupport.prototype,
        'resolveRepositoryProvisioning',
      )
      .mockResolvedValue({
        repositoryCreationToken: 'token',
        provisioningToken: 'token',
        provisioningOwnerLogin: 'owner',
      });
    createPair = jest
      .spyOn(
        MultiRepositoryProjectProvisioner.prototype,
        'createMultiRepoProject',
      )
      .mockResolvedValue(pair);
    listProjectEnvironments
      .mockReset()
      .mockImplementation((projectId: string) =>
        Promise.resolve(
          projectId === 'backend-project'
            ? [
                { id: 'be-dev', slug: 'dev' },
                { id: 'be-main', slug: 'main' },
              ]
            : [
                { id: 'fe-dev', slug: 'dev' },
                { id: 'fe-main', slug: 'main' },
              ],
        ),
      );
    ensureAutomaticAssignment.mockReset().mockResolvedValue(null);
    assignProvisionedEnvironment
      .mockReset()
      .mockImplementation((projectId: string, environmentId: string) =>
        Promise.resolve({ assignmentId: `${projectId}/${environmentId}` }),
      );
  });
  afterEach(() => jest.restoreAllMocks());

  const config = {
    ports: [
      { slot: 'backend' as const, containerPort: 4000 },
      { slot: 'frontend' as const, containerPort: 3000 },
    ],
    health: [
      { slot: 'backend' as const, path: '/health' },
      { slot: 'frontend' as const, path: '/' },
    ],
    ingress: { mode: 'tunnel' as const, publicUrl: null },
  };
  const onpremTargets = ['dev', 'main'].flatMap((environmentSlug) =>
    (['backend', 'frontend'] as const).map((slot) => ({
      slot,
      provider: 'onprem-compose',
      ownershipMode: 'byo' as const,
      environmentSlug,
    })),
  );
  const dto = {
    visibility: 'private',
    projectTypeId: 'nestjs',
    serviceName: 'example',
    repoShape: 'multi-repo',
    repoName: 'example',
    multiRepoConfig: {
      backend: { projectTypeId: 'nestjs', serviceName: 'example-be' },
      frontend: { projectTypeId: 'react-app', serviceName: 'example-fe' },
    },
    environments: [
      {
        slug: 'dev',
        displayName: 'Test',
        sourceBranch: 'dev',
        role: 'non_production',
      },
      {
        slug: 'main',
        displayName: 'Production',
        sourceBranch: 'main',
        role: 'production',
        hostAssignment: { machineId: 'machine', requestId: 'request', config },
      },
    ],
    deploymentProvisioning: { enabled: true, targets: onpremTargets },
  } satisfies CreateProjectDto;

  function service() {
    return new ProjectProvisioningApplicationService(
      {} as never,
      {} as never,
      { listProjectEnvironments } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        assignProvisionedEnvironment,
        ensureAutomaticAssignment,
        publicAddress: jest.fn(),
      },
    );
  }

  it('creates the pair with environments and assigns each row its own slot of the chosen host', async () => {
    const result = await service().createProject('user', 'login', 'token', dto);

    expect(createPair).toHaveBeenCalledTimes(1);
    expect(assignProvisionedEnvironment.mock.calls).toEqual([
      [
        'backend-project',
        'be-main',
        'user',
        {
          machineId: 'machine',
          requestId: 'request',
          config: {
            ports: [{ slot: 'backend', containerPort: 4000 }],
            health: [{ slot: 'backend', path: '/health' }],
            ingress: config.ingress,
          },
        },
      ],
      [
        'frontend-project',
        'fe-main',
        'user',
        {
          machineId: 'machine',
          requestId: 'request',
          config: {
            ports: [{ slot: 'frontend', containerPort: 3000 }],
            health: [{ slot: 'frontend', path: '/' }],
            ingress: config.ingress,
          },
        },
      ],
    ]);
    expect(result.hostAssignments).toEqual([
      {
        environmentId: 'be-main',
        status: 'assigned',
        assignmentId: 'backend-project/be-main',
        projectId: 'backend-project',
        slot: 'backend',
      },
      {
        environmentId: 'fe-main',
        status: 'assigned',
        assignmentId: 'frontend-project/fe-main',
        projectId: 'frontend-project',
        slot: 'frontend',
      },
    ]);
    expect(result).not.toHaveProperty('hostAssignmentError');
  });

  it('offers every unconfigured environment of both rows to the only healthy machine', async () => {
    await service().createProject('user', 'login', 'token', dto);

    expect(ensureAutomaticAssignment.mock.calls).toEqual([
      ['backend-project', 'be-dev', 'user'],
      ['frontend-project', 'fe-dev', 'user'],
    ]);
  });

  it("names the repository when one row's assignment fails, and keeps the other", async () => {
    assignProvisionedEnvironment.mockImplementation((projectId: string) =>
      projectId === 'frontend-project'
        ? Promise.reject(new Error('Port is occupied'))
        : Promise.resolve({ assignmentId: 'ok' }),
    );

    const result = await service().createProject('user', 'login', 'token', dto);

    expect(result.hostAssignments).toEqual([
      expect.objectContaining({
        projectId: 'backend-project',
        status: 'assigned',
      }),
      expect.objectContaining({
        projectId: 'frontend-project',
        status: 'failed',
        message: expect.stringMatching(
          /^Frontend repository: Project created/,
        ) as unknown,
      }),
    ]);
  });

  it("names the repository when one row's environments cannot be read", async () => {
    listProjectEnvironments.mockImplementation((projectId: string) =>
      projectId === 'frontend-project'
        ? Promise.reject(new Error('Database temporarily unavailable'))
        : Promise.resolve([{ id: 'be-main', slug: 'main' }]),
    );

    const result = await service().createProject('user', 'login', 'token', dto);

    expect(result.hostAssignments).toEqual([
      expect.objectContaining({ projectId: 'backend-project' }),
    ]);
    expect(result.hostAssignmentError).toMatch(
      /^Frontend repository: Project created\. Host assignments could not be read/,
    );
  });

  it('assigns only the backend row when the frontend repository was not created', async () => {
    createPair.mockResolvedValue({ ...pair, secondaryProjectId: undefined });

    const result = await service().createProject('user', 'login', 'token', dto);

    expect(listProjectEnvironments).toHaveBeenCalledTimes(1);
    expect(result.hostAssignments).toEqual([
      expect.objectContaining({ projectId: 'backend-project' }),
    ]);
  });

  it('leaves a hosted pair without environments exactly as created', async () => {
    const hosted: CreateProjectDto = { ...dto };
    delete hosted.environments;
    delete hosted.deploymentProvisioning;

    const result = await service().createProject(
      'user',
      'login',
      'token',
      hosted,
    );

    expect(result).toBe(pair);
    expect(listProjectEnvironments).not.toHaveBeenCalled();
    expect(ensureAutomaticAssignment).not.toHaveBeenCalled();
  });

  it("accepts the create wizard's two-repository on-prem request", async () => {
    // The request the frontend wizard sends: repoShape `multi`, dev/uat/main,
    // and one on-prem target per environment for each slot (6 targets),
    // validated with the real on-prem delivery rule.
    const wizard = {
      ...dto,
      repoShape: 'multi',
      environments: [
        {
          slug: 'dev',
          displayName: 'Test',
          sourceBranch: 'dev',
          role: 'non_production',
        },
        {
          slug: 'uat',
          displayName: 'UAT',
          sourceBranch: 'uat',
          role: 'non_production',
        },
        {
          slug: 'main',
          displayName: 'Production',
          sourceBranch: 'main',
          role: 'production',
        },
      ],
      deploymentProvisioning: {
        enabled: true,
        targets: ['dev', 'uat', 'main'].flatMap((environmentSlug) =>
          (['backend', 'frontend'] as const).map((slot) => ({
            slot,
            provider: 'onprem-compose',
            ownershipMode: 'byo' as const,
            environmentSlug,
          })),
        ),
      },
    } satisfies CreateProjectDto;
    const registry = {
      deliveredByHost: (provider: string) => provider === 'onprem-compose',
    };
    const args: unknown[] = [
      {},
      {},
      { listProjectEnvironments },
      {},
      {},
      ...Array<undefined>(11).fill(undefined),
      { assignProvisionedEnvironment, ensureAutomaticAssignment },
    ];
    args[13] = registry;
    const withRegistry = new ProjectProvisioningApplicationService(
      ...(args as ConstructorParameters<
        typeof ProjectProvisioningApplicationService
      >),
    );

    await withRegistry.createProject('user', 'login', 'token', wizard);

    expect(createPair).toHaveBeenCalledTimes(1);
    expect(createPair.mock.calls[0]?.[5]).toBe(wizard);
  });

  it('still refuses environments for a microservices project before any repository exists', async () => {
    await expect(
      service().createProject('user', 'login', 'token', {
        ...dto,
        repoShape: 'microservices',
      }),
    ).rejects.toThrow(/supported for single-repository projects/);
    expect(createPair).not.toHaveBeenCalled();
  });

  it('refuses a standalone target for a pair with environments', async () => {
    await expect(
      service().createProject('user', 'login', 'token', {
        ...dto,
        deploymentProvisioning: {
          enabled: true,
          targets: [
            {
              slot: 'standalone',
              provider: 'onprem-compose',
              ownershipMode: 'byo',
              environmentSlug: 'main',
            },
          ],
        },
      }),
    ).rejects.toThrow(/backend or frontend slot/);
    expect(createPair).not.toHaveBeenCalled();
  });
});
