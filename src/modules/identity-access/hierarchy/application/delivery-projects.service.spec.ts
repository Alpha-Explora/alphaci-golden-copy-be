import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import type { ProjectLifecyclePort } from '#kernel/ports/project-lifecycle.port';
import type { DeleteDeliveryProjectDto } from '../api/dto/delete-delivery-project.dto';
import type {
  DeliveryProjectRecord,
  DeliveryProjectsRepository,
} from '../infrastructure/delivery-projects.repository';
import type { HierarchyAccessService } from './hierarchy-access.service';
import type {
  RepositoriesRepository,
  RepositoryRecord,
} from '../infrastructure/repositories.repository';
import type { SystemsRepository } from '../infrastructure/systems.repository';
import { DeliveryProjectsService } from './delivery-projects.service';

const GROUP_ID = 'group-1';
const SYSTEM_ID = 'system-1';
const DELIVERY_PROJECT_ID = 'dp-1';
const USER_ID = 'user-1';
const TOKEN = 'gh-token';

const deliveryProject = (
  overrides: Partial<DeliveryProjectRecord> = {},
): DeliveryProjectRecord => ({
  id: DELIVERY_PROJECT_ID,
  systemId: SYSTEM_ID,
  groupId: GROUP_ID,
  name: 'Checkout',
  description: null,
  managerId: USER_ID,
  status: 'active',
  archivedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  repositoryCount: 0,
  ...overrides,
});

const repository = (
  overrides: Partial<RepositoryRecord> = {},
): RepositoryRecord => ({
  id: 'repo-1',
  deliveryProjectId: DELIVERY_PROJECT_ID,
  groupId: GROUP_ID,
  name: 'checkout-api',
  repoFullName: 'org/checkout-api',
  githubRepoId: null,
  visibility: 'private',
  createdBy: USER_ID,
  status: 'active',
  archivedAt: null,
  provisionedProjectId: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  assignmentCount: 0,
  htmlUrl: null,
  ...overrides,
});

const confirmedDto = (
  overrides: Partial<DeleteDeliveryProjectDto> = {},
): DeleteDeliveryProjectDto => ({
  confirmName: 'Checkout',
  ...overrides,
});

function setup({
  repositories = [],
  deliveryProjectRow = deliveryProject(),
  remainingDeliveryProjects = 0,
}: {
  repositories?: RepositoryRecord[];
  deliveryProjectRow?: DeliveryProjectRecord | null;
  remainingDeliveryProjects?: number;
} = {}) {
  const deliveryProjectsRepository = {
    findById: jest.fn().mockResolvedValue(deliveryProjectRow),
    deleteById: jest.fn().mockResolvedValue(true),
    countBySystem: jest.fn().mockResolvedValue(remainingDeliveryProjects),
  };
  const repositoriesRepository = {
    listByDeliveryProjectForManager: jest.fn().mockResolvedValue(repositories),
    deleteById: jest.fn().mockResolvedValue(true),
  };
  const systemsRepository = {
    deleteById: jest.fn().mockResolvedValue(true),
  };
  const accessService = {
    assertDeliveryProjectManager: jest
      .fn()
      .mockResolvedValue({ groupId: GROUP_ID, viaPlatformAdmin: false }),
  };
  const auditEventsService = {
    recordProjectEvent: jest.fn().mockResolvedValue(undefined),
  };
  const projectLifecyclePort = {
    disconnectProject: jest
      .fn()
      .mockResolvedValue({ githubRepoDeleted: false }),
  };

  const service = new DeliveryProjectsService(
    deliveryProjectsRepository as unknown as DeliveryProjectsRepository,
    repositoriesRepository as unknown as RepositoriesRepository,
    systemsRepository as unknown as SystemsRepository,
    accessService as unknown as HierarchyAccessService,
    auditEventsService as unknown as AuditEventPublisher,
    projectLifecyclePort as unknown as ProjectLifecyclePort,
  );

  return {
    service,
    deliveryProjectsRepository,
    repositoriesRepository,
    systemsRepository,
    accessService,
    auditEventsService,
    projectLifecyclePort,
  };
}

describe('DeliveryProjectsService.deleteDeliveryProject', () => {
  it('rejects a caller who is not a delivery-project manager, before reading anything else', async () => {
    const { service, accessService, deliveryProjectsRepository } = setup();
    accessService.assertDeliveryProjectManager.mockRejectedValue(
      new ForbiddenException('Insufficient group role'),
    );

    await expect(
      service.deleteDeliveryProject(
        DELIVERY_PROJECT_ID,
        USER_ID,
        confirmedDto(),
        TOKEN,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deliveryProjectsRepository.findById).not.toHaveBeenCalled();
  });

  it('404s when the delivery project does not exist', async () => {
    const { service } = setup({ deliveryProjectRow: null });

    await expect(
      service.deleteDeliveryProject(
        DELIVERY_PROJECT_ID,
        USER_ID,
        confirmedDto(),
        TOKEN,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a confirmName mismatch with 400 DELIVERY_PROJECT_NAME_MISMATCH and touches nothing else', async () => {
    const { service, repositoriesRepository, deliveryProjectsRepository } =
      setup();

    const error = await service
      .deleteDeliveryProject(
        DELIVERY_PROJECT_ID,
        USER_ID,
        confirmedDto({ confirmName: 'wrong-name' }),
        TOKEN,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      statusCode: number;
      code: string;
    };
    expect(body.statusCode).toBe(400);
    expect(body.code).toBe('DELIVERY_PROJECT_NAME_MISMATCH');
    expect(
      repositoriesRepository.listByDeliveryProjectForManager,
    ).not.toHaveBeenCalled();
    expect(deliveryProjectsRepository.deleteById).not.toHaveBeenCalled();
  });

  it('deletes a ghost-only folder without calling the project lifecycle port', async () => {
    const ghost = repository({ id: 'repo-ghost', provisionedProjectId: null });
    const {
      service,
      repositoriesRepository,
      projectLifecyclePort,
      deliveryProjectsRepository,
      systemsRepository,
    } = setup({ repositories: [ghost] });

    const result = await service.deleteDeliveryProject(
      DELIVERY_PROJECT_ID,
      USER_ID,
      confirmedDto(),
      TOKEN,
    );

    expect(projectLifecyclePort.disconnectProject).not.toHaveBeenCalled();
    expect(repositoriesRepository.deleteById).toHaveBeenCalledWith(
      'repo-ghost',
    );
    expect(deliveryProjectsRepository.deleteById).toHaveBeenCalledWith(
      DELIVERY_PROJECT_ID,
    );
    expect(systemsRepository.deleteById).toHaveBeenCalledWith(SYSTEM_ID);
    expect(result).toEqual({
      deliveryProjectId: DELIVERY_PROJECT_ID,
      name: 'Checkout',
      deletedRepositories: [
        {
          repositoryId: 'repo-ghost',
          name: ghost.name,
          projectId: null,
          githubRepoDeleted: false,
        },
      ],
    });
  });

  it('deletes a linked folder through the project lifecycle port', async () => {
    const linked = repository({
      id: 'repo-linked',
      provisionedProjectId: 'project-1',
    });
    const { service, projectLifecyclePort, repositoriesRepository } = setup({
      repositories: [linked],
    });
    projectLifecyclePort.disconnectProject.mockResolvedValue({
      githubRepoDeleted: true,
    });

    const result = await service.deleteDeliveryProject(
      DELIVERY_PROJECT_ID,
      USER_ID,
      confirmedDto({ deleteGithubRepos: true }),
      TOKEN,
    );

    expect(projectLifecyclePort.disconnectProject).toHaveBeenCalledWith(
      'project-1',
      USER_ID,
      {
        deleteGithubRepo: true,
        deleteProviderResources: false,
        deleteSonarProject: false,
      },
      TOKEN,
    );
    expect(repositoriesRepository.deleteById).toHaveBeenCalledWith(
      'repo-linked',
    );
    expect(result.deletedRepositories).toEqual([
      {
        repositoryId: 'repo-linked',
        name: linked.name,
        projectId: 'project-1',
        githubRepoDeleted: true,
      },
    ]);
  });

  it('handles a mixed folder (ghost + linked), processing and reporting both', async () => {
    const ghost = repository({ id: 'repo-ghost', provisionedProjectId: null });
    const linked = repository({
      id: 'repo-linked',
      name: 'checkout-web',
      provisionedProjectId: 'project-1',
    });
    const { service, projectLifecyclePort } = setup({
      repositories: [ghost, linked],
    });
    projectLifecyclePort.disconnectProject.mockResolvedValue({
      githubRepoDeleted: false,
    });

    const result = await service.deleteDeliveryProject(
      DELIVERY_PROJECT_ID,
      USER_ID,
      confirmedDto(),
      TOKEN,
    );

    expect(result.deletedRepositories.map((r) => r.repositoryId)).toEqual([
      'repo-ghost',
      'repo-linked',
    ]);
    expect(projectLifecyclePort.disconnectProject).toHaveBeenCalledTimes(1);
  });

  it('treats an already-gone AlphaCI project (NotFoundException) as success', async () => {
    const linked = repository({
      id: 'repo-linked',
      provisionedProjectId: 'project-gone',
    });
    const {
      service,
      projectLifecyclePort,
      repositoriesRepository,
      deliveryProjectsRepository,
    } = setup({ repositories: [linked] });
    projectLifecyclePort.disconnectProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );

    const result = await service.deleteDeliveryProject(
      DELIVERY_PROJECT_ID,
      USER_ID,
      confirmedDto({ deleteGithubRepos: true }),
      TOKEN,
    );

    expect(repositoriesRepository.deleteById).toHaveBeenCalledWith(
      'repo-linked',
    );
    expect(deliveryProjectsRepository.deleteById).toHaveBeenCalledWith(
      DELIVERY_PROJECT_ID,
    );
    expect(result.deletedRepositories).toEqual([
      {
        repositoryId: 'repo-linked',
        name: linked.name,
        projectId: 'project-gone',
        githubRepoDeleted: false,
      },
    ]);
  });

  it('stops on the first failure, keeps the delivery project, and reports what was already deleted', async () => {
    const ghost = repository({ id: 'repo-ghost', provisionedProjectId: null });
    const failing = repository({
      id: 'repo-failing',
      name: 'checkout-payments',
      provisionedProjectId: 'project-2',
    });
    const {
      service,
      projectLifecyclePort,
      deliveryProjectsRepository,
      systemsRepository,
    } = setup({ repositories: [ghost, failing] });
    projectLifecyclePort.disconnectProject.mockRejectedValue(
      new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'missing_scope',
        message:
          'This session has no GitHub access token. The project was kept so you can try again.',
      }),
    );

    const error = await service
      .deleteDeliveryProject(
        DELIVERY_PROJECT_ID,
        USER_ID,
        confirmedDto({ deleteGithubRepos: true }),
        TOKEN,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as {
      statusCode: number;
      code: string;
      deletedRepositories: unknown[];
      failedRepository: { repositoryId: string; name: string };
    };
    expect(body.statusCode).toBe(409);
    expect(body.code).toBe('missing_scope');
    expect(body.deletedRepositories).toEqual([
      {
        repositoryId: 'repo-ghost',
        name: ghost.name,
        projectId: null,
        githubRepoDeleted: false,
      },
    ]);
    expect(body.failedRepository).toEqual({
      repositoryId: 'repo-failing',
      name: failing.name,
    });
    expect(deliveryProjectsRepository.deleteById).not.toHaveBeenCalled();
    expect(systemsRepository.deleteById).not.toHaveBeenCalled();
  });

  it('deletes the system only when it has no remaining delivery projects', async () => {
    const { service, systemsRepository } = setup({
      repositories: [],
      remainingDeliveryProjects: 2,
    });

    await service.deleteDeliveryProject(
      DELIVERY_PROJECT_ID,
      USER_ID,
      confirmedDto(),
      TOKEN,
    );

    expect(systemsRepository.deleteById).not.toHaveBeenCalled();
  });

  it('records a deliveryProjectDeleted audit event with the deleted repository names and options', async () => {
    const linked = repository({
      id: 'repo-linked',
      provisionedProjectId: 'project-1',
    });
    const { service, auditEventsService } = setup({ repositories: [linked] });

    await service.deleteDeliveryProject(
      DELIVERY_PROJECT_ID,
      USER_ID,
      confirmedDto({ deleteProviderResources: true }),
      TOKEN,
    );

    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: GROUP_ID,
        actorUserId: USER_ID,
        eventCode: 'hierarchy.delivery_project.deleted',
        metadata: expect.objectContaining({
          groupId: GROUP_ID,
          deliveryProjectId: DELIVERY_PROJECT_ID,
          repositories: [linked.name],
          options: {
            deleteGithubRepos: false,
            deleteProviderResources: true,
            deleteSonarProjects: false,
          },
        }),
      }),
    );
  });
});
