import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  SESSION_USER_LOOKUP,
  type SessionUserLookup,
} from '#kernel/auth/session-user-lookup.contract';
import { OutboxRepository } from '#kernel/events/outbox.repository';
import { AssignmentsRepository } from '../assignments/assignments.repository';
import { RepositoriesRepository } from '../repositories/repositories.repository';
import { GithubAccessSyncRepository } from './github-access-sync.repository';
import { GithubTeamAccessProvider } from './providers/github-team-access.provider';
import {
  HIERARCHY_EVENT_CODES,
  HIERARCHY_OUTBOX_TOPICS,
  type HierarchyOutboxTopic,
} from '../hierarchy.types';

const MAX_SYNC_RETRIES_DEFAULT = 5;

export interface HierarchyOutboxJobPayload {
  assignmentId: string;
  actingUserId: string;
}

/**
 * Implements the desired_state x effective_state state machine transition
 * table (plan §1.6). Called directly by services for the synchronous parts
 * (enqueue) and by GithubSyncOutboxHandler for the async parts (process a
 * dequeued job). Kept as plain TypeScript (no DB trigger) so the state
 * machine stays testable in isolation (plan §1.6 rationale).
 */
@Injectable()
export class GithubSyncService {
  private readonly logger = new Logger(GithubSyncService.name);

  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly assignmentsRepository: AssignmentsRepository,
    private readonly syncRepository: GithubAccessSyncRepository,
    private readonly repositoriesRepository: RepositoriesRepository,
    @Inject(SESSION_USER_LOOKUP)
    private readonly sessionUserLookup: SessionUserLookup,
    private readonly provider: GithubTeamAccessProvider,
    private readonly auditEventsService: AuditEventPublisher,
  ) {}

  /** Transition #1: PM assigns developer -> pending + enqueue grant job. */
  async requestGrant(
    assignmentId: string,
    actingUserId: string,
  ): Promise<void> {
    await this.syncRepository.upsertPending(assignmentId, {
      topic: HIERARCHY_OUTBOX_TOPICS.grant,
      aggregateType: 'repository_assignment',
      aggregateId: assignmentId,
      payload: {
        assignmentId,
        actingUserId,
      } satisfies HierarchyOutboxJobPayload,
    });
  }

  /** Transition #3: PM removes assignment / member removal cascade -> revoking + enqueue revoke job. */
  async requestRevoke(
    assignmentId: string,
    actingUserId: string,
  ): Promise<void> {
    const assignment =
      await this.assignmentsRepository.setDesiredUnassigned(assignmentId, {
        topic: HIERARCHY_OUTBOX_TOPICS.revoke,
        aggregateType: 'repository_assignment',
        aggregateId: assignmentId,
        payload: {
          assignmentId,
          actingUserId,
        } satisfies HierarchyOutboxJobPayload,
      });
    if (!assignment) {
      return;
    }
  }

  /** Transition #5: manual drift-repair trigger — re-enqueues a job matching current desired_state. */
  async requestReconcile(
    assignmentId: string,
    actingUserId: string,
  ): Promise<void> {
    const assignment = await this.assignmentsRepository.findById(assignmentId);
    if (!assignment) {
      return;
    }
    const topic: HierarchyOutboxTopic =
      assignment.desiredState === 'assigned'
        ? HIERARCHY_OUTBOX_TOPICS.grant
        : HIERARCHY_OUTBOX_TOPICS.revoke;
    await this.outboxRepository.publishBestEffort({
      topic,
      aggregateType: 'repository_assignment',
      aggregateId: assignmentId,
      payload: {
        assignmentId,
        actingUserId,
      } satisfies HierarchyOutboxJobPayload,
    });
  }

  /** Processes one dequeued outbox job — called by the central relay handler. */
  async processJob(
    topic: string,
    payload: HierarchyOutboxJobPayload,
  ): Promise<void> {
    if (topic === HIERARCHY_OUTBOX_TOPICS.grant) {
      await this.processGrant(payload.assignmentId, payload.actingUserId);
      return;
    }
    if (topic === HIERARCHY_OUTBOX_TOPICS.revoke) {
      await this.processRevoke(payload.assignmentId, payload.actingUserId);
      return;
    }
    this.logger.warn(`Unknown hierarchy outbox topic: ${topic}`);
  }

  private async processGrant(
    assignmentId: string,
    actingUserId: string,
  ): Promise<void> {
    const assignment = await this.assignmentsRepository.findById(assignmentId);
    if (!assignment || assignment.desiredState !== 'assigned') {
      return; // superseded by a later revoke — nothing to do.
    }
    const repository = await this.repositoriesRepository.findById(
      assignment.repositoryId,
    );
    const user = await this.sessionUserLookup.findSessionUser(
      assignment.userId,
    );
    if (!repository?.repoFullName || !user) {
      await this.failGrant(
        assignmentId,
        'Repository or user could not be resolved for grant',
      );
      return;
    }

    try {
      await this.syncRepository.markSyncing(assignmentId);
      const [orgLogin] = repository.repoFullName.split('/');
      const team = await this.provider.ensureTeam({
        repositoryId: repository.id,
        repoFullName: repository.repoFullName,
        actingUserId,
      });
      await this.provider.addMember({
        orgLogin: orgLogin ?? '',
        githubTeamSlug: team.githubTeamSlug,
        githubLogin: user.login,
        repoFullName: repository.repoFullName,
        actingUserId,
      });
      const verification = await this.provider.verifyEffectivePermission({
        repoFullName: repository.repoFullName,
        githubLogin: user.login,
        expectedPermission: 'write',
        expectedTeamSlug: team.githubTeamSlug,
        actingUserId,
      });

      if (!verification.hasAccess || verification.hasUnapprovedGrant) {
        await this.failGrant(
          assignmentId,
          `Verification failed after grant: ${JSON.stringify(verification)}`,
          repository.groupId,
          actingUserId,
        );
        return;
      }

      await this.assignmentsRepository.markGrantVerified(assignmentId);
      await this.syncRepository.markVerified({
        assignmentId,
        githubTeamId: team.githubTeamId,
        githubTeamSlug: team.githubTeamSlug,
        verificationResult: { ...verification },
      });

      await this.auditEventsService.recordProjectEvent({
        workspaceId: repository.groupId,
        actorUserId: actingUserId,
        eventCode: HIERARCHY_EVENT_CODES.assignmentGrantVerified,
        message: `Repository access verified for ${user.login}`,
        metadata: {
          repositoryId: repository.id,
          assignmentId,
          targetUserId: assignment.userId,
        },
      });
    } catch (error) {
      await this.failGrant(
        assignmentId,
        error instanceof Error ? error.message : String(error),
        repository.groupId,
        actingUserId,
      );
    }
  }

  private async processRevoke(
    assignmentId: string,
    actingUserId: string,
  ): Promise<void> {
    const assignment = await this.assignmentsRepository.findById(assignmentId);
    if (!assignment || assignment.desiredState !== 'unassigned') {
      return;
    }
    const repository = await this.repositoriesRepository.findById(
      assignment.repositoryId,
    );
    const user = await this.sessionUserLookup.findSessionUser(
      assignment.userId,
    );
    const sync = await this.syncRepository.findByAssignmentId(assignmentId);

    if (!repository?.repoFullName || !user) {
      await this.failRevoke(
        assignmentId,
        'Repository or user could not be resolved for revoke',
      );
      return;
    }

    try {
      await this.syncRepository.markSyncing(assignmentId);
      const [orgLogin] = repository.repoFullName.split('/');
      const teamSlug =
        sync?.githubTeamSlug ??
        (
          await this.provider.ensureTeam({
            repositoryId: repository.id,
            repoFullName: repository.repoFullName,
            actingUserId,
          })
        ).githubTeamSlug;

      await this.provider.removeMember({
        orgLogin: orgLogin ?? '',
        githubTeamSlug: teamSlug,
        githubLogin: user.login,
        repoFullName: repository.repoFullName,
        actingUserId,
      });
      const verification = await this.provider.verifyEffectivePermission({
        repoFullName: repository.repoFullName,
        githubLogin: user.login,
        expectedPermission: 'write',
        expectedTeamSlug: teamSlug,
        actingUserId,
      });

      // A revoke is only verified once GitHub confirms no effective access
      // remains — never claim revoked before verified (plan §1.6 row 4a/4b).
      if (verification.hasAccess) {
        await this.failRevoke(
          assignmentId,
          'Revoke verification still reports access',
          repository.groupId,
          actingUserId,
        );
        return;
      }

      await this.assignmentsRepository.markRevokeVerified(assignmentId);
      await this.syncRepository.markVerified({
        assignmentId,
        githubTeamId: sync?.githubTeamId ?? '',
        githubTeamSlug: teamSlug,
        verificationResult: { ...verification },
      });

      await this.auditEventsService.recordProjectEvent({
        workspaceId: repository.groupId,
        actorUserId: actingUserId,
        eventCode: HIERARCHY_EVENT_CODES.assignmentRevokeVerified,
        message: `Repository access revoked for ${user.login}`,
        metadata: {
          repositoryId: repository.id,
          assignmentId,
          targetUserId: assignment.userId,
        },
      });
    } catch (error) {
      await this.failRevoke(
        assignmentId,
        error instanceof Error ? error.message : String(error),
        repository.groupId,
        actingUserId,
      );
    }
  }

  private async failGrant(
    assignmentId: string,
    message: string,
    groupId?: string,
    actingUserId?: string,
  ): Promise<void> {
    await this.assignmentsRepository.markGrantFailed(assignmentId);
    const retryCount = await this.syncRepository.markFailed({
      assignmentId,
      error: message,
    });
    this.logger.warn(`Grant failed for assignment ${assignmentId}: ${message}`);
    if (groupId && actingUserId) {
      await this.auditEventsService.recordProjectEvent({
        workspaceId: groupId,
        actorUserId: actingUserId,
        eventCode: HIERARCHY_EVENT_CODES.assignmentGrantFailed,
        message: 'Repository access grant failed',
        metadata: { assignmentId, retryCount, error: message.slice(0, 300) },
      });
    }
    await this.maybeRequeue(assignmentId, actingUserId, retryCount, 'grant');
  }

  private async failRevoke(
    assignmentId: string,
    message: string,
    groupId?: string,
    actingUserId?: string,
  ): Promise<void> {
    // Effective_state stays 'revoking' — never silently promoted to
    // 'revoked' (plan §1.6 row 4b, source §5/§9 "must retry automatically,
    // remain visible to administrators, and block any claim that access has
    // been removed until verified").
    await this.assignmentsRepository.markRevokeFailed(assignmentId);
    const retryCount = await this.syncRepository.markFailed({
      assignmentId,
      error: message,
    });
    this.logger.warn(
      `Revoke failed for assignment ${assignmentId} (HIGH PRIORITY — access may still be live): ${message}`,
    );
    if (groupId && actingUserId) {
      await this.auditEventsService.recordProjectEvent({
        workspaceId: groupId,
        actorUserId: actingUserId,
        eventCode: HIERARCHY_EVENT_CODES.assignmentRevokeFailed,
        message: 'Repository access revoke failed (high priority)',
        metadata: { assignmentId, retryCount, error: message.slice(0, 300) },
      });
    }
    await this.maybeRequeue(assignmentId, actingUserId, retryCount, 'revoke');
  }

  private async maybeRequeue(
    assignmentId: string,
    actingUserId: string | undefined,
    retryCount: number,
    kind: 'grant' | 'revoke',
    maxRetries: number = MAX_SYNC_RETRIES_DEFAULT,
  ): Promise<void> {
    if (retryCount >= maxRetries || !actingUserId) {
      return; // stays failed/revoking indefinitely, surfaced on the admin view (plan §1.6).
    }
    await this.outboxRepository.publishBestEffort({
      topic:
        kind === 'grant'
          ? HIERARCHY_OUTBOX_TOPICS.grant
          : HIERARCHY_OUTBOX_TOPICS.revoke,
      aggregateType: 'repository_assignment',
      aggregateId: assignmentId,
      payload: {
        assignmentId,
        actingUserId,
      } satisfies HierarchyOutboxJobPayload,
    });
  }
}
