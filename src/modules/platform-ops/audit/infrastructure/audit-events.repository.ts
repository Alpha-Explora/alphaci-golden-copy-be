import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type {
  ExternalAuditBatch,
  GithubActivitySyncState,
  ProjectEventSince,
} from '#kernel/ports/audit.port';

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
  external_id: string | null;
}

export interface AuditEventListRow extends AuditEventRecord {
  actorLogin: string | null;
  scope: 'repository' | 'project' | 'github';
}

interface GithubSyncRow {
  etag: string | null;
  last_synced_at: string;
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
          event.external_id,
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
      scope: row.external_id?.startsWith('github:')
        ? 'github'
        : row.project_id === null
          ? 'project'
          : 'repository',
    }));
  }

  /**
   * Newest created_at per project of `eventCode` events at or after that
   * project's own `since`, in one statement (unnest pairs the project ids with
   * their thresholds). Uses idx_audit_events_project_created. Projects with no
   * matching event are absent.
   */
  async findLatestEventTimes(
    eventCode: string,
    lookups: readonly ProjectEventSince[],
  ): Promise<Map<string, string>> {
    const result = await this.databaseService.query<{
      project_id: string;
      last_at: string;
    }>(
      `
        SELECT
          lookup.project_id,
          to_char(
            MAX(event.created_at) AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS last_at
        FROM unnest($2::uuid[], $3::timestamptz[]) AS lookup(project_id, since)
        JOIN audit.audit_events AS event
          ON event.project_id = lookup.project_id
         AND event.event_code = $1
         AND event.created_at >= lookup.since
        GROUP BY lookup.project_id;
      `,
      [
        eventCode,
        lookups.map((lookup) => lookup.projectId),
        lookups.map((lookup) => lookup.since),
      ],
    );
    return new Map(result.rows.map((row) => [row.project_id, row.last_at]));
  }

  /** The subset of `externalIds` already stored. */
  async findRecordedExternalIds(externalIds: string[]): Promise<Set<string>> {
    if (externalIds.length === 0) {
      return new Set();
    }
    const result = await this.databaseService.query<{ external_id: string }>(
      `
        SELECT external_id
        FROM audit.audit_events
        WHERE external_id = ANY($1::text[]);
      `,
      [externalIds],
    );
    return new Set(result.rows.map((row) => row.external_id));
  }

  /**
   * Inserts events that happened outside ALPHACI (GitHub activity), one
   * statement for the whole batch. `external_id` is unique, so re-syncing the
   * same GitHub events is a no-op (ON CONFLICT DO NOTHING). The actor login is
   * resolved to an ALPHACI user in the same statement; no match leaves
   * actor_user_id NULL. created_at is the event's own time, not now().
   */
  async insertExternalBatch(batch: ExternalAuditBatch): Promise<number> {
    if (batch.events.length === 0) {
      return 0;
    }
    const result = await this.databaseService.query<{ id: string }>(
      `
        INSERT INTO audit.audit_events (
          workspace_id,
          project_id,
          actor_user_id,
          event_code,
          message,
          metadata_json,
          created_at,
          external_id
        )
        SELECT
          $1::uuid,
          $2::uuid,
          (
            SELECT profile.id
            FROM identity.app_users AS profile
            WHERE e.actor_login IS NOT NULL
              AND lower(profile.login) = lower(e.actor_login)
            LIMIT 1
          ),
          e.event_code,
          e.message,
          e.metadata::jsonb,
          e.created_at,
          e.external_id
        FROM unnest(
          $3::text[],
          $4::text[],
          $5::text[],
          $6::text[],
          $7::text[],
          $8::timestamptz[]
        ) AS e(
          external_id,
          event_code,
          message,
          actor_login,
          metadata,
          created_at
        )
        ON CONFLICT (external_id) DO NOTHING
        RETURNING id;
      `,
      [
        batch.workspaceId,
        batch.projectId,
        batch.events.map((event) => event.externalId),
        batch.events.map((event) => event.eventCode),
        batch.events.map((event) => event.message),
        batch.events.map((event) => event.actorLogin),
        batch.events.map((event) => JSON.stringify(event.metadata)),
        batch.events.map((event) => event.occurredAt),
      ],
    );
    return result.rows.length;
  }

  async findGithubSyncState(
    repoFullName: string,
  ): Promise<GithubActivitySyncState | null> {
    const result = await this.databaseService.query<GithubSyncRow>(
      `
        SELECT
          etag,
          to_char(
            last_synced_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS last_synced_at
        FROM audit.github_event_syncs
        WHERE repo_full_name = lower($1);
      `,
      [repoFullName],
    );
    const row = result.rows[0];
    return row ? { etag: row.etag, syncedAt: row.last_synced_at } : null;
  }

  async saveGithubSyncState(
    repoFullName: string,
    state: GithubActivitySyncState,
  ): Promise<void> {
    await this.databaseService.query(
      `
        INSERT INTO audit.github_event_syncs (
          repo_full_name,
          etag,
          last_synced_at
        )
        VALUES (lower($1), $2, $3::timestamptz)
        ON CONFLICT (repo_full_name) DO UPDATE SET
          etag = EXCLUDED.etag,
          last_synced_at = EXCLUDED.last_synced_at;
      `,
      [repoFullName, state.etag, state.syncedAt],
    );
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
