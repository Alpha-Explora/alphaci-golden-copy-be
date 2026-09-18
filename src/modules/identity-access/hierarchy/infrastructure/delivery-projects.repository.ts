import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
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
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async create(input: {
    systemId: string;
    groupId: string;
    name: string;
    description?: string | null;
    managerId: string;
  }): Promise<DeliveryProjectRecord> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        INSERT INTO hierarchy.delivery_projects (system_id, group_id, name, description, manager_id)
        SELECT $1, $2, $3, $4, $5
        FROM hierarchy.systems AS system
        JOIN orgs.workspaces AS workspace ON workspace.id = system.group_id
        WHERE system.id = $1
          AND system.group_id = $2
          AND workspace.kind = 'team'
          AND workspace.tenant_id = $6::uuid
        RETURNING id, system_id, group_id, name, description, manager_id, status, archived_at, created_at, updated_at;
      `,
      [
        input.systemId,
        input.groupId,
        input.name,
        input.description ?? null,
        input.managerId,
        tenantId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Delivery project insert did not return a row');
    // A freshly created Delivery project has zero repositories yet.
    return this.toRecord(row, 0);
  }

  async listBySystem(systemId: string): Promise<DeliveryProjectRecord[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        SELECT hierarchy.delivery_projects.id, hierarchy.delivery_projects.system_id,
          hierarchy.delivery_projects.group_id, hierarchy.delivery_projects.name,
          hierarchy.delivery_projects.description, hierarchy.delivery_projects.manager_id,
          hierarchy.delivery_projects.status, hierarchy.delivery_projects.archived_at,
          hierarchy.delivery_projects.created_at, hierarchy.delivery_projects.updated_at
        FROM hierarchy.delivery_projects
        JOIN orgs.workspaces AS workspace ON workspace.id = hierarchy.delivery_projects.group_id
        WHERE hierarchy.delivery_projects.system_id = $1
          AND workspace.tenant_id = $2::uuid
        ORDER BY hierarchy.delivery_projects.created_at ASC;
      `,
      [systemId, tenantId],
    );
    const counts = await this.getRepositoryCounts(
      result.rows.map((row) => row.id),
      tenantId,
    );
    return result.rows.map((row) =>
      this.toRecord(row, counts.get(row.id) ?? 0),
    );
  }

  async findById(
    deliveryProjectId: string,
  ): Promise<DeliveryProjectRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        SELECT hierarchy.delivery_projects.id, hierarchy.delivery_projects.system_id,
          hierarchy.delivery_projects.group_id, hierarchy.delivery_projects.name,
          hierarchy.delivery_projects.description, hierarchy.delivery_projects.manager_id,
          hierarchy.delivery_projects.status, hierarchy.delivery_projects.archived_at,
          hierarchy.delivery_projects.created_at, hierarchy.delivery_projects.updated_at
        FROM hierarchy.delivery_projects
        JOIN orgs.workspaces AS workspace ON workspace.id = hierarchy.delivery_projects.group_id
        WHERE hierarchy.delivery_projects.id = $1
          AND workspace.tenant_id = $2::uuid;
      `,
      [deliveryProjectId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getRepositoryCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  /** Non-archived repository counts, batched by delivery-project id (current hierarchy summary contract). */
  private async getRepositoryCounts(
    deliveryProjectIds: string[],
    tenantId: string,
  ): Promise<Map<string, number>> {
    if (deliveryProjectIds.length === 0) return new Map();
    const result = await this.databaseService.query<{
      delivery_project_id: string;
      count: number;
    }>(
      `
        SELECT delivery_project.id AS delivery_project_id, count(*)::int AS count
        FROM hierarchy.repositories AS repository
        JOIN hierarchy.delivery_projects AS delivery_project
          ON delivery_project.id = repository.delivery_project_id
        JOIN orgs.workspaces AS workspace ON workspace.id = delivery_project.group_id
        WHERE delivery_project.id = ANY($1::uuid[])
          AND repository.status != 'archived'
          AND workspace.tenant_id = $2::uuid
        GROUP BY delivery_project.id;
      `,
      [deliveryProjectIds, tenantId],
    );
    return new Map(
      result.rows.map((row) => [row.delivery_project_id, row.count]),
    );
  }

  async findGroupIdForDeliveryProject(
    deliveryProjectId: string,
  ): Promise<string | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ group_id: string }>(
      `
        SELECT delivery_project.group_id
        FROM hierarchy.delivery_projects AS delivery_project
        JOIN orgs.workspaces AS workspace ON workspace.id = delivery_project.group_id
        WHERE delivery_project.id = $1 AND workspace.tenant_id = $2::uuid;
      `,
      [deliveryProjectId, tenantId],
    );
    return result.rows[0]?.group_id ?? null;
  }

  async update(
    deliveryProjectId: string,
    input: { name?: string; description?: string | null },
  ): Promise<DeliveryProjectRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        UPDATE hierarchy.delivery_projects
        SET
          name = COALESCE($2, name),
          description = CASE WHEN $3::boolean THEN $4 ELSE description END,
          updated_at = NOW()
        WHERE hierarchy.delivery_projects.id = $1
          AND EXISTS (
            SELECT 1
            FROM orgs.workspaces AS workspace
            WHERE workspace.id = hierarchy.delivery_projects.group_id
              AND workspace.tenant_id = $5::uuid
          )
        RETURNING id, system_id, group_id, name, description, manager_id, status, archived_at, created_at, updated_at;
      `,
      [
        deliveryProjectId,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        tenantId,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getRepositoryCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  async archive(
    deliveryProjectId: string,
  ): Promise<DeliveryProjectRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeliveryProjectRow>(
      `
        UPDATE hierarchy.delivery_projects
        SET status = 'archived', archived_at = NOW(), updated_at = NOW()
        WHERE hierarchy.delivery_projects.id = $1
          AND EXISTS (
            SELECT 1
            FROM orgs.workspaces AS workspace
            WHERE workspace.id = hierarchy.delivery_projects.group_id
              AND workspace.tenant_id = $2::uuid
          )
        RETURNING id, system_id, group_id, name, description, manager_id, status, archived_at, created_at, updated_at;
      `,
      [deliveryProjectId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getRepositoryCounts([row.id], tenantId);
    return this.toRecord(row, counts.get(row.id) ?? 0);
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
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
