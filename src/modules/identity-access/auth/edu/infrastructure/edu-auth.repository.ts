import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';

import { DatabaseService } from '#kernel/db/database.service.js';
import {
  EduGithubLinkConflictError,
  type CreateEduStudentInput,
  type EduAuthRepositoryPort,
  type LinkEduGithubInput,
} from '../application/edu-auth.ports.js';
import type { EduAccount, EduLab, EduRole } from '../model/edu-auth.types.js';

interface EduAccountRow extends QueryResultRow {
  user_id: string;
  email: string;
  full_name: string;
  role: EduRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  home_lab_id: string | null;
  github_user_id: string | null;
  github_login: string | null;
  github_avatar_url: string | null;
  github_profile_url: string | null;
  created_at: string | Date;
  supabase_user_id: string | null;
}

interface EduLabRow extends QueryResultRow {
  id: string;
  name: string;
  github_org_name: string;
}

const ACCOUNT_SELECT = `
  SELECT
    u.id AS user_id,
    p.email,
    p.full_name,
    p.role,
    p.status,
    p.home_lab_id,
    p.github_user_id,
    p.github_login,
    p.github_avatar_url,
    p.github_profile_url,
    p.created_at,
    si.provider_user_id AS supabase_user_id
  FROM identity.edu_profiles p
  JOIN identity.app_users u ON u.id = p.user_id
  LEFT JOIN identity.user_identities si
    ON si.user_id = p.user_id
   AND si.provider = 'supabase'
  WHERE u.archived_at IS NULL
`;

@Injectable()
export class EduAuthRepository implements EduAuthRepositoryPort {
  constructor(private readonly databaseService: DatabaseService) {}

  async findBySupabaseUserId(authUserId: string): Promise<EduAccount | null> {
    const result = await this.databaseService.query<EduAccountRow>(
      `${ACCOUNT_SELECT}
        AND si.provider_user_id = $1
        LIMIT 1;`,
      [authUserId],
    );
    return result.rows[0] ? this.toAccount(result.rows[0]) : null;
  }

  async findByUserId(userId: string): Promise<EduAccount | null> {
    const result = await this.databaseService.query<EduAccountRow>(
      `${ACCOUNT_SELECT}
        AND p.user_id = $1
        LIMIT 1;`,
      [userId],
    );
    return result.rows[0] ? this.toAccount(result.rows[0]) : null;
  }

  async findByEmail(email: string): Promise<EduAccount | null> {
    const result = await this.databaseService.query<EduAccountRow>(
      `${ACCOUNT_SELECT}
        AND p.normalized_email = lower($1)
        LIMIT 1;`,
      [email.trim()],
    );
    return result.rows[0] ? this.toAccount(result.rows[0]) : null;
  }

  async findFirstActiveLab(): Promise<EduLab | null> {
    const result = await this.databaseService.query<EduLabRow>(
      `
        SELECT id, name, github_org_name
        FROM identity.edu_labs
        WHERE active = true
        ORDER BY lower(name), id
        LIMIT 1;
      `,
    );
    return result.rows[0] ? this.toLab(result.rows[0]) : null;
  }

  async createStudent(input: CreateEduStudentInput): Promise<EduAccount> {
    return this.databaseService.withTransaction(async (client) => {
      const userResult = await client.query<{ id: string }>(
        `
          INSERT INTO identity.app_users (
            login,
            display_name,
            email,
            provider,
            is_dummy,
            is_internal,
            last_login_at
          )
          VALUES ($1, $2, $3, 'email', false, false, NOW())
          RETURNING id;
        `,
        [this.loginForEmail(input.email), input.fullName, input.email],
      );
      const userId = userResult.rows[0]?.id;
      if (!userId) throw new Error('EDU student user insert returned no row');

      await client.query(
        `
          INSERT INTO identity.edu_profiles (
            user_id,
            email,
            normalized_email,
            full_name,
            role,
            status,
            home_lab_id
          )
          VALUES ($1, $2, lower($2), $3, 'STUDENT', 'ACTIVE', $4);
        `,
        [userId, input.email, input.fullName, input.homeLabId],
      );

      await client.query(
        `
          INSERT INTO identity.user_identities (
            user_id,
            provider,
            provider_user_id,
            email,
            normalized_email,
            email_verified,
            display_name,
            last_login_at
          )
          VALUES ($1, 'supabase', $2, $3, lower($3), true, $4, NOW());
        `,
        [userId, input.authUserId, input.email, input.fullName],
      );

      const accountResult = await client.query<EduAccountRow>(
        `${ACCOUNT_SELECT}
          AND p.user_id = $1
          LIMIT 1;`,
        [userId],
      );
      const row = accountResult.rows[0];
      if (!row) throw new Error('EDU student account insert returned no row');
      return this.toAccount(row);
    });
  }

  async recordSupabaseLogin(authUserId: string, email: string): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE identity.user_identities
        SET email = COALESCE($2, email),
            normalized_email = COALESCE(lower($2), normalized_email),
            last_login_at = NOW(),
            updated_at = NOW()
        WHERE provider = 'supabase'
          AND provider_user_id = $1;
      `,
      [authUserId, email.trim()],
    );
  }

  async listAccessibleLabs(userId: string, role: EduRole): Promise<EduLab[]> {
    const result = await this.databaseService.query<EduLabRow>(
      `
        SELECT l.id, l.name, l.github_org_name
        FROM identity.edu_labs l
        WHERE l.active = true
          AND (
            $2 IN ('ADMIN', 'SUPER_ADMIN')
            OR EXISTS (
              SELECT 1
              FROM identity.edu_lab_memberships m
              WHERE m.user_id = $1
                AND m.lab_id = l.id
            )
          )
        ORDER BY lower(l.name), l.id;
      `,
      [userId, role],
    );
    return result.rows.map((row) => this.toLab(row));
  }

  async linkGithub(input: LinkEduGithubInput): Promise<EduAccount> {
    try {
      const result = await this.databaseService.query<EduAccountRow>(
        `
          UPDATE identity.edu_profiles
          SET github_user_id = $2,
              github_login = $3,
              github_avatar_url = $4,
              github_profile_url = $5,
              updated_at = NOW()
          WHERE user_id = $1
            AND role <> 'STUDENT'
            AND status = 'ACTIVE'
          RETURNING user_id;
        `,
        [
          input.userId,
          input.githubUserId,
          input.githubLogin,
          input.githubAvatarUrl,
          input.githubProfileUrl,
        ],
      );
      if (!result.rows[0]) {
        throw new Error('EDU GitHub link found no active staff profile');
      }
      const account = await this.findByUserId(input.userId);
      if (!account) throw new Error('EDU GitHub link returned no account');
      return account;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new EduGithubLinkConflictError();
      }
      throw error;
    }
  }

  private toAccount(row: EduAccountRow): EduAccount {
    return {
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      status: row.status,
      homeLabId: row.home_lab_id,
      githubUserId: row.github_user_id,
      githubLogin: row.github_login,
      githubAvatarUrl: row.github_avatar_url,
      githubProfileUrl: row.github_profile_url,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
      supabaseUserId: row.supabase_user_id,
    };
  }

  private toLab(row: EduLabRow): EduLab {
    return {
      id: row.id,
      name: row.name,
      githubOrgName: row.github_org_name,
    };
  }

  private loginForEmail(email: string): string {
    const localPart = email.split('@')[0]?.trim().toLowerCase() || 'student';
    return localPart.replaceAll(/[^a-z0-9._-]+/g, '-').slice(0, 120);
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String((error as { code?: unknown }).code) === '23505'
    );
  }
}
