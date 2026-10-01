import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type { LifecycleStatus } from '../domain/hierarchy.types';
import {
  ACTIVE_PROJECT_NAME_EXISTS_SQL,
  projectNameLockKey,
} from '../domain/project-name';

export interface DeliveryProjectRecord {
  id: string;
  systemId: string;
  groupId: string;
  name: string;
  description: string | null;
  managerId: string | null;
  status: LifecycleStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Non-archived repository count — at-a-glance chip (current hierarchy summary contract). */
  repositoryCount: number;
}

interface DeliveryProjectRow {
  id: string;
  system_id: string;
  group_id: string;
  name: string;
  description: string | null;
  manager_id: string | null;
  status: LifecycleStatus;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class DeliveryProjectsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /** True when the team already has a non-archived Project with this name. */
  async isNameTaken(groupId: string, name: string): Promise<boolean> {
    const result = await this.databaseService.query(
      ACTIVE_PROJECT_NAME_EXISTS_SQL,
      [groupId, name],
    );
    return result.rows.length > 0;
  }

  /**
   * Runs `fn` while holding a session advisory lock on (team, name), so
   * concurrent creators of the same Project name serialize and each re-checks
   * inside the lock. Same lock key as the repo-linking chain transaction.
   */
  async withNameLock<T>(
    groupId: string,
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.databaseService.withClient(async (client) => {
      const key = projectNameLockKey(groupId, name);
      await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0));`, [
        key,
      ]);
      try {
        return await fn();
      } finally {
        await client
          .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0));`, [key])
          .catch(() => undefined);
      }
    });
  }

  async create(input: {
    systemId: string;
    groupId: string;
    name: string;
    description?: string | null;
    managerId: string;
  }): Promise<DeliveryProjectRecord> {
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        INSERT INTO hierarchy.delivery_projects (system_id, group_id, name, description, manager_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, system_id, group_id, name, description, manager_id, status, archived_at, created_at, updated_at;
      `,
      [
        input.systemId,
        input.groupId,
        input.name,
        input.description ?? null,
        input.managerId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Delivery project insert did not return a row');
    // A freshly created Delivery project has zero repositories yet.
    return this.toRecord(row, 0);
  }

  async listBySystem(systemId: string): Promise<DeliveryProjectRecord[]> {
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        SELECT id, system_id, group_id, name, description, manager_id, status, archived_at, created_at, updated_at
        FROM hierarchy.delivery_projects
        WHERE system_id = $1
        ORDER BY created_at ASC;
      `,
      [systemId],
    );
    const counts = await this.getRepositoryCounts(
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) =>
      this.toRecord(row, counts.get(row.id) ?? 0),
    );
  }

  async findById(
    deliveryProjectId: string,
  ): Promise<DeliveryProjectRecord | null> {
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        SELECT id, system_id, group_id, name, description, manager_id, status, archived_at, created_at, updated_at
        FROM hierarchy.delivery_projects
        WHERE id = $1;
      `,
      [deliveryProjectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getRepositoryCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  /** Non-archived repository counts, batched by delivery-project id (current hierarchy summary contract). */
  private async getRepositoryCounts(
    deliveryProjectIds: string[],
  ): Promise<Map<string, number>> {
    if (deliveryProjectIds.length === 0) return new Map();
    const result = await this.databaseService.query<{
      delivery_project_id: string;
      count: number;
    }>(
      `
        SELECT delivery_project_id, count(*)::int AS count
        FROM hierarchy.repositories
        WHERE delivery_project_id = ANY($1::uuid[]) AND status != 'archived'
        GROUP BY delivery_project_id;
      `,
      [deliveryProjectIds],
    );
    return new Map(
      result.rows.map((row) => [row.delivery_project_id, row.count]),
    );
  }

  async findGroupIdForDeliveryProject(
    deliveryProjectId: string,
  ): Promise<string | null> {
    const result = await this.databaseService.query<{ group_id: string }>(
      `SELECT group_id FROM hierarchy.delivery_projects WHERE id = $1;`,
      [deliveryProjectId],
    );
    return result.rows[0]?.group_id ?? null;
  }

  async update(
    deliveryProjectId: string,
    input: { name?: string; description?: string | null },
  ): Promise<DeliveryProjectRecord | null> {
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        UPDATE hierarchy.delivery_projects
        SET
          name = COALESCE($2, name),
          description = CASE WHEN $3::boolean THEN $4 ELSE description END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, system_id, group_id, name, description, manager_id, status, archived_at, created_at, updated_at;
      `,
      [
        deliveryProjectId,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getRepositoryCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  async archive(
    deliveryProjectId: string,
  ): Promise<DeliveryProjectRecord | null> {
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        UPDATE hierarchy.delivery_projects
        SET status = 'archived', archived_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING id, system_id, group_id, name, description, manager_id, status, archived_at, created_at, updated_at;
      `,
      [deliveryProjectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getRepositoryCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  /**
   * ALL delivery projects under a system, any status — used to decide
   * whether a system is now empty (mirrors the ghost-cleanup migration's own
   * NOT EXISTS check: archived delivery projects still count as "not
   * empty", only their absence does).
   */
  async countBySystem(systemId: string): Promise<number> {
    const result = await this.databaseService.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM hierarchy.delivery_projects WHERE system_id = $1;`,
      [systemId],
    );
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Hard-deletes one delivery project row. Called only after every one of
   * its repository rows has already been explicitly deleted (each one may
   * first need its linked AlphaCI project disconnected) — hierarchy.
   * repositories.delivery_project_id is ON DELETE CASCADE, but relying on
   * that here would skip the per-repository disconnectProject step this
   * flow requires. Returns false if the row was already gone.
   */
  async deleteById(deliveryProjectId: string): Promise<boolean> {
    const result = await this.databaseService.query(
      `DELETE FROM hierarchy.delivery_projects WHERE id = $1;`,
      [deliveryProjectId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private toRecord(
    row: DeliveryProjectRow,
    repositoryCount: number,
  ): DeliveryProjectRecord {
    return {
      id: row.id,
      systemId: row.system_id,
      groupId: row.group_id,
      name: row.name,
      description: row.description,
      managerId: row.manager_id,
      status: row.status,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      repositoryCount,
    };
  }
}
