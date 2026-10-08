import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import type { GithubProjectPort } from '#kernel/ports/github.port';
import type { ProjectLookupPort } from '#kernel/ports/project-lookup.port';
import type { ProjectRequirementsReadinessPort } from '#kernel/ports/project-requirements-readiness.port';
import type {
  DeliveryProjectRecord,
  DeliveryProjectsRepository,
} from '../infrastructure/delivery-projects.repository';
import type {
  RepositoriesRepository,
  RepositoryRecord,
} from '../infrastructure/repositories.repository';
import type { HierarchyAccessService } from './hierarchy-access.service';
import { RepositoriesService } from './repositories.service';

const repository: RepositoryRecord = {
  id: 'repo-be',
  deliveryProjectId: 'dp-source',
  groupId: 'group-1',
  name: 'testfinals-backend',
  repoFullName: 'Alphaexplora-Sandbox/testfinals-be',
  githubRepoId: null,
  visibility: 'private',
  createdBy: 'lead-1',
  status: 'active',
  archivedAt: null,
  provisionedProjectId: 'project-be',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  assignmentCount: 2,
  htmlUrl: 'https://github.com/Alphaexplora-Sandbox/testfinals-be',
};

const target: DeliveryProjectRecord = {
  id: 'dp-target',
  systemId: 'system-target',
  groupId: 'group-1',
  name: 'testfinals',
  description: null,
  managerId: 'lead-1',
  status: 'active',
  archivedAt: null,
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T00:00:00Z',
  repositoryCount: 1,
};

function setup({ featureCount = 1, ruleEnabled = true } = {}) {
  const repositoriesRepository = {
    findById: jest.fn().mockResolvedValue(repository),
    findByProvisionedProjectId: jest.fn().mockResolvedValue(repository),
    create: jest.fn().mockResolvedValue(repository),
    moveToDeliveryProject: jest
      .fn()
      .mockResolvedValue({ ...repository, deliveryProjectId: target.id }),
    countActiveInDeliveryProject: jest.fn().mockResolvedValue(0),
  };
  const deliveryProjectsRepository = {
    findById: jest.fn().mockResolvedValue(target),
  };
  const accessService = {
    assertRepositoryManagerOrPlatformAdmin: jest
      .fn()
      .mockResolvedValue({ groupId: 'group-1', viaPlatformAdmin: false }),
    assertCanCreateUnderDeliveryProject: jest
      .fn()
      .mockResolvedValue({ groupId: 'group-1' }),
    isPlatformAdmin: jest.fn().mockResolvedValue(false),
    getAppRole: jest.fn().mockResolvedValue('member'),
  };
  const auditEventsService = { recordProjectEvent: jest.fn() };
  const githubService = {
    createRepo: jest.fn().mockResolvedValue({
      repoUrl: 'https://github.com/org/new',
      ownerLogin: 'org',
      repoName: 'new',
    }),
  };
  const projectLookup = {
    createHierarchyManagedProject: jest.fn().mockResolvedValue({ id: 'p-new' }),
  };
  const provisioning = {
    provisionRepository: jest.fn().mockResolvedValue({
      provisionedProjectId: 'p-new',
      repoFullName: 'org/new',
      repoUrl: 'https://github.com/org/new',
      workflowPath: '.github/workflows/ci.yml',
      branchesCreated: ['dev', 'uat'],
      deploymentProvisioning: { status: 'completed', targets: [] },
    }),
  };
  const membersService = {
    grantForNewRepositoryBestEffort: jest.fn().mockResolvedValue(undefined),
  };
  const readiness = {
    isFeatureRuleEnabled: jest.fn().mockReturnValue(ruleEnabled),
    countActiveFeatures: jest
      .fn()
      .mockImplementation((ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, featureCount]))),
      ),
  };
  const service = new RepositoriesService(
    repositoriesRepository as unknown as RepositoriesRepository,
    deliveryProjectsRepository as unknown as DeliveryProjectsRepository,
    accessService as unknown as HierarchyAccessService,
    githubService as unknown as GithubProjectPort,
    projectLookup as unknown as ProjectLookupPort,
    auditEventsService as unknown as AuditEventPublisher,
    readiness as unknown as ProjectRequirementsReadinessPort,
    provisioning as never,
    membersService as never,
  );
  return {
    provisioning,
    membersService,
    service,
    repositoriesRepository,
    deliveryProjectsRepository,
    accessService,
    auditEventsService,
    githubService,
    projectLookup,
    readiness,
  };
}

describe('RepositoriesService.moveRepository', () => {
  it('moves the repository, reports the emptied source and records an audit event', async () => {
    const { service, repositoriesRepository, auditEventsService } = setup();

    const result = await service.moveRepository(
      'repo-be',
      'lead-1',
      'dp-target',
    );

    expect(repositoriesRepository.moveToDeliveryProject).toHaveBeenCalledWith(
      'repo-be',
      'dp-source',
      'dp-target',
    );
    expect(result).toEqual({
      repository: expect.objectContaining({ deliveryProjectId: 'dp-target' }),
      moved: true,
      sourceDeliveryProjectId: 'dp-source',
      sourceDeliveryProjectEmpty: true,
    });
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'group-1',
        actorUserId: 'lead-1',
        eventCode: 'hierarchy.repository.moved',
        projectId: 'project-be',
        metadata: {
          groupId: 'group-1',
          repositoryId: 'repo-be',
          fromDeliveryProjectId: 'dp-source',
          toDeliveryProjectId: 'dp-target',
        },
      }),
    );
  });

  it('reports a source that still holds repositories as not empty', async () => {
    const { service, repositoriesRepository } = setup();
    repositoriesRepository.countActiveInDeliveryProject.mockResolvedValue(1);

    const result = await service.moveRepository(
      'repo-be',
      'lead-1',
      'dp-target',
    );

    expect(result.sourceDeliveryProjectEmpty).toBe(false);
  });

  it('omits projectId from the audit event when the repository has no provisioned project', async () => {
    const { service, repositoriesRepository, auditEventsService } = setup();
    repositoriesRepository.moveToDeliveryProject.mockResolvedValue({
      ...repository,
      deliveryProjectId: target.id,
      provisionedProjectId: null,
    });

    await service.moveRepository('repo-be', 'lead-1', 'dp-target');

    const event = auditEventsService.recordProjectEvent.mock.calls[0][0];
    expect(event).not.toHaveProperty('projectId');
  });

  it('rejects a caller who does not manage the team before reading anything else', async () => {
    const {
      service,
      accessService,
      deliveryProjectsRepository,
      repositoriesRepository,
    } = setup();
    accessService.assertRepositoryManagerOrPlatformAdmin.mockRejectedValue(
      new ForbiddenException(),
    );

    await expect(
      service.moveRepository('repo-be', 'dev-1', 'dp-target'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deliveryProjectsRepository.findById).not.toHaveBeenCalled();
    expect(repositoriesRepository.moveToDeliveryProject).not.toHaveBeenCalled();
  });

  it('answers a project from another team exactly like a missing one', async () => {
    const { service, deliveryProjectsRepository, repositoriesRepository } =
      setup();
    deliveryProjectsRepository.findById.mockResolvedValue({
      ...target,
      groupId: 'group-2',
    });

    await expect(
      service.moveRepository('repo-be', 'lead-1', 'dp-target'),
    ).rejects.toThrow(new NotFoundException('Delivery project not found'));
    expect(repositoriesRepository.moveToDeliveryProject).not.toHaveBeenCalled();
  });

  it('404s when the target project does not exist', async () => {
    const { service, deliveryProjectsRepository } = setup();
    deliveryProjectsRepository.findById.mockResolvedValue(null);

    await expect(
      service.moveRepository('repo-be', 'lead-1', 'dp-missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to move into an archived project', async () => {
    const { service, deliveryProjectsRepository } = setup();
    deliveryProjectsRepository.findById.mockResolvedValue({
      ...target,
      status: 'archived',
    });

    await expect(
      service.moveRepository('repo-be', 'lead-1', 'dp-target'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to move an archived repository', async () => {
    const { service, repositoriesRepository } = setup();
    repositoriesRepository.findById.mockResolvedValue({
      ...repository,
      status: 'archived',
    });

    await expect(
      service.moveRepository('repo-be', 'lead-1', 'dp-target'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repositoriesRepository.moveToDeliveryProject).not.toHaveBeenCalled();
  });

  it('is a no-op when the repository is already in the target project', async () => {
    const { service, repositoriesRepository, auditEventsService } = setup();
    repositoriesRepository.findById.mockResolvedValue({
      ...repository,
      deliveryProjectId: 'dp-target',
    });

    const result = await service.moveRepository(
      'repo-be',
      'lead-1',
      'dp-target',
    );

    expect(result).toMatchObject({
      moved: false,
      sourceDeliveryProjectEmpty: false,
    });
    expect(repositoriesRepository.moveToDeliveryProject).not.toHaveBeenCalled();
    expect(auditEventsService.recordProjectEvent).not.toHaveBeenCalled();
  });

  it('409s when a concurrent move changed the repository first', async () => {
    const { service, repositoriesRepository, auditEventsService } = setup();
    repositoriesRepository.moveToDeliveryProject.mockResolvedValue(null);

    await expect(
      service.moveRepository('repo-be', 'lead-1', 'dp-target'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(auditEventsService.recordProjectEvent).not.toHaveBeenCalled();
  });
});

const session = { githubAccessToken: 'token', login: 'dev-login' };
const dto = {
  name: 'new-repo',
  visibility: 'private',
  projectTypeId: 'nextjs-web',
} as never;

describe('RepositoriesService.createRepository Feature gate', () => {
  it('a member into a Project with no Feature gets 409 before any provisioning', async () => {
    const { service, provisioning } = setup({ featureCount: 0 });
    await expect(
      service.createRepository('dp-1', 'dev-1', session, dto),
    ).rejects.toMatchObject({
      response: {
        code: 'PROJECT_FEATURES_REQUIRED',
        deliveryProjectId: 'dp-1',
      },
    });
    expect(provisioning.provisionRepository).not.toHaveBeenCalled();
  });

  it.each([0, 2])(
    'a member naming a Project they cannot access gets the access error whatever its Feature count (%s)',
    async (featureCount) => {
      const { service, accessService, provisioning, readiness } = setup({
        featureCount,
      });
      accessService.assertCanCreateUnderDeliveryProject.mockRejectedValue(
        new NotFoundException('Group not found'),
      );
      await expect(
        service.createRepository('dp-other', 'dev-1', session, dto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
      expect(provisioning.provisionRepository).not.toHaveBeenCalled();
    },
  );

  it('a member into a Project with a Feature creates the repository', async () => {
    const { service, provisioning, readiness } = setup({ featureCount: 2 });
    await service.createRepository('dp-1', 'dev-1', session, dto);
    expect(readiness.countActiveFeatures).toHaveBeenCalledWith(['dp-1']);
    expect(provisioning.provisionRepository).toHaveBeenCalledTimes(1);
  });

  it('a platform admin is exempt', async () => {
    const { service, accessService, provisioning, readiness } = setup({
      featureCount: 0,
    });
    accessService.isPlatformAdmin.mockResolvedValue(true);
    await service.createRepository('dp-1', 'admin-1', session, dto);
    expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
    expect(provisioning.provisionRepository).toHaveBeenCalledTimes(1);
  });

  it('a global admin app_role is exempt', async () => {
    const { service, accessService, provisioning } = setup({
      featureCount: 0,
    });
    accessService.getAppRole.mockResolvedValue('admin');
    await service.createRepository('dp-1', 'admin-2', session, dto);
    expect(provisioning.provisionRepository).toHaveBeenCalledTimes(1);
  });

  it('is skipped when the QA capability is off', async () => {
    const { service, provisioning } = setup({
      featureCount: 0,
      ruleEnabled: false,
    });
    await service.createRepository('dp-1', 'dev-1', session, dto);
    expect(provisioning.provisionRepository).toHaveBeenCalledTimes(1);
  });
});

describe('RepositoriesService.createRepository (full setup)', () => {
  it('delegates to the wizard provisioning with the Project and team, defaulting the service name', async () => {
    const { service, provisioning } = setup();
    await service.createRepository('dp-1', 'dev-1', session, {
      ...(dto as object),
      deploymentProvisioning: { enabled: true, targets: [] },
    } as never);

    expect(provisioning.provisionRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'dev-1',
        userLogin: 'dev-login',
        githubAccessToken: 'token',
        workspaceId: 'group-1',
        deliveryProjectId: 'dp-1',
        repoName: 'new-repo',
        serviceName: 'new-repo',
        visibility: 'private',
        projectTypeId: 'nextjs-web',
        repoShape: 'standalone',
        deploymentProvisioning: { enabled: true, targets: [] },
      }),
    );
  });

  it('omits deploymentProvisioning when none is sent so the managed defaults apply', async () => {
    const { service, provisioning } = setup();
    await service.createRepository('dp-1', 'dev-1', session, dto);
    const input = provisioning.provisionRepository.mock.calls[0]?.[0] as object;
    expect(input).not.toHaveProperty('deploymentProvisioning');
  });

  it('returns the hierarchy row with the workflow and hosting outcome', async () => {
    const { service, provisioning } = setup();
    provisioning.provisionRepository.mockResolvedValue({
      provisionedProjectId: 'project-be',
      repoFullName: 'org/new',
      repoUrl: 'https://github.com/org/new',
      workflowPath: '.github/workflows/ci.yml',
      branchesCreated: ['dev', 'uat'],
      deploymentProvisioning: { status: 'completed', targets: [] },
    });
    const result = await service.createRepository(
      'dp-1',
      'dev-1',
      session,
      dto,
    );

    expect(result).toMatchObject({
      id: 'repo-be',
      provisioning: {
        projectId: 'project-be',
        workflowPath: '.github/workflows/ci.yml',
        branchesCreated: ['dev', 'uat'],
        hosting: { outcome: 'provisioned', failures: [] },
      },
    });
  });

  it('reports a failed hosting target with its reason instead of failing the create', async () => {
    const { service, provisioning } = setup();
    provisioning.provisionRepository.mockResolvedValue({
      provisionedProjectId: 'project-be',
      repoFullName: 'org/new',
      repoUrl: 'https://github.com/org/new',
      workflowPath: '.github/workflows/ci.yml',
      branchesCreated: ['dev', 'uat'],
      deploymentProvisioning: {
        status: 'partial',
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            status: 'failed',
            errorSummary: 'Vercel team quota reached',
            env: [],
          },
          {
            slot: 'backend',
            provider: 'render',
            status: 'created',
            errorSummary: null,
            env: [
              {
                lane: 'production',
                gitBranch: null,
                provisioned: [],
                failed: [
                  {
                    key: 'API_KEY',
                    status: 'failed',
                    errorSummary: 'rejected',
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const result = await service.createRepository(
      'dp-1',
      'dev-1',
      session,
      dto,
    );

    expect(result.provisioning.hosting).toEqual({
      outcome: 'partial',
      failures: [
        {
          slot: 'frontend',
          provider: 'vercel',
          reason: 'Vercel team quota reached',
        },
        { slot: 'backend', provider: 'render', reason: 'API_KEY: rejected' },
      ],
    });
  });

  it('reports skipped hosting as skipped', async () => {
    const { service, provisioning } = setup();
    provisioning.provisionRepository.mockResolvedValue({
      provisionedProjectId: 'project-be',
      repoFullName: 'org/new',
      repoUrl: 'u',
      workflowPath: 'w',
      branchesCreated: [],
      deploymentProvisioning: { status: 'skipped', targets: [] },
    });
    const result = await service.createRepository(
      'dp-1',
      'dev-1',
      session,
      dto,
    );
    expect(result.provisioning.hosting).toEqual({
      outcome: 'skipped',
      failures: [],
    });
  });

  it('does not write or grant again when the provisioning link already created the row', async () => {
    const { service, repositoriesRepository, membersService } = setup();
    await service.createRepository('dp-1', 'dev-1', session, dto);
    expect(repositoriesRepository.create).not.toHaveBeenCalled();
    expect(
      membersService.grantForNewRepositoryBestEffort,
    ).not.toHaveBeenCalled();
  });

  it('writes the hierarchy row and queues access itself when the best-effort link did not land', async () => {
    const { service, repositoriesRepository, membersService } = setup();
    repositoriesRepository.findByProvisionedProjectId.mockResolvedValue(null);
    await service.createRepository('dp-1', 'dev-1', session, dto);

    expect(repositoriesRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryProjectId: 'dp-1',
        groupId: 'group-1',
        repoFullName: 'org/new',
        createdBy: 'dev-1',
        provisionedProjectId: 'p-new',
      }),
    );
    expect(membersService.grantForNewRepositoryBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo-be',
        deliveryProjectId: 'dp-1',
        creatorUserId: 'dev-1',
      }),
    );
  });

  it('needs a GitHub login on the session', async () => {
    const { service, provisioning } = setup();
    await expect(
      service.createRepository(
        'dp-1',
        'dev-1',
        { githubAccessToken: 'token', login: undefined },
        dto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provisioning.provisionRepository).not.toHaveBeenCalled();
  });

  it('propagates a provisioning failure without writing a hierarchy row', async () => {
    const { service, provisioning, repositoriesRepository } = setup();
    provisioning.provisionRepository.mockRejectedValue(new Error('boom'));
    await expect(
      service.createRepository('dp-1', 'dev-1', session, dto),
    ).rejects.toThrow('boom');
    expect(repositoriesRepository.create).not.toHaveBeenCalled();
  });
});

describe('RepositoriesService.createBareRepository (legacy system flow)', () => {
  it('creates the repository and queues the creator and member access', async () => {
    const { service, githubService, membersService } = setup();
    await service.createBareRepository('dp-1', 'dev-1', 'token', {
      name: 'new-repo',
      visibility: 'private',
    });
    expect(githubService.createRepo).toHaveBeenCalledTimes(1);
    expect(membersService.grantForNewRepositoryBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryProjectId: 'dp-1',
        creatorUserId: 'dev-1',
      }),
    );
  });
});

describe('RepositoriesService.moveRepository access', () => {
  it('queues the target Project members on the moved repository, without a creator grant', async () => {
    const { service, membersService } = setup();
    await service.moveRepository('repo-be', 'lead-1', 'dp-target');
    expect(membersService.grantForNewRepositoryBestEffort).toHaveBeenCalledWith(
      {
        repositoryId: 'repo-be',
        deliveryProjectId: 'dp-target',
        assignedBy: 'lead-1',
      },
    );
  });

  it('does nothing for a no-op move', async () => {
    const { service, membersService, repositoriesRepository } = setup();
    repositoriesRepository.findById.mockResolvedValue({
      ...repository,
      deliveryProjectId: 'dp-target',
    });
    await service.moveRepository('repo-be', 'lead-1', 'dp-target');
    expect(
      membersService.grantForNewRepositoryBestEffort,
    ).not.toHaveBeenCalled();
  });
});
