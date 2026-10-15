import { ProjectProvisioningApplicationService } from './project-provisioning-application.service';
import { ProjectProvisioningSupport } from './project-provisioning.support';
import { SingleRepositoryProjectProvisioner } from './single-repository-project.provisioner';
import { WorkspaceGateService } from './workspace-gate.service';
import type { CreateProjectDto } from '../../api/dto/create-project.dto';
import type { CreateProjectResponse } from './projects.service.types';

describe('Host assignment after project creation', () => {
  const listProjectEnvironments = jest.fn();
  const assignProvisionedEnvironment = jest.fn();
  const ensureAutomaticAssignment = jest.fn();
  let create: jest.SpyInstance;
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
    create = jest
      .spyOn(
        SingleRepositoryProjectProvisioner.prototype,
        'createStandaloneProject',
      )
      .mockResolvedValue({
        id: 'existing-project',
        status: 'provisioned',
      } as CreateProjectResponse);
    listProjectEnvironments.mockResolvedValue([
      { id: 'dev-id', slug: 'dev' },
      { id: 'main-id', slug: 'main' },
    ]);
    ensureAutomaticAssignment.mockReset().mockResolvedValue(null);
    assignProvisionedEnvironment.mockRejectedValue(
      new Error('Port is occupied'),
    );
  });
  afterEach(() => jest.restoreAllMocks());
  const dto = {
    visibility: 'private',
    projectTypeId: 'nestjs',
    serviceName: 'example',
    repoShape: 'single-app',
    repoName: 'example',
    environments: [
      {
        slug: 'dev',
        displayName: 'Test',
        sourceBranch: 'dev',
        role: 'non_production',
        hostAssignment: {
          machineId: 'machine',
          requestId: 'request',
          config: {
            ports: [],
            health: [],
            ingress: { mode: 'direct', publicUrl: null },
          },
        },
      },
      {
        slug: 'main',
        displayName: 'Production',
        sourceBranch: 'main',
        role: 'production',
      },
    ],
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
      { assignProvisionedEnvironment, ensureAutomaticAssignment },
    );
  }
  it('returns the created project with a retryable binding failure, without creating another repository', async () => {
    const result = await service().createProject('user', 'login', 'token', dto);
    expect(result.id).toBe('existing-project');
    expect(result.hostAssignments).toEqual([
      expect.objectContaining({ environmentId: 'dev-id', status: 'failed' }),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('retains the created project when the post-create environment read fails', async () => {
    listProjectEnvironments.mockRejectedValue(
      new Error('Database temporarily unavailable'),
    );
    const result = await service().createProject('user', 'login', 'token', dto);
    expect(result.id).toBe('existing-project');
    expect(result.hostAssignmentError).toMatch(/Project created/);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('assigns environments nobody configured to the only healthy machine', async () => {
    ensureAutomaticAssignment.mockImplementation(
      (_project: string, environmentId: string) =>
        Promise.resolve(
          environmentId === 'main-id' ? { assignmentId: 'auto' } : null,
        ),
    );
    const result = await service().createProject('user', 'login', 'token', dto);
    // The explicitly configured environment is not auto-assigned as well.
    expect(ensureAutomaticAssignment).toHaveBeenCalledTimes(1);
    expect(ensureAutomaticAssignment).toHaveBeenCalledWith(
      'existing-project',
      'main-id',
      'user',
    );
    expect(result.hostAssignments).toEqual(
      expect.arrayContaining([
        { environmentId: 'main-id', status: 'assigned', assignmentId: 'auto' },
        expect.objectContaining({ environmentId: 'dev-id', status: 'failed' }),
      ]),
    );
  });
});
