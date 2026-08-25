import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../../kernel/db/database.service';
import type {
  AssignmentStatus,
  DesiredState,
  EffectiveState,
  SyncState,
} from '../hierarchy.types';

export interface GithubAccessSyncRecord {
  id: string;
  assignmentId: string;
  githubTeamId: string | null;
  githubTeamSlug: string | null;
  syncState: SyncState;
  verificationResult: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

interface GithubAccessSyncRow {
  id: string;
  assignment_id: string;
  github_team_id: string | null;
  github_team_slug: string | null;
  sync_state: SyncState;
  verification_result: Record<string, unknown> | string | null;
  last_synced_at: string | null;
  last_error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class GithubAccessSyncRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async upsertPending(assignmentId: string): Promise<GithubAccessSyncRecord> {
    const result = await this.databaseService.query<GithubAccessSyncRow>(
      `
        INSERT INTO hierarchy.github_access_sync (assignment_id, sync_state)
        VALUES ($1, 'pending')
        ON CONFLICT (assignment_id)
        DO UPDATE SET sync_state = 'pending', updated_at = NOW()
        RETURNING id, assignment_id, github_team_id, github_team_slug, sync_state,
          verification_result, last_synced_at, last_error, retry_count, created_at, updated_at;
      `,
      [assignmentId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('github_access_sync upsert did not return a row');
    return this.toRecord(row);
  }

  async findByAssignmentId(
    assignmentId: string,
  ): Promise<GithubAccessSyncRecord | null> {
    const result = await this.databaseService.query<GithubAccessSyncRow>(
      `
        SELECT id, assignment_id, github_team_id, github_team_slug, sync_state,
          verification_result, last_synced_at, last_error, retry_count, created_at, updated_at
        FROM hierarchy.github_access_sync
        WHERE assignment_id = $1;
      `,
      [assignmentId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async listForRepository(
    repositoryId: string,
  ): Promise<GithubAccessSyncRecord[]> {
    const result = await this.databaseService.query<GithubAccessSyncRow>(
      `
        SELECT s.id, s.assignment_id, s.github_team_id, s.github_team_slug, s.sync_state,
          s.verification_result, s.last_synced_at, s.last_error, s.retry_count, s.created_at, s.updated_at
        FROM hierarchy.github_access_sync AS s
        JOIN hierarchy.repository_assignments AS a ON a.id = s.assignment_id
        WHERE a.repository_id = $1
        ORDER BY s.updated_at DESC;
      `,
      [repositoryId],
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  /**
   * The PM-facing "pending/active/failed/revoked access status" view (plan
   * §2.6 GET /repositories/:repositoryId/access-status, §8). Joins
   * repository_assignments (desired_state/effective_state/status) +
   * github_access_sync (sync_state/retry bookkeeping) + the assignee's user
   * profile into the exact shape the FE's RepositoryAccessStatus contract
   * expects — including isHighPriorityFailure, derived server-side per plan
   * §1.6 (sync_state='failed' AND desired_state='unassigned', i.e. a failed
   * REVOCATION) so the FE only ever reads the boolean, never recomputes it.
   * LEFT JOINs github_access_sync defensively — a sync row is created
   * synchronously in the same request that creates the assignment
   * (GithubSyncService.requestGrant -> upsertPending), but this view must
   * not 500 if that invariant is ever violated.
   */
  async listAccessStatusForRepository(repositoryId: string): Promise<
    Array<{
      assignmentId: string;
      repositoryId: string;
      userId: string;
      login: string | null;
      name: string | null;
      desiredState: DesiredState;
      effectiveState: EffectiveState;
      status: AssignmentStatus;
      syncState: SyncState;
      githubTeamSlug: string | null;
      lastError: string | null;
      retryCount: number;
      lastSyncedAt: string | null;
      isHighPriorityFailure: boolean;
    }>
  > {
    const result = await this.databaseService.query<{
      assignment_id: string;
      repository_id: string;
      user_id: string;
      login: string | null;
      display_name: string | null;
      desired_state: DesiredState;
      effective_state: EffectiveState;
      status: AssignmentStatus;
      sync_state: SyncState | null;
      github_team_slug: string | null;
      last_error: string | null;
      retry_count: number | null;
      last_synced_at: string | null;
    }>(
      `
        SELECT
          a.id AS assignment_id, a.repository_id, a.user_id,
          u.login, u.display_name,
          a.desired_state, a.effective_state, a.status,
          s.sync_state, s.github_team_slug, s.last_error, s.retry_count, s.last_synced_at
        FROM hierarchy.repository_assignments AS a
        LEFT JOIN hierarchy.github_access_sync AS s ON s.assignment_id = a.id
        LEFT JOIN identity.app_users AS u ON u.id = a.user_id
        WHERE a.repository_id = $1
        ORDER BY a.created_at ASC;
      `,
      [repositoryId],
    );
    return result.rows.map((row) => {
      const syncState = row.sync_state ?? 'pending';
      return {
        assignmentId: row.assignment_id,
        repositoryId: row.repository_id,
        userId: row.user_id,
        login: row.login,
        name: row.display_name ?? row.login,
        desiredState: row.desired_state,
        effectiveState: row.effective_state,
        status: row.status,
        syncState,
        githubTeamSlug: row.github_team_slug,
        lastError: row.last_error,
        retryCount: row.retry_count ?? 0,
        lastSyncedAt: row.last_synced_at,
        isHighPriorityFailure:
          syncState === 'failed' && row.desired_state === 'unassigned',
      };
    });
  }

  async markVerified(input: {
    assignmentId: string;
    githubTeamId: string;
    githubTeamSlug: string;
    verificationResult: Record<string, unknown>;
  }): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE hierarchy.github_access_sync
        SET sync_state = 'verified', github_team_id = $2, github_team_slug = $3,
          verification_result = $4::jsonb, last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE assignment_id = $1;
      `,
      [
        input.assignmentId,
        input.githubTeamId,
        input.githubTeamSlug,
        JSON.stringify(input.verificationResult),
      ],
    );
  }

  async markFailed(input: {
    assignmentId: string;
    error: string;
  }): Promise<number> {
    const result = await this.databaseService.query<{ retry_count: number }>(
      `
        UPDATE hierarchy.github_access_sync
        SET sync_state = 'failed', last_error = $2, retry_count = retry_count + 1, updated_at = NOW()
        WHERE assignment_id = $1
        RETURNING retry_count;
      `,
      [input.assignmentId, input.error.slice(0, 500)],
    );
    return result.rows[0]?.retry_count ?? 0;
  }

  async markDriftDetected(assignmentId: string): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE hierarchy.github_access_sync
        SET sync_state = 'drift_detected', updated_at = NOW()
        WHERE assignment_id = $1;
      `,
      [assignmentId],
    );
  }

  async markSyncing(assignmentId: string): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE hierarchy.github_access_sync
        SET sync_state = 'syncing', updated_at = NOW()
        WHERE assignment_id = $1;
      `,
      [assignmentId],
    );
  }

  private toRecord(row: GithubAccessSyncRow): GithubAccessSyncRecord {
    return {
      id: row.id,
      assignmentId: row.assignment_id,
      githubTeamId: row.github_team_id,
      githubTeamSlug: row.github_team_slug,
      syncState: row.sync_state,
      verificationResult:
        typeof row.verification_result === 'string'
          ? (JSON.parse(row.verification_result) as Record<string, unknown>)
          : row.verification_result,
      lastSyncedAt: row.last_synced_at,
      lastError: row.last_error,
      retryCount: row.retry_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
