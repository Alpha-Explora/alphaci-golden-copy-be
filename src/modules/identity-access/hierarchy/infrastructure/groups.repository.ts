import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContext,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import {
  InvalidTenantContextError,
  TenantContextRequiredError,
} from '#kernel/tenancy/tenant-context.js';
import type {
  GrantableRole,
  GroupRole,
  LifecycleStatus,
  MemberStatus,
} from '../domain/hierarchy.types';

export interface GroupRecord {
  id: string;
  name: string;
  description: string | null;
  businessUnit: string | null;
  status: LifecycleStatus;
  archivedAt: string | null;
  archivedBy: string | null;
  createdAt: string;
  role?: GroupRole;
  /** Active member / active-system counts — at-a-glance chips (current hierarchy summary contract). */
  memberCount: number;
  systemCount: number;
}

export interface GroupMemberRecord {
  id: string;
  /**
   * NOTE: named groupId (not workspaceId) on purpose — the API path segment
   * is /groups and every hierarchy response uses the product term
   * (the current hierarchy contract). Only the
   * underlying orgs.workspaces/workspace_members SQL keeps the internal name.
   */
  groupId: string;
  userId: string;
  role: GroupRole;
  memberStatus: MemberStatus;
  login: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  invitedBy: string | null;
  invitedAt: string | null;
  removedAt: string | null;
  removedBy: string | null;
  removalReason: string | null;
  createdAt: string;
}

export interface InternalUserDirectoryEntry {
  /** Null when the GitHub org member has never signed into AlphaCI. */
  id: string | null;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** True only when this org member has an AlphaCI account and can be added. */
  hasAccount: boolean;
}

export interface DirectoryAccountRecord {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** Already an active member of the Group being added to. */
  isActiveMember: boolean;
}

export interface ActiveMembership {
  workspaceId: string;
  userId: string;
  role: GroupRole;
  memberId: string;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  business_unit: string | null;
  status: LifecycleStatus;
  archived_at: string | null;
  archived_by: string | null;
  created_at: string;
  role?: GroupRole;
}

interface MemberRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: GroupRole;
  member_status: MemberStatus;
  login: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  invited_by: string | null;
  invited_at: string | null;
  removed_at: string | null;
  removed_by: string | null;
  removal_reason: string | null;
  created_at: string;
}

@Injectable()
export class GroupsRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async createGroup(input: {
    name: string;
    description?: string | null;
    businessUnit?: string | null;
    creatorUserId: string;
  }): Promise<GroupRecord> {
    const context = this.requireTenantContext();
    this.assertCurrentUser(input.creatorUserId, context, 'Group creator');
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await client.query<GroupRow>(
          `
            INSERT INTO orgs.workspaces (owner_user_id, name, kind, description, business_unit, status, tenant_id)
            SELECT $1, $2, 'team', $3, $4, 'active', $5::uuid
            FROM tenancy.tenant_memberships AS tenant_membership
            WHERE tenant_membership.tenant_id = $5::uuid
              AND tenant_membership.user_id = $1
              AND tenant_membership.status = 'active'
            RETURNING id, name, description, business_unit, status, archived_at, archived_by, created_at;
          `,
          [
            input.creatorUserId,
            input.name,
            input.description ?? null,
            input.businessUnit ?? null,
            context.tenantId,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error('Group insert did not return a row');
        }
        await client.query(
          `
            INSERT INTO orgs.workspace_members (workspace_id, user_id, role, member_status)
            SELECT $1, $2, 'admin', 'active'
            WHERE EXISTS (
              SELECT 1 FROM orgs.workspaces AS workspace
              WHERE workspace.id = $1 AND workspace.tenant_id = $3::uuid
            );
          `,
          [row.id, input.creatorUserId, context.tenantId],
        );
        await client.query('COMMIT');
        return this.toGroup(row, { memberCount: 1, systemCount: 0 });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async transferLeadGuarded(
    groupId: string,
    newLeadUserId: string,
  ): Promise<{ previousRole: GroupRole } | null> {
    const tenantId = this.requireTenantId();
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `
            SELECT member.id
            FROM orgs.workspace_members AS member
            JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
            WHERE member.workspace_id = $1
              AND member.member_status = 'active'
              AND workspace.tenant_id = $2::uuid
            FOR UPDATE OF member;
          `,
          [groupId, tenantId],
        );
        const targetResult = await client.query<{ role: GroupRole }>(
          `
            SELECT role
            FROM orgs.workspace_members AS member
            JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
            WHERE member.workspace_id = $1
              AND member.user_id = $2
              AND member.member_status = 'active'
              AND workspace.tenant_id = $3::uuid;
          `,
          [groupId, newLeadUserId, tenantId],
        );
        const target = targetResult.rows[0];
        if (!target) {
          await client.query('ROLLBACK');
          return null;
        }
        await client.query(
          `
            UPDATE orgs.workspace_members
            SET role = CASE WHEN user_id = $2 THEN 'admin' ELSE 'delegated_lead' END
            WHERE workspace_id = $1
              AND member_status = 'active'
              AND (role = 'admin' OR user_id = $2)
              AND EXISTS (
                SELECT 1 FROM orgs.workspaces AS workspace
                WHERE workspace.id = workspace_members.workspace_id
                  AND workspace.tenant_id = $3::uuid
              );
          `,
          [groupId, newLeadUserId, tenantId],
        );
        await client.query(
          `
            UPDATE orgs.workspaces
            SET owner_user_id = $2, updated_at = NOW()
            WHERE id = $1 AND kind = 'team' AND tenant_id = $3::uuid;
          `,
          [groupId, newLeadUserId, tenantId],
        );
        await client.query('COMMIT');
        return { previousRole: target.role };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async listForUser(userId: string): Promise<GroupRecord[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<GroupRow>(
      `
        SELECT
          workspace.id, workspace.name, workspace.description, workspace.business_unit,
          workspace.status, workspace.archived_at, workspace.archived_by, workspace.created_at,
          CASE WHEN app_user.app_role = 'member' THEN 'member' ELSE 'admin' END AS role
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        JOIN identity.app_users AS app_user ON app_user.id = member.user_id
        WHERE member.user_id = $1
          AND member.member_status = 'active'
          AND workspace.kind = 'team'
          AND workspace.tenant_id = $2::uuid
        ORDER BY workspace.created_at ASC;
      `,
      [userId, tenantId],
    );
    const counts = await this.getCountsForGroups(
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) => this.toGroup(row, counts.get(row.id)));
  }

  async listAllGroups(): Promise<GroupRecord[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<GroupRow>(
      `
        SELECT id, name, description, business_unit, status, archived_at, archived_by, created_at,
          'admin'::text AS role
        FROM orgs.workspaces
        WHERE kind = 'team' AND tenant_id = $1::uuid
        ORDER BY created_at DESC;
      `,
      [tenantId],
    );
    const counts = await this.getCountsForGroups(
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) => this.toGroup(row, counts.get(row.id)));
  }

  async findGroupById(groupId: string): Promise<GroupRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<GroupRow>(
      `
        SELECT id, name, description, business_unit, status, archived_at, archived_by, created_at
        FROM orgs.workspaces
        WHERE id = $1 AND kind = 'team' AND tenant_id = $2::uuid;
      `,
      [groupId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getCountsForGroups([row.id]);
    return this.toGroup(row, counts.get(row.id));
  }

  /**
   * Active-member / active-system counts for the "at a glance" chips on
   * GroupSummary (current hierarchy summary contract) — batched by group id to stay N+1-free
   * when called from listForUser.
   */
  private async getCountsForGroups(
    groupIds: string[],
  ): Promise<Map<string, { memberCount: number; systemCount: number }>> {
    const tenantId = this.requireTenantId();
    if (groupIds.length === 0) return new Map();
    const result = await this.databaseService.query<{
      group_id: string;
      member_count: number;
      system_count: number;
    }>(
      `
        SELECT
          workspace.id AS group_id,
          (SELECT count(*)::int FROM orgs.workspace_members m
             WHERE m.workspace_id = workspace.id AND m.member_status = 'active') AS member_count,
          (SELECT count(*)::int FROM hierarchy.systems s
             WHERE s.group_id = workspace.id AND s.status = 'active') AS system_count
        FROM orgs.workspaces AS workspace
          WHERE workspace.id = ANY($1::uuid[])
            AND workspace.tenant_id = $2::uuid;
      `,
      [groupIds, tenantId],
    );
    return new Map(
      result.rows.map((row) => [
        row.group_id,
        { memberCount: row.member_count, systemCount: row.system_count },
      ]),
    );
  }

  /** Active membership only — the choke point every group-scoped authz check uses. */
  async findActiveMembership(
    groupId: string,
    userId: string,
  ): Promise<ActiveMembership | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{
      id: string;
      workspace_id: string;
      user_id: string;
      role: GroupRole;
    }>(
      `
        SELECT
          member.id, member.workspace_id, member.user_id,
          -- Effective group role is derived from the user's GLOBAL app_role
          -- (single source of truth) — 'admin'/'lead' act as group managers,
          -- 'member' does not. The stored member.role is no longer authoritative.
          CASE WHEN app_user.app_role = 'member' THEN 'member' ELSE 'admin' END AS role
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        JOIN identity.app_users AS app_user ON app_user.id = member.user_id
        WHERE member.workspace_id = $1
          AND member.user_id = $2
          AND member.member_status = 'active'
          AND workspace.kind = 'team'
          AND workspace.tenant_id = $3::uuid;
      `,
      [groupId, userId, tenantId],
    );
    const row = result.rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          userId: row.user_id,
          role: row.role,
          memberId: row.id,
        }
      : null;
  }

  async updateGroup(
    groupId: string,
    input: {
      name?: string;
      description?: string | null;
      businessUnit?: string | null;
    },
  ): Promise<GroupRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<GroupRow>(
      `
        UPDATE orgs.workspaces
        SET
          name = COALESCE($2, name),
          description = CASE WHEN $3::boolean THEN $4 ELSE description END,
          business_unit = CASE WHEN $5::boolean THEN $6 ELSE business_unit END,
          updated_at = NOW()
        WHERE id = $1 AND kind = 'team' AND tenant_id = $7::uuid
        RETURNING id, name, description, business_unit, status, archived_at, archived_by, created_at;
      `,
      [
        groupId,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        input.businessUnit !== undefined,
        input.businessUnit ?? null,
        tenantId,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getCountsForGroups([row.id]);
    return this.toGroup(row, counts.get(row.id));
  }

  async setArchiveStatus(
    groupId: string,
    status: LifecycleStatus,
    actingUserId: string,
  ): Promise<GroupRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<GroupRow>(
      `
        UPDATE orgs.workspaces
        SET
          status = $2,
          archived_at = CASE WHEN $2 = 'archived' THEN NOW() ELSE NULL END,
          archived_by = CASE WHEN $2 = 'archived' THEN $3 ELSE NULL END,
          updated_at = NOW()
        WHERE id = $1 AND kind = 'team' AND tenant_id = $4::uuid
        RETURNING id, name, description, business_unit, status, archived_at, archived_by, created_at;
      `,
      [groupId, status, actingUserId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getCountsForGroups([row.id]);
    return this.toGroup(row, counts.get(row.id));
  }

  async listMembers(groupId: string): Promise<GroupMemberRecord[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<MemberRow>(
      `
        SELECT
          member.id, member.workspace_id, member.user_id,
          CASE WHEN user_profile.app_role = 'member' THEN 'member' ELSE 'admin' END AS role,
          member.member_status,
          member.invited_by, member.invited_at, member.removed_at, member.removed_by, member.removal_reason,
          member.created_at,
          user_profile.login, user_profile.display_name, user_profile.email, user_profile.avatar_url
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        JOIN identity.app_users AS user_profile ON user_profile.id = member.user_id
        WHERE member.workspace_id = $1 AND workspace.tenant_id = $2::uuid
        ORDER BY
          CASE member.member_status WHEN 'active' THEN 1 WHEN 'invited' THEN 2 ELSE 3 END,
          CASE WHEN user_profile.app_role = 'member' THEN 2 ELSE 1 END,
          lower(user_profile.login) ASC;
      `,
      [groupId, tenantId],
    );
    return result.rows.map((row) => this.toMember(row));
  }

  async findMemberById(
    groupId: string,
    memberId: string,
  ): Promise<GroupMemberRecord | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<MemberRow>(
      `
        SELECT
          member.id, member.workspace_id, member.user_id, member.role, member.member_status,
          member.invited_by, member.invited_at, member.removed_at, member.removed_by, member.removal_reason,
          member.created_at,
          user_profile.login, user_profile.display_name, user_profile.email, user_profile.avatar_url
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        JOIN identity.app_users AS user_profile ON user_profile.id = member.user_id
        WHERE member.workspace_id = $1
          AND member.id = $2
          AND workspace.tenant_id = $3::uuid;
      `,
      [groupId, memberId, tenantId],
    );
    const row = result.rows[0];
    return row ? this.toMember(row) : null;
  }

  async countActiveOwners(groupId: string): Promise<number> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ count: number }>(
      `
        SELECT count(*)::int AS count
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        WHERE member.workspace_id = $1
          AND member.role = 'admin'
          AND member.member_status = 'active'
          AND workspace.tenant_id = $2::uuid;
      `,
      [groupId, tenantId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async updateMemberRole(
    groupId: string,
    memberId: string,
    role: GroupRole,
  ): Promise<GroupMemberRecord | null> {
    const tenantId = this.requireTenantId();
    await this.databaseService.query(
      `
        UPDATE orgs.workspace_members
        SET role = $3
        WHERE workspace_id = $1
          AND id = $2
          AND EXISTS (
            SELECT 1 FROM orgs.workspaces AS workspace
            WHERE workspace.id = workspace_members.workspace_id
              AND workspace.tenant_id = $4::uuid
          );
      `,
      [groupId, memberId, role, tenantId],
    );
    return this.findMemberById(groupId, memberId);
  }

  /** Offboarding — recorded event, not a hard delete (member-management contract). */
  async markMemberRemoved(
    groupId: string,
    memberId: string,
    removedBy: string,
    reason?: string | null,
  ): Promise<GroupMemberRecord | null> {
    const tenantId = this.requireTenantId();
    await this.databaseService.query(
      `
        UPDATE orgs.workspace_members
        SET member_status = 'removed', removed_at = NOW(), removed_by = $3, removal_reason = $4
        WHERE workspace_id = $1
          AND id = $2
          AND EXISTS (
            SELECT 1 FROM orgs.workspaces AS workspace
            WHERE workspace.id = workspace_members.workspace_id
              AND workspace.tenant_id = $5::uuid
          );
      `,
      [groupId, memberId, removedBy, reason ?? null, tenantId],
    );
    return this.findMemberById(groupId, memberId);
  }

  /**
   * Race-free "last owner" guard for a role change (ciso finding, last-owner safety rule
   * "last-manager protection ... race-condition safety in the transaction
   * handling"). The naive check-then-act pattern (SELECT count, then
   * UPDATE in two separate statements — see the now-unused combination of
   * countActiveOwners + updateMemberRole above) lets two concurrent
   * requests each read "2 active owners" before either commits, and both
   * proceed, leaving the Group with zero owners. This method closes that
   * window by taking a row lock (`FOR UPDATE`) on every active-owner row of
   * the Group inside a single transaction before deciding — a second,
   * concurrent call for the same Group blocks on that lock until the first
   * transaction commits or rolls back, so the owner count it eventually
   * reads is never stale.
   */
  async changeMemberRoleGuarded(
    groupId: string,
    memberId: string,
    role: GroupRole,
  ): Promise<{ member: GroupMemberRecord | null; blockedLastOwner: boolean }> {
    const tenantId = this.requireTenantId();
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `
            SELECT member.id
            FROM orgs.workspace_members AS member
            JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
            WHERE member.workspace_id = $1
              AND member.role = 'admin'
              AND member.member_status = 'active'
              AND workspace.tenant_id = $4::uuid
            FOR UPDATE OF member;
          `,
          [groupId, memberId, role, tenantId],
        );

        const targetResult = await client.query<MemberRow>(
          `
            SELECT
              member.id, member.workspace_id, member.user_id, member.role, member.member_status,
              member.invited_by, member.invited_at, member.removed_at, member.removed_by, member.removal_reason,
              member.created_at,
              user_profile.login, user_profile.display_name, user_profile.email, user_profile.avatar_url
            FROM orgs.workspace_members AS member
            JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
            JOIN identity.app_users AS user_profile ON user_profile.id = member.user_id
            WHERE member.workspace_id = $1
              AND member.id = $2
              AND workspace.tenant_id = $4::uuid
            FOR UPDATE OF member;
          `,
          [groupId, memberId, role, tenantId],
        );
        const target = targetResult.rows[0];
        if (!target) {
          await client.query('ROLLBACK');
          return { member: null, blockedLastOwner: false };
        }

        if (target.role === 'admin' && role !== 'admin') {
          const countResult = await client.query<{ count: number }>(
            `
              SELECT count(*)::int AS count
              FROM orgs.workspace_members AS member
              JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
              WHERE member.workspace_id = $1
                AND member.role = 'admin'
                AND member.member_status = 'active'
                AND workspace.tenant_id = $4::uuid;
            `,
            [groupId, memberId, role, tenantId],
          );
          const ownerCount = Number(countResult.rows[0]?.count ?? 0);
          if (ownerCount <= 1) {
            await client.query('ROLLBACK');
            return { member: this.toMember(target), blockedLastOwner: true };
          }
        }

        await client.query(
          `
            UPDATE orgs.workspace_members
            SET role = $3
            WHERE workspace_id = $1
              AND id = $2
              AND EXISTS (
                SELECT 1 FROM orgs.workspaces AS workspace
                WHERE workspace.id = workspace_members.workspace_id
                  AND workspace.tenant_id = $4::uuid
              );
          `,
          [groupId, memberId, role, tenantId],
        );
        await client.query('COMMIT');

        return {
          member: this.toMember({ ...target, role }),
          blockedLastOwner: false,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  /**
   * Same race-free lock pattern as changeMemberRoleGuarded (see that
   * method's comment), applied to member removal — the other path that can
   * orphan a Group of its last owner (hierarchy ownership contract "must keep at least
   * one owner").
   */
  async removeMemberGuarded(
    groupId: string,
    memberId: string,
    removedBy: string,
    reason?: string | null,
  ): Promise<{ member: GroupMemberRecord | null; blockedLastOwner: boolean }> {
    this.requireTenantId();
    return this.databaseService.withTransaction((client) =>
      this.removeMemberGuardedWithClient(
        client,
        groupId,
        memberId,
        removedBy,
        reason,
      ),
    );
  }

  /**
   * Removes a member against a caller-owned transaction. The caller can use
   * the same transaction to enqueue the member's assignment revokes, so a
   * partial offboarding cannot commit without its durable follow-up work.
   */
  async removeMemberGuardedWithClient(
    client: Pick<PoolClient, 'query'>,
    groupId: string,
    memberId: string,
    removedBy: string,
    reason?: string | null,
  ): Promise<{ member: GroupMemberRecord | null; blockedLastOwner: boolean }> {
    const tenantId = this.requireTenantId();
    await client.query(
      `
        SELECT member.id
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        WHERE member.workspace_id = $1
          AND member.role = 'admin'
          AND member.member_status = 'active'
          AND workspace.tenant_id = $5::uuid
        FOR UPDATE OF member;
      `,
      [groupId, memberId, removedBy, reason ?? null, tenantId],
    );

    const targetResult = await client.query<MemberRow>(
      `
        SELECT
          member.id, member.workspace_id, member.user_id, member.role, member.member_status,
          member.invited_by, member.invited_at, member.removed_at, member.removed_by, member.removal_reason,
          member.created_at,
          user_profile.login, user_profile.display_name, user_profile.email, user_profile.avatar_url
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        JOIN identity.app_users AS user_profile ON user_profile.id = member.user_id
        WHERE member.workspace_id = $1
          AND member.id = $2
          AND workspace.tenant_id = $5::uuid
        FOR UPDATE OF member;
      `,
      [groupId, memberId, removedBy, reason ?? null, tenantId],
    );
    const target = targetResult.rows[0];
    if (!target) {
      return { member: null, blockedLastOwner: false };
    }

    if (target.role === 'admin') {
      const countResult = await client.query<{ count: number }>(
        `
          SELECT count(*)::int AS count
          FROM orgs.workspace_members AS member
          JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
          WHERE member.workspace_id = $1
            AND member.role = 'admin'
            AND member.member_status = 'active'
            AND workspace.tenant_id = $5::uuid;
        `,
        [groupId, memberId, removedBy, reason ?? null, tenantId],
      );
      const ownerCount = Number(countResult.rows[0]?.count ?? 0);
      if (ownerCount <= 1) {
        return { member: this.toMember(target), blockedLastOwner: true };
      }
    }

    await client.query(
      `
        UPDATE orgs.workspace_members
        SET member_status = 'removed', removed_at = NOW(), removed_by = $3, removal_reason = $4
        WHERE workspace_id = $1
          AND id = $2
          AND EXISTS (
            SELECT 1 FROM orgs.workspaces AS workspace
            WHERE workspace.id = workspace_members.workspace_id
              AND workspace.tenant_id = $5::uuid
          );
      `,
      [groupId, memberId, removedBy, reason ?? null, tenantId],
    );

    return {
      member: this.toMember({ ...target, member_status: 'removed' }),
      blockedLastOwner: false,
    };
  }

  /**
   * Grants membership immediately — there is no invitation and no pending
   * state. Upserting on (workspace_id, user_id) makes re-adding a previously
   * removed member a reinstatement rather than a unique violation.
   *
   * invited_by / invited_at keep their column names (renaming them would be a
   * migration for no behavioural gain) but now record who added the member and
   * when.
   */
  async addMemberDirect(
    groupId: string,
    userId: string,
    role: GrantableRole,
    addedBy: string,
  ): Promise<void> {
    const context = this.requireTenantContext();
    this.assertCurrentUser(addedBy, context, 'Member actor');
    await this.databaseService.query(
      `
        INSERT INTO orgs.workspace_members (workspace_id, user_id, role, member_status, invited_by, invited_at)
        SELECT $1, $2, $3, 'active', $4, NOW()
        WHERE EXISTS (
          SELECT 1 FROM orgs.workspaces AS workspace
          WHERE workspace.id = $1
            AND workspace.kind = 'team'
            AND workspace.tenant_id = $5::uuid
        )
        AND EXISTS (
          SELECT 1
          FROM tenancy.tenant_memberships AS tenant_membership
          WHERE tenant_membership.tenant_id = $5::uuid
            AND tenant_membership.user_id = $2
            AND tenant_membership.status = 'active'
        )
        ON CONFLICT (workspace_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, member_status = 'active', removed_at = NULL, removed_by = NULL, removal_reason = NULL;
      `,
      [groupId, userId, role, addedBy, context.tenantId],
    );
  }

  /**
   * Resolves an internal user by login or email from the intentionally global
   * identity directory. The lookup is still tenant-context gated, while the
   * actual group-membership write enforces active tenancy membership.
   */
  async findInternalUserByLoginOrEmail(
    loginOrEmail: string,
  ): Promise<{ id: string } | null> {
    this.requireTenantId();
    const result = await this.databaseService.query<{ id: string }>(
      `
        SELECT id
        FROM identity.app_users
        WHERE (lower(login) = lower($1) OR lower(email) = lower($1))
          AND is_internal = true
        LIMIT 1;
      `,
      [loginOrEmail],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The identity directory is intentionally global; tenant membership is
   * enforced by addMemberDirect rather than by hiding directory candidates.
   */
  async findInternalUserById(userId: string): Promise<{ id: string } | null> {
    this.requireTenantId();
    const result = await this.databaseService.query<{ id: string }>(
      `
        SELECT id
        FROM identity.app_users
        WHERE id = $1 AND is_internal = true
        LIMIT 1;
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async searchEligibleInternalUsers(
    groupId: string,
    search: string,
    limit = 20,
  ): Promise<InternalUserDirectoryEntry[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{
      id: string;
      login: string;
      display_name: string | null;
      email: string | null;
      avatar_url: string | null;
    }>(
      `
        SELECT app_user.id, app_user.login, app_user.display_name, app_user.email, app_user.avatar_url
        FROM identity.app_users AS app_user
        WHERE app_user.is_internal = true
          AND (
            lower(app_user.login) LIKE lower($2)
            OR lower(COALESCE(app_user.display_name, '')) LIKE lower($2)
            OR lower(COALESCE(app_user.email, '')) LIKE lower($2)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orgs.workspace_members AS member
            JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
            WHERE member.workspace_id = $1
              AND member.user_id = app_user.id
              AND member.member_status = 'active'
              AND workspace.tenant_id = $4::uuid
          )
        ORDER BY lower(app_user.login) ASC
        LIMIT $3;
      `,
      [groupId, `%${search}%`, limit, tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      login: row.login,
      name: row.display_name,
      email: row.email,
      avatarUrl: row.avatar_url,
      hasAccount: true,
    }));
  }

  /**
   * Resolves a batch of GitHub logins to AlphaCI accounts, flagging any that
   * are already an active member of the given Group. Used to cross-reference
   * the GitHub org roster against local accounts for the member picker.
   *
   * Only INTERNAL accounts count as "has an account" — the same gate
   * GroupMembersService.addMember applies. An org member who has signed in but
   * is not internal is reported hasAccount:false and shown disabled, rather
   * than being offered and rejected on submit.
   */
  async findAccountsByLogins(
    groupId: string,
    logins: string[],
  ): Promise<DirectoryAccountRecord[]> {
    if (logins.length === 0) return [];
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{
      id: string;
      login: string;
      display_name: string | null;
      email: string | null;
      avatar_url: string | null;
      is_active_member: boolean;
    }>(
      `
        SELECT
          app_user.id, app_user.login, app_user.display_name,
          app_user.email, app_user.avatar_url,
          EXISTS (
            SELECT 1 FROM orgs.workspace_members AS member
            JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
            WHERE member.workspace_id = $1
              AND member.user_id = app_user.id
              AND member.member_status = 'active'
              AND workspace.tenant_id = $3::uuid
          ) AS is_active_member
        FROM identity.app_users AS app_user
        WHERE lower(app_user.login) = ANY($2::text[])
          -- Must match findInternalUserById's gate exactly. Without this a
          -- non-internal account renders as selectable in the picker and then
          -- fails the add with a 404 the UI cannot explain.
          AND app_user.is_internal = true;
      `,
      [groupId, logins.map((login) => login.toLowerCase()), tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      login: row.login,
      name: row.display_name,
      email: row.email,
      avatarUrl: row.avatar_url,
      isActiveMember: row.is_active_member,
    }));
  }

  private toGroup(
    row: GroupRow,
    counts?: { memberCount: number; systemCount: number },
  ): GroupRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      businessUnit: row.business_unit,
      status: row.status,
      archivedAt: row.archived_at,
      archivedBy: row.archived_by,
      createdAt: row.created_at,
      memberCount: counts?.memberCount ?? 0,
      systemCount: counts?.systemCount ?? 0,
      ...(row.role ? { role: row.role } : {}),
    };
  }

  private toMember(row: MemberRow): GroupMemberRecord {
    return {
      id: row.id,
      groupId: row.workspace_id,
      userId: row.user_id,
      role: row.role,
      memberStatus: row.member_status,
      login: row.login,
      name: row.display_name ?? row.login,
      email: row.email,
      avatarUrl: row.avatar_url,
      invitedBy: row.invited_by ?? null,
      invitedAt: row.invited_at,
      removedAt: row.removed_at,
      removedBy: row.removed_by ?? null,
      removalReason: row.removal_reason ?? null,
      createdAt: row.created_at,
    };
  }

  /**
   * Hard-deletes a Group (team workspace). FK cascades remove its members,
   * invitations, systems, delivery projects and hierarchy repositories; any
   * provisioned_projects rows survive with workspace_id set to NULL (ON DELETE
   * SET NULL), i.e. their GitHub repos are detached to "individual", never
   * destroyed. Returns false when no such team workspace existed.
   */
  async deleteGroup(groupId: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query(
      `DELETE FROM orgs.workspaces WHERE id = $1 AND kind = 'team' AND tenant_id = $2::uuid;`,
      [groupId, tenantId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private requireTenantId(): string {
    return this.requireTenantContext().tenantId;
  }

  private requireTenantContext(): TenantContext {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require();
  }

  private assertCurrentUser(
    inputUserId: string,
    context: TenantContext,
    label: string,
  ): void {
    if (inputUserId !== context.userId) {
      throw new InvalidTenantContextError(
        `${label} must match the validated tenant context user`,
      );
    }
  }
}
