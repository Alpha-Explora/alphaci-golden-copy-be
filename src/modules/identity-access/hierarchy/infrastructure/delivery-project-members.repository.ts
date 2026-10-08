import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import type {
  DeliveryProjectMemberKind,
  DeliveryProjectMemberStatus,
} from '../domain/hierarchy.types';

export interface DeliveryProjectMemberRecord {
  id: string;
  deliveryProjectId: string;
  userId: string;
  memberKind: DeliveryProjectMemberKind;
  status: DeliveryProjectMemberStatus;
  addedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Profile fields, null where a query does not join the user. */
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
}

interface MemberRow {
  id: string;
  delivery_project_id: string;
  user_id: string;
  member_kind: DeliveryProjectMemberKind;
  status: DeliveryProjectMemberStatus;
  added_by: string | null;
  created_at: string;
  updated_at: string;
  login?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
}

const MEMBER_COLUMNS = `
  m.id, m.delivery_project_id, m.user_id, m.member_kind, m.status,
  m.added_by, m.created_at, m.updated_at,
  u.login, u.display_name, u.avatar_url`;

/** Persistence for hierarchy.delivery_project_members. */
@Injectable()
export class DeliveryProjectMembersRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /** Active members of a Project, Developers first, then by login. */
  async listActive(
    deliveryProjectId: string,
  ): Promise<DeliveryProjectMemberRecord[]> {
    const result = await this.databaseService.query<MemberRow>(
      `
        SELECT ${MEMBER_COLUMNS}
        FROM hierarchy.delivery_project_members AS m
        LEFT JOIN identity.app_users AS u ON u.id = m.user_id
        WHERE m.delivery_project_id = $1 AND m.status = 'active'
        ORDER BY CASE m.member_kind WHEN 'developer' THEN 1 ELSE 2 END,
          lower(u.login) ASC;
      `,
      [deliveryProjectId],
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  /** User ids of the active Developers of a Project. */
  async listActiveDeveloperUserIdsWithClient(
    client: Pick<PoolClient, 'query'>,
    deliveryProjectId: string,
  ): Promise<string[]> {
    const result = await client.query<{ user_id: string }>(
      `
        SELECT user_id
        FROM hierarchy.delivery_project_members
        WHERE delivery_project_id = $1
          AND member_kind = 'developer'
          AND status = 'active'
        ORDER BY created_at ASC;
      `,
      [deliveryProjectId],
    );
    return result.rows.map((row) => row.user_id);
  }

  async findActive(
    deliveryProjectId: string,
    userId: string,
  ): Promise<DeliveryProjectMemberRecord | null> {
    const result = await this.databaseService.query<MemberRow>(
      `
        SELECT ${MEMBER_COLUMNS}
        FROM hierarchy.delivery_project_members AS m
        LEFT JOIN identity.app_users AS u ON u.id = m.user_id
        WHERE m.delivery_project_id = $1 AND m.user_id = $2 AND m.status = 'active';
      `,
      [deliveryProjectId, userId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  /** Adds, or re-activates a removed, member. Kind is refreshed on re-add. */
  async upsertActiveWithClient(
    client: Pick<PoolClient, 'query'>,
    input: {
      deliveryProjectId: string;
      userId: string;
      memberKind: DeliveryProjectMemberKind;
      addedBy: string;
    },
  ): Promise<DeliveryProjectMemberRecord> {
    const result = await client.query<MemberRow>(
      `
        WITH upserted AS (
          INSERT INTO hierarchy.delivery_project_members (
            delivery_project_id, user_id, member_kind, status, added_by
          )
          VALUES ($1, $2, $3, 'active', $4)
          ON CONFLICT (delivery_project_id, user_id)
          DO UPDATE SET
            member_kind = EXCLUDED.member_kind,
            status = 'active',
            added_by = EXCLUDED.added_by,
            updated_at = NOW()
          RETURNING *
        )
        SELECT ${MEMBER_COLUMNS}
        FROM upserted AS m
        LEFT JOIN identity.app_users AS u ON u.id = m.user_id;
      `,
      [input.deliveryProjectId, input.userId, input.memberKind, input.addedBy],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Project member upsert did not return a row');
    return this.toRecord(row);
  }

  /** Marks one active member removed; null when they were not active. */
  async markRemovedWithClient(
    client: Pick<PoolClient, 'query'>,
    deliveryProjectId: string,
    userId: string,
  ): Promise<DeliveryProjectMemberRecord | null> {
    const result = await client.query<MemberRow>(
      `
        WITH removed AS (
          UPDATE hierarchy.delivery_project_members
          SET status = 'removed', updated_at = NOW()
          WHERE delivery_project_id = $1 AND user_id = $2 AND status = 'active'
          RETURNING *
        )
        SELECT ${MEMBER_COLUMNS}
        FROM removed AS m
        LEFT JOIN identity.app_users AS u ON u.id = m.user_id;
      `,
      [deliveryProjectId, userId],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  /**
   * Team offboarding: drops the person from every Project of the team in the
   * caller's transaction. Returns how many memberships were closed.
   */
  async markRemovedForUserInGroupWithClient(
    client: Pick<PoolClient, 'query'>,
    groupId: string,
    userId: string,
  ): Promise<number> {
    const result = await client.query(
      `
        UPDATE hierarchy.delivery_project_members AS m
        SET status = 'removed', updated_at = NOW()
        FROM hierarchy.delivery_projects AS dp
        WHERE dp.id = m.delivery_project_id
          AND dp.group_id = $1
          AND m.user_id = $2
          AND m.status = 'active';
      `,
      [groupId, userId],
    );
    return result.rowCount ?? 0;
  }

  private toRecord(row: MemberRow): DeliveryProjectMemberRecord {
    return {
      id: row.id,
      deliveryProjectId: row.delivery_project_id,
      userId: row.user_id,
      memberKind: row.member_kind,
      status: row.status,
      addedBy: row.added_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      login: row.login ?? null,
      name: row.display_name ?? null,
      avatarUrl: row.avatar_url ?? null,
    };
  }
}
