import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import type {
  CustomDomainSummary,
  DomainVerificationChallenge,
  EnvProvider,
} from '../../core/deployments.types';

interface CustomDomainRow {
  id: string;
  project_id: string;
  deployment_target_id: string;
  provider: EnvProvider;
  hostname: string;
  apex_domain: string | null;
  git_branch: string | null;
  verified: boolean;
  verification: DomainVerificationChallenge[] | null;
  misconfigured: boolean | null;
  last_checked_at: string | null;
  last_error_safe_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertCustomDomainInput {
  projectId: string;
  deploymentTargetId: string;
  provider: EnvProvider;
  hostname: string;
  apexDomain: string | null;
  gitBranch: string | null;
  verified: boolean;
  verification: DomainVerificationChallenge[];
  misconfigured: boolean | null;
  createdBy: string;
}

export interface UpdateCustomDomainStateInput {
  id: string;
  verified: boolean;
  verification: DomainVerificationChallenge[];
  misconfigured: boolean | null;
  lastErrorSafeMessage: string | null;
}

function projectTenantPredicate(
  projectAlias: string,
  tenantParam: string,
): string {
  return `
    ${projectAlias}.tenant_id = ${tenantParam}::uuid
    AND (
      ${projectAlias}.workspace_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM orgs.workspaces AS tenant_workspace
        WHERE tenant_workspace.id = ${projectAlias}.workspace_id
          AND tenant_workspace.tenant_id = ${tenantParam}::uuid
      )
    )
  `;
}

@Injectable()
export class CustomDomainsRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext: TenantContextPort,
  ) {}

  async listForProject(projectId: string): Promise<CustomDomainSummary[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<CustomDomainRow>(
      `
        SELECT domain.*
        FROM env_provisioning.project_custom_domains AS domain
        JOIN projects.provisioned_projects AS project
          ON project.id = domain.project_id
        WHERE domain.project_id = $1
          AND ${projectTenantPredicate('project', '$2')}
        ORDER BY domain.git_branch NULLS FIRST, domain.hostname;
      `,
      [projectId, tenantId],
    );

    return result.rows.map((row) => this.toSummary(row));
  }

  async findById(id: string): Promise<CustomDomainSummary | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<CustomDomainRow>(
      `
        SELECT domain.*
        FROM env_provisioning.project_custom_domains AS domain
        JOIN projects.provisioned_projects AS project
          ON project.id = domain.project_id
        WHERE domain.id = $1
          AND ${projectTenantPredicate('project', '$2')}
        LIMIT 1;
      `,
      [id, tenantId],
    );

    const row = result.rows[0];
    return row ? this.toSummary(row) : null;
  }

  async insert(input: InsertCustomDomainInput): Promise<CustomDomainSummary> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<CustomDomainRow>(
      `
        INSERT INTO env_provisioning.project_custom_domains (
          project_id,
          deployment_target_id,
          provider,
          hostname,
          apex_domain,
          git_branch,
          verified,
          verification,
          misconfigured,
          last_checked_at,
          created_by
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW(), $10
        FROM projects.provisioned_projects AS project
        JOIN env_provisioning.project_deployment_targets AS target
          ON target.id = $2
         AND target.project_id = project.id
        WHERE project.id = $1
          AND ${projectTenantPredicate('project', '$11')}
        RETURNING *;
      `,
      [
        input.projectId,
        input.deploymentTargetId,
        input.provider,
        input.hostname,
        input.apexDomain,
        input.gitBranch,
        input.verified,
        JSON.stringify(input.verification),
        input.misconfigured,
        input.createdBy,
        tenantId,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        'env_provisioning.project_custom_domains INSERT returned no row',
      );
    }
    return this.toSummary(row);
  }

  async updateState(
    input: UpdateCustomDomainStateInput,
  ): Promise<CustomDomainSummary | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<CustomDomainRow>(
      `
        UPDATE env_provisioning.project_custom_domains AS domain
        SET verified = $2,
            verification = $3::jsonb,
            misconfigured = $4,
            last_error_safe_message = $5,
            last_checked_at = NOW(),
            updated_at = NOW()
        FROM projects.provisioned_projects AS project
        WHERE domain.id = $1
          AND project.id = domain.project_id
          AND ${projectTenantPredicate('project', '$6')}
        RETURNING domain.*;
      `,
      [
        input.id,
        input.verified,
        JSON.stringify(input.verification),
        input.misconfigured,
        input.lastErrorSafeMessage,
        tenantId,
      ],
    );

    const row = result.rows[0];
    return row ? this.toSummary(row) : null;
  }

  async deleteById(id: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query(
      `
        DELETE FROM env_provisioning.project_custom_domains AS domain
        USING projects.provisioned_projects AS project
        WHERE domain.id = $1
          AND project.id = domain.project_id
          AND ${projectTenantPredicate('project', '$2')};
      `,
      [id, tenantId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  private toSummary(row: CustomDomainRow): CustomDomainSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      deploymentTargetId: row.deployment_target_id,
      provider: row.provider,
      hostname: row.hostname,
      apexDomain: row.apex_domain,
      gitBranch: row.git_branch,
      verified: row.verified,
      verification: row.verification ?? [],
      misconfigured: row.misconfigured,
      lastCheckedAt: row.last_checked_at,
      lastErrorSafeMessage: row.last_error_safe_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private requireTenantId(): string {
    return this.tenantContext.require().tenantId;
  }
}
