import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher';
import type { MemberDirectoryService } from '#modules/identity-access/directory/index.js';
import type { GroupsRepository } from '../infrastructure/groups.repository';
import { GroupMembersService } from './group-members.service';
import type { HierarchyAccessService } from './hierarchy-access.service';

describe('GroupMembersService.addMember', () => {
  const lead = { userId: 'lead-id', githubToken: 'gho_lead' };
  let groupsRepository: jest.Mocked<GroupsRepository>;
  let accessService: jest.Mocked<HierarchyAccessService>;
  let directory: jest.Mocked<MemberDirectoryService>;
  let service: GroupMembersService;

  beforeEach(() => {
    groupsRepository = {
      findActiveMembership: jest.fn().mockResolvedValue(null),
      addMemberDirect: jest.fn().mockResolvedValue(undefined),
      listMembers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ramos-id', login: 'bpramos-ae' }]),
    } as unknown as jest.Mocked<GroupsRepository>;
    accessService = {
      assertGroupManagerOrPlatformAdmin: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<HierarchyAccessService>;
    directory = {
      assertEligible: jest
        .fn()
        .mockResolvedValue({ id: 'ramos-id', login: 'bpramos-ae' }),
    } as unknown as jest.Mocked<MemberDirectoryService>;
    service = new GroupMembersService(
      groupsRepository,
      accessService,
      {
        recordProjectEvent: jest.fn(),
      } as unknown as AuditEventPublisher,
      directory,
    );
  });

  it('adds a directory member as a Member', async () => {
    await expect(
      service.addMember('group-1', lead, { userId: 'ramos-id' }),
    ).resolves.toMatchObject({ login: 'bpramos-ae' });

    expect(directory.assertEligible).toHaveBeenCalledWith(lead, 'ramos-id');
    expect(groupsRepository.addMemberDirect).toHaveBeenCalledWith(
      'group-1',
      'ramos-id',
      'member',
      'lead-id',
    );
  });

  it('writes nothing for someone outside the directory', async () => {
    directory.assertEligible.mockRejectedValue(
      new NotFoundException('outsider is not a member of the org.'),
    );

    await expect(
      service.addMember('group-1', lead, { userId: 'outsider-id' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(groupsRepository.addMemberDirect).not.toHaveBeenCalled();
  });

  it('checks the lead before reading the directory', async () => {
    accessService.assertGroupManagerOrPlatformAdmin.mockRejectedValue(
      new ForbiddenException(),
    );

    await expect(
      service.addMember('group-1', lead, { userId: 'ramos-id' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(directory.assertEligible).not.toHaveBeenCalled();
  });
});
