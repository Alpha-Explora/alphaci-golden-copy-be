import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';

export interface ProjectCiTokenInput {
  projectId: string;
  tokenHash: string;
  tokenPrefix: string;
}

export interface CiValidationContextRow {
  project_id: string;
  tenant_id: string;
  user_id: string;
  repo_full_name: string;
  project_status: 'provisioning' | 'provisioned' | 'failed';
  token_status: 'active' | 'revoked';
  subscription_status: 'inactive' | 'active' | 'canceled' | null;
  /**
   * Mirrors identity.app_users.is_internal. Internal users are fully entitled
   * without a billing row, exactly as SubscriptionService.getForUser treats
   * them — this column is what lets CI validation honour that same rule.
   * Null when the project's owner row is missing.
   */
  is_internal: boolean | null;
}

interface ProjectTokenStatusRow {
  status: 'active' | 'revoked';
  token_prefix: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface ProjectTokenStatus {
  status: 'active' | 'revoked';
  tokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

@Injectable()
export class CiTokensRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async upsertProjectToken(data: ProjectCiTokenInput): Promise<void> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ project_id: string }>(
      `
        INSERT INTO ci.project_ci_tokens (
          project_id,
          token_hash,
          token_prefix,
          status
        )
        SELECT $1, $2, $3, 'active'
        FROM projects.provisioned_projects AS project
        WHERE project.id = $1
          AND project.tenant_id = $4::uuid
        ON CONFLICT (project_id)
        DO UPDATE SET
          token_hash = EXCLUDED.token_hash,
          token_prefix = EXCLUDED.token_prefix,
          status = 'active',
          revoked_at = NULL,
          updated_at = NOW()
        RETURNING project_id;
      `,
      [data.projectId, data.tokenHash, data.tokenPrefix, tenantId],
    );

    if (!result.rows[0]) {
      throw new Error(
        'Project does not belong to the validated tenant context',
      );
    }
  }

  async findDeploymentGlobalValidationContext(
    tokenHash: string,
    repoFullName: string,
  ): Promise<CiValidationContextRow | null> {
    // This is the bearer-token CI ingress path, not a user-facing read. The
    // generated workflow has no session tenant context, so validation is
    // intentionally deployment-global and is bounded by the token hash plus
    // repository identity. User-facing token status reads remain tenant-scoped
    // below.
    const result = await this.databaseService.query<CiValidationContextRow>(
      `
        SELECT
          p.id AS project_id,
          p.tenant_id,
          p.user_id,
          p.repo_full_name,
          p.status AS project_status,
          t.status AS token_status,
          s.status AS subscription_status,
          u.is_internal
        FROM ci.project_ci_tokens t
        JOIN projects.provisioned_projects p ON p.id = t.project_id
        LEFT JOIN identity.app_users u ON u.id = p.user_id
        LEFT JOIN LATERAL (
          SELECT status
          FROM billing.user_subscriptions
          WHERE user_id = p.user_id
          ORDER BY created_at DESC
          LIMIT 1
        ) s ON true
        WHERE t.token_hash = $1
          AND p.repo_full_name = $2
          AND p.tenant_id IS NOT NULL
        LIMIT 1;
      `,
      [tokenHash, repoFullName],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Compatibility name for existing CI validation callers. This remains the
   * deployment-global bearer-token path; user-facing token reads below require
   * tenant context.
   */
  async findValidationContext(
    tokenHash: string,
    repoFullName: string,
  ): Promise<CiValidationContextRow | null> {
    return this.findDeploymentGlobalValidationContext(tokenHash, repoFullName);
  }

  async revokeProjectTokens(projectId: string): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.databaseService.query(
      `
        UPDATE ci.project_ci_tokens AS token
        SET
          status = 'revoked',
          revoked_at = NOW(),
          updated_at = NOW()
        FROM projects.provisioned_projects AS project
        WHERE token.project_id = project.id
          AND token.project_id = $1
          AND project.tenant_id = $2::uuid
          AND token.status = 'active';
      `,
      [projectId, tenantId],
    );
  }

  async findProjectTokenStatus(
    projectId: string,
  ): Promise<ProjectTokenStatus | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<ProjectTokenStatusRow>(
      `
        SELECT
          token.status,
          token.token_prefix,
          token.created_at,
          token.updated_at,
          token.revoked_at
        FROM ci.project_ci_tokens AS token
        JOIN projects.provisioned_projects AS project
          ON project.id = token.project_id
        WHERE token.project_id = $1
          AND project.tenant_id = $2::uuid
        LIMIT 1;
      `,
      [projectId, tenantId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      status: row.status,
      tokenPrefix: row.token_prefix,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
    };
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
  }
}
