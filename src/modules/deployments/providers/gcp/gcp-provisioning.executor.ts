import { Inject, Injectable } from '@nestjs/common';

import {
  GCP_RUNTIME_ADAPTER,
  GcpRuntimeAdapterError,
  type GcpRuntimeAdapter,
  type GcpRuntimeEnvironment,
} from './gcp-runtime.port';
import { GcpDeploymentTargetsRepository } from './gcp-deployment-targets.repository';
import {
  ProvisioningJobsRepository,
  type ClaimedProvisioningJob,
} from './provisioning-jobs.repository';

export interface ExecuteGcpProvisioningInput {
  workspaceId: string;
  projectId: string;
  deploymentTargetId: string;
  gcpProjectId: string;
  region: string;
  artifactRegistryRepository: string;
  serviceName: string;
  imageName: string;
  runtimeServiceAccount: string;
  environment: GcpRuntimeEnvironment;
}

export interface ExecuteGcpProvisioningResult {
  repositoryUri: string;
  serviceUrl: string;
  revision: string;
}

/** Executes a job already persisted by GcpProvisioningService. */
@Injectable()
export class GcpProvisioningExecutor {
  constructor(
    @Inject(GCP_RUNTIME_ADAPTER)
    private readonly runtime: GcpRuntimeAdapter,
    private readonly provisioningJobs?: ProvisioningJobsRepository,
    private readonly deploymentTargets?: GcpDeploymentTargetsRepository,
  ) {}

  async execute(
    input: ExecuteGcpProvisioningInput,
  ): Promise<ExecuteGcpProvisioningResult> {
    const labels = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      deploymentTargetId: input.deploymentTargetId,
      environment: input.environment,
    };
    const registry = await this.runtime.ensureArtifactRegistry({
      gcpProjectId: input.gcpProjectId,
      region: input.region,
      repository: input.artifactRegistryRepository,
      labels,
    });
    const service = await this.runtime.ensureCloudRunService({
      gcpProjectId: input.gcpProjectId,
      region: input.region,
      serviceName: input.serviceName,
      imageName: input.imageName,
      runtimeServiceAccountEmail: input.runtimeServiceAccount,
      labels,
    });

    return {
      repositoryUri: registry.repositoryUri,
      serviceUrl: service.serviceUrl,
      revision: service.revision,
    };
  }

  async executeClaimed(
    job: ClaimedProvisioningJob,
  ): Promise<ExecuteGcpProvisioningResult> {
    if (!job.deploymentTargetId) {
      throw new Error('Claimed GCP provisioning job has no deployment target');
    }
    const provisioningJobs = this.provisioningJobs;
    const deploymentTargets = this.deploymentTargets;
    if (!provisioningJobs || !deploymentTargets) {
      throw new Error('GCP provisioning lifecycle dependencies are unavailable');
    }

    try {
      const result = await this.execute(this.toExecutionInput(job));
      await provisioningJobs.complete(job.id);
      await deploymentTargets.markProvisioned(job.deploymentTargetId);
      return result;
    } catch (error) {
      const failure = this.toSafeFailure(error);
      await provisioningJobs.fail(job.id, failure);
      await deploymentTargets.markFailed(job.deploymentTargetId, failure);
      throw error;
    }
  }

  private toExecutionInput(
    job: ClaimedProvisioningJob,
  ): ExecuteGcpProvisioningInput {
    const payload = job.payload;
    const required = [
      'gcpProjectId',
      'region',
      'artifactRegistryRepository',
      'serviceName',
      'imageName',
      'runtimeServiceAccount',
      'environment',
    ] as const;
    for (const key of required) {
      if (typeof payload[key] !== 'string' || !payload[key].trim()) {
        throw new Error(`Claimed GCP provisioning job is missing ${key}`);
      }
    }
    const environment = payload.environment;
    if (
      environment !== 'dev' &&
      environment !== 'stg' &&
      environment !== 'uat' &&
      environment !== 'prod' &&
      environment !== 'preview'
    ) {
      throw new Error('Claimed GCP provisioning job has an invalid environment');
    }

    return {
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      deploymentTargetId: job.deploymentTargetId!,
      gcpProjectId: payload.gcpProjectId,
      region: payload.region,
      artifactRegistryRepository: payload.artifactRegistryRepository,
      serviceName: payload.serviceName,
      imageName: payload.imageName,
      runtimeServiceAccount: payload.runtimeServiceAccount,
      environment,
    };
  }

  private toSafeFailure(error: unknown): {
    code: string;
    safeMessage: string;
  } {
    if (error instanceof GcpRuntimeAdapterError) {
      return { code: error.code, safeMessage: error.safeMessage };
    }
    return {
      code: 'GCP_RUNTIME_OPERATION_FAILED',
      safeMessage: 'GCP runtime provisioning failed',
    };
  }
}
