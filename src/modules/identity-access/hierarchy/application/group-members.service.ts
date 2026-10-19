import { BadRequestException, Injectable } from '@nestjs/common';

import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  MemberDirectoryService,
  type DirectoryCaller,
} from '#modules/identity-access/directory/index.js';
import { HierarchyAccessService } from './hierarchy-access.service';
import {
  HIERARCHY_EVENT_CODES,
  type GrantableRole,
} from '../domain/hierarchy.types';
import {
  GroupsRepository,
  type GroupMemberRecord,
} from '../infrastructure/groups.repository';

/**
 * Adding people to a group.
 *
 * Membership is granted DIRECTLY by a group lead — there is no invitation,
 * no pending state, and nothing for the recipient to accept. The person is a
 * member the moment the lead adds them (product decision 2026-08-18, replacing
 * the previous invite/accept/decline flow).
 *
 * The person must be in the deployment's member directory and have an
 * AlphaCI account: a directory member who has never signed in has no row to
 * attach a membership to, so they must sign in once first.
 */
@Injectable()
export class GroupMembersService {
  constructor(
    private readonly groupsRepository: GroupsRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly auditEventsService: AuditEventPublisher,
    private readonly directory: MemberDirectoryService,
    private readonly notifications: NotificationEventPublisher,
  ) {}

  async addMember(
    groupId: string,
    actor: DirectoryCaller,
    input: { userId: string; role?: GrantableRole },
  ): Promise<GroupMemberRecord> {
    const actorUserId = actor.userId;
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      actorUserId,
    );

    // Ownership only moves via transfer, so 'admin' is never grantable here —
    // the same rule the invitation flow enforced.
    const role: GrantableRole = input.role ?? 'member';

    // The same directory the picker lists from, so a person offered there is
    // never refused here, and a crafted request cannot add someone outside it.
    await this.directory.assertEligible(actor, input.userId);

    const existing = await this.groupsRepository.findActiveMembership(
      groupId,
      input.userId,
    );
    if (existing) {
      throw new BadRequestException(
        'User is already an active member of this Group',
      );
    }

    const added = await this.groupsRepository.addMemberDirect(
      groupId,
      input.userId,
      role,
      actorUserId,
      (client, context) =>
        this.notifications.recordInTransaction(client, {
          userId: input.userId,
          workspaceId: groupId,
          eventCode: HIERARCHY_EVENT_CODES.memberAdded,
          title: `You were added to ${context.groupName}`,
          body: `${context.actorLogin ? `@${context.actorLogin}` : 'A workspace lead'} added you as a ${role === 'delegated_lead' ? 'Delegated lead' : role === 'viewer' ? 'Viewer' : 'Member'}.`,
        }),
    );
    if (!added) {
      throw new BadRequestException(
        'User is already an active member of this Group',
      );
    }

    // Re-read through listMembers so the response carries the same shape the
    // member table already renders (login, name, avatar, status) rather than a
    // bare membership row the UI would have to special-case.
    const members = await this.groupsRepository.listMembers(groupId);
    const member = members.find((row) => row.userId === input.userId);
    if (!member) {
      // The insert reported success but the row is not readable back — surface
      // it rather than returning a hollow object the UI would render as a
      // half-added member.
      throw new BadRequestException('Member could not be added');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId,
      eventCode: HIERARCHY_EVENT_CODES.memberAdded,
      message: `Member added with role ${role}`,
      metadata: { groupId, addedUserId: input.userId, role },
    });

    return member;
  }
}
