import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type { LifecycleStatus } from '../domain/hierarchy.types';

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
  /** Active delivery-project count — at-a-glance chip (current hierarchy summary contract). */
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
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async create(input: {
    groupId: string;
    name: string;
    description?: string | null;
    ownerId: string;
  }): Promise<SystemRecord> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<SystemRow>(
      `
        INSERT INTO hierarchy.systems (group_id, name, description, owner_id)
        SELECT $1, $2, $3, $4
        FROM orgs.workspaces AS workspace
        WHERE workspace.id = $1
          AND workspace.kind = 'team'
          AND workspace.tenant_id = $5::uuid
        RETURNING id, group_id, name, description, owner_id, status, archived_at, created_at, updated_at;
      `,
      [
        input.groupId,
        input.name,
        input.description ?? null,
        input.ownerId,
        tenantId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('System insert did not return a row');
    // A freshly created System has zero delivery projects yet.
    return this.toRecord(row, 0);
  }

  async listByGroup(groupId: string): Promise<SystemRecord[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<SystemRow>(
      `
        SELECT hierarchy.systems.id, hierarchy.systems.group_id, hierarchy.systems.name,
          hierarchy.systems.description, hierarchy.systems.owner_id, hierarchy.systems.status,
          hierarchy.systems.archived_at, hierarchy.systems.created_at, hierarchy.systems.updated_at
        FROM hierarchy.systems
        JOIN orgs.workspaces AS workspace ON workspace.id = hierarchy.systems.group_id
        WHERE hierarchy.systems.group_id = $1 AND workspace.tenant_id = $2::uuid
        ORDER BY hierarchy.systems.created_at ASC;
      `,
      [groupId, tenantId],
    );
    const counts = await this.getDeliveryProjectCounts(
      result.rows.map((row) => row.id),
      tenantId,
    );
    return result.rows.map((row) =>
      this.toRecord(row, counts.get(row.id) ?? 0),
    );
  }

  async findById(systemId: string): Promise<SystemRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<SystemRow>(
      `
        SELECT hierarchy.systems.id, hierarchy.systems.group_id, hierarchy.systems.name,
          hierarchy.systems.description, hierarchy.systems.owner_id, hierarchy.systems.status,
          hierarchy.systems.archived_at, hierarchy.systems.created_at, hierarchy.systems.updated_at
        FROM hierarchy.systems
        JOIN orgs.workspaces AS workspace ON workspace.id = hierarchy.systems.group_id
        WHERE hierarchy.systems.id = $1 AND workspace.tenant_id = $2::uuid;
      `,
      [systemId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getDeliveryProjectCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  /** Active delivery-project counts, batched by system id (current hierarchy summary contract). */
  private async getDeliveryProjectCounts(
    systemIds: string[],
    tenantId: string,
  ): Promise<Map<string, number>> {
    if (systemIds.length === 0) return new Map();
    const result = await this.databaseService.query<{
      system_id: string;
      count: number;
    }>(
      `
        SELECT delivery_project.system_id, count(*)::int AS count
        FROM hierarchy.delivery_projects AS delivery_project
        JOIN hierarchy.systems AS system ON system.id = delivery_project.system_id
        JOIN orgs.workspaces AS workspace ON workspace.id = system.group_id
        WHERE delivery_project.system_id = ANY($1::uuid[])
          AND delivery_project.status = 'active'
          AND workspace.tenant_id = $2::uuid
        GROUP BY delivery_project.system_id;
      `,
      [systemIds, tenantId],
    );
    return new Map(result.rows.map((row) => [row.system_id, row.count]));
  }

  /** Resolves owning Group id without loading the full record — the hot authz path. */
  async findGroupIdForSystem(systemId: string): Promise<string | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ group_id: string }>(
      `
        SELECT system.group_id
        FROM hierarchy.systems AS system
        JOIN orgs.workspaces AS workspace ON workspace.id = system.group_id
        WHERE system.id = $1 AND workspace.tenant_id = $2::uuid;
      `,
      [systemId, tenantId],
    );
    return result.rows[0]?.group_id ?? null;
  }

  async update(
    systemId: string,
    input: { name?: string; description?: string | null },
  ): Promise<SystemRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<SystemRow>(
      `
        UPDATE hierarchy.systems
        SET
          name = COALESCE($2, name),
          description = CASE WHEN $3::boolean THEN $4 ELSE description END,
          updated_at = NOW()
        WHERE hierarchy.systems.id = $1
          AND EXISTS (
            SELECT 1
            FROM orgs.workspaces AS workspace
            WHERE workspace.id = hierarchy.systems.group_id
              AND workspace.tenant_id = $5::uuid
          )
        RETURNING id, group_id, name, description, owner_id, status, archived_at, created_at, updated_at;
      `,
      [
        systemId,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        tenantId,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getDeliveryProjectCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  async archive(systemId: string): Promise<SystemRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<SystemRow>(
      `
        UPDATE hierarchy.systems
        SET status = 'archived', archived_at = NOW(), updated_at = NOW()
        WHERE hierarchy.systems.id = $1
          AND EXISTS (
            SELECT 1
            FROM orgs.workspaces AS workspace
            WHERE workspace.id = hierarchy.systems.group_id
              AND workspace.tenant_id = $2::uuid
          )
        RETURNING id, group_id, name, description, owner_id, status, archived_at, created_at, updated_at;
      `,
      [systemId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getDeliveryProjectCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
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
