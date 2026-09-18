import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service.js';

export type VerificationCodePurpose =
  | 'signup'
  | 'login_verification'
  | 'email_change';

interface VerificationCodeRow {
  id: string;
  normalized_email: string;
  code_hash: string;
  pending_identity_id: string | null;
  attempt_count: number;
  sent_count: number;
  expires_at: string;
}

export interface VerificationCodeRecord {
  id: string;
  normalizedEmail: string;
  codeHash: string;
  pendingIdentityId: string | null;
  attemptCount: number;
  sentCount: number;
  expiresAt: string;
}

@Injectable()
export class EmailVerificationCodesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async create(input: {
    normalizedEmail: string;
    codeHash: string;
    purpose: VerificationCodePurpose;
    pendingIdentityId?: string;
    expiresAt: Date;
  }): Promise<{ id: string }> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        INSERT INTO identity.email_verification_codes (
          normalized_email,
          code_hash,
          purpose,
          pending_identity_id,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id;
      `,
      [
        input.normalizedEmail,
        input.codeHash,
        input.purpose,
        input.pendingIdentityId ?? null,
        input.expiresAt,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error('Verification code insert returned no row');
    return row;
  }

  async findLatestActive(
    normalizedEmail: string,
    purpose: VerificationCodePurpose,
  ): Promise<VerificationCodeRecord | null> {
    const result = await this.databaseService.query<VerificationCodeRow>(
      `
        SELECT
          id,
          normalized_email,
          code_hash,
          pending_identity_id,
          attempt_count,
          sent_count,
          expires_at
        FROM identity.email_verification_codes
        WHERE normalized_email = $1
          AND purpose = $2
          AND consumed_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      [normalizedEmail, purpose],
    );

    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  async incrementAttempt(id: string): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE identity.email_verification_codes
        SET attempt_count = attempt_count + 1
        WHERE id = $1;
      `,
      [id],
    );
  }

  async consumeAllForEmail(
    normalizedEmail: string,
    purpose: VerificationCodePurpose,
  ): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE identity.email_verification_codes
        SET consumed_at = NOW()
        WHERE normalized_email = $1
          AND purpose = $2
          AND consumed_at IS NULL;
      `,
      [normalizedEmail, purpose],
    );
  }

  private toRecord(row: VerificationCodeRow): VerificationCodeRecord {
    return {
      id: row.id,
      normalizedEmail: row.normalized_email,
      codeHash: row.code_hash,
      pendingIdentityId: row.pending_identity_id,
      attemptCount: row.attempt_count,
      sentCount: row.sent_count,
      expiresAt: row.expires_at,
    };
  }
}
