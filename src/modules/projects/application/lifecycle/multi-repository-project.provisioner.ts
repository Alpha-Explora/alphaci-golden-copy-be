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
    _userLogin: string,
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
