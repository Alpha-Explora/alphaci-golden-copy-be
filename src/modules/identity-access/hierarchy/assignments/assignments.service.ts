import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { GroupsRepository } from '../groups/groups.repository';
import { GithubAccessSyncRepository } from '../github-sync/github-access-sync.repository';
import { GithubSyncService } from '../github-sync/github-sync.service';
import { HierarchyAccessService } from '../hierarchy-access.service';
import { HIERARCHY_EVENT_CODES } from '../hierarchy.types';
import {
  AssignmentsRepository,
  type AssignmentRecord,
} from './assignments.repository';
import type { CreateAssignmentDto } from '../dto/create-assignment.dto';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly assignmentsRepository: AssignmentsRepository,
    private readonly syncRepository: GithubAccessSyncRepository,
    private readonly githubSyncService: GithubSyncService,
    private readonly groupsRepository: GroupsRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly auditEventsService: AuditEventPublisher,
    private readonly configService: ConfigService,
  ) {}

  /** Transition #1 (plan §1.6): verifies group membership, creates the pending row, enqueues the grant job. */
  async createAssignment(
    repositoryId: string,
    userId: string,
    dto: CreateAssignmentDto,
  ): Promise<AssignmentRecord> {
    const config = this.configService.getOrThrow<AppConfig>('app');
    if (config.hierarchy.githubSyncMode !== 'live') {
      throw new ServiceUnavailableException(
        'Repository assignment is unavailable until live GitHub synchronization is enabled',
      );
    }
    const { groupId } =
      await this.accessService.assertRepositoryManagerOrPlatformAdmin(
        repositoryId,
        userId,
      );

    // Source plan §5 step 1: "AlphaCI verifies that the developer belongs to
    // the PM's group" before an assignment can be created.
    const targetMembership = await this.groupsRepository.findActiveMembership(
      groupId,
      dto.userId,
    );
    if (!targetMembership) {
      throw new BadRequestException(
        "The target user must be an active member of the repository's owning Group",
      );
    }
    if (targetMembership.role !== 'member') {
      throw new BadRequestException(
        'Only users with the Member role can be assigned to a repository',
      );
    }

    const assignment = await this.assignmentsRepository.createOrReset({
      repositoryId,
      userId: dto.userId,
      assignedBy: userId,
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.assignmentRequested,
      message: 'Repository assignment requested',
      metadata: {
        repositoryId,
        assignmentId: assignment.id,
        targetUserId: dto.userId,
      },
    });

    await this.githubSyncService.requestGrant(assignment.id, userId);

    return assignment;
  }

  async listAssignments(
    repositoryId: string,
    userId: string,
  ): Promise<AssignmentRecord[]> {
    await this.accessService.assertRepositoryManagerOrPlatformAdmin(
      repositoryId,
      userId,
    );
    return this.assignmentsRepository.listByRepository(repositoryId);
  }

  /** Transition #3: sets desired_state='unassigned' and enqueues the revoke job. Does not hard-delete. */
  async removeAssignment(
    repositoryId: string,
    userId: string,
    assignmentId: string,
  ): Promise<AssignmentRecord> {
    const { groupId } =
      await this.accessService.assertRepositoryManagerOrPlatformAdmin(
        repositoryId,
        userId,
      );
    const assignment = await this.assignmentsRepository.findById(assignmentId);
    if (!assignment || assignment.repositoryId !== repositoryId) {
      throw new NotFoundException('Assignment not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.assignmentRevokeRequested,
      message: 'Repository assignment revoke requested',
      metadata: { repositoryId, assignmentId, targetUserId: assignment.userId },
    });

    await this.githubSyncService.requestRevoke(assignmentId, userId);

    const updated = await this.assignmentsRepository.findById(assignmentId);
    if (!updated) {
      throw new NotFoundException('Assignment not found');
    }
    return updated;
  }

  /** Manual drift-repair trigger (periodic cron is a Phase 6 follow-up, plan §1.6 row 5). */
  async reconcile(
    repositoryId: string,
    userId: string,
    assignmentId: string,
  ): Promise<AssignmentRecord> {
    const { groupId } =
      await this.accessService.assertRepositoryManagerOrPlatformAdmin(
        repositoryId,
        userId,
      );
    const assignment = await this.assignmentsRepository.findById(assignmentId);
    if (!assignment || assignment.repositoryId !== repositoryId) {
      throw new NotFoundException('Assignment not found');
    }

    await this.githubSyncService.requestReconcile(assignmentId, userId);

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.assignmentReconciled,
      message: 'Repository assignment reconciliation requested',
      metadata: { repositoryId, assignmentId },
    });

    return assignment;
  }

  async getAccessStatus(
    repositoryId: string,
    userId: string,
  ): Promise<{
    items: Awaited<
      ReturnType<GithubAccessSyncRepository['listAccessStatusForRepository']>
    >;
  }> {
    await this.accessService.assertRepositoryManagerOrPlatformAdmin(
      repositoryId,
      userId,
    );
    const items =
      await this.syncRepository.listAccessStatusForRepository(repositoryId);
    return { items };
  }
}
