import { BadRequestException } from '@nestjs/common';

import { AssignmentsService } from './assignments.service';

function build(role: string | undefined, memberRole = 'member') {
  const assignmentsRepository = {};
  const syncRepository = {};
  const githubSyncService = {
    createAssignmentAndRequestGrant: jest.fn(() =>
      Promise.resolve({ id: 'assignment-1' }),
    ),
  };
  const groupsRepository = {
    findActiveMembership: jest.fn(() => Promise.resolve({ role: memberRole })),
  };
  const accessService = {
    assertRepositoryManagerOrPlatformAdmin: jest.fn(() =>
      Promise.resolve({ groupId: 'group-1' }),
    ),
  };
  const auditEventsService = { recordProjectEvent: jest.fn() };
  const configService = {
    getOrThrow: jest.fn(() => ({ hierarchy: { githubSyncMode: 'live' } })),
  };
  const appRoleLookup = { findAppRole: jest.fn(() => Promise.resolve(role)) };
  const service = new AssignmentsService(
    assignmentsRepository as never,
    syncRepository as never,
    githubSyncService as never,
    groupsRepository as never,
    accessService as never,
    auditEventsService as never,
    configService as never,
    appRoleLookup as never,
  );
  return { service, githubSyncService, appRoleLookup };
}

describe('AssignmentsService.createAssignment role allow-list', () => {
  it('assigns a Developer (app_role member)', async () => {
    const { service, githubSyncService, appRoleLookup } = build('member');
    await expect(
      service.createAssignment('repo-1', 'manager', {
        userId: 'dev-1',
      } as never),
    ).resolves.toEqual({ id: 'assignment-1' });
    // Checked on the TARGET, not the caller.
    expect(appRoleLookup.findAppRole).toHaveBeenCalledWith('dev-1');
    expect(
      githubSyncService.createAssignmentAndRequestGrant,
    ).toHaveBeenCalled();
  });

  it.each(['qa', 'lead', 'admin', undefined])(
    'refuses a %s target with ASSIGNMENT_ROLE_NOT_ALLOWED even though the derived group role is member',
    async (role) => {
      const { service, githubSyncService } = build(role, 'member');
      const error = await service
        .createAssignment('repo-1', 'manager', { userId: 'x' } as never)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'ASSIGNMENT_ROLE_NOT_ALLOWED',
        message:
          'Only Developers are assigned repositories; QA and leads already see every repository in the team.',
      });
      expect(
        githubSyncService.createAssignmentAndRequestGrant,
      ).not.toHaveBeenCalled();
    },
  );
});
