import { Logger, UnprocessableEntityException } from '@nestjs/common';

import { ALPHACI_REPORT_URL } from '../workflows/index';
import type { DeploymentProvisioningResult } from '#kernel/ports/deployment-runtime.port';
import { resolveDeploymentWorkflowTargets } from '../workflows/deployment-workflow-targets';
import { workflowFileMetadata } from '../dashboard/project-overview.view';
import {
  combineDeploymentProvisioningResults,
  extractDeploymentProvider,
  withDefaultCreateDeploymentProvisioning,
} from './deployment-provisioning.policy';
import { normalizeRepoShape } from '../../scaffold.builder';
import type { CreateProjectDto } from '../../dto/create-project.dto';
import type { CreateProjectResponse } from '../../projects.service.types';
import type { ProvisionedProjectRow } from '../../projects.repository';
import type { ProjectProvisioningSupport } from './project-provisioning.support';

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

    // Derive repo names — avoid double-suffixing if caller already appended -be
    const beRepoName = dto.repoName.endsWith('-be')
      ? dto.repoName
      : `${dto.repoName}-be`;
    const feRepoName = beRepoName.replace(/-be$/, '-fe');
    const effectiveDeploymentProvisioning =
      withDefaultCreateDeploymentProvisioning({
        request: dto.deploymentProvisioning,
        projectTypeId: backend.projectTypeId,
        serviceName: backend.serviceName,
        repoName: beRepoName,
        servicePath: '.',
        deploymentProvisioningDefaults:
          this.support.deploymentProvisioningDefaults,
      });

    // ── Backend repository ──────────────────────────────────────────────────

    const backendTemplateId = this.support.resolveTemplateId(
      backend.projectTypeId,
      backend.workflowRecipeId,
    );
    // Each repo carries a flat standalone scaffold, so the workflow always
    // runs at the repo root — slot servicePaths like 'backend/' only apply to
    // single-repo shapes and would point at a directory that does not exist.
    const {
      workflowFiles: backendWorkflowFiles,
      outputFileName: backendOutputFileName,
    } = await this.support.buildWorkflowBundle({
      templateId: backendTemplateId,
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
        this.support.workflowFragmentRegistry,
      ),
    });

    const {
      repoUrl: beRepoUrl,
      ownerLogin,
      repoName: actualBeRepoName,
    } = await this.support.githubService.createRepo(
      repositoryCreationToken,
      {
        repoName: beRepoName,
        private: dto.visibility === 'private',
      },
      provisioningOwnerLogin,
    );

    const beRepoFullName = `${ownerLogin}/${actualBeRepoName}`;
    const backendWorkflowPath =
      backendWorkflowFiles[0]?.path ??
      `.github/workflows/${backendOutputFileName}`;

    let backendRow: ProvisionedProjectRow | undefined;
    let backendCommitSha = '';
    let backendCommitUrl: string | null = null;
    let backendProvisioningComplete = false;
    try {
      await this.support.pushStarterFiles(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
        {
          projectName: backend.serviceName || actualBeRepoName,
          stack: backend.projectTypeId,
          repoShape: 'standalone',
          ...(dto.tests?.['docker'] !== undefined && {
            includeDocker: dto.tests['docker'],
          }),
        },
      );

      // Persist + token + secrets before the workflow push so the first
      // access-gate run can authenticate (see createProject for rationale).
      backendRow = await this.support.createProjectRow({
        userId,
        workspaceId:
          await this.support.workspaceGate.resolveWorkspaceIdForCreate(
            userId,
            dto.workspaceId,
          ),
        repoFullName: beRepoFullName,
        templateId: backendTemplateId,
        serviceName: backend.serviceName,
        workflowPath: backendWorkflowPath,
        status: 'provisioned',
        repoUrl: beRepoUrl,
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

      const backendCiToken = await this.support.ciService.issueProjectToken(
        backendRow.id,
      );
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
        'ALPHACI_TOKEN',
        backendCiToken.token,
      );
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.support.sonar.installSecrets(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
      );

      ({ commitSha: backendCommitSha, commitUrl: backendCommitUrl } =
        await this.support.pushWorkflowFiles(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          backendWorkflowFiles,
        ));
      await this.support.projectsRepository.updateStatus(
        backendRow.id,
        'provisioned',
        backendCommitSha,
        backendCommitUrl,
      );

      // `develop` remains available but unprotected and does not run CI.
      for (const branch of ['develop', 'uat'] as const) {
        await this.support.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          branch,
          'main',
        );
      }

      for (const branch of ['uat', 'main'] as const) {
        await this.support.githubService.applyBranchProtection(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          branch,
        );
      }

      backendProvisioningComplete = true;
    } catch (error) {
      if (!backendProvisioningComplete) {
        await this.support.compensateFailedProvision(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          backendRow?.id,
          userId,
        );
      }
      throw error;
    }

    if (!backendRow) {
      // Unreachable: a backend failure is rethrown from the catch above.
      throw new UnprocessableEntityException(
        'Backend repository provisioning did not complete',
      );
    }

    // ── Frontend repository (non-fatal on failure) ──────────────────────────

    let feRepoFullName: string | undefined;
    let feRepoUrl: string | undefined;
    let feRepoCreated: { owner: string; repo: string } | undefined;
    let feRow: ProvisionedProjectRow | undefined;
    let feProvisioningComplete = false;

    try {
      const frontendTemplateId = this.support.resolveTemplateId(
        frontend.projectTypeId,
        frontend.workflowRecipeId,
      );
      const {
        workflowFiles: frontendWorkflowFiles,
        outputFileName: frontendOutputFileName,
      } = await this.support.buildWorkflowBundle({
        templateId: frontendTemplateId,
        serviceName: frontend.serviceName,
        servicePath: '.',
        nodeVersion: dto.nodeVersion,
        coverageThreshold: dto.coverageThreshold,
        hasTestsDirectory: true,
        deploymentTargets: resolveDeploymentWorkflowTargets(
          effectiveDeploymentProvisioning,
          ['frontend'],
          '.',
          this.support.workflowFragmentRegistry,
        ),
      });

      const {
        repoUrl: resolvedFeRepoUrl,
        ownerLogin: feOwnerLogin,
        repoName: actualFeRepoName,
      } = await this.support.githubService.createRepo(
        repositoryCreationToken,
        {
          repoName: feRepoName,
          private: dto.visibility === 'private',
        },
        provisioningOwnerLogin,
      );

      feRepoCreated = { owner: feOwnerLogin, repo: actualFeRepoName };
      feRepoFullName = `${feOwnerLogin}/${actualFeRepoName}`;
      feRepoUrl = resolvedFeRepoUrl;

      await this.support.pushStarterFiles(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
        {
          projectName: frontend.serviceName || actualFeRepoName,
          stack: frontend.projectTypeId,
          repoShape: 'standalone',
          ...(dto.tests?.['docker'] !== undefined && {
            includeDocker: dto.tests['docker'],
          }),
        },
      );

      const frontendWorkflowPath =
        frontendWorkflowFiles[0]?.path ??
        `.github/workflows/${frontendOutputFileName}`;

      feRow = await this.support.createProjectRow({
        userId,
        workspaceId:
          await this.support.workspaceGate.resolveWorkspaceIdForCreate(
            userId,
            dto.workspaceId,
          ),
        repoFullName: feRepoFullName,
        templateId: frontendTemplateId,
        serviceName: frontend.serviceName,
        workflowPath: frontendWorkflowPath,
        status: 'provisioned',
        repoUrl: feRepoUrl,
        visibility: dto.visibility,
        repoShape: normalizeRepoShape(dto.repoShape),
        projectTypeId: frontend.projectTypeId,
        workflowRecipeId: frontend.workflowRecipeId ?? null,
        projectOptions: {
          ...this.support.repositoryOwnershipMetadata(dto, feOwnerLogin),
          workflowFiles: workflowFileMetadata(frontendWorkflowFiles),
        },
      });

      const frontendCiToken = await this.support.ciService.issueProjectToken(
        feRow.id,
      );
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
        'ALPHACI_TOKEN',
        frontendCiToken.token,
      );
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.support.sonar.installSecrets(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
      );

      const { commitSha: frontendCommitSha, commitUrl: frontendCommitUrl } =
        await this.support.pushWorkflowFiles(
          provisioningToken,
          feOwnerLogin,
          actualFeRepoName,
          frontendWorkflowFiles,
        );
      await this.support.projectsRepository.updateStatus(
        feRow.id,
        'provisioned',
        frontendCommitSha,
        frontendCommitUrl,
      );

      // `develop` remains available but unprotected and does not run CI.
      for (const branch of ['develop', 'uat'] as const) {
        await this.support.githubService.createBranch(
          provisioningToken,
          feOwnerLogin,
          actualFeRepoName,
          branch,
          'main',
        );
      }

      for (const branch of ['uat', 'main'] as const) {
        await this.support.githubService.applyBranchProtection(
          provisioningToken,
          feOwnerLogin,
          actualFeRepoName,
          branch,
        );
      }

      feProvisioningComplete = true;
    } catch (err) {
      this.logger.warn(
        `Multi-repo project created but frontend repo provisioning failed: ${String(err)}`,
      );
      // Roll back a half-created frontend repo so a retry can reuse its name;
      // the backend repo is fully provisioned and is still returned.
      if (!feProvisioningComplete && feRepoCreated) {
        await this.support.compensateFailedProvision(
          provisioningToken,
          feRepoCreated.owner,
          feRepoCreated.repo,
          feRow?.id,
          userId,
        );
        feRepoFullName = undefined;
        feRepoUrl = undefined;
      }
    }

    // Each repository provisions its own hosting slot: the backend repo gets
    // the Render target, the frontend repo (when it survived creation) gets
    // the Vercel target. Both use the centralized platform credentials.
    const provisioningResults: DeploymentProvisioningResult[] = [
      await this.support.provisionDeploymentTargets({
        projectId: backendRow.id,
        userId,
        repoFullName: beRepoFullName,
        githubAccessToken: provisioningToken,
        request: effectiveDeploymentProvisioning,
        slots: ['backend'],
      }),
    ];
    if (feRow && feRepoFullName) {
      provisioningResults.push(
        await this.support.provisionDeploymentTargets({
          projectId: feRow.id,
          userId,
          repoFullName: feRepoFullName,
          githubAccessToken: provisioningToken,
          request: effectiveDeploymentProvisioning,
          slots: ['frontend'],
        }),
      );

      // The per-repo provisioning passes cannot see each other's targets, so
      // cross-link the backend and frontend services here: the frontend gets
      // the backend's API URL, the backend gets the frontend origin for CORS.
      try {
        await this.support.projectDeploymentProvisioningService.crossLinkServiceUrls(
          {
            userId,
            request: effectiveDeploymentProvisioning,
            groups: [
              { projectId: backendRow.id, result: provisioningResults[0]! },
              { projectId: feRow.id, result: provisioningResults[1]! },
            ],
          },
        );
      } catch (error) {
        this.logger.warn(
          `Multi-repo cross-service env injection failed: ${String(error)}`,
        );
      }
    }

    return {
      id: backendRow.id,
      repoFullName: beRepoFullName,
      repoUrl: beRepoUrl,
      status: 'provisioned',
      workflowPath: backendWorkflowPath,
      workflowFiles: workflowFileMetadata(backendWorkflowFiles),
      githubCommitSha: backendCommitSha,
      githubCommitUrl: backendCommitUrl,
      projectTypeId: backend.projectTypeId,
      workflowRecipeId: backend.workflowRecipeId ?? '',
      additionalWorkflowPaths: [],
      ...(feRepoFullName !== undefined && {
        secondaryRepoFullName: feRepoFullName,
      }),
      ...(feRepoUrl !== undefined && { secondaryRepoUrl: feRepoUrl }),
      deploymentProvisioning:
        combineDeploymentProvisioningResults(provisioningResults),
    };
  }
}
