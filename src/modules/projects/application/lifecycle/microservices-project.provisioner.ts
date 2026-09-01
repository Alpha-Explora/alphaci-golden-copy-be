import { Logger, UnprocessableEntityException } from '@nestjs/common';

import { ALPHACI_REPORT_URL } from '../workflows/index';
import { resolveDeploymentWorkflowTargets } from '../workflows/deployment-workflow-targets';
import { workflowFileMetadata } from '../dashboard/project-overview.view';
import {
  extractDeploymentProvider,
  withDefaultCreateDeploymentProvisioning,
} from './deployment-provisioning.policy';
import { normalizeRepoShape } from '../../scaffold.builder';
import type { CreateProjectDto } from '../../dto/create-project.dto';
import type { CreateProjectResponse } from '../../projects.service.types';
import type { ProvisionedProjectRow } from '../../projects.repository';
import type { ProjectProvisioningSupport } from './project-provisioning.support';

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
    const effectiveDeploymentProvisioning =
      withDefaultCreateDeploymentProvisioning({
        request: dto.deploymentProvisioning,
        projectTypeId: backend.projectTypeId,
        serviceName: backend.serviceName,
        repoName: dto.repoName,
        servicePath: backend.servicePath ?? 'backend',
        deploymentProvisioningDefaults:
          this.support.deploymentProvisioningDefaults,
      });

    // 1. Resolve template IDs for both slots
    const backendTemplateId = this.support.resolveTemplateId(
      backend.projectTypeId,
      backend.workflowRecipeId,
    );
    const frontendTemplateId = this.support.resolveTemplateId(
      frontend.projectTypeId,
      frontend.workflowRecipeId,
    );

    // 2. Build workflow YAML for both slots. Each slot gets a variant suffix
    // so the two pipelines coexist in one repo without overwriting each other,
    // and service paths default to the scaffold's backend/ and frontend/ dirs.
    const {
      workflowFiles: backendWorkflowFiles,
      outputFileName: backendOutputFileName,
    } = await this.support.buildWorkflowBundle({
      templateId: backendTemplateId,
      serviceName: backend.serviceName,
      servicePath: backend.servicePath ?? 'backend',
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      workflowVariant: 'backend',
      // The scaffold seeds tests/ only inside its own backend/ dir; a custom
      // servicePath points at a layout the scaffold does not control.
      hasTestsDirectory: (backend.servicePath ?? 'backend') === 'backend',
      deploymentProvider: extractDeploymentProvider(
        effectiveDeploymentProvisioning,
        'backend',
      ),
      deploymentTargets: resolveDeploymentWorkflowTargets(
        effectiveDeploymentProvisioning,
        ['backend'],
        backend.servicePath ?? 'backend',
        this.support.workflowFragmentRegistry,
      ),
    });

    const {
      workflowFiles: frontendWorkflowFiles,
      outputFileName: frontendOutputFileName,
    } = await this.support.buildWorkflowBundle({
      templateId: frontendTemplateId,
      serviceName: frontend.serviceName,
      servicePath: frontend.servicePath ?? 'frontend',
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      workflowVariant: 'frontend',
      hasTestsDirectory: (frontend.servicePath ?? 'frontend') === 'frontend',
      deploymentTargets: resolveDeploymentWorkflowTargets(
        effectiveDeploymentProvisioning,
        ['frontend'],
        frontend.servicePath ?? 'frontend',
        this.support.workflowFragmentRegistry,
      ),
    });

    // 3. Create the GitHub repository once
    const { repoUrl, ownerLogin, repoName } =
      await this.support.githubService.createRepo(
        repositoryCreationToken,
        {
          repoName: dto.repoName,
          private: dto.visibility === 'private',
        },
        provisioningOwnerLogin,
      );

    const repoFullName = `${ownerLogin}/${repoName}`;
    const backendWorkflowPath =
      backendWorkflowFiles[0]?.path ??
      `.github/workflows/${backendOutputFileName}`;
    const frontendWorkflowPath =
      frontendWorkflowFiles[0]?.path ??
      `.github/workflows/${frontendOutputFileName}`;
    const additionalWorkflowPaths: string[] = [];

    let backendRow: ProvisionedProjectRow | undefined;
    let provisioningComplete = false;
    try {
      // 4. Push starter files to main so all subsequent branches inherit them
      await this.support.pushStarterFiles(
        provisioningToken,
        ownerLogin,
        repoName,
        {
          projectName: dto.repoName,
          stack: backend.projectTypeId,
          repoShape: 'microservices',
          ...(dto.tests?.['docker'] !== undefined && {
            includeDocker: dto.tests['docker'],
          }),
          backendServiceName: backend.serviceName,
          frontendStack: frontend.projectTypeId,
          frontendServiceName: frontend.serviceName,
        },
      );

      // 5. Persist the backend row, issue the CI token, and install the shared
      // repo Actions secrets BEFORE pushing any workflow YAML — both pipeline
      // chains authenticate with the same repo-level ALPHACI_TOKEN, and the
      // access-gate runs as soon as a workflow file is pushed.
      backendRow = await this.support.createProjectRow({
        userId,
        workspaceId:
          await this.support.workspaceGate.resolveWorkspaceIdForCreate(
            userId,
            dto.workspaceId,
          ),
        repoFullName,
        templateId: backendTemplateId,
        serviceName: backend.serviceName,
        workflowPath: backendWorkflowPath,
        status: 'provisioned',
        repoUrl,
        visibility: dto.visibility,
        repoShape: normalizeRepoShape(dto.repoShape),
        projectTypeId: backend.projectTypeId,
        workflowRecipeId: backend.workflowRecipeId ?? null,
        projectOptions: {
          ...this.support.repositoryOwnershipMetadata(dto, ownerLogin),
          ...(dto.tests ? { tests: dto.tests } : {}),
          workflowFiles: workflowFileMetadata(backendWorkflowFiles),
        },
      });

      const ciToken = await this.support.ciService.issueProjectToken(
        backendRow.id,
      );
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.support.sonar.installSecrets(
        provisioningToken,
        ownerLogin,
        repoName,
      );

      // 6. Push backend workflow file to main, then record the commit.
      const { commitSha: backendCommitSha, commitUrl: backendCommitUrl } =
        await this.support.pushWorkflowFiles(
          provisioningToken,
          ownerLogin,
          repoName,
          backendWorkflowFiles,
        );
      await this.support.projectsRepository.updateStatus(
        backendRow.id,
        'provisioned',
        backendCommitSha,
        backendCommitUrl,
      );

      // 7. Push frontend workflow file to main (wrapped: failure should not block backend)
      let frontendPushResult:
        | { commitSha: string; commitUrl: string | null }
        | undefined;
      try {
        frontendPushResult = await this.support.pushWorkflowFiles(
          provisioningToken,
          ownerLogin,
          repoName,
          frontendWorkflowFiles,
        );
        additionalWorkflowPaths.push(
          ...frontendWorkflowFiles.map((file) => file.path),
        );
      } catch (err) {
        this.logger.warn(
          `Microservices project: frontend workflow push failed: ${String(err)}`,
        );
      }

      // 8. Create develop and uat from main. CI runs only on uat/main.
      for (const branch of ['develop', 'uat'] as const) {
        await this.support.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
          'main',
        );
      }

      // 9. Protect only the integration/test and production branches.
      for (const branch of ['uat', 'main'] as const) {
        await this.support.githubService.applyBranchProtection(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
        );
      }

      // Repo is now fully usable; failures past this point must not delete it.
      provisioningComplete = true;

      // 10. Save frontend DB row if the push succeeded
      if (frontendPushResult !== undefined) {
        try {
          await this.support.createProjectRow({
            userId,
            workspaceId:
              await this.support.workspaceGate.resolveWorkspaceIdForCreate(
                userId,
                dto.workspaceId,
              ),
            repoFullName,
            templateId: frontendTemplateId,
            serviceName: frontend.serviceName,
            workflowPath: frontendWorkflowPath,
            status: 'provisioned',
            githubCommitSha: frontendPushResult.commitSha,
            githubCommitUrl: frontendPushResult.commitUrl,
            repoUrl,
            visibility: dto.visibility,
            repoShape: normalizeRepoShape(dto.repoShape),
            projectTypeId: frontend.projectTypeId,
            workflowRecipeId: frontend.workflowRecipeId ?? null,
            projectOptions: {
              ...this.support.repositoryOwnershipMetadata(dto, ownerLogin),
              workflowFiles: workflowFileMetadata(frontendWorkflowFiles),
            },
          });
        } catch (err) {
          this.logger.warn(
            `Microservices project: frontend DB row save failed: ${String(err)}`,
          );
        }
      }

      // Both slots live in this one repository, so a single provisioning pass
      // creates the backend + frontend hosting targets and installs their
      // centralized Render/Vercel Actions secrets.
      const deploymentProvisioning =
        await this.support.provisionDeploymentTargets({
          projectId: backendRow.id,
          userId,
          repoFullName,
          githubAccessToken: provisioningToken,
          request: effectiveDeploymentProvisioning,
          slots: ['backend', 'frontend'],
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

      return {
        id: backendRow.id,
        repoFullName,
        repoUrl,
        status: 'provisioned',
        workflowPath: backendWorkflowPath,
        workflowFiles: workflowFileMetadata(backendWorkflowFiles),
        githubCommitSha: backendCommitSha,
        githubCommitUrl: backendCommitUrl,
        projectTypeId: backend.projectTypeId,
        workflowRecipeId: backend.workflowRecipeId ?? '',
        additionalWorkflowPaths,
        deploymentProvisioning,
      };
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
