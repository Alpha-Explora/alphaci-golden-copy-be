import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { DatabaseService } from '#kernel/db/database.service';
import {
  MemberDirectoryService,
  type DirectoryCaller,
  type DirectoryEntry,
} from '#modules/identity-access/directory/index.js';
import { AssignmentsRepository } from '../infrastructure/assignments.repository';
import { GithubSyncService } from './github-sync.service';
import { HierarchyAccessService } from './hierarchy-access.service';
import { HIERARCHY_EVENT_CODES } from '../domain/hierarchy.types';
import {
  GroupsRepository,
  type GroupMemberRecord,
  type GroupRecord,
} from '../infrastructure/groups.repository';
import type { UpdateGroupDto } from '../api/dto/update-group.dto';
import type { UpdateMemberRoleDto } from '../api/dto/update-member-role.dto';

@Injectable()
export class GroupsService {
  constructor(
    private readonly groupsRepository: GroupsRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly assignmentsRepository: AssignmentsRepository,
    private readonly githubSyncService: GithubSyncService,
    private readonly directory: MemberDirectoryService,
    private readonly auditEventsService: AuditEventPublisher,
    private readonly databaseService: DatabaseService,
  ) {}

  async createGroup(
    userId: string,
    input: { name: string; description?: string; businessUnit?: string },
  ): Promise<GroupRecord> {
    // Only global Leads and Admins may create groups. Allow-list, not
    // exclusion: 'qa' and 'member' (and any future role) are refused.
    const appRole = await this.accessService.getAppRole(userId);
    if (
      appRole !== 'admin' &&
      appRole !== 'lead' &&
      !(await this.accessService.isPlatformAdmin(userId))
    ) {
      throw new ForbiddenException('Only Leads and Admins can create groups');
    }

    const group = await this.groupsRepository.createGroup({
      name: input.name,
      description: input.description ?? null,
      businessUnit: input.businessUnit ?? null,
      creatorUserId: userId,
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: group.id,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupCreated,
      message: `Group "${group.name}" created`,
      metadata: { groupId: group.id },
    });

    return { ...group, role: 'admin' };
  }

  async getMyGroups(userId: string): Promise<GroupRecord[]> {
    if (await this.accessService.isPlatformAdmin(userId)) {
      return this.groupsRepository.listAllGroups();
    }
    return this.groupsRepository.listForUser(userId);
  }

  async getGroup(groupId: string, userId: string): Promise<GroupRecord> {
    if (await this.accessService.isPlatformAdmin(userId)) {
      const group = await this.groupsRepository.findGroupById(groupId);
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      return { ...group, role: 'admin' };
    }
    const membership = await this.accessService.assertGroupMembership(
      groupId,
      userId,
    );
    const group = await this.groupsRepository.findGroupById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    return { ...group, role: membership.role };
  }

  async updateGroup(
    groupId: string,
    userId: string,
    dto: UpdateGroupDto,
  ): Promise<GroupRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin', 'delegated_lead'],
    );
    const group = await this.groupsRepository.updateGroup(groupId, dto);
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupUpdated,
      message: `Group "${group.name}" updated`,
      metadata: { groupId, changes: dto },
    });

    return group;
  }

  async archiveGroup(groupId: string, userId: string): Promise<GroupRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin'],
    );
    const group = await this.groupsRepository.setArchiveStatus(
      groupId,
      'archived',
      userId,
    );
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupArchived,
      message: `Group "${group.name}" archived`,
      metadata: { groupId },
    });

    return group;
  }

  /**
   * Hard-deletes a Group. Restricted to the Group's top tier ('admin' = the
   * "Lead" product label) or a platform admin — the same gate archiving uses,
   * since delete is strictly more destructive. Cascades handle members /
   * invitations / systems; any provisioned repositories are detached to
   * "individual" (workspace_id → NULL), never destroyed (see
   * GroupsRepository.deleteGroup).
   */
  async deleteGroup(
    groupId: string,
    userId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin'],
    );
    const group = await this.groupsRepository.findGroupById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    // Record the intent BEFORE the row (and its cascaded audit rows) disappear.
    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupDeleted,
      message: `Group "${group.name}" deleted`,
      metadata: { groupId, name: group.name },
    });

    const deleted = await this.groupsRepository.deleteGroup(groupId);
    if (!deleted) {
      throw new NotFoundException('Group not found');
    }

    return { id: groupId, deleted: true };
  }

  async reopenGroup(groupId: string, userId: string): Promise<GroupRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin'],
    );
    const group = await this.groupsRepository.setArchiveStatus(
      groupId,
      'active',
      userId,
    );
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupReopened,
      message: `Group "${group.name}" reopened`,
      metadata: { groupId },
    });

    return group;
  }

  /**
   * Platform-admin-only (enforced by PlatformAdminGuard at the controller).
   * Promotes newManagerUserId to owner, demotes every other current owner to
   * admin — a Group can never lose its final active manager.
   */
  async transferManager(
    groupId: string,
    actingUserId: string,
    newManagerUserId: string,
  ): Promise<GroupRecord> {
    const group = await this.groupsRepository.findGroupById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    const target = await this.groupsRepository.findActiveMembership(
      groupId,
      newManagerUserId,
    );
    if (!target) {
      throw new BadRequestException(
        'The new manager must already be an active member of the Group',
      );
    }

    const transfer = await this.groupsRepository.transferLeadGuarded(
      groupId,
      newManagerUserId,
    );
    if (!transfer) {
      throw new BadRequestException(
        'The new manager must already be an active member of the Group',
      );
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: actingUserId,
      eventCode: HIERARCHY_EVENT_CODES.groupManagerTransferred,
      message: `Group lead transferred to ${newManagerUserId}`,
      metadata: {
        groupId,
        newManagerUserId,
        previousRole: transfer.previousRole,
      },
    });

    return group;
  }

  async listMembers(
    groupId: string,
    userId: string,
  ): Promise<GroupMemberRecord[]> {
    if (!(await this.accessService.isPlatformAdmin(userId))) {
      await this.accessService.assertGroupMembership(groupId, userId);
    }
    return this.groupsRepository.listMembers(groupId);
  }

  /**
   * The member picker's list: people in the deployment's member directory
   * who are not already active in this Group. Directory members who have not
   * signed in yet come back with `hasAccount: false`, so the picker can show
   * them as not-yet-addable instead of hiding them.
   */
  async searchEligibleMembers(
    groupId: string,
    caller: DirectoryCaller,
    search: string,
  ): Promise<DirectoryEntry[]> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      caller.userId,
    );
    return this.directory.listEligible(caller, {
      search,
      workspaceId: groupId,
    });
  }

  async updateMemberRole(
    groupId: string,
    userId: string,
    memberId: string,
    dto: UpdateMemberRoleDto,
  ): Promise<GroupMemberRecord> {
    const { viaPlatformAdmin, membership } =
      await this.accessService.assertGroupManagerOrPlatformAdmin(
        groupId,
        userId,
        ['admin', 'delegated_lead'],
      );
    const target = await this.groupsRepository.findMemberById(
      groupId,
      memberId,
    );
    if (!target) {
      throw new NotFoundException('Member not found');
    }

    // A Lead promotes members to whichever tier they choose (Member,
    // Delegated lead, or Admin). Granting the top Admin/Lead tier is reserved
    // for an existing Admin (or a platform admin) — a Delegated lead cannot
    // mint an Admin above their own authority. The last-owner guard below
    // still prevents demoting the final Admin out of existence.
    if (
      dto.role === 'admin' &&
      !viaPlatformAdmin &&
      membership?.role !== 'admin'
    ) {
      throw new ForbiddenException(
        'Only a Group Admin can grant the Admin (Lead) role',
      );
    }

    // Race-free last-owner guard: changeMemberRoleGuarded holds a row lock
    // on every active owner of the Group for the duration of the check +
    // write, so two concurrent demotions of two different owners can no
    // longer both read "2 owners" and both proceed to zero (ciso finding,
    // last-owner safety rule "last-manager protection ... race-condition safety").
    const { member: updated, blockedLastOwner } =
      await this.groupsRepository.changeMemberRoleGuarded(
        groupId,
        memberId,
        dto.role,
      );
    if (blockedLastOwner) {
      throw new BadRequestException('Group must keep at least one owner');
    }
    if (!updated) {
      throw new NotFoundException('Member not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.memberRoleChanged,
      message: `Member role changed to ${dto.role}`,
      metadata: {
        groupId,
        memberId,
        targetUserId: target.userId,
        previousRole: target.role,
        newRole: dto.role,
      },
    });

    return updated;
  }

  /**
   * Offboarding event, not a hard delete. Cascades to a revoke job for every
   * active repository assignment this member holds anywhere in the Group
   * (member-management contract, hierarchy offboarding contract "removing a member must immediately trigger
   * the repository-assignment access review").
   */
  async removeMember(
    groupId: string,
    userId: string,
    memberId: string,
    reason?: string,
  ): Promise<GroupMemberRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin', 'delegated_lead'],
    );
    const target = await this.groupsRepository.findMemberById(
      groupId,
      memberId,
    );
    if (!target) {
      throw new NotFoundException('Member not found');
    }

    // Keep the member mutation, assignment transitions, and durable revoke
    // events in one transaction. If any enqueue fails, the member remains
    // active and no earlier assignment transition is left half-committed.
    const {
      member: removed,
      blockedLastOwner,
      assignments,
    } = await this.databaseService.withTransaction(async (client) => {
      const removal = await this.groupsRepository.removeMemberGuardedWithClient(
        client,
        groupId,
        memberId,
        userId,
        reason,
      );
      if (removal.blockedLastOwner || !removal.member) {
        return { ...removal, assignments: [] };
      }

      const cascade =
        await this.assignmentsRepository.listAssignedByUserWithinGroupWithClient(
          client,
          groupId,
          target.userId,
        );
      for (const assignment of cascade) {
        await this.githubSyncService.requestRevokeWithClient(
          client,
          assignment.id,
          userId,
        );
      }

      return { ...removal, assignments: cascade };
    });
    if (blockedLastOwner) {
      throw new BadRequestException('Group must keep at least one owner');
    }
    if (!removed) {
      throw new NotFoundException('Member not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.memberRemoved,
      message: `Member removed from Group`,
      metadata: {
        groupId,
        memberId,
        targetUserId: target.userId,
        reason: reason ?? null,
        cascadedRevokeCount: assignments.length,
      },
    });

    return removed;
  }
}
