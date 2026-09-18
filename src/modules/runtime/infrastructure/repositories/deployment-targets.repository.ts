import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import type {
  DeploymentTargetStatus,
  DeploymentStrategy,
  DeploymentTargetSummary,
  EnvOwnershipMode,
  EnvProvider,
  EnvTargetSlot,
  RenderEnvironmentName,
  RenderRuntime,
  RenderServiceType,
  UpdateDeploymentTargetMetadataInput,
} from '../../core/deployments.types';

interface DeploymentTargetRow {
  id: string;
  project_id: string;
  slot: EnvTargetSlot;
  ownership_mode: EnvOwnershipMode;
  provider: EnvProvider;
  provider_connection_id: string | null;
  provider_project_id: string;
  provider_project_name: string;
  repo_full_name: string;
  branch_name: string;
  root_directory: string | null;
  build_command: string | null;
  start_command: string | null;
  render_service_type: RenderServiceType | null;
  render_instance_type: string | null;
  render_region: string | null;
  render_environment_name: RenderEnvironmentName | null;
  docker_context: string | null;
  dockerfile_path: string | null;
  image_url: string | null;
  environment_map: Record<string, unknown>;
  deployment_strategy: DeploymentStrategy | null;
  provider_metadata: Record<string, unknown> | null;
  status: DeploymentTargetStatus;
}

export interface CreateDeploymentTargetInput {
  projectId: string;
  slot: EnvTargetSlot;
  ownershipMode: EnvOwnershipMode;
  provider: EnvProvider;
  providerConnectionId?: string | null;
  providerProjectId: string;
  providerProjectName: string;
  repoFullName: string;
  branchName: string;
  rootDirectory?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  renderServiceType?: RenderServiceType | null | undefined;
  renderInstanceType?: string | null | undefined;
  renderRegion?: string | null | undefined;
  renderEnvironmentName?: RenderEnvironmentName | null | undefined;
  dockerContext?: string | null | undefined;
  dockerfilePath?: string | null | undefined;
  imageUrl?: string | null | undefined;
  environmentMap?: Record<string, unknown>;
  deploymentStrategy?: DeploymentStrategy;
  providerMetadata?: Record<string, unknown>;
}

function toInsertParams(input: CreateDeploymentTargetInput): unknown[] {
  return [
    input.projectId,
    input.slot,
    input.ownershipMode,
    input.provider,
    input.providerConnectionId ?? null,
    input.providerProjectId,
    input.providerProjectName,
    input.repoFullName,
    input.branchName,
    input.rootDirectory ?? null,
    input.buildCommand ?? null,
    input.startCommand ?? null,
    input.renderServiceType ?? null,
    input.renderInstanceType ?? null,
    input.renderRegion ?? null,
    input.renderEnvironmentName ?? null,
    input.dockerContext ?? null,
    input.dockerfilePath ?? null,
    input.imageUrl ?? null,
    JSON.stringify(input.environmentMap ?? {}),
    input.deploymentStrategy ?? 'provider_native',
    JSON.stringify(input.providerMetadata ?? {}),
  ];
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
export class DeploymentTargetsRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext: TenantContextPort,
  ) {}

  async createDeploymentTarget(
    input: CreateDeploymentTargetInput,
  ): Promise<DeploymentTargetSummary> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeploymentTargetRow>(
      `
        INSERT INTO env_provisioning.project_deployment_targets (
          project_id,
          slot,
          ownership_mode,
          provider,
          provider_connection_id,
          provider_project_id,
          provider_project_name,
          repo_full_name,
          branch_name,
          root_directory,
          build_command,
          start_command,
          render_service_type,
          render_instance_type,
          render_region,
          render_environment_name,
          docker_context,
          dockerfile_path,
          image_url,
          environment_map,
          deployment_strategy,
          provider_metadata
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
        FROM projects.provisioned_projects AS project
        WHERE project.id = $1
          AND ${projectTenantPredicate('project', '$23')}
        RETURNING *;
      `,
      [...toInsertParams(input), tenantId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        'env_provisioning.project_deployment_targets INSERT returned no row',
      );
    }

    return this.toSummary(row);
  }

  async listDeploymentTargets(
    projectId: string,
  ): Promise<DeploymentTargetSummary[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeploymentTargetRow>(
      `
        SELECT target.*
        FROM env_provisioning.project_deployment_targets AS target
        JOIN projects.provisioned_projects AS project
          ON project.id = target.project_id
        WHERE target.project_id = $1
          AND ${projectTenantPredicate('project', '$2')}
        ORDER BY target.created_at DESC;
      `,
      [projectId, tenantId],
    );

    return result.rows.map((row) => this.toSummary(row));
  }

  async updateProviderMetadata(
    targetId: string,
    providerMetadata: Record<string, unknown>,
    status?: DeploymentTargetStatus,
  ): Promise<DeploymentTargetSummary> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeploymentTargetRow>(
      `
        UPDATE env_provisioning.project_deployment_targets AS target
        SET provider_metadata = $2,
            status = COALESCE($3, status),
            updated_at = NOW()
        FROM projects.provisioned_projects AS project
        WHERE target.id = $1
          AND project.id = target.project_id
          AND ${projectTenantPredicate('project', '$4')}
        RETURNING target.*;
      `,
      [targetId, JSON.stringify(providerMetadata), status ?? null, tenantId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        'env_provisioning.project_deployment_targets UPDATE returned no row',
      );
    }

    return this.toSummary(row);
  }

  async updateDeploymentTargetMetadataForUser(
    projectId: string,
    targetId: string,
    userId: string,
    input: UpdateDeploymentTargetMetadataInput,
  ): Promise<DeploymentTargetSummary | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeploymentTargetRow>(
      `
        UPDATE env_provisioning.project_deployment_targets AS target
        SET slot = CASE WHEN $4 THEN $5 ELSE target.slot END,
            provider_project_name = CASE WHEN $6 THEN $7 ELSE target.provider_project_name END,
            branch_name = CASE WHEN $8 THEN $9 ELSE target.branch_name END,
            root_directory = CASE WHEN $10 THEN $11 ELSE target.root_directory END,
            build_command = CASE WHEN $12 THEN $13 ELSE target.build_command END,
            start_command = CASE WHEN $14 THEN $15 ELSE target.start_command END,
            render_environment_name = CASE WHEN $16 THEN $17 ELSE target.render_environment_name END,
            updated_at = NOW()
        FROM projects.provisioned_projects AS project
        WHERE project.id = target.project_id
          AND target.project_id = $1
          AND target.id = $2
          AND ${projectTenantPredicate('project', '$18')}
          AND (
            project.user_id = $3
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              JOIN orgs.workspaces AS workspace
                ON workspace.id = member.workspace_id
              WHERE member.workspace_id = project.workspace_id
                AND member.user_id = $3
                AND member.role IN ('admin', 'delegated_lead', 'member')
                AND workspace.tenant_id = $18::uuid
            )
          )
        RETURNING target.*;
      `,
      [
        projectId,
        targetId,
        userId,
        input.slot !== undefined,
        input.slot ?? null,
        input.providerProjectName !== undefined,
        input.providerProjectName ?? null,
        input.branchName !== undefined,
        input.branchName ?? null,
        input.rootDirectory !== undefined,
        input.rootDirectory ?? null,
        input.buildCommand !== undefined,
        input.buildCommand ?? null,
        input.startCommand !== undefined,
        input.startCommand ?? null,
        input.renderEnvironmentName !== undefined,
        input.renderEnvironmentName ?? null,
        tenantId,
      ],
    );

    const row = result.rows[0];
    return row ? this.toSummary(row) : null;
  }

  async deleteDeploymentTargetForUser(
    projectId: string,
    targetId: string,
    userId: string,
  ): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<{ id: string }>(
      `
        DELETE FROM env_provisioning.project_deployment_targets AS target
        USING projects.provisioned_projects AS project
        WHERE project.id = target.project_id
          AND target.project_id = $1
          AND target.id = $2
          AND ${projectTenantPredicate('project', '$4')}
          AND (
            project.user_id = $3
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              JOIN orgs.workspaces AS workspace
                ON workspace.id = member.workspace_id
              WHERE member.workspace_id = project.workspace_id
                AND member.user_id = $3
                AND member.role IN ('admin', 'delegated_lead', 'member')
                AND workspace.tenant_id = $4::uuid
            )
          )
        RETURNING target.id;
      `,
      [projectId, targetId, userId, tenantId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async findDeploymentTargetForUser(
    targetId: string,
    userId: string,
  ): Promise<DeploymentTargetSummary | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<DeploymentTargetRow>(
      `
        SELECT t.*
        FROM env_provisioning.project_deployment_targets t
        JOIN projects.provisioned_projects p ON p.id = t.project_id
        WHERE t.id = $1
          AND ${projectTenantPredicate('p', '$3')}
          AND (
            p.user_id = $2
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              JOIN orgs.workspaces AS workspace
                ON workspace.id = member.workspace_id
              WHERE member.workspace_id = p.workspace_id
                AND member.user_id = $2
                AND member.role IN ('admin', 'delegated_lead', 'member')
                AND workspace.tenant_id = $3::uuid
            )
          )
        LIMIT 1;
      `,
      [targetId, userId, tenantId],
    );

    const row = result.rows[0];
    return row ? this.toSummary(row) : null;
  }

  private requireTenantId(): string {
    return this.tenantContext.require().tenantId;
  }

  private toSummary(row: DeploymentTargetRow): DeploymentTargetSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      slot: row.slot,
      ownershipMode: row.ownership_mode,
      provider: row.provider,
      providerConnectionId: row.provider_connection_id,
      providerProjectId: row.provider_project_id,
      providerProjectName: row.provider_project_name,
      repoFullName: row.repo_full_name,
      branchName: row.branch_name,
      rootDirectory: row.root_directory,
      buildCommand: row.build_command,
      startCommand: row.start_command,
      renderServiceType: row.render_service_type,
      renderRuntime: this.renderRuntimeFromMetadata(row.provider_metadata),
      renderInstanceType: row.render_instance_type,
      renderRegion: row.render_region,
      renderEnvironmentName: row.render_environment_name,
      dockerContext: row.docker_context,
      dockerfilePath: row.dockerfile_path,
      imageUrl: row.image_url,
      environmentMap: row.environment_map ?? {},
      deploymentStrategy: row.deployment_strategy ?? 'provider_native',
      providerMetadata: row.provider_metadata ?? {},
      status: row.status,
    };
  }

  private renderRuntimeFromMetadata(
    metadata: Record<string, unknown> | null,
  ): RenderRuntime | null {
    const value = metadata?.['renderRuntime'];
    return value === 'node' ||
      value === 'python' ||
      value === 'ruby' ||
      value === 'go' ||
      value === 'rust' ||
      value === 'elixir' ||
      value === 'docker'
      ? value
      : null;
  }
}
