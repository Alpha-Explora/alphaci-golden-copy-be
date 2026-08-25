import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../../../kernel/db/database.service';

export interface CreateGcpDeploymentTargetInput {
  workspaceId: string;
  projectId: string;
  appSlug: string;
  environment: 'dev' | 'stg' | 'uat' | 'prod' | 'preview';
  serviceSlot: 'web' | 'api' | 'worker' | 'standalone';
  gcpProjectId: string;
  region: string;
  artifactRegistryRepository: string;
  imageName: string;
  cloudRunServiceName: string;
  runtimeServiceAccount: string;
  deployerServiceAccount: string;
}

export interface GcpDeploymentTargetSummary {
  id: string;
  workspaceId: string;
  projectId: string;
  appSlug: string;
  environment: string;
  serviceSlot: string;
  gcpProjectId: string;
  region: string;
  artifactRegistryRepository: string;
  cloudRunServiceName: string;
  runtimeServiceAccount: string;
}

export interface GcpProvisioningFailure {
  code: string;
  safeMessage: string;
}

interface GcpDeploymentTargetRow {
  id: string;
  workspace_id: string;
  project_id: string;
  app_slug: string;
  environment: string;
  service_slot: string;
  gcp_project_id: string;
  region: string;
  artifact_registry_repo: string;
  cloud_run_service_name: string;
  runtime_service_account: string;
}

@Injectable()
export class GcpDeploymentTargetsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async createOrGet(
    input: CreateGcpDeploymentTargetInput,
  ): Promise<GcpDeploymentTargetSummary> {
    const result = await this.databaseService.query<GcpDeploymentTargetRow>(
      `
        INSERT INTO runtime_deployments.deployment_targets (
          workspace_id,
          project_id,
          owner_type,
          runtime_scope,
          product_slug,
          customer_slug,
          app_slug,
          environment,
          service_slot,
          gcp_project_id,
          region,
          artifact_registry_location,
          artifact_registry_repo,
          image_name,
          cloud_run_service_name,
          runtime_service_account,
          deployer_service_account,
          metadata
        )
        VALUES (
          $1, $2, 'alphaci_customer', 'shared_project', 'alphaci', $3, $4,
          $5, $6, $7, $8, $8, $9, $10, $11, $12, $13::jsonb
        )
        ON CONFLICT (workspace_id, project_id, app_slug, environment, service_slot)
        DO UPDATE SET
          image_name = EXCLUDED.image_name,
          runtime_service_account = EXCLUDED.runtime_service_account,
          deployer_service_account = EXCLUDED.deployer_service_account,
          updated_at = NOW()
        RETURNING *;
      `,
      [
        input.workspaceId,
        input.projectId,
        `workspace-${input.workspaceId}`,
        input.appSlug,
        input.environment,
        input.serviceSlot,
        input.gcpProjectId,
        input.region,
        input.artifactRegistryRepository,
        input.imageName,
        input.cloudRunServiceName,
        input.runtimeServiceAccount,
        input.deployerServiceAccount,
        JSON.stringify({ managedBy: 'alphaci' }),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('GCP deployment target create returned no row');
    }

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      appSlug: row.app_slug,
      environment: row.environment,
      serviceSlot: row.service_slot,
      gcpProjectId: row.gcp_project_id,
      region: row.region,
      artifactRegistryRepository: row.artifact_registry_repo,
      cloudRunServiceName: row.cloud_run_service_name,
      runtimeServiceAccount: row.runtime_service_account,
    };
  }

  async markProvisioned(targetId: string): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE runtime_deployments.deployment_targets
        SET provisioning_status = 'provisioned',
            deployment_status = 'healthy',
            last_deployment_error_code = NULL,
            last_deployment_error_safe_message = NULL,
            updated_at = NOW()
        WHERE id = $1;
      `,
      [targetId],
    );
  }

  async markFailed(
    targetId: string,
    failure: GcpProvisioningFailure,
  ): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE runtime_deployments.deployment_targets
        SET provisioning_status = 'failed',
            deployment_status = 'failed',
            last_deployment_error_code = $1,
            last_deployment_error_safe_message = $2,
            updated_at = NOW()
        WHERE id = $3;
      `,
      [failure.code, failure.safeMessage, targetId],
    );
  }
}
