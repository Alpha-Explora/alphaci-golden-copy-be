import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import {
  CI_TOKEN_STATUS_LOOKUP,
  type CiTokenStatusLookup,
} from '#modules/pipelines/index.js';
import { DeploymentTargetsRepository } from '../infrastructure/deployment-targets.repository';
import { EnvVarsRepository } from '../infrastructure/env-vars.repository';
import type {
  DeploymentTargetSummary,
  EnvVarMetadata,
} from '../core/deployments.types';
import {
  DEPLOYMENT_DRIFT_FINDINGS_STORE,
  type DeploymentDriftFindingsStore,
  type DeploymentDriftQuery,
  type DeploymentDriftResponse,
  type DeploymentProjectReference,
} from '../core/deployment-provisioning.contract';
import type { ProjectDriftFindingInput } from './project-drift.types';

@Injectable()
export class ProjectDriftService implements DeploymentDriftQuery {
  constructor(
    @Inject(DEPLOYMENT_DRIFT_FINDINGS_STORE)
    private readonly findingsRepository: DeploymentDriftFindingsStore,
    @Optional()
    private readonly deploymentTargetsRepository?: DeploymentTargetsRepository,
    @Optional()
    private readonly envVarsRepository?: EnvVarsRepository,
    @Optional()
    @Inject(CI_TOKEN_STATUS_LOOKUP)
    private readonly ciTokensRepository?: CiTokenStatusLookup,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async listFindings(
    project: DeploymentProjectReference,
  ): Promise<DeploymentDriftResponse> {
    const { projectId } = project;
    if (!this.enabled()) {
      return { enabled: false, mode: 'local_snapshot', findings: [] };
    }

    return {
      enabled: true,
      mode: 'local_snapshot',
      findings: await this.findingsRepository.findActiveByProject(projectId),
    };
  }

  async runDetection(
    project: DeploymentProjectReference,
  ): Promise<DeploymentDriftResponse> {
    const { projectId } = project;
    if (!this.enabled()) {
      return { enabled: false, mode: 'local_snapshot', findings: [] };
    }

    const targets =
      (await this.deploymentTargetsRepository?.listDeploymentTargets(
        projectId,
      )) ?? [];
    const envMetadata =
      (await this.envVarsRepository?.listEnvMetadata(projectId)) ?? [];
    const ciToken =
      (await this.ciTokensRepository?.findProjectTokenStatus(projectId)) ??
      null;

    const findings = this.buildFindings(project, targets, envMetadata, ciToken);
    return {
      enabled: true,
      mode: 'local_snapshot',
      findings: await this.findingsRepository.replaceActiveFindings(
        projectId,
        findings,
      ),
    };
  }

  private buildFindings(
    project: DeploymentProjectReference,
    targets: DeploymentTargetSummary[],
    envMetadata: EnvVarMetadata[],
    ciToken: Awaited<ReturnType<CiTokenStatusLookup['findProjectTokenStatus']>>,
  ): ProjectDriftFindingInput[] {
    const findings: ProjectDriftFindingInput[] = [];
    const projectId = project.projectId;
    const workflowFiles = project.projectOptions?.['workflowFiles'];

    if (!project.repoFullName || !project.repoUrl) {
      findings.push({
        projectId,
        source: 'local_snapshot',
        severity: 'warning',
        code: 'project_repo_metadata_missing',
        message: 'Project repository metadata is incomplete.',
        details: {
          repoFullName: project.repoFullName,
          repoUrl: project.repoUrl ?? null,
        },
      });
    }

    if (
      !project.workflowPath &&
      (!Array.isArray(workflowFiles) || workflowFiles.length === 0)
    ) {
      findings.push({
        projectId,
        source: 'local_snapshot',
        severity: 'warning',
        code: 'workflow_files_missing',
        message: 'No workflow file metadata is tracked for this project.',
      });
    }

    if (!ciToken) {
      findings.push({
        projectId,
        source: 'local_snapshot',
        severity: 'error',
        code: 'ci_token_missing',
        message: 'No active CI token metadata is tracked for this project.',
      });
    } else if (ciToken.status === 'revoked') {
      findings.push({
        projectId,
        source: 'local_snapshot',
        severity: 'error',
        code: 'ci_token_revoked',
        message: 'The tracked CI token is revoked.',
      });
    }

    for (const target of targets) {
      if (!target.branchName) {
        findings.push({
          projectId,
          targetId: target.id,
          source: 'local_snapshot',
          severity: 'warning',
          code: 'branch_metadata_missing',
          message: 'Deployment target branch metadata is missing.',
        });
      }
      if (!target.providerProjectId || !target.providerProjectName) {
        findings.push({
          projectId,
          targetId: target.id,
          source: 'local_snapshot',
          severity: 'error',
          code: 'deployment_target_metadata_missing',
          message: 'Deployment target provider metadata is incomplete.',
          details: { provider: target.provider },
        });
      }
      if (target.ownershipMode === 'byo' && !target.providerConnectionId) {
        findings.push({
          projectId,
          targetId: target.id,
          source: 'local_snapshot',
          severity: 'warning',
          code: 'provider_connection_metadata_unavailable',
          message: 'BYO deployment target has no provider connection metadata.',
          details: { provider: target.provider },
        });
      }
    }

    if (targets.length > 0 && envMetadata.length === 0) {
      findings.push({
        projectId,
        source: 'local_snapshot',
        severity: 'info',
        code: 'env_metadata_empty',
        message:
          'No environment variable metadata is tracked for this project.',
      });
    }

    for (const env of envMetadata.filter((item) => item.status === 'failed')) {
      findings.push({
        projectId,
        targetId: env.deploymentTargetId,
        source: 'local_snapshot',
        severity: 'warning',
        code: 'provider_env_key_failed',
        message: `Environment key ${env.key} last failed to provision.`,
        details: { key: env.key, lane: env.lane, gitBranch: env.gitBranch },
      });
    }

    return findings;
  }

  private enabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.driftDetection?.enabled ?? false;
  }
}
