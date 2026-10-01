import { ConflictException, ForbiddenException } from '@nestjs/common';

import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import type {
  AppRole,
  PlatformAdminAccessService,
} from '#modules/identity-access/admin/application/platform-admin-access.service';
import type { AssignmentsRepository } from '../infrastructure/assignments.repository';
import type { DeliveryProjectsRepository } from '../infrastructure/delivery-projects.repository';
import { DeliveryProjectsService } from './delivery-projects.service';
import type { GroupsRepository } from '../infrastructure/groups.repository';
import { HierarchyAccessService } from './hierarchy-access.service';
import type { RepositoriesRepository } from '../infrastructure/repositories.repository';
import type { RepositoriesService } from './repositories.service';
import type { SystemsRepository } from '../infrastructure/systems.repository';
import { SystemsService } from './systems.service';

/**
 * `createEmptyProject`'s permission gate is `assertCanCreateInGroup` — the
 * SAME global-role gate `createSystem` already uses. This exercises the
 * REAL HierarchyAccessService (not a stub of the gate) against every role in
 * the app's single-role model, so a regression that loosens the gate itself
 * — not just SystemsService's use of it — fails here too.
 */
function buildAccessService(options: {
  appRole: AppRole;
  isPlatformAdminRow?: boolean;
  isGroupMember?: boolean;
}) {
  const groupsRepository = {
    findActiveMembership: jest.fn(() =>
      Promise.resolve(
        options.isGroupMember === false
          ? null
          : {
              workspaceId: 'group-1',
              userId: 'user-1',
              role: 'member' as const,
              memberId: 'member-1',
            },
      ),
    ),
    findGroupById: jest.fn(() =>
      Promise.resolve({
        id: 'group-1',
        name: 'Group',
        description: null,
        businessUnit: null,
        status: 'active' as const,
        archivedAt: null,
        archivedBy: null,
        createdAt: '2026-01-01T00:00:00Z',
        memberCount: 1,
        systemCount: 0,
      }),
    ),
  } as unknown as jest.Mocked<GroupsRepository>;
  const platformAdminsRepository = {
    findRole: jest.fn(() =>
      Promise.resolve(options.isPlatformAdminRow ? ('admin' as const) : null),
    ),
    findAppRole: jest.fn(() => Promise.resolve(options.appRole)),
  } as unknown as jest.Mocked<PlatformAdminAccessService>;

  return new HierarchyAccessService(
    groupsRepository,
    {} as unknown as jest.Mocked<SystemsRepository>,
    {} as unknown as jest.Mocked<DeliveryProjectsRepository>,
    {} as unknown as jest.Mocked<RepositoriesRepository>,
    {} as unknown as jest.Mocked<AssignmentsRepository>,
    platformAdminsRepository,
  );
}

function buildSystemsService(accessService: HierarchyAccessService) {
  const systemsRepository = {
    create: jest.fn(() =>
      Promise.resolve({
        id: 'system-1',
        groupId: 'group-1',
        name: 'Payments',
        description: null,
        ownerId: 'user-1',
        status: 'active' as const,
        archivedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        deliveryProjectCount: 0,
      }),
    ),
  } as unknown as jest.Mocked<SystemsRepository>;
  const auditEventsService = {
    recordProjectEvent: jest.fn(() => Promise.resolve()),
  } as unknown as jest.Mocked<AuditEventPublisher>;
  const deliveryProject = {
    id: 'dp-1',
    systemId: 'system-1',
    groupId: 'group-1',
    name: 'Payments',
    description: null,
    managerId: 'user-1',
    status: 'active' as const,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    repositoryCount: 0,
  };
  const deliveryProjectsService = {
    createDeliveryProject: jest.fn(() => Promise.resolve(deliveryProject)),
    assertProjectNameAvailable: jest.fn(() => Promise.resolve()),
    withProjectNameLock: jest.fn(
      (_groupId: string, _name: string, fn: () => Promise<unknown>) => fn(),
    ),
  } as unknown as jest.Mocked<DeliveryProjectsService>;
  const repositoriesService = {} as unknown as RepositoriesService;

  const service = new SystemsService(
    systemsRepository,
    accessService,
    auditEventsService,
    deliveryProjectsService,
    repositoriesService,
  );

  return {
    service,
    systemsRepository,
    auditEventsService,
    deliveryProjectsService,
    deliveryProject,
  };
}

describe('SystemsService.createEmptyProject', () => {
  it.each<[string, AppRole, boolean]>([
    ['lead', 'lead', true],
    ['admin', 'admin', true],
    ['member', 'member', false],
    ['qa', 'qa', false],
  ])('%s: allowed=%s', async (_label, appRole, allowed) => {
    const accessService = buildAccessService({ appRole });
    const { service } = buildSystemsService(accessService);

    const call = service.createEmptyProject('group-1', 'user-1', {
      name: 'Payments',
    });

    if (allowed) {
      await expect(call).resolves.toMatchObject({ id: 'dp-1' });
    } else {
      await expect(call).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('creates a system AND a delivery project, but no repository, and returns the DeliveryProject shape', async () => {
    const accessService = buildAccessService({ appRole: 'lead' });
    const {
      service,
      systemsRepository,
      deliveryProjectsService,
      deliveryProject,
    } = buildSystemsService(accessService);

    await expect(
      service.createEmptyProject('group-1', 'user-1', {
        name: 'Payments',
        description: 'Q3 payments initiative',
      }),
    ).resolves.toEqual(deliveryProject);

    expect(systemsRepository.create).toHaveBeenCalledWith({
      groupId: 'group-1',
      name: 'Payments',
      description: 'Q3 payments initiative',
      ownerId: 'user-1',
    });
    expect(deliveryProjectsService.createDeliveryProject).toHaveBeenCalledWith(
      'system-1',
      'user-1',
      { name: 'Payments', description: 'Q3 payments initiative' },
    );
  });

  it('lets a platform admin create even without group membership', async () => {
    const accessService = buildAccessService({
      appRole: 'member',
      isPlatformAdminRow: true,
      isGroupMember: false,
    });
    const { service } = buildSystemsService(accessService);

    await expect(
      service.createEmptyProject('group-1', 'platform-admin-1', {
        name: 'Payments',
      }),
    ).resolves.toMatchObject({ id: 'dp-1' });
  });

  it('rejects a duplicate Project name with 409 PROJECT_NAME_TAKEN and creates nothing', async () => {
    const accessService = buildAccessService({ appRole: 'lead' });
    const { service, systemsRepository, deliveryProjectsService } =
      buildSystemsService(accessService);
    deliveryProjectsService.assertProjectNameAvailable.mockRejectedValue(
      new ConflictException({
        code: 'PROJECT_NAME_TAKEN',
        message: 'A Project named "Payments" already exists in this team.',
      }),
    );

    await expect(
      service.createEmptyProject('group-1', 'user-1', { name: 'Payments' }),
    ).rejects.toMatchObject({
      response: { code: 'PROJECT_NAME_TAKEN' },
    });
    expect(systemsRepository.create).not.toHaveBeenCalled();
    expect(
      deliveryProjectsService.createDeliveryProject,
    ).not.toHaveBeenCalled();
  });

  it('checks the name inside the per-(team, name) lock', async () => {
    const accessService = buildAccessService({ appRole: 'lead' });
    const { service, deliveryProjectsService } =
      buildSystemsService(accessService);

    await service.createEmptyProject('group-1', 'user-1', { name: 'Payments' });

    expect(deliveryProjectsService.withProjectNameLock).toHaveBeenCalledWith(
      'group-1',
      'Payments',
      expect.any(Function),
    );
    expect(
      deliveryProjectsService.assertProjectNameAvailable,
    ).toHaveBeenCalledWith('group-1', 'Payments');
  });
});
