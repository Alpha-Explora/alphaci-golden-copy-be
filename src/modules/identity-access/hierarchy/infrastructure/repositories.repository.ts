import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type { RepositoryStatus } from '../domain/hierarchy.types';

export interface RepositoryRecord {
  id: string;
  deliveryProjectId: string;
  groupId: string;
  name: string;
  repoFullName: string | null;
  githubRepoId: string | null;
  visibility: 'private';
  createdBy: string | null;
  status: RepositoryStatus;
  archivedAt: string | null;
  provisionedProjectId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Active-assignment ("developers") count — at-a-glance chip (current hierarchy summary contract). */
  assignmentCount: number;
  /** Derived from repoFullName — null until the GitHub repo is created. */
  htmlUrl: string | null;
}

interface RepositoryRow {
  id: string;
  delivery_project_id: string;
  group_id: string;
  name: string;
  repo_full_name: string | null;
  github_repo_id: string | number | null;
  visibility: 'private';
  created_by: string | null;
  status: RepositoryStatus;
  archived_at: string | null;
  provisioned_project_id: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class RepositoriesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async create(input: {
    deliveryProjectId: string;
    groupId: string;
    name: string;
    repoFullName: string;
    createdBy: string;
    provisionedProjectId?: string | null;
  }): Promise<RepositoryRecord> {
    const result = await this.databaseService.query<RepositoryRow>(
      `
        INSERT INTO hierarchy.repositories (
          delivery_project_id, group_id, name, repo_full_name, created_by, status, provisioned_project_id
        )
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
        RETURNING id, delivery_project_id, group_id, name, repo_full_name, github_repo_id, visibility,
          created_by, status, archived_at, provisioned_project_id, created_at, updated_at;
      `,
      [
        input.deliveryProjectId,
        input.groupId,
        input.name,
        input.repoFullName,
        input.createdBy,
        input.provisionedProjectId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Repository insert did not return a row');
    // A freshly created Repository has zero assignments yet.
    return this.toRecord(row, 0);
  }

  async listByDeliveryProjectForManager(
    deliveryProjectId: string,
  ): Promise<RepositoryRecord[]> {
    const result = await this.databaseService.query<RepositoryRow>(
      `
        SELECT id, delivery_project_id, group_id, name, repo_full_name, github_repo_id, visibility,
          created_by, status, archived_at, provisioned_project_id, created_at, updated_at
        FROM hierarchy.repositories
        WHERE delivery_project_id = $1
        ORDER BY created_at ASC;
      `,
      [deliveryProjectId],
    );
    const counts = await this.getAssignmentCounts(
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) =>
      this.toRecord(row, counts.get(row.id) ?? 0),
    );
  }

  /**
   * Developer/viewer visibility: only repositories where the caller holds an
   * assignment with status='active' (current hierarchy API contract — server-side filtering, never
   * "returned then hidden by the FE").
   */
  async listByDeliveryProjectForAssignee(
    deliveryProjectId: string,
    userId: string,
  ): Promise<RepositoryRecord[]> {
    const result = await this.databaseService.query<RepositoryRow>(
      `
        SELECT r.id, r.delivery_project_id, r.group_id, r.name, r.repo_full_name, r.github_repo_id,
          r.visibility, r.created_by, r.status, r.archived_at, r.provisioned_project_id, r.created_at, r.updated_at
        FROM hierarchy.repositories AS r
        JOIN hierarchy.repository_assignments AS a
          ON a.repository_id = r.id
        WHERE r.delivery_project_id = $1
          AND a.user_id = $2
          AND a.status = 'active'
        ORDER BY r.created_at ASC;
      `,
      [deliveryProjectId, userId],
    );
    const counts = await this.getAssignmentCounts(
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) =>
      this.toRecord(row, counts.get(row.id) ?? 0),
    );
  }

  async findById(repositoryId: string): Promise<RepositoryRecord | null> {
    const result = await this.databaseService.query<RepositoryRow>(
      `
        SELECT id, delivery_project_id, group_id, name, repo_full_name, github_repo_id, visibility,
          created_by, status, archived_at, provisioned_project_id, created_at, updated_at
        FROM hierarchy.repositories
        WHERE id = $1;
      `,
      [repositoryId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getAssignmentCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  /** Active-assignment counts, batched by repository id (current hierarchy summary contract). */
  private async getAssignmentCounts(
    repositoryIds: string[],
  ): Promise<Map<string, number>> {
    if (repositoryIds.length === 0) return new Map();
    const result = await this.databaseService.query<{
      repository_id: string;
      count: number;
    }>(
      `
        SELECT repository_id, count(*)::int AS count
        FROM hierarchy.repository_assignments
        WHERE repository_id = ANY($1::uuid[]) AND status = 'active'
        GROUP BY repository_id;
      `,
      [repositoryIds],
    );
    return new Map(result.rows.map((row) => [row.repository_id, row.count]));
  }

  async findGroupIdForRepository(repositoryId: string): Promise<string | null> {
    const result = await this.databaseService.query<{ group_id: string }>(
      `SELECT group_id FROM hierarchy.repositories WHERE id = $1;`,
      [repositoryId],
    );
    return result.rows[0]?.group_id ?? null;
  }

  async update(
    repositoryId: string,
    input: { name?: string },
  ): Promise<RepositoryRecord | null> {
    const result = await this.databaseService.query<RepositoryRow>(
      `
        UPDATE hierarchy.repositories
        SET name = COALESCE($2, name), updated_at = NOW()
        WHERE id = $1
        RETURNING id, delivery_project_id, group_id, name, repo_full_name, github_repo_id, visibility,
          created_by, status, archived_at, provisioned_project_id, created_at, updated_at;
      `,
      [repositoryId, input.name ?? null],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getAssignmentCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  async archive(repositoryId: string): Promise<RepositoryRecord | null> {
    const result = await this.databaseService.query<RepositoryRow>(
      `
        UPDATE hierarchy.repositories
        SET status = 'archived', archived_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING id, delivery_project_id, group_id, name, repo_full_name, github_repo_id, visibility,
          created_by, status, archived_at, provisioned_project_id, created_at, updated_at;
      `,
      [repositoryId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getAssignmentCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  private toRecord(
    row: RepositoryRow,
    assignmentCount: number,
  ): RepositoryRecord {
    return {
      id: row.id,
      deliveryProjectId: row.delivery_project_id,
      groupId: row.group_id,
      name: row.name,
      repoFullName: row.repo_full_name,
      githubRepoId:
        row.github_repo_id === null ? null : String(row.github_repo_id),
      visibility: row.visibility,
      createdBy: row.created_by,
      status: row.status,
      archivedAt: row.archived_at,
      provisionedProjectId: row.provisioned_project_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      assignmentCount,
      // GitHub always assigns https://github.com/<owner>/<repo> as the repo
      // URL for a repo created through the normal API — deriving it from
      // repo_full_name avoids a second persisted column for a value that's
      // fully determined by an existing one.
      htmlUrl: row.repo_full_name
        ? `https://github.com/${row.repo_full_name}`
        : null,
    };
  }
}
