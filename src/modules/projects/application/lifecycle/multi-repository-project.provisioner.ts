import { Logger, UnprocessableEntityException } from '@nestjs/common';

import {
  withDefaultCreateDeploymentProvisioning,
  withDefaultFrontendDeploymentProvisioning,
  withRepoShapeRootDirectory,
} from '../../domain/deployment-provisioning.policy';
import type { CreateProjectDto } from '../../api/dto/create-project.dto';
import type { CreateProjectResponse } from './projects.service.types';
import type { ProjectProvisioningSupport } from './project-provisioning.support';
import {
  buildMultiRepoBackendBundle,
  buildMultiRepoCreateResponse,
  createMultiRepoGithubRepo,
  deriveMultiRepoNames,
  provisionMultiRepoBackend,
  provisionMultiRepoDeployments,
  provisionMultiRepoFrontend,
} from './multi-repository-project.steps';

export class MultiRepositoryProjectProvisioner {
  private readonly logger = new Logger(MultiRepositoryProjectProvisioner.name);

  constructor(private readonly support: ProjectProvisioningSupport) {}
  async createMultiRepoProject(
    userId: string,
    userLogin: string,
    repositoryCreationToken: string,
    provisioningToken: string,
    provisioningOwnerLogin: string | undefined,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    if (!dto.multiRepoConfig) {
      throw new UnprocessableEntityException(
        'multiRepoConfig is required for multi-repo shape',
      );
    }

    const { backend, frontend } = dto.multiRepoConfig;
    const { beRepoName, feRepoName } = deriveMultiRepoNames(dto.repoName);
    /*
     * Each repo's sibling full name, computed up front rather than read back
     * from repo-creation results: `provisioningOwnerLogin` already names the
     * owner both repos are about to be created under (it drives
     * createMultiRepoGithubRepo below), and the repo names are derived
     * deterministically above - so both full names are knowable before either
     * repo exists. That matters because the BACKEND bundle is built (and its
     * `sibling-repo` input baked into the generated YAML) before the
     * FRONTEND repo is created; waiting for the real frontend repo would mean
     * never being able to tell the backend about it.
     *
     * Left undefined - and the generated pipeline then carries no
     * `sibling-repo` input at all - only when provisioningOwnerLogin is
     * undefined: the personal-OAuth fallback where GitHub itself decides the
     * owner, so it cannot be predicted here. Personal workspaces are
     * currently retired, so this fallback is not expected to be reached for
     * multi-repo projects; if it is, promotion PRs are simply not
     * cross-linked, matching today's behavior exactly.
     *
     * If frontend repo creation later fails (see provisionMultiRepoFrontend),
     * the backend's already-pushed pipeline still carries this predicted
     * sibling name even though the frontend repo never came to exist -
     * promotion.yml's lookup against it degrades to a broken pulls-page link
     * rather than failing the job. Re-running frontend provisioning
     * afterwards would require regenerating the backend's workflow to match.
     */
    const beSiblingRepoFullName = provisioningOwnerLogin
      ? `${provisioningOwnerLogin}/${feRepoName}`
      : undefined;
    const feSiblingRepoFullName = provisioningOwnerLogin
      ? `${provisioningOwnerLogin}/${beRepoName}`
      : undefined;
    const effectiveDeploymentProvisioning = withRepoShapeRootDirectory(
      withDefaultFrontendDeploymentProvisioning({
        request: withDefaultCreateDeploymentProvisioning({
          request: dto.deploymentProvisioning,
          projectTypeId: backend.projectTypeId,
          serviceName: backend.serviceName,
          repoName: beRepoName,
          servicePath: '.',
          deploymentProvisioningDefaults:
            this.support.deploymentProvisioningDefaults,
        }),
        serviceName: frontend.serviceName,
        repoName: feRepoName,
        servicePath: '.',
        deploymentProvisioningDefaults:
          this.support.deploymentProvisioningDefaults,
      }),
      dto.repoShape,
    );

    const backendBundle = await buildMultiRepoBackendBundle({
      support: this.support,
      backend,
      dto,
      effectiveDeploymentProvisioning,
      ...(beSiblingRepoFullName !== undefined && {
        siblingRepoFullName: beSiblingRepoFullName,
      }),
    });
    const beRepo = await createMultiRepoGithubRepo({
      support: this.support,
      repositoryCreationToken,
      repoName: beRepoName,
      visibility: dto.visibility,
      provisioningOwnerLogin,
    });
    const beRepoFullName = `${beRepo.ownerLogin}/${beRepo.repoName}`;

    const backendProvision = await provisionMultiRepoBackend({
      support: this.support,
      userId,
      provisioningToken,
      dto,
      backend,
      repo: beRepo,
      bundle: backendBundle,
    });

    const frontendProvision = await provisionMultiRepoFrontend({
      support: this.support,
      logger: this.logger,
      userId,
      repositoryCreationToken,
      provisioningToken,
      provisioningOwnerLogin,
      dto,
      frontend,
      feRepoName,
      effectiveDeploymentProvisioning,
      pairDeliveryProjectId:
        dto.deliveryProjectId ?? backendProvision.deliveryProjectId,
      ...(feSiblingRepoFullName !== undefined && {
        siblingRepoFullName: feSiblingRepoFullName,
      }),
    });

    const deploymentProvisioning = await provisionMultiRepoDeployments({
      support: this.support,
      logger: this.logger,
      userId,
      provisioningToken,
      effectiveDeploymentProvisioning,
      backendRow: backendProvision.row,
      beRepoFullName,
      frontend: frontendProvision,
    });

    // ONE announcement per logical project, not one per repository. The
    // response already treats the backend row and repo as the project's
    // identity (id / repoFullName), the pair shares one delivery-project
    // folder so deep links resolve identically from either row, and the user
    // performed a single "create project" action.
    await this.support.notifyProjectCreated({
      workspaceId: backendProvision.row.workspace_id ?? null,
      creatorUserId: userId,
      creatorLogin: userLogin,
      projectId: backendProvision.row.id,
      repoFullName: beRepoFullName,
      metadata: {
        repoShape: 'multi-repo',
        projectTypeId: backend.projectTypeId,
        ...(frontendProvision.feRepoFullName
          ? { secondaryRepoFullName: frontendProvision.feRepoFullName }
          : {}),
      },
    });

    return buildMultiRepoCreateResponse({
      backend,
      backendRow: backendProvision.row,
      beRepoFullName,
      beRepoUrl: beRepo.repoUrl,
      backendWorkflowPath: backendBundle.workflowPath,
      backendWorkflowFiles: backendBundle.workflowFiles,
      backendCommitSha: backendProvision.commitSha,
      backendCommitUrl: backendProvision.commitUrl,
      frontend: frontendProvision,
      deploymentProvisioning,
    });
  }
}
