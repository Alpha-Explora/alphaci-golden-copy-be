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
  );
  return {
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

describe('RepositoriesService.createRepository Feature gate', () => {
  const dto = { name: 'new-repo', visibility: 'private' } as const;

  it('a member into a Project with no Feature gets 409 before any GitHub call', async () => {
    const { service, githubService, projectLookup } = setup({
      featureCount: 0,
    });
    await expect(
      service.createRepository('dp-1', 'dev-1', 'token', dto),
    ).rejects.toMatchObject({
      response: {
        code: 'PROJECT_FEATURES_REQUIRED',
        deliveryProjectId: 'dp-1',
      },
    });
    expect(githubService.createRepo).not.toHaveBeenCalled();
    expect(projectLookup.createHierarchyManagedProject).not.toHaveBeenCalled();
  });

  it.each([0, 2])(
    'a member naming a Project they cannot access gets the access error whatever its Feature count (%s)',
    async (featureCount) => {
      const { service, accessService, githubService, readiness } = setup({
        featureCount,
      });
      accessService.assertCanCreateUnderDeliveryProject.mockRejectedValue(
        new NotFoundException('Group not found'),
      );
      await expect(
        service.createRepository('dp-other', 'dev-1', 'token', dto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
      expect(githubService.createRepo).not.toHaveBeenCalled();
    },
  );

  it('a member into a Project with a Feature creates the repository', async () => {
    const { service, githubService, readiness } = setup({ featureCount: 2 });
    await service.createRepository('dp-1', 'dev-1', 'token', dto);
    expect(readiness.countActiveFeatures).toHaveBeenCalledWith(['dp-1']);
    expect(githubService.createRepo).toHaveBeenCalledTimes(1);
  });

  it('a platform admin is exempt', async () => {
    const { service, accessService, githubService, readiness } = setup({
      featureCount: 0,
    });
    accessService.isPlatformAdmin.mockResolvedValue(true);
    await service.createRepository('dp-1', 'admin-1', 'token', dto);
    expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
    expect(githubService.createRepo).toHaveBeenCalledTimes(1);
  });

  it('a global admin app_role is exempt', async () => {
    const { service, accessService, githubService } = setup({
      featureCount: 0,
    });
    accessService.getAppRole.mockResolvedValue('admin');
    await service.createRepository('dp-1', 'admin-2', 'token', dto);
    expect(githubService.createRepo).toHaveBeenCalledTimes(1);
  });

  it('is skipped when the QA capability is off', async () => {
    const { service, githubService } = setup({
      featureCount: 0,
      ruleEnabled: false,
    });
    await service.createRepository('dp-1', 'dev-1', 'token', dto);
    expect(githubService.createRepo).toHaveBeenCalledTimes(1);
  });
});
