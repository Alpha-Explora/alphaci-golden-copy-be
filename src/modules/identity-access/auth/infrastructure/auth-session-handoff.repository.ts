import { Injectable, Logger } from '@nestjs/common';

import type { SessionUser } from '#kernel/auth/session-user.interface.js';
import { DatabaseService } from '#kernel/db/database.service.js';

export type AuthSessionHandoffPayload = {
  kind: 'authenticated';
  user: SessionUser;
};

interface HandoffRow {
  payload: AuthSessionHandoffPayload;
}

@Injectable()
export class AuthSessionHandoffRepository {
  private readonly logger = new Logger(AuthSessionHandoffRepository.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async save(
    token: string,
    payload: AuthSessionHandoffPayload,
    ttlSeconds = 120,
  ): Promise<void> {
    const result = await this.databaseService.query(
      `
        INSERT INTO identity.auth_session_handoffs (token, payload, expires_at)
        VALUES ($1, $2::jsonb, NOW() + ($3::int * INTERVAL '1 second'));
      `,
      [token, JSON.stringify(payload), ttlSeconds],
    );

    if (result.rowCount === 0) {
      throw new Error('Auth session handoff insert returned no affected rows');
    }
  }

  async findAndDelete(
    token: string,
  ): Promise<AuthSessionHandoffPayload | null> {
    const result = await this.databaseService.query<HandoffRow>(
      `
        DELETE FROM identity.auth_session_handoffs
        WHERE token = $1
          AND expires_at > NOW()
        RETURNING payload;
      `,
      [token],
    );

    const row = result.rows[0];
    if (!row) {
      this.logger.warn(
        `Auth session handoff not found or expired: ${token.slice(0, 8)}…`,
      );
      return null;
    }

    return row.payload;
  }

  async pruneExpired(): Promise<void> {
    try {
      await this.databaseService.query(
        `SELECT identity.clean_expired_auth_session_handoffs();`,
        [],
      );
    } catch (error) {
      this.logger.warn(
        `Auth session handoff prune failed (non-fatal): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
