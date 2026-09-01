import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { DatabaseService } from '#kernel/db/database.service';
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
 * table (hierarchy state-machine contract). Called directly by services for the synchronous parts
 * (enqueue) and by GithubSyncOutboxHandler for the async parts (process a
 * dequeued job). Kept as plain TypeScript (no DB trigger) so the state
 * machine stays testable in isolation (hierarchy state-machine contract rationale).
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
    @Optional() private readonly databaseService?: DatabaseService,
  ) {}

  /**
   * Transition #1 transaction boundary: create/reset the assignment, create
   * its pending sync row, and enqueue the grant in one commit. Keeping this
   * orchestration here makes the business mutation and its durable work item
   * share the same client without changing the public assignment response.
   */
  async createAssignmentAndRequestGrant(input: {
    repositoryId: string;
    userId: string;
    assignedBy: string;
  }): Promise<Awaited<ReturnType<AssignmentsRepository['createOrReset']>>> {
    if (!this.databaseService) {
      throw new Error(
        'DatabaseService is required for transactionally creating an assignment grant',
      );
    }

    return this.databaseService.withTransaction(async (client) => {
      const assignment =
        await this.assignmentsRepository.createOrResetWithClient(client, input);
      await this.syncRepository.upsertPendingWithClient(client, assignment.id);
      await this.outboxRepository.publishInTransaction(
        client,
        this.grantEvent(assignment.id, input.assignedBy),
      );
      return assignment;
    });
  }

  /** Transition #1: PM assigns developer -> pending + enqueue grant job. */
  async requestGrant(
    assignmentId: string,
    actingUserId: string,
  ): Promise<void> {
    await this.syncRepository.upsertPending(
      assignmentId,
      this.grantEvent(assignmentId, actingUserId),
    );
  }

  private grantEvent(assignmentId: string, actingUserId: string) {
    return {
      topic: HIERARCHY_OUTBOX_TOPICS.grant,
      aggregateType: 'repository_assignment',
      aggregateId: assignmentId,
      payload: {
        assignmentId,
        actingUserId,
      } satisfies HierarchyOutboxJobPayload,
    } as const;
  }

  /** Transition #3: PM removes assignment / member removal cascade -> revoking + enqueue revoke job. */
  async requestRevoke(
    assignmentId: string,
    actingUserId: string,
  ): Promise<void> {
    const assignment = await this.assignmentsRepository.setDesiredUnassigned(
      assignmentId,
      this.revokeEvent(assignmentId, actingUserId),
    );
    if (!assignment) {
      return;
    }
  }

  /**
   * Revoke transition against a caller-owned transaction. This is used by
   * member offboarding so the membership update, assignment transitions, and
   * outbox rows commit or roll back together.
   */
  async requestRevokeWithClient(
    client: Pick<PoolClient, 'query'>,
    assignmentId: string,
    actingUserId: string,
  ): Promise<void> {
    const assignment =
      await this.assignmentsRepository.setDesiredUnassignedWithClient(
        client,
        assignmentId,
      );
    if (!assignment) {
      return;
    }

    await this.outboxRepository.publishInTransaction(
      client,
      this.revokeEvent(assignmentId, actingUserId),
    );
  }

  private revokeEvent(assignmentId: string, actingUserId: string) {
    return {
      topic: HIERARCHY_OUTBOX_TOPICS.revoke,
      aggregateType: 'repository_assignment',
      aggregateId: assignmentId,
      payload: {
        assignmentId,
        actingUserId,
      } satisfies HierarchyOutboxJobPayload,
    } as const;
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
    // A manual reconcile is an explicit operator request. Do not silently
    // lose it after the state lookup succeeds: the relay can retry the caller
    // when the durable enqueue is unavailable.
    await this.outboxRepository.publishDurably({
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
        repository?.groupId,
        actingUserId,
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
        repository?.groupId,
        actingUserId,
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
      // remains — never claim revoked before verified (hierarchy state-machine contract).
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
    // 'revoked' (hierarchy state-machine contract, hierarchy retry and security contract "must retry automatically,
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
      return; // stays failed/revoking indefinitely, surfaced on the admin view (hierarchy state-machine contract).
    }
    // The state transition has already been recorded as failed/revoking, but
    // the retry request itself is still durable work. Let the relay retain the
    // failed event when this enqueue cannot be written rather than pretending
    // the retry was scheduled.
    await this.outboxRepository.publishDurably({
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
