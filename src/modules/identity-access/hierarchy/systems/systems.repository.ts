import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type { LifecycleStatus } from '../hierarchy.types';

export interface SystemRecord {
  id: string;
  groupId: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  status: LifecycleStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Active delivery-project count — at-a-glance chip (UI_LAYOUTS.md §6.5). */
  deliveryProjectCount: number;
}

interface SystemRow {
  id: string;
  group_id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  status: LifecycleStatus;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class SystemsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async create(input: {
    groupId: string;
    name: string;
    description?: string | null;
    ownerId: string;
  }): Promise<SystemRecord> {
    const result = await this.databaseService.query<SystemRow>(
      `
        INSERT INTO hierarchy.systems (group_id, name, description, owner_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id, group_id, name, description, owner_id, status, archived_at, created_at, updated_at;
      `,
      [input.groupId, input.name, input.description ?? null, input.ownerId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('System insert did not return a row');
    // A freshly created System has zero delivery projects yet.
    return this.toRecord(row, 0);
  }

  async listByGroup(groupId: string): Promise<SystemRecord[]> {
    const result = await this.databaseService.query<SystemRow>(
      `
        SELECT id, group_id, name, description, owner_id, status, archived_at, created_at, updated_at
        FROM hierarchy.systems
        WHERE group_id = $1
        ORDER BY created_at ASC;
      `,
      [groupId],
    );
    const counts = await this.getDeliveryProjectCounts(
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) =>
      this.toRecord(row, counts.get(row.id) ?? 0),
    );
  }

  async findById(systemId: string): Promise<SystemRecord | null> {
    const result = await this.databaseService.query<SystemRow>(
      `
        SELECT id, group_id, name, description, owner_id, status, archived_at, created_at, updated_at
        FROM hierarchy.systems
        WHERE id = $1;
      `,
      [systemId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getDeliveryProjectCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  /** Active delivery-project counts, batched by system id (UI_LAYOUTS.md §6.5). */
  private async getDeliveryProjectCounts(
    systemIds: string[],
  ): Promise<Map<string, number>> {
    if (systemIds.length === 0) return new Map();
    const result = await this.databaseService.query<{
      system_id: string;
      count: number;
    }>(
      `
        SELECT system_id, count(*)::int AS count
        FROM hierarchy.delivery_projects
        WHERE system_id = ANY($1::uuid[]) AND status = 'active'
        GROUP BY system_id;
      `,
      [systemIds],
    );
    return new Map(result.rows.map((row) => [row.system_id, row.count]));
  }

  /** Resolves owning Group id without loading the full record — the hot authz path. */
  async findGroupIdForSystem(systemId: string): Promise<string | null> {
    const result = await this.databaseService.query<{ group_id: string }>(
      `SELECT group_id FROM hierarchy.systems WHERE id = $1;`,
      [systemId],
    );
    return result.rows[0]?.group_id ?? null;
  }

  async update(
    systemId: string,
    input: { name?: string; description?: string | null },
  ): Promise<SystemRecord | null> {
    const result = await this.databaseService.query<SystemRow>(
      `
        UPDATE hierarchy.systems
        SET
          name = COALESCE($2, name),
          description = CASE WHEN $3::boolean THEN $4 ELSE description END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, group_id, name, description, owner_id, status, archived_at, created_at, updated_at;
      `,
      [
        systemId,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getDeliveryProjectCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  async archive(systemId: string): Promise<SystemRecord | null> {
    const result = await this.databaseService.query<SystemRow>(
      `
        UPDATE hierarchy.systems
        SET status = 'archived', archived_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING id, group_id, name, description, owner_id, status, archived_at, created_at, updated_at;
      `,
      [systemId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getDeliveryProjectCounts([row.id]);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  private toRecord(row: SystemRow, deliveryProjectCount: number): SystemRecord {
    return {
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      status: row.status,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deliveryProjectCount,
    };
  }
}
