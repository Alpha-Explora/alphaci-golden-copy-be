import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
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
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async create(input: {
    deliveryProjectId: string;
    groupId: string;
    name: string;
    repoFullName: string;
    createdBy: string;
    provisionedProjectId?: string | null;
  }): Promise<RepositoryRecord> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<RepositoryRow>(
      `
        INSERT INTO hierarchy.repositories (
          delivery_project_id, group_id, name, repo_full_name, created_by, status, provisioned_project_id
        )
        SELECT $1, $2, $3, $4, $5, 'active', $6
        FROM hierarchy.delivery_projects AS delivery_project
        JOIN orgs.workspaces AS workspace ON workspace.id = delivery_project.group_id
        LEFT JOIN projects.provisioned_projects AS provisioned_project
          ON provisioned_project.id = $6::uuid
         AND provisioned_project.tenant_id = $7::uuid
        WHERE delivery_project.id = $1
          AND delivery_project.group_id = $2
          AND workspace.tenant_id = $7::uuid
          AND ($6::uuid IS NULL OR provisioned_project.id IS NOT NULL)
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
        tenantId,
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
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<RepositoryRow>(
      `
        SELECT repository.id, repository.delivery_project_id, repository.group_id,
          repository.name, repository.repo_full_name, repository.github_repo_id,
          repository.visibility, repository.created_by, repository.status,
          repository.archived_at, repository.provisioned_project_id,
          repository.created_at, repository.updated_at
        FROM hierarchy.repositories AS repository
        JOIN hierarchy.delivery_projects AS delivery_project
          ON delivery_project.id = repository.delivery_project_id
         AND delivery_project.group_id = repository.group_id
        JOIN orgs.workspaces AS workspace ON workspace.id = repository.group_id
        WHERE repository.delivery_project_id = $1
          AND workspace.tenant_id = $2::uuid
        ORDER BY repository.created_at ASC;
      `,
      [deliveryProjectId, tenantId],
    );
    const counts = await this.getAssignmentCounts(
      result.rows.map((row) => row.id),
      tenantId,
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
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<RepositoryRow>(
      `
        SELECT r.id, r.delivery_project_id, r.group_id, r.name, r.repo_full_name, r.github_repo_id,
          r.visibility, r.created_by, r.status, r.archived_at, r.provisioned_project_id, r.created_at, r.updated_at
        FROM hierarchy.repositories AS r
        JOIN hierarchy.repository_assignments AS a
          ON a.repository_id = r.id
        JOIN hierarchy.delivery_projects AS delivery_project
          ON delivery_project.id = r.delivery_project_id
         AND delivery_project.group_id = r.group_id
        JOIN orgs.workspaces AS workspace ON workspace.id = r.group_id
        WHERE r.delivery_project_id = $1
          AND a.user_id = $2
          AND a.status = 'active'
          AND workspace.tenant_id = $3::uuid
        ORDER BY r.created_at ASC;
      `,
      [deliveryProjectId, userId, tenantId],
    );
    const counts = await this.getAssignmentCounts(
      result.rows.map((row) => row.id),
      tenantId,
    );
    return result.rows.map((row) =>
      this.toRecord(row, counts.get(row.id) ?? 0),
    );
  }

  async findById(repositoryId: string): Promise<RepositoryRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<RepositoryRow>(
      `
        SELECT repository.id, repository.delivery_project_id, repository.group_id,
          repository.name, repository.repo_full_name, repository.github_repo_id,
          repository.visibility, repository.created_by, repository.status,
          repository.archived_at, repository.provisioned_project_id,
          repository.created_at, repository.updated_at
        FROM hierarchy.repositories AS repository
        JOIN hierarchy.delivery_projects AS delivery_project
          ON delivery_project.id = repository.delivery_project_id
         AND delivery_project.group_id = repository.group_id
        JOIN orgs.workspaces AS workspace ON workspace.id = repository.group_id
        WHERE repository.id = $1 AND workspace.tenant_id = $2::uuid;
      `,
      [repositoryId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getAssignmentCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  /**
   * Worker-only lookup for a durable GitHub sync job. Outbox jobs have no
   * request tenant context; the assignment id is the durable aggregate key.
   * Request paths must use findById(), which is tenant-scoped and fail-closed.
   */
  async findByIdForWorker(
    repositoryId: string,
  ): Promise<RepositoryRecord | null> {
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
    const counts = await this.getAssignmentCountsForWorker([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  /** Active-assignment counts, batched by repository id (current hierarchy summary contract). */
  private async getAssignmentCounts(
    repositoryIds: string[],
    tenantId: string,
  ): Promise<Map<string, number>> {
    if (repositoryIds.length === 0) return new Map();
    const result = await this.databaseService.query<{
      repository_id: string;
      count: number;
    }>(
      `
        SELECT repository.id AS repository_id, count(*)::int AS count
        FROM hierarchy.repository_assignments AS assignment
        JOIN hierarchy.repositories AS repository ON repository.id = assignment.repository_id
        JOIN orgs.workspaces AS workspace ON workspace.id = repository.group_id
        WHERE repository.id = ANY($1::uuid[])
          AND assignment.status = 'active'
          AND workspace.tenant_id = $2::uuid
        GROUP BY repository.id;
      `,
      [repositoryIds, tenantId],
    );
    return new Map(result.rows.map((row) => [row.repository_id, row.count]));
  }

  async findGroupIdForRepository(repositoryId: string): Promise<string | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ group_id: string }>(
      `
        SELECT repository.group_id
        FROM hierarchy.repositories AS repository
        JOIN hierarchy.delivery_projects AS delivery_project
          ON delivery_project.id = repository.delivery_project_id
         AND delivery_project.group_id = repository.group_id
        JOIN orgs.workspaces AS workspace ON workspace.id = repository.group_id
        WHERE repository.id = $1 AND workspace.tenant_id = $2::uuid;
      `,
      [repositoryId, tenantId],
    );
    return result.rows[0]?.group_id ?? null;
  }

  async update(
    repositoryId: string,
    input: { name?: string },
  ): Promise<RepositoryRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<RepositoryRow>(
      `
        UPDATE hierarchy.repositories
        SET name = COALESCE($2, name), updated_at = NOW()
        WHERE hierarchy.repositories.id = $1
          AND EXISTS (
            SELECT 1
            FROM orgs.workspaces AS workspace
            JOIN hierarchy.delivery_projects AS delivery_project
              ON delivery_project.group_id = workspace.id
            WHERE workspace.id = hierarchy.repositories.group_id
              AND delivery_project.id = hierarchy.repositories.delivery_project_id
              AND workspace.tenant_id = $3::uuid
          )
        RETURNING id, delivery_project_id, group_id, name, repo_full_name, github_repo_id, visibility,
          created_by, status, archived_at, provisioned_project_id, created_at, updated_at;
      `,
      [repositoryId, input.name ?? null, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getAssignmentCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  async archive(repositoryId: string): Promise<RepositoryRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<RepositoryRow>(
      `
        UPDATE hierarchy.repositories
        SET status = 'archived', archived_at = NOW(), updated_at = NOW()
        WHERE hierarchy.repositories.id = $1
          AND EXISTS (
            SELECT 1
            FROM orgs.workspaces AS workspace
            JOIN hierarchy.delivery_projects AS delivery_project
              ON delivery_project.group_id = workspace.id
            WHERE workspace.id = hierarchy.repositories.group_id
              AND delivery_project.id = hierarchy.repositories.delivery_project_id
              AND workspace.tenant_id = $2::uuid
          )
        RETURNING id, delivery_project_id, group_id, name, repo_full_name, github_repo_id, visibility,
          created_by, status, archived_at, provisioned_project_id, created_at, updated_at;
      `,
      [repositoryId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getAssignmentCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  private async getAssignmentCountsForWorker(
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

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
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
