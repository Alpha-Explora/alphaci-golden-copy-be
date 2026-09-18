import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';

export interface AuditEventRecord {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  actorUserId: string | null;
  eventCode: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateAuditEventInput {
  workspaceId?: string | null;
  projectId?: string | null;
  actorUserId?: string | null;
  eventCode: string;
  message: string;
  metadata?: Record<string, unknown>;
}

interface AuditEventRow {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  actor_user_id: string | null;
  event_code: string;
  message: string;
  metadata_json: Record<string, unknown> | string;
  created_at: string;
}

@Injectable()
export class AuditEventsRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  /**
   * Explicit deployment-global append path for worker/outbox events. Worker
   * reconciliation has no request tenant context; user-facing project reads
   * are tenant-scoped in listByProjectForUser below.
   */
  async createDeploymentGlobal(
    input: CreateAuditEventInput,
  ): Promise<AuditEventRecord> {
    const result = await this.databaseService.query<AuditEventRow>(
      `
        INSERT INTO audit.audit_events (
          workspace_id,
          project_id,
          actor_user_id,
          event_code,
          message,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING *;
      `,
      [
        input.workspaceId ?? null,
        input.projectId ?? null,
        input.actorUserId ?? null,
        input.eventCode,
        input.message,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Audit event insert did not return a row');
    }

    return this.toRecord(row);
  }

  /**
   * Compatibility name for existing callers. New worker code should use the
   * explicit createDeploymentGlobal name so its scope is visible at the call
   * site.
   */
  async create(input: CreateAuditEventInput): Promise<AuditEventRecord> {
    return this.createDeploymentGlobal(input);
  }

  async listByProjectForUser(
    projectId: string,
    userId: string,
    limit = 50,
  ): Promise<AuditEventRecord[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<AuditEventRow>(
      `
        SELECT event.*
        FROM audit.audit_events AS event
        JOIN projects.provisioned_projects AS project
          ON project.id = event.project_id
        WHERE event.project_id = $1
          AND project.user_id = $2
          AND project.tenant_id = $3::uuid
        ORDER BY event.created_at DESC
        LIMIT $4;
      `,
      [projectId, userId, tenantId, limit],
    );

    return result.rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: AuditEventRow): AuditEventRecord {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      actorUserId: row.actor_user_id,
      eventCode: row.event_code,
      message: row.message,
      metadata:
        typeof row.metadata_json === 'string'
          ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
          : row.metadata_json,
      createdAt: row.created_at,
    };
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
  }
}
