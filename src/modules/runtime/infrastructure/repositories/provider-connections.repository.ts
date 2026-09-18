import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  EnvProvider,
  ProviderConnectionStatus,
  ProviderConnectionSummary,
  ProviderConnectionWithToken,
} from '../../core/deployments.types';

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
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async createProviderConnection(
    input: CreateProviderConnectionInput,
  ): Promise<ProviderConnectionSummary> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<ProviderConnectionRow>(
      `
        INSERT INTO env_provisioning.provider_connections (
          tenant_id,
          user_id,
          provider,
          label,
          encrypted_token,
          token_last_four,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, provider, label, token_last_four, status, metadata, created_at, updated_at, last_used_at;
      `,
      [
        tenantId,
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
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<ProviderConnectionRow>(
      `
        SELECT id, provider, label, token_last_four, status, metadata, created_at, updated_at, last_used_at
        FROM env_provisioning.provider_connections
        WHERE user_id = $1
          AND tenant_id = $2::uuid
        ORDER BY created_at DESC;
      `,
      [userId, tenantId],
    );

    return result.rows.map((row) => this.toSummary(row));
  }

  async findActiveProviderConnection(
    id: string,
    userId: string,
  ): Promise<ProviderConnectionWithToken | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<ProviderConnectionRow>(
      `
        SELECT id, provider, label, encrypted_token, token_last_four, status, metadata, created_at, updated_at, last_used_at
        FROM env_provisioning.provider_connections
        WHERE id = $1
          AND user_id = $2
          AND tenant_id = $3::uuid
          AND status = 'active'
        LIMIT 1;
      `,
      [id, userId, tenantId],
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
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ id: string }>(
      `
        UPDATE env_provisioning.provider_connections
        SET status = 'revoked', updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
          AND tenant_id = $3::uuid
          AND status = 'active'
        RETURNING id;
      `,
      [id, userId, tenantId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async markProviderConnectionUsed(id: string): Promise<void> {
    // This is a worker lifecycle marker, not a request-facing lookup. The
    // caller already holds the connection id obtained through a tenant-scoped
    // request path, so it deliberately remains usable by provider workers that
    // do not carry AsyncLocalStorage request context.
    await this.databaseService.query(
      `
        UPDATE env_provisioning.provider_connections
        SET last_used_at = NOW(), updated_at = NOW()
        WHERE id = $1;
      `,
      [id],
    );
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }

    return this.tenantContext.require().tenantId;
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
