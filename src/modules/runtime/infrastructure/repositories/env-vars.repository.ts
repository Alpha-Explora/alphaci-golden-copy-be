import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import type {
  EnvLane,
  EnvProvider,
  EnvVarMetadata,
  EnvVarProvisionStatus,
  EnvVarScope,
} from '../../core/deployments.types';

interface EnvVarMetadataRow {
  id: string;
  project_id: string;
  deployment_target_id: string;
  environment: EnvLane;
  git_branch: string | null;
  key: string;
  provider: EnvProvider;
  value_stored: false;
  last_provisioned_at: string;
  last_provisioned_by: string;
  status: EnvVarProvisionStatus;
  error_summary: string | null;
  removed_at: string | null;
}

export interface UpsertEnvMetadataBatchInput extends EnvVarScope {
  projectId: string;
  deploymentTargetId: string;
  provider: EnvProvider;
  provisionedBy: string;
  entries: Array<{
    key: string;
    status: EnvVarProvisionStatus;
    errorSummary: string | null;
  }>;
}

export interface CountExistingActiveKeysInput extends EnvVarScope {
  deploymentTargetId: string;
  keys: string[];
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
export class EnvVarsRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext: TenantContextPort,
  ) {}

  async listEnvMetadata(projectId: string): Promise<EnvVarMetadata[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<EnvVarMetadataRow>(
      `
        SELECT metadata.*
        FROM env_provisioning.project_env_var_metadata AS metadata
        JOIN projects.provisioned_projects AS project
          ON project.id = metadata.project_id
        WHERE metadata.project_id = $1
          AND ${projectTenantPredicate('project', '$2')}
          AND metadata.removed_at IS NULL
        ORDER BY metadata.deployment_target_id, metadata.environment, metadata.git_branch NULLS FIRST, metadata.key;
      `,
      [projectId, tenantId],
    );

    return result.rows.map((row) => this.toMetadata(row));
  }

  async listEnvMetadataForUser(
    projectId: string,
    userId: string,
  ): Promise<EnvVarMetadata[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<EnvVarMetadataRow>(
      `
        SELECT metadata.*
        FROM env_provisioning.project_env_var_metadata AS metadata
        JOIN projects.provisioned_projects AS project
          ON project.id = metadata.project_id
        WHERE metadata.project_id = $1
          AND ${projectTenantPredicate('project', '$3')}
          AND (
            project.user_id = $2
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              JOIN orgs.workspaces AS workspace
                ON workspace.id = member.workspace_id
              WHERE member.workspace_id = project.workspace_id
                AND member.user_id = $2
                AND member.role IN ('admin', 'delegated_lead', 'member', 'viewer')
                AND workspace.tenant_id = $3::uuid
            )
          )
          AND metadata.removed_at IS NULL
        ORDER BY metadata.deployment_target_id, metadata.environment, metadata.git_branch NULLS FIRST, metadata.key;
      `,
      [projectId, userId, tenantId],
    );

    return result.rows.map((row) => this.toMetadata(row));
  }

  async upsertEnvMetadataBatch(
    input: UpsertEnvMetadataBatchInput,
  ): Promise<void> {
    const tenantId = this.requireTenantId();
    if (input.entries.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const placeholders = input.entries
      .map((entry, index) => {
        const offset = index * 9;
        values.push(
          input.projectId,
          input.deploymentTargetId,
          input.lane,
          input.gitBranch,
          entry.key,
          input.provider,
          input.provisionedBy,
          entry.status,
          entry.errorSummary,
        );
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
      })
      .join(', ');
    const tenantParam = input.entries.length * 9 + 1;
    values.push(tenantId);

    await this.databaseService.query(
      `
        INSERT INTO env_provisioning.project_env_var_metadata AS metadata (
          project_id,
          deployment_target_id,
          environment,
          git_branch,
          key,
          provider,
          value_stored,
          last_provisioned_at,
          last_provisioned_by,
          status,
          error_summary
        )
        SELECT input.project_id,
               input.deployment_target_id,
               input.environment,
               input.git_branch,
               input.key,
               input.provider,
               false,
               NOW(),
               input.last_provisioned_by,
               input.status,
               input.error_summary
        FROM (VALUES ${placeholders}) AS input(
          project_id,
          deployment_target_id,
          environment,
          git_branch,
          key,
          provider,
          last_provisioned_by,
          status,
          error_summary
        )
        JOIN projects.provisioned_projects AS project
          ON project.id = input.project_id
        JOIN env_provisioning.project_deployment_targets AS target
          ON target.id = input.deployment_target_id
         AND target.project_id = project.id
        WHERE ${projectTenantPredicate('project', `$${tenantParam}`)}
        -- Matches project_env_var_metadata_target_lane_branch_key_key, which is
        -- declared NULLS NOT DISTINCT so the branchless production rows still
        -- conflict with each other on (target, key).
        ON CONFLICT (deployment_target_id, environment, git_branch, key)
        DO UPDATE SET
          provider = EXCLUDED.provider,
          value_stored = false,
          last_provisioned_at = NOW(),
          last_provisioned_by = EXCLUDED.last_provisioned_by,
           status = EXCLUDED.status,
           error_summary = EXCLUDED.error_summary,
           removed_at = NULL,
           updated_at = NOW()
        WHERE EXISTS (
          SELECT 1
          FROM projects.provisioned_projects AS project
          WHERE project.id = metadata.project_id
            AND ${projectTenantPredicate('project', `$${tenantParam}`)}
        );
      `,
      values,
    );
  }

  async countExistingActiveKeys(
    input: CountExistingActiveKeysInput,
  ): Promise<number> {
    const tenantId = this.requireTenantId();
    if (input.keys.length === 0) {
      return 0;
    }

    const result = await this.databaseService.query<{
      existing_count: string | number;
    }>(
      `
        SELECT COUNT(*) AS existing_count
        FROM env_provisioning.project_env_var_metadata AS metadata
        JOIN env_provisioning.project_deployment_targets AS target
          ON target.id = metadata.deployment_target_id
         AND target.project_id = metadata.project_id
        JOIN projects.provisioned_projects AS project
          ON project.id = target.project_id
        WHERE metadata.deployment_target_id = $1
          AND metadata.environment = $2
          -- IS NOT DISTINCT FROM, not '=': the production lane stores NULL,
          -- and '= NULL' is never true, so plain equality would count zero
          -- existing production keys and charge quota for every re-provision.
          AND metadata.git_branch IS NOT DISTINCT FROM $3
          AND metadata.key = ANY($4::text[])
          AND ${projectTenantPredicate('project', '$5')}
          AND metadata.removed_at IS NULL;
      `,
      [
        input.deploymentTargetId,
        input.lane,
        input.gitBranch,
        input.keys,
        tenantId,
      ],
    );

    return Number(result.rows[0]?.existing_count ?? 0);
  }

  async findEnvMetadataForUser(
    metadataId: string,
    userId: string,
  ): Promise<EnvVarMetadata | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<EnvVarMetadataRow>(
      `
        SELECT metadata.*
        FROM env_provisioning.project_env_var_metadata AS metadata
        JOIN projects.provisioned_projects AS project
          ON project.id = metadata.project_id
        WHERE metadata.id = $1
          AND ${projectTenantPredicate('project', '$3')}
          AND (
            project.user_id = $2
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              JOIN orgs.workspaces AS workspace
                ON workspace.id = member.workspace_id
              WHERE member.workspace_id = project.workspace_id
                AND member.user_id = $2
                AND member.role IN ('admin', 'delegated_lead', 'member')
                AND workspace.tenant_id = $3::uuid
            )
          )
          AND metadata.removed_at IS NULL
        LIMIT 1;
      `,
      [metadataId, userId, tenantId],
    );

    const row = result.rows[0];
    return row ? this.toMetadata(row) : null;
  }

  async markEnvMetadataRemoved(
    metadataId: string,
    userId: string,
    errorSummary: string | null,
  ): Promise<EnvVarMetadata | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<EnvVarMetadataRow>(
      `
        UPDATE env_provisioning.project_env_var_metadata AS metadata
        SET removed_at = NOW(),
            error_summary = $3,
            updated_at = NOW()
        FROM projects.provisioned_projects AS project
        WHERE project.id = metadata.project_id
          AND metadata.id = $1
          AND ${projectTenantPredicate('project', '$4')}
          AND (
            project.user_id = $2
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              JOIN orgs.workspaces AS workspace
                ON workspace.id = member.workspace_id
              WHERE member.workspace_id = project.workspace_id
                AND member.user_id = $2
                AND member.role IN ('admin', 'delegated_lead', 'member')
                AND workspace.tenant_id = $4::uuid
            )
          )
        RETURNING metadata.*;
      `,
      [metadataId, userId, errorSummary, tenantId],
    );

    const row = result.rows[0];
    return row ? this.toMetadata(row) : null;
  }

  private toMetadata(row: EnvVarMetadataRow): EnvVarMetadata {
    return {
      id: row.id,
      projectId: row.project_id,
      deploymentTargetId: row.deployment_target_id,
      lane: row.environment,
      gitBranch: row.git_branch,
      key: row.key,
      provider: row.provider,
      valueStored: row.value_stored,
      lastProvisionedAt: row.last_provisioned_at,
      lastProvisionedBy: row.last_provisioned_by,
      status: row.status,
      errorSummary: row.error_summary,
      removedAt: row.removed_at,
    };
  }

  private requireTenantId(): string {
    return this.tenantContext.require().tenantId;
  }
}
