import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { GcpDeploymentProviderConfig } from './gcp.provider';
import { GcpDeploymentTargetsRepository } from './gcp-deployment-targets.repository';
import { ProvisioningJobsRepository } from './provisioning-jobs.repository';

export interface EnqueueGcpProvisioningInput {
  workspaceId: string;
  projectId: string;
  appSlug: string;
  environment: 'dev' | 'stg' | 'uat' | 'prod' | 'preview';
  slot: 'backend' | 'frontend' | 'standalone';
  imageName: string;
  runtimeServiceAccount: string;
  deployerServiceAccount: string;
}

export interface EnqueueGcpProvisioningResult {
  deploymentTargetId: string;
  jobId: string;
}

/**
 * Creates durable intent only. A worker must claim and execute the queued job;
 * request handling never talks to Google Cloud directly.
 */
@Injectable()
export class GcpProvisioningService {
  constructor(
    private readonly config: GcpDeploymentProviderConfig,
    private readonly deploymentTargets: GcpDeploymentTargetsRepository,
    private readonly provisioningJobs: ProvisioningJobsRepository,
  ) {}

  async enqueue(
    input: EnqueueGcpProvisioningInput,
  ): Promise<EnqueueGcpProvisioningResult> {
    this.assertEnabled();
    const cloudRunServiceName = this.deriveCloudRunServiceName(input);
    const target = await this.deploymentTargets.createOrGet({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      appSlug: input.appSlug,
      environment: input.environment,
      serviceSlot: this.toGcpServiceSlot(input.slot),
      gcpProjectId: this.config.projectId,
      region: this.config.region,
      artifactRegistryRepository: this.config.artifactRegistryRepository,
      imageName: input.imageName,
      cloudRunServiceName,
      runtimeServiceAccount: input.runtimeServiceAccount,
      deployerServiceAccount: input.deployerServiceAccount,
    });
    const desiredStateRevision = this.desiredStateRevision(
      input,
      cloudRunServiceName,
    );
    const job = await this.provisioningJobs.create({
      idempotencyKey: `gcp-provision-target:${target.id}:${desiredStateRevision}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      deploymentTargetId: target.id,
      payload: {
        targetId: target.id,
        serviceName: cloudRunServiceName,
        imageName: input.imageName,
        runtimeServiceAccount: input.runtimeServiceAccount,
        environment: input.environment,
        gcpProjectId: this.config.projectId,
        region: this.config.region,
        artifactRegistryRepository: this.config.artifactRegistryRepository,
      },
    });

    return { deploymentTargetId: target.id, jobId: job.id };
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error('GCP deployments are disabled');
    }
    if (
      !this.config.projectId.trim() ||
      !this.config.region.trim() ||
      !this.config.artifactRegistryRepository.trim()
    ) {
      throw new Error('GCP deployment configuration is incomplete');
    }
  }

  private toGcpServiceSlot(
    slot: EnqueueGcpProvisioningInput['slot'],
  ): 'web' | 'api' | 'standalone' {
    if (slot === 'frontend') {
      return 'web';
    }
    if (slot === 'backend') {
      return 'api';
    }
    return 'standalone';
  }

  private deriveCloudRunServiceName(
    input: EnqueueGcpProvisioningInput,
  ): string {
    const base = input.appSlug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 43);
    const safeBase = base || 'service';
    const suffix = createHash('sha256')
      .update(
        [
          input.workspaceId,
          input.projectId,
          input.environment,
          input.slot,
        ].join(':'),
      )
      .digest('hex')
      .slice(0, 12);

    return `svc-${safeBase}-${suffix}`;
  }

  private desiredStateRevision(
    input: EnqueueGcpProvisioningInput,
    cloudRunServiceName: string,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          cloudRunServiceName,
          gcpProjectId: this.config.projectId,
          region: this.config.region,
          artifactRegistryRepository: this.config.artifactRegistryRepository,
          imageName: input.imageName,
          runtimeServiceAccount: input.runtimeServiceAccount,
          deployerServiceAccount: input.deployerServiceAccount,
        }),
      )
      .digest('hex')
      .slice(0, 16);
  }
}
