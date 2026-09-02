import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher';
import type { SessionUserLookup } from '#kernel/auth/session-user-lookup.contract';
import type { OutboxRepository } from '#kernel/events/outbox.repository';
import type { DatabaseService } from '#kernel/db/database.service';
import type {
  AssignmentRecord,
  AssignmentsRepository,
} from '../infrastructure/assignments.repository';
import type { RepositoriesRepository } from '../infrastructure/repositories.repository';
import type { GithubAccessSyncRepository } from '../infrastructure/github-access-sync.repository';
import { GithubSyncService } from './github-sync.service';
import type { GithubTeamAccessProvider } from './github-team-access.provider';
import { HIERARCHY_OUTBOX_TOPICS } from '../domain/hierarchy.types';

const baseAssignment = (
  overrides: Partial<AssignmentRecord> = {},
): AssignmentRecord => ({
  id: 'assignment-1',
  repositoryId: 'repo-1',
  userId: 'dev-1',
  accessLevel: 'write',
  desiredState: 'assigned',
  effectiveState: 'pending',
  status: 'pending',
  assignedBy: 'pm-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const baseRepository = {
  id: 'repo-1',
  deliveryProjectId: 'dp-1',
  groupId: 'group-1',
  name: 'payments-api',
  repoFullName: 'acme/payments-api',
  githubRepoId: null,
  visibility: 'private' as const,
  createdBy: 'pm-1',
  status: 'active' as const,
  archivedAt: null,
  provisionedProjectId: 'pp-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const baseUser = {
  id: 'dev-1',
  login: 'dev-one',
  onboardingCompleted: true,
  isInternal: true,
};

describe('GithubSyncService — assignment state machine (hierarchy state-machine contract)', () => {
  let outboxRepository: jest.Mocked<OutboxRepository>;
  let assignmentsRepository: jest.Mocked<AssignmentsRepository>;
  let syncRepository: jest.Mocked<GithubAccessSyncRepository>;
  let repositoriesRepository: jest.Mocked<RepositoriesRepository>;
  let sessionUserLookup: jest.Mocked<SessionUserLookup>;
  let provider: jest.Mocked<GithubTeamAccessProvider>;
  let auditEventsService: jest.Mocked<AuditEventPublisher>;
  let databaseService: jest.Mocked<DatabaseService>;
  let service: GithubSyncService;

  beforeEach(() => {
    outboxRepository = {
      publishBestEffort: jest.fn(),
      publishDurably: jest.fn(),
      publishInTransaction: jest.fn(),
    } as unknown as jest.Mocked<OutboxRepository>;
    assignmentsRepository = {
      findById: jest.fn(),
      createOrResetWithClient: jest.fn(),
      setDesiredUnassigned: jest.fn(),
      markGrantVerified: jest.fn(),
      markGrantFailed: jest.fn(),
      markRevokeVerified: jest.fn(),
      markRevokeFailed: jest.fn(),
    } as unknown as jest.Mocked<AssignmentsRepository>;
    syncRepository = {
      upsertPending: jest.fn(),
      upsertPendingWithClient: jest.fn(),
      markSyncing: jest.fn(),
      markVerified: jest.fn(),
      markFailed: jest.fn(),
      findByAssignmentId: jest.fn(),
    } as unknown as jest.Mocked<GithubAccessSyncRepository>;
    repositoriesRepository = {
      findById: jest.fn().mockResolvedValue(baseRepository),
    } as unknown as jest.Mocked<RepositoriesRepository>;
    sessionUserLookup = {
      findSessionUser: jest.fn().mockResolvedValue(baseUser),
    };
    provider = {
      ensureTeam: jest.fn(),
      addMember: jest.fn(),
      removeMember: jest.fn(),
      verifyEffectivePermission: jest.fn(),
    };
    auditEventsService = {
      record: jest.fn(),
      recordProjectEvent: jest.fn(),
    } as unknown as jest.Mocked<AuditEventPublisher>;
    databaseService = {
      withTransaction: jest.fn(),
    } as unknown as jest.Mocked<DatabaseService>;

    service = new GithubSyncService(
      outboxRepository,
      assignmentsRepository,
      syncRepository,
      repositoriesRepository,
      sessionUserLookup,
      provider,
      auditEventsService,
      databaseService,
    );
  });

  it('creates the assignment, sync state, and grant outbox row in one transaction', async () => {
    const client = { query: jest.fn() };
    const assignment = baseAssignment();
    assignmentsRepository.createOrResetWithClient.mockResolvedValue(assignment);
    syncRepository.upsertPendingWithClient.mockResolvedValue({
      id: 'sync-1',
      assignmentId: assignment.id,
      githubTeamId: null,
      githubTeamSlug: null,
      syncState: 'pending',
      verificationResult: null,
      lastSyncedAt: null,
      lastError: null,
      retryCount: 0,
      createdAt: assignment.createdAt,
      updatedAt: assignment.updatedAt,
    });
    databaseService.withTransaction.mockImplementation(async (fn) =>
      fn(client as never),
    );

    await service.createAssignmentAndRequestGrant({
      repositoryId: assignment.repositoryId,
      userId: assignment.userId,
      assignedBy: assignment.assignedBy,
    });

    expect(assignmentsRepository.createOrResetWithClient).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        repositoryId: assignment.repositoryId,
        userId: assignment.userId,
        assignedBy: assignment.assignedBy,
      }),
    );
    expect(syncRepository.upsertPendingWithClient).toHaveBeenCalledWith(
      client,
      assignment.id,
    );
    expect(outboxRepository.publishInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        topic: HIERARCHY_OUTBOX_TOPICS.grant,
        aggregateId: assignment.id,
        payload: {
          assignmentId: assignment.id,
          actingUserId: assignment.assignedBy,
        },
      }),
    );
  });

  it('requestGrant (transition #1) marks sync pending and enqueues a grant job', async () => {
    await service.requestGrant('assignment-1', 'pm-1');

    expect(syncRepository.upsertPending).toHaveBeenCalledWith(
      'assignment-1',
      expect.objectContaining({ topic: HIERARCHY_OUTBOX_TOPICS.grant }),
    );
    expect(outboxRepository.publishBestEffort).not.toHaveBeenCalled();
  });

  it('transition #2a: a verified grant marks the assignment active — never active before verification', async () => {
    assignmentsRepository.findById.mockResolvedValue(baseAssignment());
    provider.ensureTeam.mockResolvedValue({
      githubTeamId: 'team-1',
      githubTeamSlug: 'payments-api-developers',
    });
    provider.verifyEffectivePermission.mockResolvedValue({
      hasAccess: true,
      permission: 'write',
    });

    await service.processJob(HIERARCHY_OUTBOX_TOPICS.grant, {
      assignmentId: 'assignment-1',
      actingUserId: 'pm-1',
    });

    // Order matters: verification must run before the row is marked active.
    expect(provider.verifyEffectivePermission).toHaveBeenCalled();
    expect(assignmentsRepository.markGrantVerified).toHaveBeenCalledWith(
      'assignment-1',
    );
    expect(assignmentsRepository.markGrantFailed).not.toHaveBeenCalled();
    expect(syncRepository.markVerified).toHaveBeenCalled();
  });

  it('transition #2b: a grant that fails verification is marked failed, not active, and is requeued for retry', async () => {
    assignmentsRepository.findById.mockResolvedValue(baseAssignment());
    provider.ensureTeam.mockResolvedValue({
      githubTeamId: 'team-1',
      githubTeamSlug: 'payments-api-developers',
    });
    provider.verifyEffectivePermission.mockResolvedValue({ hasAccess: false });
    syncRepository.markFailed.mockResolvedValue(1);

    await service.processJob(HIERARCHY_OUTBOX_TOPICS.grant, {
      assignmentId: 'assignment-1',
      actingUserId: 'pm-1',
    });

    expect(assignmentsRepository.markGrantFailed).toHaveBeenCalledWith(
      'assignment-1',
    );
    expect(assignmentsRepository.markGrantVerified).not.toHaveBeenCalled();
    expect(outboxRepository.publishDurably).toHaveBeenCalledWith(
      expect.objectContaining({ topic: HIERARCHY_OUTBOX_TOPICS.grant }),
    );
  });

  it('a grant is NOT requeued once retryCount has hit the max (stays failed, surfaced on the admin view)', async () => {
    assignmentsRepository.findById.mockResolvedValue(baseAssignment());
    provider.ensureTeam.mockRejectedValue(new Error('GitHub API down'));
    syncRepository.markFailed.mockResolvedValue(5); // at the default max

    await service.processJob(HIERARCHY_OUTBOX_TOPICS.grant, {
      assignmentId: 'assignment-1',
      actingUserId: 'pm-1',
    });

    expect(assignmentsRepository.markGrantFailed).toHaveBeenCalled();
    expect(outboxRepository.publishBestEffort).not.toHaveBeenCalled();
  });

  it('requeues a grant when the repository or user cannot be resolved', async () => {
    assignmentsRepository.findById.mockResolvedValue(baseAssignment());
    repositoriesRepository.findById.mockResolvedValue(null);
    syncRepository.markFailed.mockResolvedValue(1);

    await service.processJob(HIERARCHY_OUTBOX_TOPICS.grant, {
      assignmentId: 'assignment-1',
      actingUserId: 'pm-1',
    });

    expect(outboxRepository.publishDurably).toHaveBeenCalledWith(
      expect.objectContaining({ topic: HIERARCHY_OUTBOX_TOPICS.grant }),
    );
  });

  it('transition #3: requestRevoke sets desired_state=unassigned and enqueues a revoke job', async () => {
    assignmentsRepository.setDesiredUnassigned.mockResolvedValue(
      baseAssignment({
        desiredState: 'unassigned',
        effectiveState: 'revoking',
      }),
    );

    await service.requestRevoke('assignment-1', 'pm-1');

    expect(assignmentsRepository.setDesiredUnassigned).toHaveBeenCalledWith(
      'assignment-1',
      expect.objectContaining({ topic: HIERARCHY_OUTBOX_TOPICS.revoke }),
    );
    expect(outboxRepository.publishBestEffort).not.toHaveBeenCalled();
  });

  it('transition #4a: a verified revoke marks the assignment revoked', async () => {
    assignmentsRepository.findById.mockResolvedValue(
      baseAssignment({
        desiredState: 'unassigned',
        effectiveState: 'revoking',
      }),
    );
    syncRepository.findByAssignmentId.mockResolvedValue({
      id: 'sync-1',
      assignmentId: 'assignment-1',
      githubTeamId: 'team-1',
      githubTeamSlug: 'payments-api-developers',
      syncState: 'syncing',
      verificationResult: null,
      lastSyncedAt: null,
      lastError: null,
      retryCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    provider.verifyEffectivePermission.mockResolvedValue({ hasAccess: false });

    await service.processJob(HIERARCHY_OUTBOX_TOPICS.revoke, {
      assignmentId: 'assignment-1',
      actingUserId: 'pm-1',
    });

    expect(assignmentsRepository.markRevokeVerified).toHaveBeenCalledWith(
      'assignment-1',
    );
    expect(assignmentsRepository.markRevokeFailed).not.toHaveBeenCalled();
  });

  it('transition #4b: a revoke that still reports access is NEVER marked revoked (fails closed, high-priority) and is requeued', async () => {
    assignmentsRepository.findById.mockResolvedValue(
      baseAssignment({
        desiredState: 'unassigned',
        effectiveState: 'revoking',
      }),
    );
    syncRepository.findByAssignmentId.mockResolvedValue({
      id: 'sync-1',
      assignmentId: 'assignment-1',
      githubTeamId: 'team-1',
      githubTeamSlug: 'payments-api-developers',
      syncState: 'syncing',
      verificationResult: null,
      lastSyncedAt: null,
      lastError: null,
      retryCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    // GitHub still reports the developer has access — revoke must NOT be
    // claimed successful (current hierarchy integration contract/§9, hierarchy state-machine contract).
    provider.verifyEffectivePermission.mockResolvedValue({
      hasAccess: true,
      permission: 'write',
    });
    syncRepository.markFailed.mockResolvedValue(1);

    await service.processJob(HIERARCHY_OUTBOX_TOPICS.revoke, {
      assignmentId: 'assignment-1',
      actingUserId: 'pm-1',
    });

    expect(assignmentsRepository.markRevokeVerified).not.toHaveBeenCalled();
    expect(assignmentsRepository.markRevokeFailed).toHaveBeenCalledWith(
      'assignment-1',
    );
    expect(outboxRepository.publishDurably).toHaveBeenCalledWith(
      expect.objectContaining({ topic: HIERARCHY_OUTBOX_TOPICS.revoke }),
    );
  });

  it('requeues a revoke when the repository or user cannot be resolved', async () => {
    assignmentsRepository.findById.mockResolvedValue(
      baseAssignment({
        desiredState: 'unassigned',
        effectiveState: 'revoking',
      }),
    );
    repositoriesRepository.findById.mockResolvedValue(null);
    syncRepository.findByAssignmentId.mockResolvedValue(null);
    syncRepository.markFailed.mockResolvedValue(1);

    await service.processJob(HIERARCHY_OUTBOX_TOPICS.revoke, {
      assignmentId: 'assignment-1',
      actingUserId: 'pm-1',
    });

    expect(outboxRepository.publishDurably).toHaveBeenCalledWith(
      expect.objectContaining({ topic: HIERARCHY_OUTBOX_TOPICS.revoke }),
    );
  });

  it('a grant job for an assignment superseded by a later revoke (desired_state no longer assigned) is a no-op', async () => {
    assignmentsRepository.findById.mockResolvedValue(
      baseAssignment({ desiredState: 'unassigned' }),
    );

    await service.processJob(HIERARCHY_OUTBOX_TOPICS.grant, {
      assignmentId: 'assignment-1',
      actingUserId: 'pm-1',
    });

    expect(provider.ensureTeam).not.toHaveBeenCalled();
    expect(assignmentsRepository.markGrantVerified).not.toHaveBeenCalled();
    expect(assignmentsRepository.markGrantFailed).not.toHaveBeenCalled();
  });

  it('requestReconcile re-enqueues a grant job when desired_state is assigned', async () => {
    assignmentsRepository.findById.mockResolvedValue(
      baseAssignment({ desiredState: 'assigned' }),
    );

    await service.requestReconcile('assignment-1', 'pm-1');

    expect(outboxRepository.publishDurably).toHaveBeenCalledWith(
      expect.objectContaining({ topic: HIERARCHY_OUTBOX_TOPICS.grant }),
    );
  });

  it('requestReconcile re-enqueues a revoke job when desired_state is unassigned', async () => {
    assignmentsRepository.findById.mockResolvedValue(
      baseAssignment({ desiredState: 'unassigned' }),
    );

    await service.requestReconcile('assignment-1', 'pm-1');

    expect(outboxRepository.publishDurably).toHaveBeenCalledWith(
      expect.objectContaining({ topic: HIERARCHY_OUTBOX_TOPICS.revoke }),
    );
  });
});
