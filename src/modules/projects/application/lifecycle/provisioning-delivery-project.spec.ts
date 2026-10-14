import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

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
    ensurePullRequestProtection: jest
      .fn()
      .mockResolvedValue({ status: 'applied' }),
    setActionsSecret: jest.fn().mockResolvedValue(undefined),
    setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
    deleteRepo: jest.fn().mockResolvedValue(true),
  }) as unknown as GithubService;

const makeProjectsRepository = (appRole = 'admin') =>
  ({
    create: jest.fn().mockResolvedValue({ id: 'project-1' }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    deleteByIdAndUser: jest.fn().mockResolvedValue(true),
    // Both required for resolveWorkspaceIdForCreate('w1') to resolve rather
    // than throw before the deliveryProjectId gate is even reached.
    findAppRole: jest.fn().mockResolvedValue(appRole),
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
  appRole = 'admin',
  { featureCount = 1, ruleEnabled = true } = {},
) {
  const readiness = {
    isFeatureRuleEnabled: jest.fn().mockReturnValue(ruleEnabled),
    countActiveFeatures: jest
      .fn()
      .mockImplementation((ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, featureCount]))),
      ),
  };
  const githubService = makeGithubService();
  const projectsRepository = makeProjectsRepository(appRole);
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
    undefined,
    readiness as never,
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

  return { service, githubService, projectsRepository, readiness };
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
      getProjectFolder: jest.fn().mockResolvedValue(null),
      getDeliveryProject: jest.fn().mockResolvedValue(null),
      listDeliveryProjectsForGroup: jest.fn().mockResolvedValue([]),
      ensureLink: jest.fn().mockResolvedValue(null),
      assertProjectNameAvailableForCreate: jest.fn(),
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
      getProjectFolder: jest.fn().mockResolvedValue(null),
      getDeliveryProject: jest.fn().mockResolvedValue(null),
      listDeliveryProjectsForGroup: jest.fn().mockResolvedValue([]),
      ensureLink: jest.fn().mockResolvedValue(null),
      assertProjectNameAvailableForCreate: jest.fn(),
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
      getProjectFolder: jest.fn().mockResolvedValue(null),
      getDeliveryProject: jest.fn().mockResolvedValue(null),
      listDeliveryProjectsForGroup: jest.fn().mockResolvedValue([]),
      ensureLink: jest.fn().mockResolvedValue(null),
      assertProjectNameAvailableForCreate: jest.fn(),
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
      getProjectFolder: jest.fn().mockResolvedValue(null),
      getDeliveryProject: jest.fn().mockResolvedValue(null),
      listDeliveryProjectsForGroup: jest.fn().mockResolvedValue([]),
      ensureLink: jest.fn().mockResolvedValue(null),
      assertProjectNameAvailableForCreate: jest.fn(),
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
    getProjectFolder: jest.fn().mockResolvedValue(null),
    getDeliveryProject: jest.fn().mockResolvedValue(null),
    listDeliveryProjectsForGroup: jest.fn().mockResolvedValue([]),
    ensureLink: jest.fn().mockResolvedValue(null),
    assertProjectNameAvailableForCreate: jest.fn(),
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

const nameTaken = () =>
  new ConflictException({
    code: 'PROJECT_NAME_TAKEN',
    message: 'A Project named "Payments" already exists in this team.',
  });

describe('ProjectProvisioningApplicationService — projectName (new Project on create)', () => {
  const link = (over: Partial<ProjectLinkPort> = {}): ProjectLinkPort => ({
    getLinkedRepositoryId: jest.fn().mockResolvedValue(null),
    getProjectFolder: jest.fn().mockResolvedValue(null),
    getDeliveryProject: jest.fn().mockResolvedValue(null),
    listDeliveryProjectsForGroup: jest.fn().mockResolvedValue([]),
    ensureLink: jest.fn().mockResolvedValue(null),
    assertProjectNameAvailableForCreate: jest.fn().mockResolvedValue(undefined),
    assertDeliveryProjectAvailableForCreate: jest.fn(),
    ...over,
  });

  it('single repo: names the new chain after projectName and enforces uniqueness', async () => {
    const hierarchy = link();
    const { service } = makeService(hierarchy);

    await service.createProject('user-1', 'octocat', 'gh-token', {
      ...baseDto,
      projectName: '  Payments Platform ',
    });

    expect(hierarchy.assertProjectNameAvailableForCreate).toHaveBeenCalledWith({
      workspaceId: 'w1',
      name: 'Payments Platform',
    });
    expect(hierarchy.ensureLink).toHaveBeenCalledWith(
      expect.objectContaining({
        chainName: 'Payments Platform',
        enforceUniqueChainName: true,
      }),
    );
  });

  it('old callers without projectName are unchanged (no gate, no chainName, no enforcement)', async () => {
    const hierarchy = link();
    const { service } = makeService(hierarchy);

    await service.createProject('user-1', 'octocat', 'gh-token', baseDto);

    expect(
      hierarchy.assertProjectNameAvailableForCreate,
    ).not.toHaveBeenCalled();
    const input = (hierarchy.ensureLink as jest.Mock).mock.calls[0]?.[0];
    expect(input).not.toHaveProperty('chainName');
    expect(input).not.toHaveProperty('enforceUniqueChainName');
  });

  it('deliveryProjectId wins: projectName is ignored and not checked', async () => {
    const hierarchy = link();
    const { service } = makeService(hierarchy);

    await service.createProject('user-1', 'octocat', 'gh-token', {
      ...baseDto,
      projectName: 'Ignored',
      deliveryProjectId: 'dp-1',
    });

    expect(
      hierarchy.assertProjectNameAvailableForCreate,
    ).not.toHaveBeenCalled();
    const input = (hierarchy.ensureLink as jest.Mock).mock.calls[0]?.[0];
    expect(input).toMatchObject({ deliveryProjectId: 'dp-1' });
    expect(input).not.toHaveProperty('chainName');
  });

  it('a duplicate name fails 409 PROJECT_NAME_TAKEN before any GitHub call', async () => {
    const hierarchy = link({
      assertProjectNameAvailableForCreate: jest
        .fn()
        .mockRejectedValue(nameTaken()),
    });
    const { service, githubService } = makeService(hierarchy);

    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', {
        ...baseDto,
        projectName: 'Payments',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(githubService.createRepo).not.toHaveBeenCalled();
    expect(
      githubService.getInstallationAccessTokenForUser,
    ).not.toHaveBeenCalled();
  });

  it('losing the name race after the repo exists removes the project row and the repo, and fails 409', async () => {
    const hierarchy = link({
      ensureLink: jest.fn().mockRejectedValue(nameTaken()),
    });
    const { service, githubService, projectsRepository } =
      makeService(hierarchy);

    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', {
        ...baseDto,
        projectName: 'Payments',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(projectsRepository.deleteByIdAndUser).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
    expect(githubService.deleteRepo).toHaveBeenCalled();
  });

  it('setupProject gates a duplicate name before its first GitHub call', async () => {
    const hierarchy = link({
      assertProjectNameAvailableForCreate: jest
        .fn()
        .mockRejectedValue(nameTaken()),
    });
    const { service, githubService } = makeService(hierarchy);

    await expect(
      service.setupProject('user-1', 'gh-token', {
        templateId: 'be-nestjs',
        serviceName: 'api',
        repoFullName: 'owner/repo',
        workspaceId: 'w1',
        projectName: 'Payments',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(
      githubService.getInstallationAccessTokenForUserRepo,
    ).not.toHaveBeenCalled();
  });
});

describe('ProjectProvisioningApplicationService - persona gate on repository creation', () => {
  const link = (): ProjectLinkPort => ({
    getLinkedRepositoryId: jest.fn().mockResolvedValue(null),
    getProjectFolder: jest.fn().mockResolvedValue(null),
    getDeliveryProject: jest.fn().mockResolvedValue(null),
    listDeliveryProjectsForGroup: jest.fn().mockResolvedValue([]),
    ensureLink: jest.fn().mockResolvedValue(null),
    assertProjectNameAvailableForCreate: jest.fn(),
    assertDeliveryProjectAvailableForCreate: jest.fn(),
  });
  const setupDto = {
    templateId: 'be-nestjs',
    serviceName: 'api',
    repoFullName: 'owner/repo',
    workspaceId: 'w1',
  };

  it.each(['lead', 'qa'])(
    '%s is refused 403 REPOSITORY_CREATE_FORBIDDEN on create and setup, before GitHub',
    async (role) => {
      const { service, githubService } = makeService(link(), undefined, role);
      const attempts = [
        () =>
          service.createProject('user-1', 'octocat', 'gh-token', {
            ...baseDto,
            deliveryProjectId: 'dp-1',
          }),
        () =>
          service.setupProject('user-1', 'gh-token', {
            ...setupDto,
            deliveryProjectId: 'dp-1',
          }),
      ];
      for (const attempt of attempts) {
        const error = await attempt().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'REPOSITORY_CREATE_FORBIDDEN',
        });
      }
      expect(githubService.createRepo).not.toHaveBeenCalled();
    },
  );

  it('a member without a Project is refused 400 PROJECT_REQUIRED on create and setup', async () => {
    const { service, githubService } = makeService(link(), undefined, 'member');
    const attempts = [
      () => service.createProject('user-1', 'octocat', 'gh-token', baseDto),
      () =>
        service.createProject('user-1', 'octocat', 'gh-token', {
          ...baseDto,
          projectName: 'New folder',
        }),
      () => service.setupProject('user-1', 'gh-token', setupDto),
    ];
    for (const attempt of attempts) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'PROJECT_REQUIRED',
      });
    }
    expect(githubService.createRepo).not.toHaveBeenCalled();
  });

  it('a member into an existing Project proceeds to the Project availability check and GitHub', async () => {
    const hierarchy = link();
    const { service, githubService } = makeService(
      hierarchy,
      undefined,
      'member',
    );
    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', {
        ...baseDto,
        deliveryProjectId: 'dp-1',
      }),
    ).resolves.toMatchObject({ id: 'project-1' });
    expect(
      hierarchy.assertDeliveryProjectAvailableForCreate,
    ).toHaveBeenCalled();
    expect(githubService.createRepo).toHaveBeenCalled();
  });

  it("a member into another team's Project keeps the existing refusal", async () => {
    const hierarchy = link();
    (
      hierarchy.assertDeliveryProjectAvailableForCreate as jest.Mock
    ).mockRejectedValue(new NotFoundException('Group not found'));
    const { service, githubService } = makeService(
      hierarchy,
      undefined,
      'member',
    );
    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', {
        ...baseDto,
        deliveryProjectId: 'dp-other',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(githubService.createRepo).not.toHaveBeenCalled();
  });

  it.each([0, 3])(
    "a member naming another team's Project gets the same 404 whatever its Feature count (%s), never reaching GitHub or the Feature count",
    async (featureCount) => {
      const hierarchy = link();
      (
        hierarchy.assertDeliveryProjectAvailableForCreate as jest.Mock
      ).mockRejectedValue(new NotFoundException('Group not found'));
      const { service, githubService, readiness } = makeService(
        hierarchy,
        undefined,
        'member',
        { featureCount },
      );
      const attempts = [
        () =>
          service.createProject('user-1', 'octocat', 'gh-token', {
            ...baseDto,
            deliveryProjectId: 'dp-other',
          }),
        () =>
          service.setupProject('user-1', 'gh-token', {
            ...setupDto,
            deliveryProjectId: 'dp-other',
          }),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
      expect(githubService.createRepo).not.toHaveBeenCalled();
    },
  );

  it('a member into a Project with no Feature is refused 409 PROJECT_FEATURES_REQUIRED on create and setup, before GitHub', async () => {
    const { service, githubService, readiness } = makeService(
      link(),
      undefined,
      'member',
      { featureCount: 0 },
    );
    const attempts = [
      () =>
        service.createProject('user-1', 'octocat', 'gh-token', {
          ...baseDto,
          deliveryProjectId: 'dp-1',
        }),
      () =>
        service.setupProject('user-1', 'gh-token', {
          ...setupDto,
          deliveryProjectId: 'dp-1',
        }),
    ];
    for (const attempt of attempts) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'PROJECT_FEATURES_REQUIRED',
        deliveryProjectId: 'dp-1',
      });
    }
    expect(readiness.countActiveFeatures).toHaveBeenCalledWith(['dp-1']);
    expect(githubService.createRepo).not.toHaveBeenCalled();
  });

  it('a member into a Project with a Feature, or with the QA capability off, is not blocked', async () => {
    for (const options of [
      { featureCount: 1 },
      { featureCount: 0, ruleEnabled: false },
    ]) {
      const { service, githubService } = makeService(
        link(),
        undefined,
        'member',
        options,
      );
      await expect(
        service.createProject('user-1', 'octocat', 'gh-token', {
          ...baseDto,
          deliveryProjectId: 'dp-1',
        }),
      ).resolves.toMatchObject({ id: 'project-1' });
      expect(githubService.createRepo).toHaveBeenCalled();
    }
  });

  it('an admin is exempt from the Feature rule', async () => {
    const { service, readiness } = makeService(link(), undefined, 'admin', {
      featureCount: 0,
    });
    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', {
        ...baseDto,
        deliveryProjectId: 'dp-1',
      }),
    ).resolves.toMatchObject({ id: 'project-1' });
    expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
  });

  it('an admin is unchanged: create works without a Project', async () => {
    const { service } = makeService(link(), undefined, 'admin');
    await expect(
      service.createProject('user-1', 'octocat', 'gh-token', baseDto),
    ).resolves.toMatchObject({ id: 'project-1' });
  });
});

/*
 * ATTACHING an existing org repository (POST /projects/setup) must never queue
 * automatic GitHub grants: a Developer with org-base read could otherwise be
 * handed Write on any repository as its "creator", and the Project's
 * Developers with them. Only a repository ALPHACI just created asks for them.
 */
describe('ProjectProvisioningApplicationService - automatic GitHub grants only for created repositories', () => {
  const link = (): ProjectLinkPort => ({
    getLinkedRepositoryId: jest.fn().mockResolvedValue(null),
    getProjectFolder: jest.fn().mockResolvedValue(null),
    getDeliveryProject: jest.fn().mockResolvedValue(null),
    listDeliveryProjectsForGroup: jest.fn().mockResolvedValue([]),
    ensureLink: jest.fn().mockResolvedValue(null),
    assertProjectNameAvailableForCreate: jest.fn(),
    assertDeliveryProjectAvailableForCreate: jest.fn(),
  });

  it('creating a repository asks the link for the new-repository grants', async () => {
    const hierarchy = link();
    const { service } = makeService(hierarchy);

    await service.createProject('user-1', 'octocat', 'gh-token', baseDto);

    expect(hierarchy.ensureLink).toHaveBeenCalledWith(
      expect.objectContaining({ accessGrant: 'new-repository' }),
    );
  });

  it('setupProject (attach) links with accessGrant none, so nobody is granted', async () => {
    const hierarchy = link();
    const { service, projectsRepository, githubService } =
      makeService(hierarchy);
    (projectsRepository.create as jest.Mock).mockResolvedValue({
      id: 'project-1',
      workspace_id: 'w1',
    });
    (
      githubService as unknown as {
        getInstallationAccessTokenForUserRepo: jest.Mock;
      }
    ).getInstallationAccessTokenForUserRepo.mockResolvedValue('install-token');
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

    const input = (hierarchy.ensureLink as jest.Mock).mock.calls[0]?.[0] as {
      accessGrant?: string;
    };
    expect(input.accessGrant).toBe('none');
  });
});
