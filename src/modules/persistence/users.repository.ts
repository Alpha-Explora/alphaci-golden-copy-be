import { Injectable } from '@nestjs/common';

import type { SessionUser } from '../../common/interfaces/session-user.interface';
import { DatabaseService } from '../../kernel/db/database.service';

interface UpsertGitHubUserInput {
  githubUserId: string;
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  /**
   * Internal-org membership to persist:
   *  - `true`/`false`: the deployment can verify membership (internal
   *    deployment) and authoritatively sets the flag on every sign-in, so
   *    leaving/joining the org self-heals.
   *  - `null`: the deployment cannot verify membership (external/sold
   *    deployment, GITHUB_INTERNAL_ORG unset). Preserve the existing flag on
   *    updates; brand-new rows default to false. This keeps an employee's
   *    internal status from being clobbered when they use the sold platform.
   */
  isInternal: boolean | null;
  /**
   * Global hierarchy role to SEED on first login ONLY. It is written into the
   * INSERT VALUES for a brand-new row (Alpha-Explora org owners → 'admin',
   * everyone else → 'member') but is deliberately absent from the ON CONFLICT
   * DO UPDATE clause, so a returning user keeps whatever the Admin Console has
   * since assigned. `null`/undefined falls back to the column default ('member').
   */
  seedAppRole?: 'admin' | 'lead' | 'member' | null;
}

interface UpsertGoogleUserInput {
  googleUserId: string;
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

interface PersistedUserRow {
  id: string;
  login: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  onboarding_completed_at: string | null;
  archived_at?: string | null;
  github_user_id?: string | null;
  is_internal?: boolean | null;
}

export interface ArchivedUserLookup {
  id: string;
  login: string;
  archivedAt: string | null;
  githubUserId: string | null;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async upsertGitHubUser(input: UpsertGitHubUserInput): Promise<SessionUser> {
    const normalizedLogin = this.normalizeLogin(
      input.login,
      input.githubUserId,
    );

    const query = `
      WITH candidate AS (
        SELECT CASE
          WHEN EXISTS (
            SELECT 1
            FROM app_users
            WHERE login = $2
              AND COALESCE(github_user_id, '') <> $1
          )
            THEN CONCAT($2, '-', SUBSTRING(md5($1) FROM 1 FOR 6))
            ELSE $2
        END AS safe_login
      )
      INSERT INTO app_users (
        github_user_id,
        login,
        display_name,
        email,
        avatar_url,
        provider,
        is_dummy,
        is_internal,
        app_role,
        last_login_at
      )
      VALUES ($1, (SELECT safe_login FROM candidate), $3, $4, $5, 'github', false, COALESCE($6, false), COALESCE($7, 'member'), NOW())
      ON CONFLICT (github_user_id)
      DO UPDATE SET
        login = EXCLUDED.login,
        display_name = EXCLUDED.display_name,
        email = COALESCE(EXCLUDED.email, app_users.email),
        avatar_url = EXCLUDED.avatar_url,
        provider = 'github',
        is_dummy = false,
        -- $6 null (unverifiable/sold platform) preserves the existing flag;
        -- a boolean (internal platform) authoritatively overwrites it.
        is_internal = COALESCE($6::boolean, app_users.is_internal),
        -- app_role is INTENTIONALLY not updated here: the org-ownership seed
        -- ($7) applies only to the INSERT above (first login), so a returning
        -- user keeps whatever the Admin Console has since assigned.
        last_login_at = NOW(),
        updated_at = NOW()
      RETURNING id, login, display_name, email, avatar_url, onboarding_completed_at, is_internal;
    `;

    const result = await this.databaseService.query<PersistedUserRow>(query, [
      input.githubUserId,
      normalizedLogin,
      input.name ?? input.login,
      input.email ?? null,
      input.avatarUrl ?? null,
      input.isInternal,
      input.seedAppRole ?? null,
    ]);

    const row = result.rows[0];
    if (!row) throw new Error('Upsert returned no row');
    return this.toSessionUser(row);
  }

  async upsertGoogleUser(input: UpsertGoogleUserInput): Promise<SessionUser> {
    const normalizedLogin = this.normalizeLogin(
      input.login,
      input.googleUserId,
      'google',
    );

    const query = `
      INSERT INTO app_users (
        login,
        display_name,
        email,
        avatar_url,
        provider,
        is_dummy,
        last_login_at
      )
      VALUES ($1, $2, $3, $4, 'google', false, NOW())
      ON CONFLICT (login)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        email = COALESCE(EXCLUDED.email, app_users.email),
        avatar_url = EXCLUDED.avatar_url,
        provider = 'google',
        is_dummy = false,
        last_login_at = NOW(),
        updated_at = NOW()
      RETURNING id, login, display_name, email, avatar_url, onboarding_completed_at, is_internal;
    `;

    const result = await this.databaseService.query<PersistedUserRow>(query, [
      normalizedLogin,
      input.name ?? input.login,
      input.email ?? null,
      input.avatarUrl ?? null,
    ]);

    const row = result.rows[0];
    if (!row) throw new Error('Upsert returned no row');
    return this.toSessionUser(row);
  }

  async deleteById(userId: string): Promise<void> {
    await this.databaseService.query(`DELETE FROM app_users WHERE id = $1;`, [
      userId,
    ]);
  }

  /**
   * Soft-delete: sets archived_at to NOW(). ON DELETE CASCADE children are
   * preserved. Skips already-archived rows (AND archived_at IS NULL guard).
   */
  async archiveById(userId: string): Promise<void> {
    await this.databaseService.query(
      `UPDATE app_users
         SET archived_at = NOW(), updated_at = NOW()
       WHERE id = $1
         AND archived_at IS NULL;`,
      [userId],
    );
  }

  /**
   * Look up a user by their GitHub provider id, including rows that are
   * archived. Used by the OAuth callback to detect whether a returning user
   * has previously archived their account.
   */
  async findByGithubUserIdIncludingArchived(
    githubUserId: string,
  ): Promise<ArchivedUserLookup | null> {
    const result = await this.databaseService.query<PersistedUserRow>(
      `SELECT id, login, archived_at, github_user_id
         FROM app_users
        WHERE github_user_id = $1
        LIMIT 1;`,
      [githubUserId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      login: row.login,
      archivedAt: row.archived_at ?? null,
      githubUserId: row.github_user_id ?? null,
    };
  }

  /**
   * Restore an archived account: clears archived_at and touches last_login_at.
   * Returns the full SessionUser so the caller can establish the session.
   */
  async restoreByGithubUserId(
    githubUserId: string,
    isInternal: boolean | null,
  ): Promise<SessionUser> {
    const result = await this.databaseService.query<PersistedUserRow>(
      `UPDATE app_users
          SET archived_at   = NULL,
              is_internal   = COALESCE($2::boolean, app_users.is_internal),
              last_login_at = NOW(),
              updated_at    = NOW()
        WHERE github_user_id = $1
        RETURNING id, login, display_name, email, avatar_url, onboarding_completed_at, is_internal;`,
      [githubUserId, isInternal],
    );

    const row = result.rows[0];
    if (!row) throw new Error('Restore found no matching archived row');
    return this.toSessionUser(row);
  }

  /**
   * Hard-delete an archived row so that a start-fresh upsert produces a clean
   * new account with no conflict. All child rows cascade automatically.
   */
  async hardDeleteByGithubUserId(githubUserId: string): Promise<void> {
    await this.databaseService.query(
      `DELETE FROM app_users WHERE github_user_id = $1;`,
      [githubUserId],
    );
  }

  /**
   * Invoke the DB-side retention purge function. Returns the number of rows
   * that were permanently deleted.
   *
   * NOTE: @nestjs/schedule is not installed. Wire this to an OS/pg_cron job or
   * use the companion script at scripts/purge-archived-accounts.ts.
   */
  async purgeExpiredArchived(retentionDays: number): Promise<number> {
    const result = await this.databaseService.query<{ count: string }>(
      `SELECT purge_expired_archived_accounts($1) AS count;`,
      [retentionDays],
    );

    const row = result.rows[0];
    return row ? Number(row.count) : 0;
  }

  async findById(userId: string): Promise<SessionUser | null> {
    const result = await this.databaseService.query<PersistedUserRow>(
      `
        SELECT id, login, display_name, email, avatar_url, onboarding_completed_at, is_internal
        FROM app_users
        WHERE id = $1
        LIMIT 1;
      `,
      [userId],
    );

    const row = result.rows[0];
    return row ? this.toSessionUser(row) : null;
  }

  async markOnboardingComplete(userId: string): Promise<void> {
    await this.databaseService.query(
      `UPDATE app_users
         SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
             updated_at = NOW()
       WHERE id = $1;`,
      [userId],
    );
  }

  private toSessionUser(row: PersistedUserRow): SessionUser {
    return {
      id: row.id,
      login: row.login,
      name: row.display_name ?? row.login,
      ...(row.email != null && { email: row.email }),
      ...(row.avatar_url != null && { avatarUrl: row.avatar_url }),
      onboardingCompleted: row.onboarding_completed_at != null,
      isInternal: row.is_internal ?? false,
    };
  }

  private normalizeLogin(
    login: string,
    providerUserId: string,
    provider = 'github',
  ): string {
    const normalized = login
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, '-')
      .replaceAll(/-+/g, '-')
      .replaceAll(/^-+|-+$/g, '');

    if (normalized) {
      return normalized;
    }

    return `${provider}-${providerUserId.slice(0, 24)}`;
  }
}
