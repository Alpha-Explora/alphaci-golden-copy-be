import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';

export interface DirectoryAccount {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** Already an active member of the workspace passed in, if any. */
  isActiveMember: boolean;
}

/**
 * AlphaCI accounts, as the member directory sees them. An account counts
 * once it is not archived. Whether its owner belongs in the directory is the
 * source's decision, never a column here: the old `is_internal = true` filter
 * is only ever set on a deployment with GITHUB_INTERNAL_ORG, so every other
 * deployment had an empty directory.
 */
@Injectable()
export class DirectoryAccountsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findByLogins(
    logins: string[],
    workspaceId: string | null,
  ): Promise<DirectoryAccount[]> {
    if (logins.length === 0) return [];
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
            WHERE member.workspace_id = $2
              AND member.user_id = app_user.id
              AND member.member_status = 'active'
          ) AS is_active_member
        FROM identity.app_users AS app_user
        WHERE lower(app_user.login) = ANY($1::text[])
          AND app_user.archived_at IS NULL;
      `,
      [logins.map((login) => login.toLowerCase()), workspaceId],
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

  async findActiveById(
    userId: string,
  ): Promise<{ id: string; login: string } | null> {
    const result = await this.databaseService.query<{
      id: string;
      login: string;
    }>(
      `
        SELECT id, login
        FROM identity.app_users
        WHERE id = $1 AND archived_at IS NULL AND login IS NOT NULL
        LIMIT 1;
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  /** Every active account, as directory people: the `accounts` source. */
  async listActivePeople(): Promise<
    Array<{ login: string; avatarUrl: string | null }>
  > {
    const result = await this.databaseService.query<{
      login: string;
      avatar_url: string | null;
    }>(
      `
        SELECT login, avatar_url
        FROM identity.app_users
        WHERE archived_at IS NULL AND login IS NOT NULL
        ORDER BY lower(login);
      `,
    );
    return result.rows.map((row) => ({
      login: row.login,
      avatarUrl: row.avatar_url,
    }));
  }
}
