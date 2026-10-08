import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import type { DeliveryProjectsRepository } from '../../infrastructure/delivery-projects.repository';
import type { HierarchyAccessService } from '../../application/hierarchy-access.service';
import { HierarchyProjectLinkService } from './hierarchy-project-link.service';
import type { HierarchyProjectLinkRepository } from '../infrastructure/hierarchy-project-link.repository';

function build(overrides: Partial<HierarchyProjectLinkRepository> = {}) {
  const link = jest.fn(() =>
    Promise.resolve({ repositoryId: 'repo-1', deliveryProjectId: 'dp-1' }),
  );
  const repository = {
    isTeamWorkspace: jest.fn(() => Promise.resolve(true)),
    findLinkedRepositoryId: jest.fn(() => Promise.resolve(null)),
    findLinkedRepositoryAndDeliveryProject: jest.fn(() =>
      Promise.resolve(null),
    ),
    link,
    isProjectNameTaken: jest.fn(() => Promise.resolve(false)),
    ...overrides,
  } as unknown as HierarchyProjectLinkRepository;

  const accessService = {
    assertCanCreateUnderDeliveryProject: jest.fn(() =>
      Promise.resolve({ groupId: 'w1' }),
    ),
  } as unknown as jest.Mocked<HierarchyAccessService>;

  const deliveryProjectsRepository = {
    findById: jest.fn(() =>
      Promise.resolve({
        id: 'dp-1',
        systemId: 'sys-1',
        groupId: 'w1',
        name: 'payments',
        description: null,
        managerId: 'u1',
        status: 'active',
        archivedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        repositoryCount: 1,
      }),
    ),
  } as unknown as jest.Mocked<DeliveryProjectsRepository>;

  const projectMembers = {
    grantForNewRepositoryBestEffort: jest.fn(() => Promise.resolve()),
  };

  return {
    service: new HierarchyProjectLinkService(
      repository,
      accessService,
      deliveryProjectsRepository,
      projectMembers as never,
    ),
    projectMembers,
    repository,
    accessService,
    deliveryProjectsRepository,
    link: repository.link as unknown as jest.Mock,
  };
}

const BASE = {
  projectId: 'p1',
  workspaceId: 'w1',
  name: 'payments-api',
  repoFullName: 'Alpha-Explora/payments-api',
  visibility: 'private',
  createdBy: 'u1',
  projectStatus: 'provisioned',
};

describe('HierarchyProjectLinkService', () => {
  describe('ensureLink', () => {
    it('skips projects with no workspace', async () => {
      const { service, link } = build();
      await expect(
        service.ensureLink({ ...BASE, workspaceId: null }),
      ).resolves.toBeNull();
      expect(link).not.toHaveBeenCalled();
    });

    it('skips personal workspaces — they have no hierarchy tree', async () => {
      const { service, link } = build({
        isTeamWorkspace: jest.fn(() => Promise.resolve(false)),
      });
      await expect(service.ensureLink(BASE)).resolves.toBeNull();
      expect(link).not.toHaveBeenCalled();
    });

    it('is idempotent — an already-linked project is not linked twice', async () => {
      const { service, link } = build({
        findLinkedRepositoryAndDeliveryProject: jest.fn(() =>
          Promise.resolve({
            repositoryId: 'existing',
            deliveryProjectId: 'dp-9',
          }),
        ),
      });
      await expect(service.ensureLink(BASE)).resolves.toEqual({
        repositoryId: 'existing',
        deliveryProjectId: 'dp-9',
      });
      expect(link).not.toHaveBeenCalled();
    });

    it('links a group project and maps provisioned status', async () => {
      const { service, link } = build();
      await expect(service.ensureLink(BASE)).resolves.toEqual({
        repositoryId: 'repo-1',
        deliveryProjectId: 'dp-1',
      });
      expect(link).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'p1',
          workspaceId: 'w1',
          name: 'payments-api',
          visibility: 'private',
          projectStatus: 'provisioned',
        }),
      );
      // No deliveryProjectId given — a brand new chain is created, so the
      // link call must not carry one either.
      expect(link.mock.calls[0]?.[0]).not.toHaveProperty('deliveryProjectId');
    });

    it('queues the creator and Project members access once a new repository is linked', async () => {
      const { service, projectMembers } = build();
      await service.ensureLink(BASE);
      expect(
        projectMembers.grantForNewRepositoryBestEffort,
      ).toHaveBeenCalledWith({
        repositoryId: 'repo-1',
        deliveryProjectId: 'dp-1',
        creatorUserId: 'u1',
        assignedBy: 'u1',
      });
    });

    it('does not re-queue access for an already-linked project', async () => {
      const { service, projectMembers } = build({
        findLinkedRepositoryAndDeliveryProject: jest.fn(() =>
          Promise.resolve({
            repositoryId: 'existing',
            deliveryProjectId: 'dp-9',
          }),
        ),
      });
      await service.ensureLink(BASE);
      expect(
        projectMembers.grantForNewRepositoryBestEffort,
      ).not.toHaveBeenCalled();
    });

    it('records public visibility rather than forcing private', async () => {
      const { service, link } = build();
      await service.ensureLink({ ...BASE, visibility: 'public' });
      expect(link).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: 'public' }),
      );
    });

    it('falls back to the repo name when the service name is blank', async () => {
      const { service, link } = build();
      await service.ensureLink({ ...BASE, name: '   ' });
      expect(link).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'payments-api' }),
      );
    });

    it('passes chainName through for a naming override without touching the repository name', async () => {
      const { service, link } = build();
      await service.ensureLink({ ...BASE, chainName: 'payments' });
      expect(link).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'payments-api',
          chainName: 'payments',
        }),
      );
    });

    it('passes an explicit deliveryProjectId through to the repository so both pair members land under one chain', async () => {
      const { service, link } = build();
      await service.ensureLink({ ...BASE, deliveryProjectId: 'dp-shared' });
      expect(link).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryProjectId: 'dp-shared' }),
      );
    });

    it('never throws — a failed link must not fail an already-provisioned project', async () => {
      // By the time this runs the GitHub repo, branches, secrets and workflow
      // commit have all succeeded. Throwing here would report a working project
      // as a failure and let the compensation path delete it.
      const { service } = build({
        link: jest.fn(() => Promise.reject(new Error('db down'))),
      });
      await expect(service.ensureLink(BASE)).resolves.toBeNull();
    });

    it('is no-link-plus-logged-error when the repository rejects an invalid deliveryProjectId (e.g. wrong workspace)', async () => {
      const { service, link } = build({
        link: jest.fn(() =>
          Promise.reject(
            new Error(
              'Delivery project dp-other is not an active delivery project in workspace w1',
            ),
          ),
        ),
      });
      await expect(
        service.ensureLink({ ...BASE, deliveryProjectId: 'dp-other' }),
      ).resolves.toBeNull();
      expect(link).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryProjectId: 'dp-other' }),
      );
    });
  });

  describe('getLinkedRepositoryId', () => {
    it('returns the linked repository id', async () => {
      const { service } = build({
        findLinkedRepositoryId: jest.fn(() => Promise.resolve('repo-9')),
      });
      await expect(service.getLinkedRepositoryId('p1')).resolves.toBe('repo-9');
    });

    it('returns null for an unlinked project so the UI hides the entry point', async () => {
      const { service } = build();
      await expect(service.getLinkedRepositoryId('p1')).resolves.toBeNull();
    });

    it('never throws — the project overview must render without the link', async () => {
      const { service } = build({
        findLinkedRepositoryId: jest.fn(() =>
          Promise.reject(new Error('db down')),
        ),
      });
      await expect(service.getLinkedRepositoryId('p1')).resolves.toBeNull();
    });

    it('is READ-ONLY — looking up a link never creates one', async () => {
      const { service, link } = build();
      await service.getLinkedRepositoryId('p1');
      expect(link).not.toHaveBeenCalled();
    });
  });

  describe('assertDeliveryProjectAvailableForCreate', () => {
    it('passes for an active delivery project in the caller-resolved workspace', async () => {
      const { service } = build();
      await expect(
        service.assertDeliveryProjectAvailableForCreate({
          deliveryProjectId: 'dp-1',
          workspaceId: 'w1',
          userId: 'u1',
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects (404/403 via HierarchyAccessService) when the caller may not create in that group', async () => {
      const { service, accessService } = build();
      accessService.assertCanCreateUnderDeliveryProject.mockRejectedValueOnce(
        new ForbiddenException('Only a Lead or Admin can create'),
      );
      await expect(
        service.assertDeliveryProjectAvailableForCreate({
          deliveryProjectId: 'dp-1',
          workspaceId: 'w1',
          userId: 'u1',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects with 400 when the delivery project belongs to a different workspace than the one being created into', async () => {
      const { service, accessService } = build();
      accessService.assertCanCreateUnderDeliveryProject.mockResolvedValueOnce({
        groupId: 'w-other',
      });
      await expect(
        service.assertDeliveryProjectAvailableForCreate({
          deliveryProjectId: 'dp-1',
          workspaceId: 'w1',
          userId: 'u1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects with 400 when the delivery project is archived', async () => {
      const { service, deliveryProjectsRepository } = build();
      deliveryProjectsRepository.findById.mockResolvedValueOnce({
        id: 'dp-1',
        systemId: 'sys-1',
        groupId: 'w1',
        name: 'payments',
        description: null,
        managerId: 'u1',
        status: 'archived',
        archivedAt: '2026-01-02T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        repositoryCount: 0,
      });
      await expect(
        service.assertDeliveryProjectAvailableForCreate({
          deliveryProjectId: 'dp-1',
          workspaceId: 'w1',
          userId: 'u1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('assertProjectNameAvailableForCreate', () => {
    it('passes when no active Project has the name', async () => {
      const { service, repository } = build();
      await expect(
        service.assertProjectNameAvailableForCreate({
          workspaceId: 'w1',
          name: '  Payments ',
        }),
      ).resolves.toBeUndefined();
      expect(repository.isProjectNameTaken).toHaveBeenCalledWith(
        'w1',
        'Payments',
      );
    });

    it('throws 409 PROJECT_NAME_TAKEN with the contract message when taken', async () => {
      const { service } = build({
        isProjectNameTaken: jest.fn(() => Promise.resolve(true)),
      });
      const error = await service
        .assertProjectNameAvailableForCreate({
          workspaceId: 'w1',
          name: 'Payments',
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: 'PROJECT_NAME_TAKEN',
        message: 'A Project named "Payments" already exists in this team.',
      });
    });

    it('skips personal workspaces (no hierarchy, no Projects)', async () => {
      const { service, repository } = build({
        isTeamWorkspace: jest.fn(() => Promise.resolve(false)),
      });
      await expect(
        service.assertProjectNameAvailableForCreate({
          workspaceId: 'w1',
          name: 'Payments',
        }),
      ).resolves.toBeUndefined();
      expect(repository.isProjectNameTaken).not.toHaveBeenCalled();
    });
  });

  describe('ensureLink name enforcement', () => {
    it('passes chainName and enforceUniqueChainName through to the repository', async () => {
      const { service, link } = build();
      await service.ensureLink({
        ...BASE,
        chainName: 'Payments',
        enforceUniqueChainName: true,
      });
      expect(link).toHaveBeenCalledWith(
        expect.objectContaining({
          chainName: 'Payments',
          enforceUniqueChainName: true,
        }),
      );
    });

    it('propagates a lost name race (409) instead of swallowing it', async () => {
      const { ProjectNameTakenException } = jest.requireActual<
        typeof import('../../domain/project-name')
      >('../../domain/project-name');
      const { service } = build({
        link: jest.fn(() =>
          Promise.reject(new ProjectNameTakenException('Payments')),
        ),
      } as never);
      await expect(
        service.ensureLink({
          ...BASE,
          chainName: 'Payments',
          enforceUniqueChainName: true,
        }),
      ).rejects.toBeInstanceOf(ProjectNameTakenException);
    });

    it('still swallows other link failures (best-effort contract)', async () => {
      const { service } = build({
        link: jest.fn(() => Promise.reject(new Error('db down'))),
      } as never);
      await expect(service.ensureLink(BASE)).resolves.toBeNull();
    });
  });
});
