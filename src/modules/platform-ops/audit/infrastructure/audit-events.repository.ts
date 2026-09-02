import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';

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
  constructor(private readonly databaseService: DatabaseService) {}

  async create(input: CreateAuditEventInput): Promise<AuditEventRecord> {
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

  async listByProjectForUser(
    projectId: string,
    userId: string,
    limit = 50,
  ): Promise<AuditEventRecord[]> {
    const result = await this.databaseService.query<AuditEventRow>(
      `
        SELECT event.*
        FROM audit.audit_events AS event
        JOIN projects.provisioned_projects AS project
          ON project.id = event.project_id
        WHERE event.project_id = $1
          AND project.user_id = $2
        ORDER BY event.created_at DESC
        LIMIT $3;
      `,
      [projectId, userId, limit],
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
}
