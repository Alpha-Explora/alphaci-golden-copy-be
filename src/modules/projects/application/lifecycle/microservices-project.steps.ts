import type { Logger } from '@nestjs/common';

import { ALPHACI_API_URL, ALPHACI_REPORT_URL } from '../workflows/index';
import type { DeploymentProvisioningResult } from '#kernel/ports/deployment-runtime.port';
import { resolveDeploymentWorkflowTargets } from '../workflows/deployment-workflow-targets';
import { workflowFileMetadata } from '../dashboard/project-overview.view';
import { extractDeploymentProvider } from '../../domain/deployment-provisioning.policy';
import { normalizeRepoShape } from '../../scaffold.builder';
import type {
  CreateProjectDto,
  DeploymentProvisioningRequestDto,
  MicroserviceSlotDto,
} from '../../api/dto/create-project.dto';
import type { CreateProjectResponse } from './projects.service.types';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import type { StagedWorkflowFile } from '../workflows/index';
import type { ProjectProvisioningSupport } from './project-provisioning.support';
import {
  BRANCHES_CREATED_ON_PROVISION,
  PROTECTED_BRANCHES,
  PROVISIONED_BRANCHES,
} from '#kernel/config/pipeline-branches';

export type CreatedPackedGithubRepo = {
  repoUrl: string;
  ownerLogin: string;
  repoName: string;
};

export type PackedWorkflowBundle = {
  templateId: string;
  workflowFiles: StagedWorkflowFile[];
  workflowPath: string;
};

export type PackedFrontendPush = {
  additionalWorkflowPaths: string[];
  frontendPushResult:
    | { commitSha: string; commitUrl: string | null }
    | undefined;
};

export function packedSlotServicePath(
  slot: MicroserviceSlotDto,
  fallback: string,
): string {
  return slot.servicePath ?? fallback;
}

export function workflowPathFromPackedBundle(
  workflowFiles: StagedWorkflowFile[],
  outputFileName: string,
): string {
  return workflowFiles[0]?.path ?? `.github/workflows/${outputFileName}`;
}

export function packedStarterIncludeDocker(
  tests: Partial<Record<string, boolean>> | undefined,
): { includeDocker?: boolean } {
  if (tests?.['docker'] === undefined) {
    return {};
  }
  return { includeDocker: tests['docker'] };
}

export function packedTestsProjectOption(
  tests: Partial<Record<string, boolean>> | undefined,
): { tests?: Partial<Record<string, boolean>> } {
  if (!tests) {
    return {};
  }
  return { tests };
}

export async function buildPackedBackendBundle(input: {
  support: ProjectProvisioningSupport;
  backend: MicroserviceSlotDto;
  dto: CreateProjectDto;
  backendServicePath: string;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
}): Promise<PackedWorkflowBundle> {
  const {
    support,
    backend,
    dto,
    backendServicePath,
    effectiveDeploymentProvisioning,
  } = input;
  const templateId = support.resolveTemplateId(
    backend.projectTypeId,
    backend.workflowRecipeId,
  );
  // Each slot gets a variant suffix so the two pipelines coexist in one
  // repo without overwriting each other.
  const { workflowFiles, outputFileName } = await support.buildWorkflowBundle({
    templateId,
    serviceName: backend.serviceName,
    servicePath: backendServicePath,
    nodeVersion: dto.nodeVersion,
    coverageThreshold: dto.coverageThreshold,
    workflowVariant: 'backend',
    // The scaffold seeds tests/ only inside its own backend/ dir; a custom
    // servicePath points at a layout the scaffold does not control.
    hasTestsDirectory: backendServicePath === 'backend',
    deploymentProvider: extractDeploymentProvider(
      effectiveDeploymentProvisioning,
      'backend',
    ),
    deploymentTargets: resolveDeploymentWorkflowTargets(
      effectiveDeploymentProvisioning,
      ['backend'],
      backendServicePath,
      support.workflowFragmentRegistry,
    ),
  });

  return {
    templateId,
    workflowFiles,
    workflowPath: workflowPathFromPackedBundle(workflowFiles, outputFileName),
  };
}

export async function buildPackedFrontendBundle(input: {
  support: ProjectProvisioningSupport;
  frontend: MicroserviceSlotDto;
  dto: CreateProjectDto;
  frontendServicePath: string;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
}): Promise<PackedWorkflowBundle> {
  const {
    support,
    frontend,
    dto,
    frontendServicePath,
    effectiveDeploymentProvisioning,
  } = input;
  const templateId = support.resolveTemplateId(
    frontend.projectTypeId,
    frontend.workflowRecipeId,
  );
  const { workflowFiles, outputFileName } = await support.buildWorkflowBundle({
    templateId,
    serviceName: frontend.serviceName,
    servicePath: frontendServicePath,
    nodeVersion: dto.nodeVersion,
    coverageThreshold: dto.coverageThreshold,
    workflowVariant: 'frontend',
    hasTestsDirectory: frontendServicePath === 'frontend',
    deploymentTargets: resolveDeploymentWorkflowTargets(
      effectiveDeploymentProvisioning,
      ['frontend'],
      frontendServicePath,
      support.workflowFragmentRegistry,
    ),
  });

  return {
    templateId,
    workflowFiles,
    workflowPath: workflowPathFromPackedBundle(workflowFiles, outputFileName),
  };
}

export async function createPackedGithubRepo(input: {
  support: ProjectProvisioningSupport;
  repositoryCreationToken: string;
  dto: CreateProjectDto;
  provisioningOwnerLogin: string | undefined;
}): Promise<CreatedPackedGithubRepo> {
  const created = await input.support.githubService.createRepo(
    input.repositoryCreationToken,
    {
      repoName: input.dto.repoName,
      private: input.dto.visibility === 'private',
    },
    input.provisioningOwnerLogin,
  );
  return {
    repoUrl: created.repoUrl,
    ownerLogin: created.ownerLogin,
    repoName: created.repoName,
  };
}

export async function pushPackedStarterFiles(input: {
  support: ProjectProvisioningSupport;
  provisioningToken: string;
  ownerLogin: string;
  repoName: string;
  dto: CreateProjectDto;
  backend: MicroserviceSlotDto;
  frontend: MicroserviceSlotDto;
}): Promise<void> {
  await input.support.pushStarterFiles(
    input.provisioningToken,
    input.ownerLogin,
    input.repoName,
    {
      projectName: input.dto.repoName,
      stack: input.backend.projectTypeId,
      repoShape: 'microservices',
      ...packedStarterIncludeDocker(input.dto.tests),
      backendServiceName: input.backend.serviceName,
      frontendStack: input.frontend.projectTypeId,
      frontendServiceName: input.frontend.serviceName,
    },
  );
}

export async function persistPackedBackendRow(input: {
  support: ProjectProvisioningSupport;
  userId: string;
  dto: CreateProjectDto;
  backend: MicroserviceSlotDto;
  ownerLogin: string;
  repoFullName: string;
  repoUrl: string;
  bundle: PackedWorkflowBundle;
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
    backend,
    ownerLogin,
    repoFullName,
    repoUrl,
    bundle,
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
      ),
      repoFullName,
      templateId: bundle.templateId,
      serviceName: backend.serviceName,
      workflowPath: bundle.workflowPath,
      status: 'provisioned',
      repoUrl,
      visibility: dto.visibility,
      repoShape: normalizeRepoShape(dto.repoShape),
      projectTypeId: backend.projectTypeId,
      workflowRecipeId: backend.workflowRecipeId ?? null,
      projectOptions: {
        ...support.repositoryOwnershipMetadata(dto, ownerLogin),
        ...packedTestsProjectOption(dto.tests),
        workflowFiles: workflowFileMetadata(bundle.workflowFiles),
      },
    },
    {
      ...(deliveryProjectId !== undefined && { deliveryProjectId }),
      ...(chainName !== undefined && { chainName }),
      ...(enforceUniqueChainName && { enforceUniqueChainName }),
    },
  );
}

export async function installPackedRepoSecrets(input: {
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

export async function pushPackedBackendWorkflow(input: {
  support: ProjectProvisioningSupport;
  provisioningToken: string;
  ownerLogin: string;
  repoName: string;
  projectId: string;
  workflowFiles: StagedWorkflowFile[];
}): Promise<{ commitSha: string; commitUrl: string | null }> {
  const { commitSha, commitUrl } = await input.support.pushWorkflowFiles(
    input.provisioningToken,
    input.ownerLogin,
    input.repoName,
    input.workflowFiles,
  );
  await input.support.projectsRepository.updateStatus(
    input.projectId,
    'provisioned',
    commitSha,
    commitUrl,
  );
  return { commitSha, commitUrl };
}

export async function pushPackedFrontendWorkflow(input: {
  support: ProjectProvisioningSupport;
  logger: Logger;
  provisioningToken: string;
  ownerLogin: string;
  repoName: string;
  frontendWorkflowFiles: StagedWorkflowFile[];
}): Promise<PackedFrontendPush> {
  const additionalWorkflowPaths: string[] = [];
  let frontendPushResult:
    | { commitSha: string; commitUrl: string | null }
    | undefined;
  try {
    frontendPushResult = await input.support.pushWorkflowFiles(
      input.provisioningToken,
      input.ownerLogin,
      input.repoName,
      input.frontendWorkflowFiles,
    );
    additionalWorkflowPaths.push(
      ...input.frontendWorkflowFiles.map((file) => file.path),
    );
  } catch (err) {
    input.logger.warn(
      `Microservices project: frontend workflow push failed: ${String(err)}`,
    );
  }
  return { additionalWorkflowPaths, frontendPushResult };
}

export async function createAndProtectPackedBranches(input: {
  support: ProjectProvisioningSupport;
  provisioningToken: string;
  ownerLogin: string;
  repoName: string;
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

  for (const branch of PROTECTED_BRANCHES) {
    await input.support.githubService.applyBranchProtection(
      input.provisioningToken,
      input.ownerLogin,
      input.repoName,
      branch,
    );
  }
}

export async function persistPackedFrontendRowIfPushed(input: {
  support: ProjectProvisioningSupport;
  logger: Logger;
  userId: string;
  dto: CreateProjectDto;
  frontend: MicroserviceSlotDto;
  ownerLogin: string;
  repoFullName: string;
  repoUrl: string;
  frontendBundle: PackedWorkflowBundle;
  frontendPushResult:
    | { commitSha: string; commitUrl: string | null }
    | undefined;
  /**
   * The delivery project both slots must share — either the caller's
   * explicit dto.deliveryProjectId, or the chain the backend row just
   * auto-created. Null only when the backend row itself linked nowhere.
   */
  pairDeliveryProjectId: string | null;
}): Promise<void> {
  if (input.frontendPushResult === undefined) {
    return;
  }

  try {
    await input.support.createProjectRow(
      {
        userId: input.userId,
        workspaceId:
          await input.support.workspaceGate.resolveWorkspaceIdForCreate(
            input.userId,
            input.dto.workspaceId,
            input.dto.deliveryProjectId,
          ),
        repoFullName: input.repoFullName,
        templateId: input.frontendBundle.templateId,
        serviceName: input.frontend.serviceName,
        workflowPath: input.frontendBundle.workflowPath,
        status: 'provisioned',
        githubCommitSha: input.frontendPushResult.commitSha,
        githubCommitUrl: input.frontendPushResult.commitUrl,
        repoUrl: input.repoUrl,
        visibility: input.dto.visibility,
        repoShape: normalizeRepoShape(input.dto.repoShape),
        projectTypeId: input.frontend.projectTypeId,
        workflowRecipeId: input.frontend.workflowRecipeId ?? null,
        projectOptions: {
          ...input.support.repositoryOwnershipMetadata(
            input.dto,
            input.ownerLogin,
          ),
          workflowFiles: workflowFileMetadata(
            input.frontendBundle.workflowFiles,
          ),
        },
      },
      input.pairDeliveryProjectId
        ? { deliveryProjectId: input.pairDeliveryProjectId }
        : { chainName: input.dto.projectName?.trim() || input.dto.repoName },
    );
  } catch (err) {
    input.logger.warn(
      `Microservices project: frontend DB row save failed: ${String(err)}`,
    );
  }
}

export async function provisionPackedDeploymentTargets(input: {
  support: ProjectProvisioningSupport;
  userId: string;
  projectId: string;
  repoFullName: string;
  provisioningToken: string;
  effectiveDeploymentProvisioning: DeploymentProvisioningRequestDto | undefined;
}): Promise<DeploymentProvisioningResult> {
  // Both slots live in this one repository, so a single provisioning pass
  // creates the backend + frontend hosting targets and installs their
  // centralized Render/Vercel Actions secrets.
  return input.support.provisionDeploymentTargets({
    projectId: input.projectId,
    userId: input.userId,
    repoFullName: input.repoFullName,
    githubAccessToken: input.provisioningToken,
    request: input.effectiveDeploymentProvisioning,
    slots: ['backend', 'frontend'],
  });
}

export function buildPackedCreateResponse(input: {
  backend: MicroserviceSlotDto;
  backendRow: ProvisionedProjectRow;
  repoFullName: string;
  repoUrl: string;
  backendWorkflowPath: string;
  backendWorkflowFiles: StagedWorkflowFile[];
  backendCommitSha: string;
  backendCommitUrl: string | null;
  additionalWorkflowPaths: string[];
  deploymentProvisioning: DeploymentProvisioningResult;
}): CreateProjectResponse {
  return {
    id: input.backendRow.id,
    repoFullName: input.repoFullName,
    repoUrl: input.repoUrl,
    status: 'provisioned',
    branchesCreated: [...PROVISIONED_BRANCHES],
    workflowPath: input.backendWorkflowPath,
    workflowFiles: workflowFileMetadata(input.backendWorkflowFiles),
    githubCommitSha: input.backendCommitSha,
    githubCommitUrl: input.backendCommitUrl,
    projectTypeId: input.backend.projectTypeId,
    workflowRecipeId: input.backend.workflowRecipeId ?? '',
    additionalWorkflowPaths: input.additionalWorkflowPaths,
    deploymentProvisioning: input.deploymentProvisioning,
  };
}
