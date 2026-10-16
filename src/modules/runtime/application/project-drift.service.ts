import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import {
  CI_TOKEN_STATUS_LOOKUP,
  type CiTokenStatusLookup,
  type ProjectTokenStatus,
} from '#kernel/ports/ci-project.port';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import {
  findStaleCiWorkflowFiles,
  isReachableFromGithubRunners,
  resolvePlatformBaseUrl,
} from '#kernel/config/ci-api-base-url';
import {
  PROTECTED_BRANCHES,
  projectPipelineBranches,
} from '#kernel/config/pipeline-branches';
import {
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
  type DeploymentProjectReferenceLookup,
} from '#kernel/ports/deployment-runtime.port';
import { DeploymentTargetsRepository } from '../infrastructure/repositories/deployment-targets.repository';
import { EnvVarsRepository } from '../infrastructure/repositories/env-vars.repository';
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

/** The code of the finding the CI API URL probe raises. */
const CI_API_URL_STALE = 'ci_api_url_stale';

function maybeRepoFinding(
  project: DeploymentProjectReference,
): ProjectDriftFindingInput | null {
  if (!project.repoFullName || !project.repoUrl) {
    return {
      projectId: project.projectId,
      source: 'local_snapshot',
      severity: 'warning',
      code: 'project_repo_metadata_missing',
      message: 'Project repository metadata is incomplete.',
      details: {
        repoFullName: project.repoFullName,
        repoUrl: project.repoUrl ?? null,
      },
    };
  }
  return null;
}

function maybeWorkflowFinding(
  project: DeploymentProjectReference,
): ProjectDriftFindingInput | null {
  const workflowFiles = project.projectOptions?.['workflowFiles'];
  if (
    !project.workflowPath &&
    (!Array.isArray(workflowFiles) || workflowFiles.length === 0)
  ) {
    return {
      projectId: project.projectId,
      source: 'local_snapshot',
      severity: 'warning',
      code: 'workflow_files_missing',
      message: 'No workflow file metadata is tracked for this project.',
    };
  }
  return null;
}

function maybeCiTokenFinding(
  projectId: string,
  ciToken: ProjectTokenStatus | null,
): ProjectDriftFindingInput | null {
  if (!ciToken) {
    return {
      projectId,
      source: 'local_snapshot',
      severity: 'error',
      code: 'ci_token_missing',
      message: 'No active CI token metadata is tracked for this project.',
    };
  }
  if (ciToken.status === 'revoked') {
    return {
      projectId,
      source: 'local_snapshot',
      severity: 'error',
      code: 'ci_token_revoked',
      message: 'The tracked CI token is revoked.',
    };
  }
  return null;
}

function maybeTargetFindings(
  projectId: string,
  targets: DeploymentTargetSummary[],
): ProjectDriftFindingInput[] {
  const findings: ProjectDriftFindingInput[] = [];
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
  return findings;
}

@Injectable()
export class ProjectDriftService implements DeploymentDriftQuery {
  private readonly logger = new Logger(ProjectDriftService.name);

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
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver?: CapabilityResolverPort,
    @Optional()
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService?: GithubProjectPort,
    @Optional()
    @Inject(DEPLOYMENT_PROJECT_REFERENCE_LOOKUP)
    private readonly projects?: DeploymentProjectReferenceLookup,
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
    options?: { githubAccessToken?: string | null },
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
    findings.push(
      ...(await this.buildBranchProtectionFindings(
        project,
        options?.githubAccessToken,
      )),
    );
    const ciApiUrl = await this.buildCiApiUrlFindings(
      project,
      options?.githubAccessToken,
    );
    findings.push(...ciApiUrl.findings);
    return {
      enabled: true,
      mode: 'local_snapshot',
      findings: await this.findingsRepository.replaceActiveFindings(
        projectId,
        findings,
        // A scan that could not run keeps the findings it would have judged.
        ciApiUrl.complete ? [] : [CI_API_URL_STALE],
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
    const repoFinding = maybeRepoFinding(project);
    if (repoFinding) {
      findings.push(repoFinding);
    }
    const workflowFinding = maybeWorkflowFinding(project);
    if (workflowFinding) {
      findings.push(workflowFinding);
    }
    const ciTokenFinding = maybeCiTokenFinding(projectId, ciToken);
    if (ciTokenFinding) {
      findings.push(ciTokenFinding);
    }

    findings.push(...maybeTargetFindings(projectId, targets));

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

  /**
   * Live, read-only probe of the branch model (persona spec 8.7): `dev` must
   * stay pushable, `uat` and `main` must require a pull request and refuse
   * force pushes and deletions.
   *
   * Reports only positive evidence. A branch whose protection cannot be read
   * (no token, API error) yields no finding: "unknown" is not "drifted".
   * Never re-applies protection; repair is a separate, explicit, role-gated
   * action.
   */
  private async buildBranchProtectionFindings(
    project: DeploymentProjectReference,
    githubAccessToken: string | null | undefined,
  ): Promise<ProjectDriftFindingInput[]> {
    if (!githubAccessToken || !this.githubService) {
      return [];
    }
    const [owner, repo] = project.repoFullName.split('/');
    if (!owner || !repo) {
      return [];
    }

    const finding = (
      severity: 'warning' | 'error',
      code: string,
      branch: string,
      message: string,
    ): ProjectDriftFindingInput => ({
      projectId: project.projectId,
      source: 'github_live',
      severity,
      code,
      message,
      details: { branch, repoFullName: project.repoFullName },
    });
    const findings: ProjectDriftFindingInput[] = [];

    for (const branch of PROTECTED_BRANCHES) {
      const summary = await this.githubService.getBranchProtectionSummary(
        githubAccessToken,
        owner,
        repo,
        branch,
      );
      if (!summary) {
        continue;
      }
      if (!summary.pullRequestRequired) {
        findings.push(
          finding(
            'error',
            'branch_protection_missing',
            branch,
            `Branch ${branch} does not require a pull request to change.`,
          ),
        );
      }
      if (summary.allowForcePushes) {
        findings.push(
          finding(
            'warning',
            'branch_force_push_allowed',
            branch,
            `Branch ${branch} allows force pushes.`,
          ),
        );
      }
      if (summary.allowDeletions) {
        findings.push(
          finding(
            'warning',
            'branch_deletion_allowed',
            branch,
            `Branch ${branch} can be deleted.`,
          ),
        );
      }
    }

    return findings;
  }

  /**
   * Committed workflow files on the project's pipeline branches that still name
   * another AlphaCI API (a localhost address from before the public URL was read
   * correctly). The branches are the project's environment branches, then the
   * fixed tiers. Secret values cannot be read back, so this reads the files only.
   *
   * `complete` says whether the scan ran to the end. A scan that could not run
   * (no token, a base GitHub runners cannot reach, an unreadable environment
   * list, a branch GitHub would not read) judged nothing, so the caller keeps
   * the findings it already has rather than resolving them.
   */
  private async buildCiApiUrlFindings(
    project: DeploymentProjectReference,
    githubAccessToken: string | null | undefined,
  ): Promise<{ findings: ProjectDriftFindingInput[]; complete: boolean }> {
    if (!githubAccessToken || !this.githubService) {
      return { findings: [], complete: false };
    }
    const expectedBaseUrl = resolvePlatformBaseUrl();
    // A base GitHub runners cannot reach is not a drift to report: there is
    // nothing correct to point CI at until PLATFORM_PUBLIC_URL is set.
    if (!isReachableFromGithubRunners(expectedBaseUrl)) {
      return { findings: [], complete: false };
    }
    const environments = await this.readEnvironmentBranches(project.projectId);
    if (environments === null) {
      return { findings: [], complete: false };
    }
    const { base, branches } = projectPipelineBranches(environments);

    const files: Array<{ branch: string; path: string }> = [];
    const staleBaseUrls = new Set<string>();
    let complete = true;
    for (const branch of branches) {
      try {
        const stale = await findStaleCiWorkflowFiles(
          this.githubService,
          githubAccessToken,
          project.repoFullName,
          branch,
          expectedBaseUrl,
        );
        for (const file of stale) {
          files.push({ branch, path: file.path });
          file.staleBases.forEach((staleBase) => staleBaseUrls.add(staleBase));
        }
      } catch (error) {
        complete = false;
        this.logger.warn(
          `Could not read CI workflows on ${branch} of ${project.repoFullName}: ${(error as Error).message}`,
        );
      }
    }
    if (files.length === 0) {
      return { findings: [], complete };
    }

    const bases = [...staleBaseUrls];
    return {
      complete,
      findings: [
        {
          projectId: project.projectId,
          source: 'github_live',
          severity: 'error',
          code: CI_API_URL_STALE,
          message: `CI workflows still point at ${bases.join(', ')} instead of ${expectedBaseUrl}.`,
          details: {
            repoFullName: project.repoFullName,
            expectedBaseUrl,
            staleBaseUrls: bases,
            baseBranch: base,
            files,
          },
        },
      ],
    };
  }

  /** The project's environments in position order; null when they cannot be read. */
  private async readEnvironmentBranches(
    projectId: string,
  ): Promise<Array<{ sourceBranch: string }> | null> {
    if (!this.projects) return [];
    try {
      return await this.projects.listProjectEnvironments(projectId);
    } catch (error) {
      this.logger.warn(
        `Could not read the environments of ${projectId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private enabled(): boolean {
    return (
      this.capabilityResolver?.deployment().has('runtime.drift-detection') ??
      false
    );
  }
}
