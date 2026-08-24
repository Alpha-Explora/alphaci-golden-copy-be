import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../../kernel/db/database.service';
import type {
  AssignmentStatus,
  DesiredState,
  EffectiveState,
} from '../hierarchy.types';

export interface AssignmentRecord {
  id: string;
  repositoryId: string;
  userId: string;
  accessLevel: 'write';
  desiredState: DesiredState;
  effectiveState: EffectiveState;
  status: AssignmentStatus;
  assignedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface AssignmentRow {
  id: string;
  repository_id: string;
  user_id: string;
  access_level: 'write';
  desired_state: DesiredState;
  effective_state: EffectiveState;
  status: AssignmentStatus;
  assigned_by: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class AssignmentsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Creates (or reactivates) an assignment. `UNIQUE (repository_id, user_id)`
   * means history is preserved via state transitions on the same row, not new
   * rows (plan §1.6/§2.6) — re-assigning after a revoke resets the state
   * machine back to pending.
   */
  async createOrReset(input: {
    repositoryId: string;
    userId: string;
    assignedBy: string;
  }): Promise<AssignmentRecord> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        INSERT INTO hierarchy.repository_assignments (
          repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by
        )
        VALUES ($1, $2, 'write', 'assigned', 'pending', 'pending', $3)
        ON CONFLICT (repository_id, user_id)
        DO UPDATE SET
          desired_state = 'assigned',
          effective_state = 'pending',
          status = 'pending',
          assigned_by = EXCLUDED.assigned_by,
          updated_at = NOW()
        RETURNING id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at;
      `,
      [input.repositoryId, input.userId, input.assignedBy],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Assignment insert did not return a row');
    return this.toRecord(row);
  }

  async findById(assignmentId: string): Promise<AssignmentRecord | null> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        SELECT id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at
        FROM hierarchy.repository_assignments
        WHERE id = $1;
      `,
      [assignmentId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async findActiveForUserAndRepository(
    repositoryId: string,
    userId: string,
  ): Promise<AssignmentRecord | null> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        SELECT id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at
        FROM hierarchy.repository_assignments
        WHERE repository_id = $1 AND user_id = $2 AND status = 'active' AND effective_state = 'active';
      `,
      [repositoryId, userId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async listByRepository(repositoryId: string): Promise<AssignmentRecord[]> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        SELECT id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at
        FROM hierarchy.repository_assignments
        WHERE repository_id = $1
        ORDER BY created_at ASC;
      `,
      [repositoryId],
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  /** Every currently-assigned (desired_state='assigned') row for a user across a whole group's repositories — cascade-on-removal (plan §4). */
  async listAssignedByUserWithinGroup(
    groupId: string,
    userId: string,
  ): Promise<AssignmentRecord[]> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        SELECT a.id, a.repository_id, a.user_id, a.access_level, a.desired_state, a.effective_state, a.status, a.assigned_by, a.created_at, a.updated_at
        FROM hierarchy.repository_assignments AS a
        JOIN hierarchy.repositories AS r ON r.id = a.repository_id
        WHERE r.group_id = $1
          AND a.user_id = $2
          AND a.desired_state = 'assigned';
      `,
      [groupId, userId],
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  async listActiveOrPendingForUser(
    userId: string,
  ): Promise<AssignmentRecord[]> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        SELECT id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at
        FROM hierarchy.repository_assignments
        WHERE user_id = $1 AND status IN ('active', 'pending')
        ORDER BY created_at DESC;
      `,
      [userId],
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  /**
   * Developer dashboard "My assigned repositories" (plan §2.6 GET
   * /me/assigned-repositories). Field names match FE's MyAssignedRepository
   * contract exactly (assignmentId, not the raw assignment id; groupId/
   * systemId/deliveryProjectId + their *Name siblings for the breadcrumb;
   * htmlUrl derived the same way RepositoriesRepository.toRecord derives it).
   */
  async listActiveOrPendingForUserWithRepository(userId: string): Promise<
    Array<{
      assignmentId: string;
      repositoryId: string;
      repositoryName: string;
      repoFullName: string | null;
      htmlUrl: string | null;
      deliveryProjectId: string | null;
      deliveryProjectName: string | null;
      systemId: string | null;
      systemName: string | null;
      groupId: string | null;
      groupName: string | null;
      status: AssignmentStatus;
      effectiveState: EffectiveState;
      accessLevel: 'write';
      updatedAt: string;
    }>
  > {
    const result = await this.databaseService.query<{
      assignment_id: string;
      repository_id: string;
      repository_name: string;
      repo_full_name: string | null;
      delivery_project_id: string | null;
      delivery_project_name: string | null;
      system_id: string | null;
      system_name: string | null;
      group_id: string | null;
      group_name: string | null;
      status: AssignmentStatus;
      effective_state: EffectiveState;
      access_level: 'write';
      updated_at: string;
    }>(
      `
        SELECT
          a.id AS assignment_id, a.repository_id, a.status, a.effective_state, a.access_level, a.updated_at,
          r.name AS repository_name, r.repo_full_name,
          dp.id AS delivery_project_id, dp.name AS delivery_project_name,
          s.id AS system_id, s.name AS system_name,
          w.id AS group_id, w.name AS group_name
        FROM hierarchy.repository_assignments AS a
        JOIN hierarchy.repositories AS r ON r.id = a.repository_id
        LEFT JOIN hierarchy.delivery_projects AS dp ON dp.id = r.delivery_project_id
        LEFT JOIN hierarchy.systems AS s ON s.id = dp.system_id
        LEFT JOIN orgs.workspaces AS w ON w.id = r.group_id
        WHERE a.user_id = $1 AND a.status IN ('active', 'pending')
        ORDER BY a.created_at DESC;
      `,
      [userId],
    );
    return result.rows.map((row) => ({
      assignmentId: row.assignment_id,
      repositoryId: row.repository_id,
      repositoryName: row.repository_name,
      repoFullName: row.repo_full_name,
      htmlUrl: row.repo_full_name
        ? `https://github.com/${row.repo_full_name}`
        : null,
      deliveryProjectId: row.delivery_project_id,
      deliveryProjectName: row.delivery_project_name,
      systemId: row.system_id,
      systemName: row.system_name,
      groupId: row.group_id,
      groupName: row.group_name,
      status: row.status,
      effectiveState: row.effective_state,
      accessLevel: row.access_level,
      updatedAt: row.updated_at,
    }));
  }

  async setDesiredUnassigned(
    assignmentId: string,
  ): Promise<AssignmentRecord | null> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        UPDATE hierarchy.repository_assignments
        SET desired_state = 'unassigned', effective_state = 'revoking', updated_at = NOW()
        WHERE id = $1
        RETURNING id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at;
      `,
      [assignmentId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async markGrantVerified(
    assignmentId: string,
  ): Promise<AssignmentRecord | null> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        UPDATE hierarchy.repository_assignments
        SET effective_state = 'active', status = 'active', updated_at = NOW()
        WHERE id = $1
        RETURNING id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at;
      `,
      [assignmentId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async markGrantFailed(
    assignmentId: string,
  ): Promise<AssignmentRecord | null> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        UPDATE hierarchy.repository_assignments
        SET effective_state = 'failed', status = 'failed', updated_at = NOW()
        WHERE id = $1
        RETURNING id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at;
      `,
      [assignmentId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async markRevokeVerified(
    assignmentId: string,
  ): Promise<AssignmentRecord | null> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        UPDATE hierarchy.repository_assignments
        SET effective_state = 'revoked', status = 'revoked', updated_at = NOW()
        WHERE id = $1
        RETURNING id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at;
      `,
      [assignmentId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  /**
   * A failed revoke stays 'revoking' — status is left untouched (never
   * silently promoted to 'revoked') per plan §1.6 row 4b.
   */
  async markRevokeFailed(
    assignmentId: string,
  ): Promise<AssignmentRecord | null> {
    const result = await this.databaseService.query<AssignmentRow>(
      `
        UPDATE hierarchy.repository_assignments
        SET updated_at = NOW()
        WHERE id = $1
        RETURNING id, repository_id, user_id, access_level, desired_state, effective_state, status, assigned_by, created_at, updated_at;
      `,
      [assignmentId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: AssignmentRow): AssignmentRecord {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      userId: row.user_id,
      accessLevel: row.access_level,
      desiredState: row.desired_state,
      effectiveState: row.effective_state,
      status: row.status,
      assignedBy: row.assigned_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
