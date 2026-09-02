import { UnprocessableEntityException, type Logger } from '@nestjs/common';

import { ALPHACI_REPORT_URL } from '../workflows/index';
import type { DeploymentProvisioningResult } from '#kernel/ports/deployment-runtime.port';
import { resolveDeploymentWorkflowTargets } from '../workflows/deployment-workflow-targets';
import { workflowFileMetadata } from '../dashboard/project-overview.view';
import {
  combineDeploymentProvisioningResults,
  extractDeploymentProvider,
} from './deployment-provisioning.policy';
import { normalizeRepoShape } from '../../scaffold.builder';
import type {
  CreateProjectDto,
  DeploymentProvisioningRequestDto,
  MicroserviceSlotDto,
} from '../../dto/create-project.dto';
import type { CreateProjectResponse } from './projects.service.types';
import type { ProvisionedProjectRow } from '../../projects.repository';
import type { StagedWorkflowFile } from '../workflows/index';
import type { ProjectProvisioningSupport } from './project-provisioning.support';

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
};

export type MultiRepoFrontendProvision = {
  feRepoFullName: string | undefined;
  feRepoUrl: string | undefined;
  feRow: ProvisionedProjectRow | undefined;
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
}): Promise<MultiRepoWorkflowBundle> {
  const { support, backend, dto, effectiveDeploymentProvisioning } = input;
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
}): Promise<MultiRepoWorkflowBundle> {
  const { support, frontend, dto, effectiveDeploymentProvisioning } = input;
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
}): Promise<ProvisionedProjectRow> {
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
  } = input;

  return support.createProjectRow({
    userId,
    workspaceId: await support.workspaceGate.resolveWorkspaceIdForCreate(
      userId,
      dto.workspaceId,
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
    projectOptions: {
      ...support.repositoryOwnershipMetadata(dto, ownerLogin),
      ...(includeTests ? testsProjectOption(dto.tests) : {}),
      workflowFiles: workflowFileMetadata(workflowFiles),
    },
  });
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
}): Promise<void> {
  // `develop` remains available but unprotected and does not run CI.
  for (const branch of ['develop', 'uat'] as const) {
    await input.support.githubService.createBranch(
      input.provisioningToken,
      input.ownerLogin,
      input.repoName,
      branch,
      'main',
    );
  }

  for (const branch of ['uat', 'main'] as const) {
    await input.support.githubService.applyBranchProtection(
      input.provisioningToken,
      input.ownerLogin,
      input.repoName,
      branch,
    );
  }
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
}): Promise<MultiRepoBackendProvision> {
  const { support, userId, provisioningToken, dto, backend, repo, bundle } =
    input;
  const repoFullName = `${repo.ownerLogin}/${repo.repoName}`;

  let backendRow: ProvisionedProjectRow | undefined;
  let backendCommitSha = '';
  let backendCommitUrl: string | null = null;
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
    backendRow = await persistMultiRepoStandaloneRow({
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
    });

    await installMultiRepoCiSecrets({
      support,
      provisioningToken,
      ownerLogin: repo.ownerLogin,
      repoName: repo.repoName,
      projectId: backendRow.id,
    });

    ({ commitSha: backendCommitSha, commitUrl: backendCommitUrl } =
      await support.pushWorkflowFiles(
        provisioningToken,
        repo.ownerLogin,
        repo.repoName,
        bundle.workflowFiles,
      ));
    await support.projectsRepository.updateStatus(
      backendRow.id,
      'provisioned',
      backendCommitSha,
      backendCommitUrl,
    );

    await createAndProtectDefaultBranches({
      support,
      provisioningToken,
      ownerLogin: repo.ownerLogin,
      repoName: repo.repoName,
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

  if (!backendRow) {
    // Unreachable: a backend failure is rethrown from the catch above.
    throw new UnprocessableEntityException(
      'Backend repository provisioning did not complete',
    );
  }

  return {
    row: backendRow,
    commitSha: backendCommitSha,
    commitUrl: backendCommitUrl,
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
  } = input;

  let feRepoFullName: string | undefined;
  let feRepoUrl: string | undefined;
  let feRepoCreated: { owner: string; repo: string } | undefined;
  let feRow: ProvisionedProjectRow | undefined;
  let feProvisioningComplete = false;

  try {
    const bundle = await buildMultiRepoFrontendBundle({
      support,
      frontend,
      dto,
      effectiveDeploymentProvisioning,
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

    feRow = await persistMultiRepoStandaloneRow({
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
    });

    await installMultiRepoCiSecrets({
      support,
      provisioningToken,
      ownerLogin: repo.ownerLogin,
      repoName: repo.repoName,
      projectId: feRow.id,
    });

    const { commitSha: frontendCommitSha, commitUrl: frontendCommitUrl } =
      await support.pushWorkflowFiles(
        provisioningToken,
        repo.ownerLogin,
        repo.repoName,
        bundle.workflowFiles,
      );
    await support.projectsRepository.updateStatus(
      feRow.id,
      'provisioned',
      frontendCommitSha,
      frontendCommitUrl,
    );

    await createAndProtectDefaultBranches({
      support,
      provisioningToken,
      ownerLogin: repo.ownerLogin,
      repoName: repo.repoName,
    });

    feProvisioningComplete = true;
  } catch (err) {
    logger.warn(
      `Multi-repo project created but frontend repo provisioning failed: ${String(err)}`,
    );
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
    }
  }

  return { feRepoFullName, feRepoUrl, feRow };
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
}): CreateProjectResponse {
  return {
    id: input.backendRow.id,
    repoFullName: input.beRepoFullName,
    repoUrl: input.beRepoUrl,
    status: 'provisioned',
    workflowPath: input.backendWorkflowPath,
    workflowFiles: workflowFileMetadata(input.backendWorkflowFiles),
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
    deploymentProvisioning: input.deploymentProvisioning,
  };
}
