import { NotFoundException } from '@nestjs/common';

import { ProjectProvisioningApplicationService } from './project-provisioning-application.service';
import type { CatalogService } from '../catalog/catalog.service';
import type { CiService } from '#modules/pipelines/ci/application/ci.service';
import type { GithubService } from '#modules/pipelines/github/infrastructure/github.service';
import type { ProjectLinkPort } from '#kernel/ports/project-link.port';
import { createDefaultWorkflowFragmentRegistry } from '#modules/runtime/index.js';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';

const makeCatalogService = () =>
  ({
    getProjectOptions: jest.fn().mockReturnValue({
      recipes: [
        {
          id: 'backend-api-ci',
          templateByProjectType: { 'nestjs-api': 'be-nestjs' },
        },
      ],
    }),
    getStackRuntimeVersion: jest.fn().mockReturnValue(undefined),
    getTemplateById: jest.fn().mockResolvedValue({
      id: 'be-nestjs',
      name: 'NestJS Backend',
      stack: 'nestjs',
      workflowPath: '/template.yml',
    }),
    getResolvedStarterPath: jest.fn().mockReturnValue(null),
  }) as unknown as CatalogService;

const makeGithubService = () =>
  ({
    on: jest.fn(),
    getInstallationAccessTokenForUser: jest.fn().mockResolvedValue(null),
    getInstallationAccessTokenForUserRepo: jest.fn().mockResolvedValue(null),
    getInstallationOwnerLogin: jest.fn().mockResolvedValue(undefined),
    getEnforcedOrg: jest.fn().mockReturnValue(''),
    createRepo: jest.fn().mockResolvedValue({
      repoUrl: 'https://github.com/owner/repo',
      ownerLogin: 'owner',
      repoName: 'repo',
    }),
    createBranch: jest.fn().mockResolvedValue(undefined),
    applyBranchProtection: jest.fn().mockResolvedValue(undefined),
    setActionsSecret: jest.fn().mockResolvedValue(undefined),
    setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
    deleteRepo: jest.fn().mockResolvedValue(true),
  }) as unknown as GithubService;

const makeProjectsRepository = () =>
  ({
    create: jest.fn().mockResolvedValue({ id: 'project-1' }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    deleteByIdAndUser: jest.fn().mockResolvedValue(true),
    // Both required for resolveWorkspaceIdForCreate('w1') to resolve rather
    // than throw before the deliveryProjectId gate is even reached.
    isGlobalProjectCreator: jest.fn().mockResolvedValue(true),
    canCreateInWorkspace: jest.fn().mockResolvedValue(true),
    listWorkspaceLeadAndDeveloperIds: jest
      .fn()
      .mockResolvedValue(['lead-1', 'dev-1']),
    findUserLogin: jest.fn().mockResolvedValue('tone'),
  }) as unknown as ProjectsRepository;

const makeCiService = () =>
  ({
    issueProjectToken: jest.fn().mockResolvedValue({
      token: 'aci_test-token',
      tokenPrefix: 'aci_test-tok',
    }),
  }) as unknown as CiService;

const makeProjectDeploymentProvisioningService = () => ({
  provisionForProject: jest.fn().mockResolvedValue({
    status: 'skipped',
    targets: [],
  }),
  crossLinkServiceUrls: jest.fn().mockResolvedValue(undefined),
});

const baseDto = {
  repoName: 'repo',
  visibility: 'private' as const,
  repoShape: 'standalone',
  projectTypeId: 'nestjs-api',
  workflowRecipeId: 'backend-api-ci',
  serviceName: 'api',
  workspaceId: 'w1',
};

function makeService(
  hierarchyProjectLinkService: ProjectLinkPort,
  notificationEventPublisher?: { record: jest.Mock },
) {
  const githubService = makeGithubService();
  const projectsRepository = makeProjectsRepository();
  const ciService = makeCiService();

  const service = new ProjectProvisioningApplicationService(
    makeCatalogService(),
    githubService,
    projectsRepository,
    ciService,
    makeProjectDeploymentProvisioningService(),
    undefined,
    undefined,
    undefined,
    undefined,
    notificationEventPublisher as never,
    undefined,
    hierarchyProjectLinkService,
    undefined,
    createDefaultWorkflowFragmentRegistry(),
  );

  // Bypass the workflow-file generation internals (irrelevant to ordering) —
  // same technique as projects.service.workflow-auth.spec.ts.
  const support = (
    service as unknown as {
      support: {
        buildWorkflowBundle: jest.Mock;
        pushStarterFiles: jest.Mock;
        pushWorkflowFile: jest.Mock;
      };
    }
  ).support;
  jest.spyOn(support, 'buildWorkflowBundle').mockResolvedValue({
    workflowFiles: [
      {
        stage: 'access',
        name: 'a',
        path: '.github/workflows/a.yml',
        gated: true,
        yaml: 'x',
      },
    ],
    outputFileName: 'a.yml',
  });
  jest.spyOn(support, 'pushStarterFiles').mockResolvedValue(undefined);
  jest
    .spyOn(support, 'pushWorkflowFile')
    .mockResolvedValue({ commitSha: 'sha', commitUrl: null });

  return { service, githubService, projectsRepository };
}

/**
 * A caller-supplied deliveryProjectId must be validated before any GitHub
 * call — a late rejection would strand an already-created repository (the
 * whole reason the plan requires this ordering). These tests assert not just
 * that an invalid id is rejected, but that GitHub is never touched trying.
 */
describe('ProjectProvisioningApplicationService — deliveryProjectId validation ordering', () => {
  it('rejects an invalid deliveryProjectId before resolving GitHub provisioning, and never calls the GitHub port', async () => {
    const hierarchyProjectLinkService: ProjectLinkPort = {
      getLinkedRepositoryId: jest.fn().mockResolvedValue(null),
      ensureLink: jest.fn().mockResolvedValue(null),
      assertDeliveryProjectAvailableForCreate: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Delivery project not found')),
    };
    const { service, githubService } = makeService(hierarchyProjectLinkService);

    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', {
        ...baseDto,
        deliveryProjectId: 'dp-missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(
      hierarchyProjectLinkService.assertDeliveryProjectAvailableForCreate,
    ).toHaveBeenCalledWith({
      deliveryProjectId: 'dp-missing',
      workspaceId: 'w1',
      userId: 'user-1',
    });
    expect(githubService.createRepo).not.toHaveBeenCalled();
    expect(
      githubService.getInstallationAccessTokenForUser,
    ).not.toHaveBeenCalled();
  });

  it('does not call the deliveryProjectId gate at all when none is given, and still reaches GitHub', async () => {
    const hierarchyProjectLinkService: ProjectLinkPort = {
      getLinkedRepositoryId: jest.fn().mockResolvedValue(null),
      ensureLink: jest.fn().mockResolvedValue(null),
      assertDeliveryProjectAvailableForCreate: jest.fn(),
    };
    const { service, githubService } = makeService(hierarchyProjectLinkService);

    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', baseDto),
    ).resolves.toMatchObject({ id: 'project-1' });

    expect(
      hierarchyProjectLinkService.assertDeliveryProjectAvailableForCreate,
    ).not.toHaveBeenCalled();
    expect(githubService.createRepo).toHaveBeenCalled();
  });

  it('validates the deliveryProjectId BEFORE resolving a provisioning token — ordering holds even for a valid id', async () => {
    const calls: string[] = [];
    const hierarchyProjectLinkService: ProjectLinkPort = {
      getLinkedRepositoryId: jest.fn().mockResolvedValue(null),
      ensureLink: jest.fn().mockResolvedValue(null),
      assertDeliveryProjectAvailableForCreate: jest.fn(async () => {
        calls.push('gate');
      }),
    };
    const { service, githubService } = makeService(hierarchyProjectLinkService);
    (githubService.createRepo as jest.Mock).mockImplementation(async () => {
      calls.push('createRepo');
      return {
        repoUrl: 'https://github.com/owner/repo',
        ownerLogin: 'owner',
        repoName: 'repo',
      };
    });

    await service.createProject('user-1', 'octocat', 'gh-token', {
      ...baseDto,
      deliveryProjectId: 'dp-1',
    });

    expect(calls).toEqual(['gate', 'createRepo']);
  });

  it('setupProject validates deliveryProjectId before resolveSetupProvisioningToken (its first GitHub call)', async () => {
    const hierarchyProjectLinkService: ProjectLinkPort = {
      getLinkedRepositoryId: jest.fn().mockResolvedValue(null),
      ensureLink: jest.fn().mockResolvedValue(null),
      assertDeliveryProjectAvailableForCreate: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Delivery project not found')),
    };
    const { service, githubService } = makeService(hierarchyProjectLinkService);

    await expect(
      service.setupProject('user-1', 'gh-token', {
        templateId: 'be-nestjs',
        serviceName: 'api',
        repoFullName: 'owner/repo',
        workspaceId: 'w1',
        deliveryProjectId: 'dp-missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(
      githubService.getInstallationAccessTokenForUserRepo,
    ).not.toHaveBeenCalled();
  });
});

describe('ProjectProvisioningApplicationService, project_created fan-out (single repository)', () => {
  const link = (): ProjectLinkPort => ({
    getLinkedRepositoryId: jest.fn().mockResolvedValue(null),
    ensureLink: jest.fn().mockResolvedValue(null),
    assertDeliveryProjectAvailableForCreate: jest.fn(),
  });

  const recipients = (record: jest.Mock) =>
    record.mock.calls
      .map(([call]) => call as { userId: string; eventCode: string })
      .filter((call) => call.eventCode === 'project_created')
      .map((call) => call.userId)
      .sort();

  it('createProject notifies the creator, leads and developers once each', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { service, projectsRepository } = makeService(link(), { record });
    (projectsRepository.create as jest.Mock).mockResolvedValue({
      id: 'project-1',
      workspace_id: 'w1',
    });

    await service.createProject('user-1', 'octocat', 'gh-token', baseDto);

    expect(recipients(record)).toEqual(['dev-1', 'lead-1', 'user-1']);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        title: 'New project created: owner/repo',
        body: expect.stringContaining('@octocat created project owner/repo'),
      }),
    );
  });

  it('createProject does not double-notify a creator who is also a lead', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { service, projectsRepository } = makeService(link(), { record });
    (projectsRepository.create as jest.Mock).mockResolvedValue({
      id: 'project-1',
      workspace_id: 'w1',
    });
    (
      projectsRepository.listWorkspaceLeadAndDeveloperIds as jest.Mock
    ).mockResolvedValue(['user-1', 'dev-1']);

    await service.createProject('user-1', 'octocat', 'gh-token', baseDto);

    expect(recipients(record)).toEqual(['dev-1', 'user-1']);
  });

  it('createProject succeeds even when the recipient lookup throws', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { service, projectsRepository } = makeService(link(), { record });
    (
      projectsRepository.listWorkspaceLeadAndDeveloperIds as jest.Mock
    ).mockRejectedValue(new Error('db down'));
    (projectsRepository.create as jest.Mock).mockResolvedValue({
      id: 'project-1',
      workspace_id: 'w1',
    });

    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', baseDto),
    ).resolves.toMatchObject({ id: 'project-1' });
  });

  it('setupProject fans out using the login read back from the user record', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { service, projectsRepository, githubService } = makeService(link(), {
      record,
    });
    (projectsRepository.create as jest.Mock).mockResolvedValue({
      id: 'project-1',
      workspace_id: 'w1',
    });
    (
      githubService as unknown as {
        getInstallationAccessTokenForUserRepo: jest.Mock;
      }
    ).getInstallationAccessTokenForUserRepo.mockResolvedValue('install-token');
    (githubService as unknown as Record<string, jest.Mock>)[
      'getInstallationOwnerLogin'
    ]?.mockResolvedValue('owner');
    Object.assign(githubService, {
      branchExists: jest.fn().mockResolvedValue(true),
      getRepo: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
      listBranches: jest
        .fn()
        .mockResolvedValue([
          { name: 'main', protected: false, commitSha: 's' },
        ]),
      requiresPullRequestToPush: jest.fn().mockResolvedValue(false),
    });

    await service.setupProject('user-1', 'gh-token', {
      templateId: 'be-nestjs',
      serviceName: 'api',
      repoFullName: 'owner/repo',
      workspaceId: 'w1',
    });

    expect(projectsRepository.findUserLogin).toHaveBeenCalledWith('user-1');
    expect(recipients(record)).toEqual(['dev-1', 'lead-1', 'user-1']);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('@tone created project owner/repo'),
      }),
    );
  });
});
