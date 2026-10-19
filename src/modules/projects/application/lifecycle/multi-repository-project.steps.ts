import { UnprocessableEntityException, type Logger } from '@nestjs/common';

import { ALPHACI_API_URL, ALPHACI_REPORT_URL } from '../workflows/index';
import type { DeploymentProvisioningResult } from '#kernel/ports/deployment-runtime.port';
import { resolveDeploymentWorkflowTargets } from '../workflows/deployment-workflow-targets';
import { workflowFileMetadata } from '../dashboard/project-overview.view';
import {
  combineDeploymentProvisioningResults,
  extractDeploymentProvider,
} from '../../domain/deployment-provisioning.policy';
import { normalizeRepoShape } from '../../scaffold.builder';
import type {
  CreateProjectDto,
  DeploymentProvisioningRequestDto,
  MicroserviceSlotDto,
} from '../../api/dto/create-project.dto';
import type { CreateProjectResponse } from './projects.service.types';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import type { StagedWorkflowFile } from '../workflows/index';
import {
  newChainLinkOptions,
  type ProjectProvisioningSupport,
} from './project-provisioning.support';
import {
  BRANCHES_CREATED_ON_PROVISION,
  PROVISIONED_BRANCHES,
} from '#kernel/config/pipeline-branches';
import {
  combineEnvironmentResults,
  completeEnvironmentPipeline,
  placeholderWorkflowEnvironments,
  type EnvironmentPipelineResult,
} from './environment-project.pipeline';

export type CreatedGithubRepo = {
  repoUrl: string;
  ownerLogin: string;
  repoName: string;
};

export type MultiRepoWorkflowBundle = {
  templateId: string;
  workflowFiles: StagedWorkflowFile[];
  workflowPath: string;
};

export type MultiRepoBackendProvision = {
  row: ProvisionedProjectRow;
  commitSha: string;
  commitUrl: string | null;
  /** The hierarchy delivery project the backend row was linked under, if any. */
  deliveryProjectId: string | null;
  /** Set when the project has its own environments. */
  environment?: EnvironmentPipelineResult;
};

export type MultiRepoFrontendProvision = {
  feRepoFullName: string | undefined;
  feRepoUrl: string | undefined;
  /** The frontend row, only once its repository is fully provisioned. */
  feRow: ProvisionedProjectRow | undefined;
  /** Set when the project has its own environments. */
  environment?: EnvironmentPipelineResult;
  /** Why the frontend repository is missing, when its provisioning failed. */
  error?: string;
};

export function deriveMultiRepoNames(repoName: string): {
  beRepoName: string;
  feRepoName: string;
} {
  // Avoid double-suffixing if the caller already appended -be.
  const beRepoName = repoName.endsWith('-be') ? repoName : `${repoName}-be`;
  return { beRepoName, feRepoName: beRepoName.replace(/-be$/, '-fe') };
}

export function workflowPathFromBundle(
  workflowFiles: StagedWorkflowFile[],
  outputFileName: string,
): string {
  return workflowFiles[0]?.path ?? `.github/workflows/${outputFileName}`;
}

export function starterIncludeDocker(
  tests: Partial<Record<string, boolean>> | undefined,
): { includeDocker?: boolean } {
  if (tests?.['docker'] === undefined) {
    return {};
  }
  return { includeDocker: tests['docker'] };
}

export function testsProjectOption(
  tests: Partial<Record<string, boolean>> | undefined,
): { tests?: Partial<Record<string, boolean>> } {
  if (!tests) {
    return {};
  }
  return { tests };
}

export async function createMultiRepoGithubRepo(input: {
  support: ProjectProvisioningSupport;
  repositoryCreationToken: string;
  repoName: string;
  visibility: CreateProjectDto['visibility'];
  provisioningOwnerLogin: string | undefined;
}): Promise<CreatedGithubRepo> {
  const created = await input.support.githubService.createRepo(
    input.repositoryCreationToken,
    {
      repoName: input.repoName,
      private: input.visibility === 'private',
    },
    input.provisioningOwnerLogin,
  );
  return {
    repoUrl: created.repoUrl,
    ownerLogin: created.ownerLogin,
    repoName: created.repoName,
  };
}

export async function buildMultiRepoBackendBundle(input: {
  support: ProjectProvisioningSupport;
  backend: MicroserviceSlotDto;
  dto: CreateProjectDto;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
  /**
   * `owner/repo` of the paired frontend repository, so the generated
   * promotion jobs can cross-link with it (§8.5). Undefined when the owner
   * cannot be predicted yet (see resolveMultiRepoSiblingNames) - the
   * generated pipeline then carries no `sibling-repo` input at all, same as
   * before this feature existed.
   */
  siblingRepoFullName?: string;
}): Promise<MultiRepoWorkflowBundle> {
  const {
    support,
    backend,
    dto,
    effectiveDeploymentProvisioning,
    siblingRepoFullName,
  } = input;
  const templateId = support.resolveTemplateId(
    backend.projectTypeId,
    backend.workflowRecipeId,
  );
  // Each repo carries a flat standalone scaffold, so the workflow always
  // runs at the repo root — slot servicePaths like 'backend/' only apply to
  // single-repo shapes and would point at a directory that does not exist.
  const { workflowFiles, outputFileName } = await support.buildWorkflowBundle({
    templateId,
    serviceName: backend.serviceName,
    servicePath: '.',
    nodeVersion: dto.nodeVersion,
    coverageThreshold: dto.coverageThreshold,
    // Each multi-repo repository carries the standalone scaffold, tests/
    // included, at its root.
    hasTestsDirectory: true,
    deploymentProvider: extractDeploymentProvider(
      effectiveDeploymentProvisioning,
      'backend',
    ),
    deploymentTargets: resolveDeploymentWorkflowTargets(
      effectiveDeploymentProvisioning,
      ['backend', 'standalone'],
      '.',
      support.workflowFragmentRegistry,
    ),
    ...(siblingRepoFullName !== undefined && { siblingRepoFullName }),
    ...placeholderWorkflowEnvironments(dto.environments),
  });

  return {
    templateId,
    workflowFiles,
    workflowPath: workflowPathFromBundle(workflowFiles, outputFileName),
  };
}

export async function buildMultiRepoFrontendBundle(input: {
  support: ProjectProvisioningSupport;
  frontend: MicroserviceSlotDto;
  dto: CreateProjectDto;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
  /** `owner/repo` of the paired backend repository. See buildMultiRepoBackendBundle. */
  siblingRepoFullName?: string;
}): Promise<MultiRepoWorkflowBundle> {
  const {
    support,
    frontend,
    dto,
    effectiveDeploymentProvisioning,
    siblingRepoFullName,
  } = input;
  const templateId = support.resolveTemplateId(
    frontend.projectTypeId,
    frontend.workflowRecipeId,
  );
  const { workflowFiles, outputFileName } = await support.buildWorkflowBundle({
    templateId,
    serviceName: frontend.serviceName,
    servicePath: '.',
    nodeVersion: dto.nodeVersion,
    coverageThreshold: dto.coverageThreshold,
    hasTestsDirectory: true,
    deploymentTargets: resolveDeploymentWorkflowTargets(
      effectiveDeploymentProvisioning,
      ['frontend'],
      '.',
      support.workflowFragmentRegistry,
    ),
    ...(siblingRepoFullName !== undefined && { siblingRepoFullName }),
    ...placeholderWorkflowEnvironments(dto.environments),
  });

  return {
    templateId,
    workflowFiles,
    workflowPath: workflowPathFromBundle(workflowFiles, outputFileName),
  };
}

export async function persistMultiRepoStandaloneRow(input: {
  support: ProjectProvisioningSupport;
  userId: string;
  dto: CreateProjectDto;
  slot: MicroserviceSlotDto;
  ownerLogin: string;
  repoFullName: string;
  repoUrl: string;
  templateId: string;
  workflowPath: string;
  workflowFiles: StagedWorkflowFile[];
  includeTests: boolean;
  /** Link into this existing delivery project instead of creating a new chain. */
  deliveryProjectId?: string;
  /** Name for a newly auto-created system/delivery-project chain. */
  chainName?: string;
  /** `chainName` is a caller-chosen Project name that must be unique in the team. */
  enforceUniqueChainName?: boolean;
}): Promise<{ row: ProvisionedProjectRow; deliveryProjectId: string | null }> {
  const {
    support,
    userId,
    dto,
    slot,
    ownerLogin,
    repoFullName,
    repoUrl,
    templateId,
    workflowPath,
    workflowFiles,
    includeTests,
    deliveryProjectId,
    chainName,
    enforceUniqueChainName,
  } = input;

  return support.createProjectRow(
    {
      userId,
      workspaceId: await support.workspaceGate.resolveWorkspaceIdForCreate(
        userId,
        dto.workspaceId,
        dto.deliveryProjectId,
        { requireFeatures: false },
      ),
      repoFullName,
      templateId,
      serviceName: slot.serviceName,
      workflowPath,
      status: 'provisioned',
      repoUrl,
      visibility: dto.visibility,
      repoShape: normalizeRepoShape(dto.repoShape),
      projectTypeId: slot.projectTypeId,
      workflowRecipeId: slot.workflowRecipeId ?? null,
      ...(dto.environments ? { environments: dto.environments } : {}),
      projectOptions: {
        ...support.repositoryOwnershipMetadata(dto, ownerLogin),
        ...(includeTests ? testsProjectOption(dto.tests) : {}),
        workflowFiles: workflowFileMetadata(workflowFiles),
      },
    },
    {
      ...(deliveryProjectId !== undefined && { deliveryProjectId }),
      ...(chainName !== undefined && { chainName }),
      ...(enforceUniqueChainName && { enforceUniqueChainName }),
      accessGrant: 'new-repository',
    },
  );
}

export async function installMultiRepoCiSecrets(input: {
  support: ProjectProvisioningSupport;
  provisioningToken: string;
  ownerLogin: string;
  repoName: string;
  projectId: string;
}): Promise<void> {
  const ciToken = await input.support.ciService.issueProjectToken(
    input.projectId,
  );
  await input.support.githubService.setActionsSecretStrict(
    input.provisioningToken,
    input.ownerLogin,
    input.repoName,
    'ALPHACI_TOKEN',
    ciToken.token,
  );
  await input.support.githubService.setActionsSecretStrict(
    input.provisioningToken,
    input.ownerLogin,
    input.repoName,
    'ALPHACI_REPORT_URL',
    ALPHACI_REPORT_URL,
  );
  await input.support.githubService.setActionsSecretStrict(
    input.provisioningToken,
    input.ownerLogin,
    input.repoName,
    'ALPHACI_API_URL',
    ALPHACI_API_URL,
  );
  await input.support.sonar.installSecrets(
    input.provisioningToken,
    input.ownerLogin,
    input.repoName,
  );
}

export async function createAndProtectDefaultBranches(input: {
  support: ProjectProvisioningSupport;
  provisioningToken: string;
  ownerLogin: string;
  repoName: string;
  userId: string;
  project: { id: string; workspace_id?: string | null };
}): Promise<void> {
  for (const branch of BRANCHES_CREATED_ON_PROVISION) {
    await input.support.githubService.createBranch(
      input.provisioningToken,
      input.ownerLogin,
      input.repoName,
      branch,
      'main',
    );
  }

  // Pull request required on dev, uat and main; best effort, never throws.
  await input.support.protectPipelineBranches({
    token: input.provisioningToken,
    owner: input.ownerLogin,
    repo: input.repoName,
    userId: input.userId,
    projectId: input.project.id,
    workspaceId: input.project.workspace_id ?? null,
  });
}

/** One repository's pipeline, once its row and CI secrets exist. */
export type MultiRepoPipeline = {
  commitSha: string;
  commitUrl: string | null;
  /** Set when the project has its own environments. */
  environment?: EnvironmentPipelineResult;
};

/**
 * Give one repository of the pair its pipeline.
 *
 * Without project environments: the branch-based pipeline already built in
 * `bundle`, pushed to main, then dev and uat created and protected. With
 * them: the environment pipeline (release signing, environment branches, one
 * target per environment for this repository's slot, the generated pipeline
 * on every source branch), the same one a single-repository project gets.
 */
export async function finishMultiRepoPipeline(input: {
  support: ProjectProvisioningSupport;
  userId: string;
  provisioningToken: string;
  dto: CreateProjectDto;
  slot: MicroserviceSlotDto;
  /** The hosting slot this repository deploys. */
  deploySlot: 'backend' | 'frontend';
  repo: CreatedGithubRepo;
  row: ProvisionedProjectRow;
  bundle: MultiRepoWorkflowBundle;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
  siblingRepoFullName?: string | undefined;
}): Promise<MultiRepoPipeline> {
  const { support, provisioningToken, dto, repo, row, bundle } = input;
  if (dto.environments) {
    const environment = await completeEnvironmentPipeline(support, {
      userId: input.userId,
      row,
      provisioningToken,
      ownerLogin: repo.ownerLogin,
      repoName: repo.repoName,
      repoFullName: `${repo.ownerLogin}/${repo.repoName}`,
      deploymentProvisioning: input.effectiveDeploymentProvisioning,
      slots: [input.deploySlot],
      ownSlotTargetsOnly: true,
      workflow: {
        templateId: bundle.templateId,
        serviceName: input.slot.serviceName,
        servicePath: '.',
        nodeVersion: dto.nodeVersion,
        coverageThreshold: dto.coverageThreshold,
        hasTestsDirectory: true,
        ...(input.siblingRepoFullName !== undefined && {
          siblingRepoFullName: input.siblingRepoFullName,
        }),
      },
    });
    return {
      commitSha: environment.commit?.commitSha ?? '',
      commitUrl: environment.commit?.commitUrl ?? null,
      environment,
    };
  }

  const { commitSha, commitUrl } = await support.pushWorkflowFiles(
    provisioningToken,
    repo.ownerLogin,
    repo.repoName,
    bundle.workflowFiles,
  );
  await support.projectsRepository.updateStatus(
    row.id,
    'provisioned',
    commitSha,
    commitUrl,
  );
  await createAndProtectDefaultBranches({
    support,
    provisioningToken,
    ownerLogin: repo.ownerLogin,
    repoName: repo.repoName,
    userId: input.userId,
    project: row,
  });
  return { commitSha, commitUrl };
}

export async function compensateMultiRepoProvision(input: {
  support: ProjectProvisioningSupport;
  provisioningToken: string;
  ownerLogin: string;
  repoName: string;
  projectId: string | undefined;
  userId: string;
}): Promise<void> {
  await input.support.compensateFailedProvision(
    input.provisioningToken,
    input.ownerLogin,
    input.repoName,
    input.projectId,
    input.userId,
  );
}

export async function provisionMultiRepoBackend(input: {
  support: ProjectProvisioningSupport;
  userId: string;
  provisioningToken: string;
  dto: CreateProjectDto;
  backend: MicroserviceSlotDto;
  repo: CreatedGithubRepo;
  bundle: MultiRepoWorkflowBundle;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
  /** `owner/repo` of the paired frontend repository. See buildMultiRepoBackendBundle. */
  siblingRepoFullName?: string;
}): Promise<MultiRepoBackendProvision> {
  const { support, userId, provisioningToken, dto, backend, repo, bundle } =
    input;
  const repoFullName = `${repo.ownerLogin}/${repo.repoName}`;

  let backendRow: ProvisionedProjectRow | undefined;
  let backendDeliveryProjectId: string | null = null;
  let pipeline: MultiRepoPipeline | undefined;
  let backendProvisioningComplete = false;
  try {
    await support.pushStarterFiles(
      provisioningToken,
      repo.ownerLogin,
      repo.repoName,
      {
        projectName: backend.serviceName || repo.repoName,
        stack: backend.projectTypeId,
        repoShape: 'standalone',
        ...starterIncludeDocker(dto.tests),
      },
    );

    // Persist + token + secrets before the workflow push so the first
    // access-gate run can authenticate (see createProject for rationale).
    // No explicit deliveryProjectId on the request: auto-create ONE chain,
    // named after the base repoName, for the backend/frontend pair to share.
    ({ row: backendRow, deliveryProjectId: backendDeliveryProjectId } =
      await persistMultiRepoStandaloneRow({
        support,
        userId,
        dto,
        slot: backend,
        ownerLogin: repo.ownerLogin,
        repoFullName,
        repoUrl: repo.repoUrl,
        templateId: bundle.templateId,
        workflowPath: bundle.workflowPath,
        workflowFiles: bundle.workflowFiles,
        includeTests: true,
        ...newChainLinkOptions(dto, dto.repoName),
      }));

    await installMultiRepoCiSecrets({
      support,
      provisioningToken,
      ownerLogin: repo.ownerLogin,
      repoName: repo.repoName,
      projectId: backendRow.id,
    });

    pipeline = await finishMultiRepoPipeline({
      support,
      userId,
      provisioningToken,
      dto,
      slot: backend,
      deploySlot: 'backend',
      repo,
      row: backendRow,
      bundle,
      effectiveDeploymentProvisioning: input.effectiveDeploymentProvisioning,
      siblingRepoFullName: input.siblingRepoFullName,
    });

    backendProvisioningComplete = true;
  } catch (error) {
    if (!backendProvisioningComplete) {
      await compensateMultiRepoProvision({
        support,
        provisioningToken,
        ownerLogin: repo.ownerLogin,
        repoName: repo.repoName,
        projectId: backendRow?.id,
        userId,
      });
    }
    throw error;
  }

  if (!backendRow || !pipeline) {
    // Unreachable: a backend failure is rethrown from the catch above.
    throw new UnprocessableEntityException(
      'Backend repository provisioning did not complete',
    );
  }

  return {
    row: backendRow,
    commitSha: pipeline.commitSha,
    commitUrl: pipeline.commitUrl,
    deliveryProjectId: backendDeliveryProjectId,
    ...(pipeline.environment && { environment: pipeline.environment }),
  };
}

export async function provisionMultiRepoFrontend(input: {
  support: ProjectProvisioningSupport;
  logger: Logger;
  userId: string;
  repositoryCreationToken: string;
  provisioningToken: string;
  provisioningOwnerLogin: string | undefined;
  dto: CreateProjectDto;
  frontend: MicroserviceSlotDto;
  feRepoName: string;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
  /**
   * The delivery project both pair members must share — either the caller's
   * explicit dto.deliveryProjectId, or the chain the backend row just
   * auto-created. Null only when the backend row itself linked nowhere
   * (personal workspace, or no hierarchy port wired up).
   */
  pairDeliveryProjectId: string | null;
  /** `owner/repo` of the paired backend repository. See buildMultiRepoBackendBundle. */
  siblingRepoFullName?: string;
}): Promise<MultiRepoFrontendProvision> {
  const {
    support,
    logger,
    userId,
    repositoryCreationToken,
    provisioningToken,
    provisioningOwnerLogin,
    dto,
    frontend,
    feRepoName,
    effectiveDeploymentProvisioning,
    pairDeliveryProjectId,
    siblingRepoFullName,
  } = input;

  let feRepoFullName: string | undefined;
  let feRepoUrl: string | undefined;
  let feRepoCreated: { owner: string; repo: string } | undefined;
  let feRow: ProvisionedProjectRow | undefined;
  let pipeline: MultiRepoPipeline | undefined;
  let error: string | undefined;
  let feProvisioningComplete = false;

  try {
    const bundle = await buildMultiRepoFrontendBundle({
      support,
      frontend,
      dto,
      effectiveDeploymentProvisioning,
      ...(siblingRepoFullName !== undefined && { siblingRepoFullName }),
    });
    const repo = await createMultiRepoGithubRepo({
      support,
      repositoryCreationToken,
      repoName: feRepoName,
      visibility: dto.visibility,
      provisioningOwnerLogin,
    });

    feRepoCreated = { owner: repo.ownerLogin, repo: repo.repoName };
    feRepoFullName = `${repo.ownerLogin}/${repo.repoName}`;
    feRepoUrl = repo.repoUrl;

    await support.pushStarterFiles(
      provisioningToken,
      repo.ownerLogin,
      repo.repoName,
      {
        projectName: frontend.serviceName || repo.repoName,
        stack: frontend.projectTypeId,
        repoShape: 'standalone',
        ...starterIncludeDocker(dto.tests),
      },
    );

    ({ row: feRow } = await persistMultiRepoStandaloneRow({
      support,
      userId,
      dto,
      slot: frontend,
      ownerLogin: repo.ownerLogin,
      repoFullName: feRepoFullName,
      repoUrl: repo.repoUrl,
      templateId: bundle.templateId,
      workflowPath: bundle.workflowPath,
      workflowFiles: bundle.workflowFiles,
      includeTests: false,
      // Land under the SAME chain as the backend row rather than creating a
      // second, independent one — this is the pairing fix. When the pair
      // linked nowhere at all (personal workspace / no hierarchy port), fall
      // back to the same chainName the backend attempted, which will equally
      // no-op through ensureLink's own workspace check.
      ...(pairDeliveryProjectId
        ? { deliveryProjectId: pairDeliveryProjectId }
        : { chainName: dto.projectName?.trim() || dto.repoName }),
    }));

    await installMultiRepoCiSecrets({
      support,
      provisioningToken,
      ownerLogin: repo.ownerLogin,
      repoName: repo.repoName,
      projectId: feRow.id,
    });

    pipeline = await finishMultiRepoPipeline({
      support,
      userId,
      provisioningToken,
      dto,
      slot: frontend,
      deploySlot: 'frontend',
      repo,
      row: feRow,
      bundle,
      effectiveDeploymentProvisioning,
      siblingRepoFullName,
    });

    feProvisioningComplete = true;
  } catch (err) {
    logger.warn(
      `Multi-repo project created but frontend repo provisioning failed: ${String(err)}`,
    );
    error =
      'Project created with its backend repository only. The frontend repository could not be provisioned, and anything created for it was removed.';
    // Roll back a half-created frontend repo so a retry can reuse its name;
    // the backend repo is fully provisioned and is still returned.
    if (!feProvisioningComplete && feRepoCreated) {
      await compensateMultiRepoProvision({
        support,
        provisioningToken,
        ownerLogin: feRepoCreated.owner,
        repoName: feRepoCreated.repo,
        projectId: feRow?.id,
        userId,
      });
      feRepoFullName = undefined;
      feRepoUrl = undefined;
      feRow = undefined;
    }
  }

  return {
    feRepoFullName,
    feRepoUrl,
    feRow,
    ...(pipeline?.environment && { environment: pipeline.environment }),
    ...(error !== undefined && { error }),
  };
}

export async function provisionMultiRepoDeployments(input: {
  support: ProjectProvisioningSupport;
  logger: Logger;
  userId: string;
  provisioningToken: string;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
  backendRow: ProvisionedProjectRow;
  beRepoFullName: string;
  frontend: MultiRepoFrontendProvision;
}): Promise<DeploymentProvisioningResult> {
  const {
    support,
    logger,
    userId,
    provisioningToken,
    effectiveDeploymentProvisioning,
    backendRow,
    beRepoFullName,
    frontend,
  } = input;

  // Each repository provisions its own hosting slot: the backend repo gets
  // the Render target, the frontend repo (when it survived creation) gets
  // the Vercel target. Both use the centralized platform credentials.
  const provisioningResults: DeploymentProvisioningResult[] = [
    await support.provisionDeploymentTargets({
      projectId: backendRow.id,
      userId,
      repoFullName: beRepoFullName,
      githubAccessToken: provisioningToken,
      request: effectiveDeploymentProvisioning,
      slots: ['backend'],
    }),
  ];
  if (frontend.feRow && frontend.feRepoFullName) {
    provisioningResults.push(
      await support.provisionDeploymentTargets({
        projectId: frontend.feRow.id,
        userId,
        repoFullName: frontend.feRepoFullName,
        githubAccessToken: provisioningToken,
        request: effectiveDeploymentProvisioning,
        slots: ['frontend'],
      }),
    );

    // The per-repo provisioning passes cannot see each other's targets, so
    // cross-link the backend and frontend services here: the frontend gets
    // the backend's API URL, the backend gets the frontend origin for CORS.
    try {
      await support.projectDeploymentProvisioningService.crossLinkServiceUrls({
        userId,
        request: effectiveDeploymentProvisioning,
        groups: [
          { projectId: backendRow.id, result: provisioningResults[0]! },
          {
            projectId: frontend.feRow.id,
            result: provisioningResults[1]!,
          },
        ],
      });
    } catch (error) {
      logger.warn(
        `Multi-repo cross-service env injection failed: ${String(error)}`,
      );
    }
  }

  return combineDeploymentProvisioningResults(provisioningResults);
}

/**
 * The pair's deployment result when each repository provisioned its own
 * environment targets (finishMultiRepoPipeline). Neither repository's pass saw
 * the other's targets, so the halves are cross-linked here through the same
 * pass a hosted pair uses, one environment at a time: a frontend is only ever
 * handed its own environment's API URL, and a backend only its own
 * environment's frontend origin.
 */
export async function linkMultiRepoEnvironmentDeployments(input: {
  support: ProjectProvisioningSupport;
  logger: Logger;
  userId: string;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
  backendRow: ProvisionedProjectRow;
  backend: EnvironmentPipelineResult;
  frontend: MultiRepoFrontendProvision;
}): Promise<DeploymentProvisioningResult> {
  const { backend, frontend } = input;
  const frontendRow = frontend.feRow;
  const frontendPipeline = frontend.environment;
  if (frontendRow && frontendPipeline) {
    for (const { environment, result } of backend.perEnvironment) {
      const frontendResult = frontendPipeline.perEnvironment.find(
        (item) => item.environment.slug === environment.slug,
      )?.result;
      if (!frontendResult) continue;
      try {
        await input.support.projectDeploymentProvisioningService.crossLinkServiceUrls(
          {
            userId: input.userId,
            request: input.effectiveDeploymentProvisioning,
            groups: [
              { projectId: input.backendRow.id, result },
              { projectId: frontendRow.id, result: frontendResult },
            ],
          },
        );
      } catch (error) {
        input.logger.warn(
          `Multi-repo cross-service env injection failed for ${environment.slug}: ${String(error)}`,
        );
      }
    }
  }
  return combineEnvironmentResults([
    backend.deploymentProvisioning,
    ...(frontendRow && frontendPipeline
      ? [frontendPipeline.deploymentProvisioning]
      : []),
  ]);
}

export function buildMultiRepoCreateResponse(input: {
  backend: MicroserviceSlotDto;
  backendRow: ProvisionedProjectRow;
  beRepoFullName: string;
  beRepoUrl: string;
  backendWorkflowPath: string;
  backendWorkflowFiles: StagedWorkflowFile[];
  backendCommitSha: string;
  backendCommitUrl: string | null;
  frontend: MultiRepoFrontendProvision;
  deploymentProvisioning: DeploymentProvisioningResult;
  /** The backend's environment pipeline, when the project has its own environments. */
  backendEnvironment?: EnvironmentPipelineResult | undefined;
}): CreateProjectResponse {
  const environment = input.backendEnvironment;
  const releaseSigningWarnings = [
    ...new Set(
      [environment, input.frontend.environment]
        .map((pipeline) => pipeline?.releaseSigningWarning)
        .filter((warning): warning is string => warning !== undefined),
    ),
  ];
  return {
    id: input.backendRow.id,
    repoFullName: input.beRepoFullName,
    repoUrl: input.beRepoUrl,
    status: 'provisioned',
    branchesCreated: environment
      ? [...new Set(['main', ...environment.branches])]
      : [...PROVISIONED_BRANCHES],
    workflowPath: input.backendWorkflowPath,
    workflowFiles: workflowFileMetadata(
      environment?.workflowFiles ?? input.backendWorkflowFiles,
    ),
    githubCommitSha: input.backendCommitSha,
    githubCommitUrl: input.backendCommitUrl,
    projectTypeId: input.backend.projectTypeId,
    workflowRecipeId: input.backend.workflowRecipeId ?? '',
    additionalWorkflowPaths: [],
    ...(input.frontend.feRepoFullName !== undefined && {
      secondaryRepoFullName: input.frontend.feRepoFullName,
    }),
    ...(input.frontend.feRepoUrl !== undefined && {
      secondaryRepoUrl: input.frontend.feRepoUrl,
    }),
    ...(input.frontend.feRow && {
      secondaryProjectId: input.frontend.feRow.id,
    }),
    ...(input.frontend.error !== undefined && {
      secondaryRepoError: input.frontend.error,
    }),
    ...(releaseSigningWarnings.length > 0 && {
      releaseSigningWarning: releaseSigningWarnings.join(' '),
    }),
    deploymentProvisioning: input.deploymentProvisioning,
  };
}
