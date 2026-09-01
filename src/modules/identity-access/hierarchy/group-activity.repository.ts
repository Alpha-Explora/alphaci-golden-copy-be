import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type { QueryActivityDto } from './dto/query-activity.dto';

export interface GroupActivityRow {
  id: string;
  event_code: string;
  message: string;
  actor_user_id: string | null;
  actor_login: string | null;
  metadata_json: Record<string, unknown> | string;
  created_at: string;
}

@Injectable()
export class GroupActivityRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Cursor-paginated activity list. Fetches one extra row beyond `limit` to
   * detect whether a next page exists, then trims back down to `limit` —
   * the caller (GroupActivityService) turns the trimmed-off row's
   * created_at into `nextCursor` (activity-feed contract's { items, nextCursor } shape).
   * Without this, the FE's "Load more" button — gated on nextCursor being
   * non-null — never renders, silently hard-capping the feed at `limit`
   * items with no way to reach older activity.
   */
  async list(
    groupId: string,
    query: QueryActivityDto,
  ): Promise<{ rows: GroupActivityRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const conditions: string[] = [
      'event.workspace_id = $1',
      "event.event_code LIKE 'hierarchy.%'",
    ];
    const values: unknown[] = [groupId];

    if (query.memberId) {
      values.push(query.memberId);
      conditions.push(`event.actor_user_id = $${values.length}`);
    }
    if (query.systemId) {
      values.push(query.systemId);
      conditions.push(`event.metadata_json ->> 'systemId' = $${values.length}`);
    }
    if (query.deliveryProjectId) {
      values.push(query.deliveryProjectId);
      conditions.push(
        `event.metadata_json ->> 'deliveryProjectId' = $${values.length}`,
      );
    }
    if (query.repositoryId) {
      values.push(query.repositoryId);
      conditions.push(
        `event.metadata_json ->> 'repositoryId' = $${values.length}`,
      );
    }
    if (query.activityType) {
      // Maps the FE's coarse activityType filter (activity-feed contract) onto the
      // hierarchy.* event_code namespace. 'github' intentionally matches
      // nothing yet — no hierarchy event_code originates from a GitHub
      // webhook this session (activity-feed contract: "out of scope to *originate* this
      // session"); the filter option exists so the UI doesn't need a
      // breaking change once webhook-sourced rows are added later.
      const eventCodePrefixes: Record<string, string[]> = {
        assignment: ['hierarchy.assignment.'],
        configuration: ['hierarchy.configuration.'],
        membership: ['hierarchy.group.member_', 'hierarchy.group.invitation_'],
        github: [],
      };
      const prefixes = eventCodePrefixes[query.activityType] ?? [];
      if (prefixes.length === 0) {
        // No possible match (activityType='github', or an unrecognized
        // value the DTO's @IsIn already rejected) — force an empty result
        // set rather than silently ignoring the filter.
        conditions.push('FALSE');
      } else {
        const likeConditions = prefixes.map((prefix) => {
          values.push(`${prefix}%`);
          return `event.event_code LIKE $${values.length}`;
        });
        conditions.push(`(${likeConditions.join(' OR ')})`);
      }
    }
    if (query.dateFrom) {
      values.push(query.dateFrom);
      conditions.push(`event.created_at >= $${values.length}`);
    }
    if (query.dateTo) {
      values.push(query.dateTo);
      conditions.push(`event.created_at <= $${values.length}`);
    }
    if (query.cursor) {
      values.push(query.cursor);
      conditions.push(`event.created_at < $${values.length}`);
    }

    // Fetch one extra row to detect a next page without a separate COUNT query.
    values.push(limit + 1);

    const result = await this.databaseService.query<GroupActivityRow>(
      `
        SELECT
          event.id, event.event_code, event.message, event.actor_user_id,
          user_profile.login AS actor_login, event.metadata_json, event.created_at
        FROM audit.audit_events AS event
        LEFT JOIN identity.app_users AS user_profile ON user_profile.id = event.actor_user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY event.created_at DESC
        LIMIT $${values.length};
      `,
      values,
    );

    const hasNextPage = result.rows.length > limit;
    const rows = hasNextPage ? result.rows.slice(0, limit) : result.rows;
    const nextCursor = hasNextPage ? (rows.at(-1)?.created_at ?? null) : null;
    return { rows, nextCursor };
  }
}
