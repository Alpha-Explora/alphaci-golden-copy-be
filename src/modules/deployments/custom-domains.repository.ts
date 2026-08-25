import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../kernel/db/database.service';
import type {
  CustomDomainSummary,
  DomainVerificationChallenge,
  EnvProvider,
} from './deployments.types';

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

@Injectable()
export class CustomDomainsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async listForProject(projectId: string): Promise<CustomDomainSummary[]> {
    const result = await this.databaseService.query<CustomDomainRow>(
      `
        SELECT *
        FROM env_provisioning.project_custom_domains
        WHERE project_id = $1
        ORDER BY git_branch NULLS FIRST, hostname;
      `,
      [projectId],
    );

    return result.rows.map((row) => this.toSummary(row));
  }

  async findById(id: string): Promise<CustomDomainSummary | null> {
    const result = await this.databaseService.query<CustomDomainRow>(
      `
        SELECT *
        FROM env_provisioning.project_custom_domains
        WHERE id = $1
        LIMIT 1;
      `,
      [id],
    );

    const row = result.rows[0];
    return row ? this.toSummary(row) : null;
  }

  async insert(input: InsertCustomDomainInput): Promise<CustomDomainSummary> {
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW(), $10)
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
    const result = await this.databaseService.query<CustomDomainRow>(
      `
        UPDATE env_provisioning.project_custom_domains
        SET verified = $2,
            verification = $3::jsonb,
            misconfigured = $4,
            last_error_safe_message = $5,
            last_checked_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *;
      `,
      [
        input.id,
        input.verified,
        JSON.stringify(input.verification),
        input.misconfigured,
        input.lastErrorSafeMessage,
      ],
    );

    const row = result.rows[0];
    return row ? this.toSummary(row) : null;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.databaseService.query(
      `
        DELETE FROM env_provisioning.project_custom_domains
        WHERE id = $1;
      `,
      [id],
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
}
