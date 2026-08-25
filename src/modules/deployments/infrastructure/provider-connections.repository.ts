import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../../kernel/db/database.service';
import type {
  EnvProvider,
  ProviderConnectionStatus,
  ProviderConnectionSummary,
  ProviderConnectionWithToken,
} from '../core/deployments.types';

interface ProviderConnectionRow {
  id: string;
  provider: EnvProvider;
  label: string;
  encrypted_token?: string;
  token_last_four: string;
  status: ProviderConnectionStatus;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface CreateProviderConnectionInput {
  userId: string;
  provider: EnvProvider;
  label: string;
  encryptedToken: string;
  tokenLastFour: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class ProviderConnectionsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async createProviderConnection(
    input: CreateProviderConnectionInput,
  ): Promise<ProviderConnectionSummary> {
    const result = await this.databaseService.query<ProviderConnectionRow>(
      `
        INSERT INTO env_provisioning.provider_connections (
          user_id,
          provider,
          label,
          encrypted_token,
          token_last_four,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, provider, label, token_last_four, status, metadata, created_at, updated_at, last_used_at;
      `,
      [
        input.userId,
        input.provider,
        input.label,
        input.encryptedToken,
        input.tokenLastFour,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        'env_provisioning.provider_connections INSERT returned no row',
      );
    }

    return this.toSummary(row);
  }

  async listProviderConnections(
    userId: string,
  ): Promise<ProviderConnectionSummary[]> {
    const result = await this.databaseService.query<ProviderConnectionRow>(
      `
        SELECT id, provider, label, token_last_four, status, metadata, created_at, updated_at, last_used_at
        FROM env_provisioning.provider_connections
        WHERE user_id = $1
        ORDER BY created_at DESC;
      `,
      [userId],
    );

    return result.rows.map((row) => this.toSummary(row));
  }

  async findActiveProviderConnection(
    id: string,
    userId: string,
  ): Promise<ProviderConnectionWithToken | null> {
    const result = await this.databaseService.query<ProviderConnectionRow>(
      `
        SELECT id, provider, label, encrypted_token, token_last_four, status, metadata, created_at, updated_at, last_used_at
        FROM env_provisioning.provider_connections
        WHERE id = $1
          AND user_id = $2
          AND status = 'active'
        LIMIT 1;
      `,
      [id, userId],
    );
    const row = result.rows[0];
    if (!row?.encrypted_token) {
      return null;
    }

    return {
      ...this.toSummary(row),
      encryptedToken: row.encrypted_token,
    };
  }

  async revokeProviderConnection(id: string, userId: string): Promise<boolean> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        UPDATE env_provisioning.provider_connections
        SET status = 'revoked', updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
          AND status = 'active'
        RETURNING id;
      `,
      [id, userId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async markProviderConnectionUsed(id: string): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE env_provisioning.provider_connections
        SET last_used_at = NOW(), updated_at = NOW()
        WHERE id = $1;
      `,
      [id],
    );
  }

  private toSummary(row: ProviderConnectionRow): ProviderConnectionSummary {
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      tokenLastFour: row.token_last_four,
      status: row.status,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    };
  }
}
