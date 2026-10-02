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

interface AuditEventListRowRaw extends AuditEventRow {
  actor_login: string | null;
}

export interface AuditEventListRow extends AuditEventRecord {
  actorLogin: string | null;
  scope: 'repository' | 'project';
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

  /**
   * Events for one repository's Audit tab, newest first. Visibility is NOT
   * decided here: the projects module has already authorised the caller, so
   * this never reads projects.* (schema ownership).
   *
   * Two scopes are returned: events recorded against the repository itself,
   * and Project-level events (project_id IS NULL, metadata.deliveryProjectId =
   * the repository's Project) such as requirement and checklist changes.
   *
   * createdAt is formatted at microsecond precision so the cursor round-trips
   * without skipping rows that share a millisecond.
   */
  async listForProject(query: {
    projectId: string;
    deliveryProjectId: string | null;
    limit: number;
    before: string | null;
  }): Promise<AuditEventListRow[]> {
    const result = await this.databaseService.query<AuditEventListRowRaw>(
      `
        SELECT
          event.id,
          event.workspace_id,
          event.project_id,
          event.actor_user_id,
          user_profile.login AS actor_login,
          event.event_code,
          event.message,
          event.metadata_json,
          to_char(
            event.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS created_at
        FROM audit.audit_events AS event
        LEFT JOIN identity.app_users AS user_profile
          ON user_profile.id = event.actor_user_id
        WHERE (
            event.project_id = $1
            OR (
              $2::text IS NOT NULL
              AND event.project_id IS NULL
              AND event.metadata_json ->> 'deliveryProjectId' = $2
            )
          )
          AND ($3::timestamptz IS NULL OR event.created_at < $3::timestamptz)
        ORDER BY event.created_at DESC, event.id DESC
        LIMIT $4;
      `,
      [query.projectId, query.deliveryProjectId, query.before, query.limit],
    );

    return result.rows.map((row) => ({
      ...this.toRecord(row),
      actorLogin: row.actor_login,
      scope: row.project_id === null ? 'project' : 'repository',
    }));
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
