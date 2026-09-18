import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service.js';

export type IdentityProvider = 'email' | 'google' | 'github';

interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: IdentityProvider;
  provider_user_id: string;
  email: string | null;
  normalized_email: string | null;
  email_verified: boolean;
  password_hash: string | null;
  display_name: string | null;
  avatar_url: string | null;
  archived_at: string | null;
}

export interface LinkedIdentity {
  id: string;
  userId: string;
  provider: IdentityProvider;
  providerUserId: string;
  email?: string;
  normalizedEmail?: string;
  emailVerified: boolean;
  passwordHash?: string;
  displayName?: string;
  avatarUrl?: string;
  archivedAt: string | null;
}

export interface UpsertIdentityInput {
  userId: string;
  provider: IdentityProvider;
  providerUserId: string;
  email?: string;
  emailVerified: boolean;
  passwordHash?: string;
  displayName?: string;
  avatarUrl?: string;
}

@Injectable()
export class UserIdentitiesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findByProviderIdentity(
    provider: IdentityProvider,
    providerUserId: string,
  ): Promise<LinkedIdentity | null> {
    const result = await this.databaseService.query<UserIdentityRow>(
      `
        SELECT
          ui.id,
          ui.user_id,
          ui.provider,
          ui.provider_user_id,
          ui.email,
          ui.normalized_email,
          ui.email_verified,
          ui.password_hash,
          ui.display_name,
          ui.avatar_url,
          u.archived_at
        FROM identity.user_identities ui
        JOIN identity.app_users u ON u.id = ui.user_id
        WHERE ui.provider = $1
          AND ui.provider_user_id = $2
        LIMIT 1;
      `,
      [provider, providerUserId],
    );

    const row = result.rows[0];
    return row ? this.toIdentity(row) : null;
  }

  async findActiveUserIdsByVerifiedEmail(email: string): Promise<string[]> {
    const result = await this.databaseService.query<{ user_id: string }>(
      `
        SELECT DISTINCT user_id
        FROM (
          SELECT ui.user_id
          FROM identity.user_identities ui
          JOIN identity.app_users u ON u.id = ui.user_id
          WHERE ui.email_verified = true
            AND ui.normalized_email = lower($1)
            AND u.archived_at IS NULL

          UNION

          SELECT u.id AS user_id
          FROM identity.app_users u
          WHERE lower(u.email) = lower($1)
            AND u.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM identity.user_identities pending_email
              WHERE pending_email.user_id = u.id
                AND pending_email.provider = 'email'
                AND pending_email.email_verified = false
            )
        ) matched_users;
      `,
      [email],
    );

    return result.rows.map((row) => row.user_id);
  }

  async upsertIdentity(input: UpsertIdentityInput): Promise<LinkedIdentity> {
    const normalizedEmail = input.email?.trim().toLowerCase() ?? null;
    const result = await this.databaseService.query<UserIdentityRow>(
      `
        INSERT INTO identity.user_identities (
          user_id,
          provider,
          provider_user_id,
          email,
          normalized_email,
          email_verified,
          password_hash,
          display_name,
          avatar_url,
          last_login_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (provider, provider_user_id)
        DO UPDATE SET
          -- A provider identity is never moved to a different account just
          -- because two concurrent signup/link requests raced.
          user_id = identity.user_identities.user_id,
          email = COALESCE(EXCLUDED.email, identity.user_identities.email),
          normalized_email = COALESCE(EXCLUDED.normalized_email, identity.user_identities.normalized_email),
          email_verified = identity.user_identities.email_verified OR EXCLUDED.email_verified,
          password_hash = COALESCE(EXCLUDED.password_hash, identity.user_identities.password_hash),
          display_name = COALESCE(EXCLUDED.display_name, identity.user_identities.display_name),
          avatar_url = COALESCE(EXCLUDED.avatar_url, identity.user_identities.avatar_url),
          last_login_at = NOW(),
          updated_at = NOW()
        RETURNING
          id,
          user_id,
          provider,
          provider_user_id,
          email,
          normalized_email,
          email_verified,
          password_hash,
          display_name,
          avatar_url,
          NULL::timestamptz AS archived_at;
      `,
      [
        input.userId,
        input.provider,
        input.providerUserId,
        input.email?.trim() ?? null,
        normalizedEmail,
        input.emailVerified,
        input.passwordHash ?? null,
        input.displayName ?? null,
        input.avatarUrl ?? null,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error('Identity upsert returned no row');
    return this.toIdentity(row);
  }

  private toIdentity(row: UserIdentityRow): LinkedIdentity {
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      providerUserId: row.provider_user_id,
      ...(row.email ? { email: row.email } : {}),
      ...(row.normalized_email
        ? { normalizedEmail: row.normalized_email }
        : {}),
      emailVerified: row.email_verified,
      ...(row.password_hash ? { passwordHash: row.password_hash } : {}),
      ...(row.display_name ? { displayName: row.display_name } : {}),
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
      archivedAt: row.archived_at,
    };
  }
}
