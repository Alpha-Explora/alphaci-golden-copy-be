import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type { LifecycleStatus } from '../domain/hierarchy.types';

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
