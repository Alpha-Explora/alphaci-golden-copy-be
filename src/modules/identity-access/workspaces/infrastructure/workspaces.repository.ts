import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';

/**
 * `admin` here is the TOP workspace/group membership tier (product label
 * "Lead", formerly stored as `owner`) — see ROLE_VALUE_RENAME_PLAN.md §2.1.
 * This is UNRELATED to `identity.platform_admins.role` (`'admin' |
 * 'super_admin'`), the separate platform-wide admin tier. Same literal
 * string, two different systems — do not conflate them.
 */
export type WorkspaceRole = 'admin' | 'delegated_lead' | 'member' | 'viewer';
/**
 * `kind` is retained as a single-member union rather than dropped because the
 * column still exists and is still selected. Every workspace is a team - a
 * workspace IS a team - and the CHECK constraint enforces that as of the
 * personal-workspace removal migration.
 */
export type WorkspaceKind = 'team';

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
}

export interface WorkspaceMemberSummary {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  login: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

interface WorkspaceRow {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
}

interface WorkspaceMemberRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string | Date;
  login: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

@Injectable()
export class WorkspacesRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<WorkspaceRow>(
      `
        SELECT
          workspace.id,
          workspace.name,
          workspace.kind,
          member.role
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace
          ON workspace.id = member.workspace_id
        WHERE member.user_id = $1
          AND workspace.tenant_id = $2::uuid
        ORDER BY workspace.created_at ASC;
      `,
      [userId, tenantId],
    );

    return result.rows.map((row) => this.toSummary(row));
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberSummary[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<WorkspaceMemberRow>(
      `
        SELECT
          member.id,
          member.workspace_id,
          member.user_id,
          member.role,
          member.created_at,
          user_profile.login,
          user_profile.display_name,
          user_profile.email,
          user_profile.avatar_url
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace
          ON workspace.id = member.workspace_id
        JOIN identity.app_users AS user_profile
          ON user_profile.id = member.user_id
        WHERE member.workspace_id = $1
          AND workspace.tenant_id = $2::uuid
        ORDER BY
          CASE member.role
            WHEN 'admin' THEN 1
            WHEN 'delegated_lead' THEN 2
            WHEN 'member' THEN 3
            ELSE 4
          END,
          lower(user_profile.login) ASC;
      `,
      [workspaceId, tenantId],
    );

    return result.rows.map((row) => this.toMemberSummary(row));
  }

  async findMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembership | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{
      workspace_id: string;
      user_id: string;
      role: WorkspaceRole;
    }>(
      `
        SELECT workspace_id, user_id, role
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace
          ON workspace.id = member.workspace_id
        WHERE member.workspace_id = $1
          AND member.user_id = $2
          AND workspace.tenant_id = $3::uuid;
      `,
      [workspaceId, userId, tenantId],
    );

    return this.toMembership(result.rows[0]);
  }

  async findProjectMembership(
    projectId: string,
    userId: string,
  ): Promise<WorkspaceMembership | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{
      workspace_id: string;
      user_id: string;
      role: WorkspaceRole;
    }>(
      `
        SELECT member.workspace_id, member.user_id, member.role
        FROM projects.provisioned_projects AS project
        JOIN orgs.workspace_members AS member
          ON member.workspace_id = project.workspace_id
        JOIN orgs.workspaces AS workspace
          ON workspace.id = project.workspace_id
        WHERE project.id = $1
          AND member.user_id = $2
          AND project.tenant_id = $3::uuid
          AND workspace.tenant_id = $3::uuid;
      `,
      [projectId, userId, tenantId],
    );

    return this.toMembership(result.rows[0]);
  }

  async findMemberById(
    workspaceId: string,
    memberId: string,
  ): Promise<WorkspaceMembership | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{
      workspace_id: string;
      user_id: string;
      role: WorkspaceRole;
    }>(
      `
        SELECT workspace_id, user_id, role
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace
          ON workspace.id = member.workspace_id
        WHERE member.workspace_id = $1
          AND member.id = $2
          AND workspace.tenant_id = $3::uuid;
      `,
      [workspaceId, memberId, tenantId],
    );

    return this.toMembership(result.rows[0]);
  }

  async countOwners(workspaceId: string): Promise<number> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ count: number | string }>(
      `
        SELECT count(*)::int AS count
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace
          ON workspace.id = member.workspace_id
        WHERE member.workspace_id = $1
          AND member.role = 'admin'
          AND workspace.tenant_id = $2::uuid;
      `,
      [workspaceId, tenantId],
    );

    return Number(result.rows[0]?.count ?? 0);
  }

  async addMemberByLoginOrEmail(
    workspaceId: string,
    loginOrEmail: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMemberSummary | null> {
    const tenantId = this.requireTenantId();
    const userResult = await this.databaseService.query<{ id: string }>(
      `
        SELECT id
        FROM identity.app_users
        WHERE lower(login) = lower($1)
           OR lower(email) = lower($1)
        LIMIT 1;
      `,
      [loginOrEmail],
    );
    const targetUser = userResult.rows[0];
    if (!targetUser) {
      return null;
    }

    await this.databaseService.query(
      `
        INSERT INTO orgs.workspace_members (workspace_id, user_id, role)
        SELECT $1, $2, $3
        WHERE EXISTS (
          SELECT 1 FROM orgs.workspaces AS workspace
          WHERE workspace.id = $1
            AND workspace.tenant_id = $4::uuid
        )
        AND EXISTS (
          SELECT 1
          FROM tenancy.tenant_memberships AS tenant_membership
          WHERE tenant_membership.tenant_id = $4::uuid
            AND tenant_membership.user_id = $2
            AND tenant_membership.status = 'active'
        )
        ON CONFLICT (workspace_id, user_id)
        DO UPDATE SET role = EXCLUDED.role;
      `,
      [workspaceId, targetUser.id, role, tenantId],
    );

    return this.findMemberByUserId(workspaceId, targetUser.id);
  }

  async updateMemberRole(
    workspaceId: string,
    memberId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMemberSummary | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ user_id: string }>(
      `
        UPDATE orgs.workspace_members
        SET role = $3
        WHERE workspace_id = $1
          AND id = $2
          AND EXISTS (
            SELECT 1 FROM orgs.workspaces AS workspace
            WHERE workspace.id = $1
              AND workspace.tenant_id = $4::uuid
          )
        RETURNING user_id;
      `,
      [workspaceId, memberId, role, tenantId],
    );
    const row = result.rows[0];
    return row ? this.findMemberByUserId(workspaceId, row.user_id) : null;
  }

  async removeMember(
    workspaceId: string,
    memberId: string,
  ): Promise<{ id: string } | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ id: string }>(
      `
        DELETE FROM orgs.workspace_members
        WHERE workspace_id = $1
          AND id = $2
          AND EXISTS (
            SELECT 1 FROM orgs.workspaces AS workspace
            WHERE workspace.id = $1
              AND workspace.tenant_id = $3::uuid
          )
        RETURNING id;
      `,
      [workspaceId, memberId, tenantId],
    );

    return result.rows[0] ?? null;
  }

  private async findMemberByUserId(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberSummary | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<WorkspaceMemberRow>(
      `
        SELECT
          member.id,
          member.workspace_id,
          member.user_id,
          member.role,
          member.created_at,
          user_profile.login,
          user_profile.display_name,
          user_profile.email,
          user_profile.avatar_url
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace
          ON workspace.id = member.workspace_id
        JOIN identity.app_users AS user_profile
          ON user_profile.id = member.user_id
        WHERE member.workspace_id = $1
          AND member.user_id = $2
          AND workspace.tenant_id = $3::uuid;
      `,
      [workspaceId, userId, tenantId],
    );

    const row = result.rows[0];
    return row ? this.toMemberSummary(row) : null;
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
  }

  private toSummary(row: WorkspaceRow): WorkspaceSummary {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      role: row.role,
    };
  }

  private toMembership(
    row:
      | {
          workspace_id: string;
          user_id: string;
          role: WorkspaceRole;
        }
      | undefined,
  ): WorkspaceMembership | null {
    return row
      ? {
          workspaceId: row.workspace_id,
          userId: row.user_id,
          role: row.role,
        }
      : null;
  }

  private toMemberSummary(row: WorkspaceMemberRow): WorkspaceMemberSummary {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      role: row.role,
      login: row.login,
      name: row.display_name ?? row.login,
      email: row.email,
      avatarUrl: row.avatar_url,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
    };
  }
}
