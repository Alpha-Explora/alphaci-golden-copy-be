import { Logger, UnprocessableEntityException } from '@nestjs/common';

import {
  withDefaultCreateDeploymentProvisioning,
  withDefaultFrontendDeploymentProvisioning,
  withRepoShapeRootDirectory,
} from '../../domain/deployment-provisioning.policy';
import type { CreateProjectDto } from '../../api/dto/create-project.dto';
import type { CreateProjectResponse } from './projects.service.types';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import type { ProjectProvisioningSupport } from './project-provisioning.support';
import {
  buildPackedBackendBundle,
  buildPackedCreateResponse,
  buildPackedFrontendBundle,
  createAndProtectPackedBranches,
  createPackedGithubRepo,
  installPackedRepoSecrets,
  packedSlotServicePath,
  persistPackedBackendRow,
  persistPackedFrontendRowIfPushed,
  provisionPackedDeploymentTargets,
  pushPackedBackendWorkflow,
  pushPackedFrontendWorkflow,
  pushPackedStarterFiles,
} from './microservices-project.steps';

export class MicroservicesProjectProvisioner {
  private readonly logger = new Logger(MicroservicesProjectProvisioner.name);

  constructor(private readonly support: ProjectProvisioningSupport) {}
  async createMicroservicesProject(
    userId: string,
    _userLogin: string,
    repositoryCreationToken: string,
    provisioningToken: string,
    provisioningOwnerLogin: string | undefined,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    if (!dto.microservicesConfig) {
      throw new UnprocessableEntityException(
        'microservicesConfig is required for microservices shape',
      );
    }

    const { backend, frontend } = dto.microservicesConfig;
    const backendServicePath = packedSlotServicePath(backend, 'backend');
    const frontendServicePath = packedSlotServicePath(frontend, 'frontend');
    const effectiveDeploymentProvisioning = withRepoShapeRootDirectory(
      withDefaultFrontendDeploymentProvisioning({
        request: withDefaultCreateDeploymentProvisioning({
          request: dto.deploymentProvisioning,
          projectTypeId: backend.projectTypeId,
          serviceName: backend.serviceName,
          repoName: dto.repoName,
          servicePath: backendServicePath,
          deploymentProvisioningDefaults:
            this.support.deploymentProvisioningDefaults,
        }),
        serviceName: frontend.serviceName,
        repoName: dto.repoName,
        servicePath: frontendServicePath,
        deploymentProvisioningDefaults:
          this.support.deploymentProvisioningDefaults,
      }),
      dto.repoShape,
    );

    const backendBundle = await buildPackedBackendBundle({
      support: this.support,
      backend,
      dto,
      backendServicePath,
      effectiveDeploymentProvisioning,
    });
    const frontendBundle = await buildPackedFrontendBundle({
      support: this.support,
      frontend,
      dto,
      frontendServicePath,
      effectiveDeploymentProvisioning,
    });

    const { repoUrl, ownerLogin, repoName } = await createPackedGithubRepo({
      support: this.support,
      repositoryCreationToken,
      dto,
      provisioningOwnerLogin,
    });
    const repoFullName = `${ownerLogin}/${repoName}`;

    let backendRow: ProvisionedProjectRow | undefined;
    let provisioningComplete = false;
    try {
      await pushPackedStarterFiles({
        support: this.support,
        provisioningToken,
        ownerLogin,
        repoName,
        dto,
        backend,
        frontend,
      });

      // Persist the backend row, issue the CI token, and install the shared
      // repo Actions secrets BEFORE pushing any workflow YAML — both pipeline
      // chains authenticate with the same repo-level ALPHACI_TOKEN, and the
      // access-gate runs as soon as a workflow file is pushed.
      backendRow = await persistPackedBackendRow({
        support: this.support,
        userId,
        dto,
        backend,
        ownerLogin,
        repoFullName,
        repoUrl,
        bundle: backendBundle,
      });
      await installPackedRepoSecrets({
        support: this.support,
        provisioningToken,
        ownerLogin,
        repoName,
        projectId: backendRow.id,
      });

      const { commitSha: backendCommitSha, commitUrl: backendCommitUrl } =
        await pushPackedBackendWorkflow({
          support: this.support,
          provisioningToken,
          ownerLogin,
          repoName,
          projectId: backendRow.id,
          workflowFiles: backendBundle.workflowFiles,
        });

      const { additionalWorkflowPaths, frontendPushResult } =
        await pushPackedFrontendWorkflow({
          support: this.support,
          logger: this.logger,
          provisioningToken,
          ownerLogin,
          repoName,
          frontendWorkflowFiles: frontendBundle.workflowFiles,
        });

      await createAndProtectPackedBranches({
        support: this.support,
        provisioningToken,
        ownerLogin,
        repoName,
      });

      // Repo is now fully usable; failures past this point must not delete it.
      provisioningComplete = true;

      await persistPackedFrontendRowIfPushed({
        support: this.support,
        logger: this.logger,
        userId,
        dto,
        frontend,
        ownerLogin,
        repoFullName,
        repoUrl,
        frontendBundle,
        frontendPushResult,
      });

      const deploymentProvisioning = await provisionPackedDeploymentTargets({
        support: this.support,
        userId,
        projectId: backendRow.id,
        repoFullName,
        provisioningToken,
        effectiveDeploymentProvisioning,
      });

      await this.support.recordProductEvent({
        userId,
        projectId: backendRow.id,
        eventCode: 'project_created',
        title: 'Project created',
        body: `${repoFullName} is now tracked by ALPHACI.`,
        metadata: {
          repoFullName,
          repoShape: 'microservices',
          projectTypeId: backend.projectTypeId,
        },
      });

      return buildPackedCreateResponse({
        backend,
        backendRow,
        repoFullName,
        repoUrl,
        backendWorkflowPath: backendBundle.workflowPath,
        backendWorkflowFiles: backendBundle.workflowFiles,
        backendCommitSha,
        backendCommitUrl,
        additionalWorkflowPaths,
        deploymentProvisioning,
      });
    } catch (error) {
      if (!provisioningComplete) {
        await this.support.compensateFailedProvision(
          provisioningToken,
          ownerLogin,
          repoName,
          backendRow?.id,
          userId,
        );
      }
      throw error;
    }
  }
}
