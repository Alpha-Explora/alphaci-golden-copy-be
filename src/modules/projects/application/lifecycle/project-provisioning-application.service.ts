import {
  Inject,
  Injectable,
  Logger,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import { CiService } from '#modules/pipelines/index.js';
import { AuditEventsService } from '#modules/platform-ops/index.js';
import {
  DEPLOYMENT_PROVISIONING_FACADE,
  type DeploymentProvisioningFacade,
  type DeploymentProvisioningResult,
} from '#modules/runtime/index.js';
import { WorkflowFragmentRegistry } from '#modules/runtime/index.js';
import { GithubService } from '#modules/pipelines/index.js';
import { CatalogService } from '../catalog/catalog.service';
import { HierarchyProjectLinkService } from '#modules/identity-access/hierarchy/project-link/index.js';
import {
  ALPHACI_REPORT_URL,
  type StagedWorkflowFile,
  type DeploymentWorkflowTarget,
} from '../workflows/index';
import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from '../../projects.repository';
import type { CreateProjectDto } from '../../dto/create-project.dto';
import {
  combineDeploymentProvisioningResults,
  extractDeploymentProvider,
  filterDeploymentProvisioningRequest,
  forceManagedProvisioning,
  resolveSingleRepoDeploymentSlots,
  skippedDeploymentProvisioning,
  withDefaultCreateDeploymentProvisioning,
} from './deployment-provisioning.policy';
import { resolveDeploymentWorkflowTargets } from '../workflows/deployment-workflow-targets';
import { buildGeneratedRepoReadme } from './generated-repo-readme';
import {
  SonarCloudSetupService,
  sonarProjectKeyFor,
} from './sonar-cloud-setup.service';
import { ProvisioningTokenService } from './provisioning-token.service';
import { SetupBranchService } from './setup-branch.service';
import { WorkspaceGateService } from './workspace-gate.service';
import { ProductEventsService } from './product-events.service';
import { ProjectWorkflowFilesService } from '../workflows/project-workflow-files.service';
import { workflowFileMetadata } from '../dashboard/project-overview.view';
import type { SetupProjectDto } from '../../dto/setup-project.dto';
import {
  type UsageLimitCode,
  type UsageQuotaService,
} from '#modules/billing/index.js';
import type { WorkspacesService } from '#modules/identity-access/index.js';
import {
  buildProjectScaffold,
  defaultIncludeDocker,
  normalizeRepoShape,
} from '../../scaffold.builder';
import type {
  DeploymentProvisioningRequestDto,
  DeploymentProvisioningTargetDto,
} from '../../dto/create-project.dto';
import type {
  CreateProjectResponse,
  SetupProjectResponse,
} from '../../projects.service.types';

export type * from '../../projects.service.types';

type WorkflowFilePusher = (
  accessToken: string,
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  commitMessage?: string,
  branch?: string,
) => Promise<{ commitSha: string; commitUrl: string | null }>;

@Injectable()
export class ProjectProvisioningApplicationService {
  private readonly logger = new Logger(
    ProjectProvisioningApplicationService.name,
  );
  /** Lazily-created SonarCloud delegate for direct constructions (tests). */
  private sonarSetupLazy?: SonarCloudSetupService;
  private get sonar(): SonarCloudSetupService {
    return (this.sonarSetupLazy ??= new SonarCloudSetupService(
      this.githubService,
      this.configService as ConfigService,
    ));
  }

  /** Lazily-created workflow-files delegate for direct constructions (tests). */
  private workflowFilesLazy?: ProjectWorkflowFilesService;
  private get workflowFiles(): ProjectWorkflowFilesService {
    return (this.workflowFilesLazy ??= new ProjectWorkflowFilesService(
      this.catalogService,
      this.workflowFragmentRegistry,
    ));
  }

  /** Lazily-created token-resolution delegate for direct constructions. */
  private tokensLazy?: ProvisioningTokenService;
  private get tokens(): ProvisioningTokenService {
    return (this.tokensLazy ??= new ProvisioningTokenService(
      this.githubService,
    ));
  }

  /** Lazily-created setup-branch delegate for direct constructions. */
  private setupBranchLazy?: SetupBranchService;
  private get setupBranch(): SetupBranchService {
    return (this.setupBranchLazy ??= new SetupBranchService(
      this.githubService,
    ));
  }

  /** Lazily-created workspace-gate delegate for direct constructions. */
  private workspaceGateLazy?: WorkspaceGateService;
  private get workspaceGate(): WorkspaceGateService {
    return (this.workspaceGateLazy ??= new WorkspaceGateService(
      this.projectsRepository,
      this.workspacesService,
    ));
  }

  /** Lazily-created product-events delegate for direct constructions. */
  private productEventsLazy?: ProductEventsService;
  private get productEvents(): ProductEventsService {
    return (this.productEventsLazy ??= new ProductEventsService(
      this.auditEventPublisher ?? this.auditEventsService,
      this.notificationEventPublisher,
    ));
  }

  /**
   * Spy/seam retained for the existing spec suite: tests stub file pushes at
   * this boundary rather than constructing a full ProjectWorkflowFilesService.
   */
  private async pushWorkflowFile(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    commitMessage = 'ci: add ALPHACI workflow',
    branch = 'main',
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    if (this.workflowFilePusher) {
      return this.workflowFilePusher(
        accessToken,
        owner,
        repo,
        filePath,
        content,
        commitMessage,
        branch,
      );
    }

    return this.workflowFiles.pushWorkflowFile(
      accessToken,
      owner,
      repo,
      filePath,
      content,
      commitMessage,
      branch,
    );
  }

  /** Spy/seam for workflow-file batch pushes (see pushWorkflowFile note). */
  private async pushWorkflowFiles(
    accessToken: string,
    owner: string,
    repo: string,
    workflowFiles: StagedWorkflowFile[],
    branch = 'main',
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    let latest: { commitSha: string; commitUrl: string | null } | null = null;

    for (const file of workflowFiles) {
      latest = await this.pushWorkflowFile(
        accessToken,
        owner,
        repo,
        file.path,
        file.yaml,
        undefined,
        branch,
      );
    }

    if (!latest) {
      throw new UnprocessableEntityException(
        'No workflow files were generated',
      );
    }

    return latest;
  }

  /** Spy/seam for bundle assembly (see pushWorkflowFile note). */
  private async buildWorkflowBundle(options: {
    templateId: string;
    serviceName: string;
    servicePath?: string | undefined;
    nodeVersion?: string | undefined;
    coverageThreshold?: number | undefined;
    customOutputFileName?: string | undefined;
    enhancements?:
      | Array<
          | 'strictProductionApproval'
          | 'enableUatApproval'
          | 'disablePlaywright'
          | 'disableK6'
        >
      | undefined;
    deploymentProvider?: string | undefined;
    deploymentTargets?: DeploymentWorkflowTarget[] | undefined;
    workflowVariant?: 'backend' | 'frontend' | undefined;
    centralWorkflowRef?: string | undefined;
    hasTestsDirectory?: boolean | undefined;
  }): Promise<{ workflowFiles: StagedWorkflowFile[]; outputFileName: string }> {
    return this.workflowFiles.buildWorkflowBundle(options);
  }

  /** Spy/seam for direct YAML building (see pushWorkflowFile note). */
  async buildWorkflowYaml(
    templateId: string,
    serviceName: string,
    servicePath?: string,
    nodeVersion?: string,
    coverageThreshold?: number,
    customOutputFileName?: string,
    enhancements?: Array<
      | 'strictProductionApproval'
      | 'enableUatApproval'
      | 'disablePlaywright'
      | 'disableK6'
    >,
  ): Promise<{ generatedYaml: string; outputFileName: string }> {
    return this.workflowFiles.buildWorkflowYaml(
      templateId,
      serviceName,
      servicePath,
      nodeVersion,
      coverageThreshold,
      customOutputFileName,
      enhancements,
    );
  }

  constructor(
    private readonly catalogService: CatalogService,
    private readonly githubService: GithubService,
    private readonly projectsRepository: ProjectsRepository,
    private readonly ciService: CiService,
    @Inject(DEPLOYMENT_PROVISIONING_FACADE)
    private readonly projectDeploymentProvisioningService: DeploymentProvisioningFacade,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly usageQuotaService?: UsageQuotaService,
    @Optional()
    private readonly auditEventsService?: AuditEventsService,
    @Optional()
    private readonly workspacesService?: WorkspacesService,
    @Optional()
    private readonly notificationEventPublisher?: NotificationEventPublisher,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
    @Optional()
    private readonly hierarchyProjectLinkService?: HierarchyProjectLinkService,
    @Optional()
    private readonly workflowFilePusher?: WorkflowFilePusher,
    @Optional()
    private readonly workflowFragmentRegistry?: WorkflowFragmentRegistry,
  ) {} // ─── POST /projects ────────────────────────────────────────────────────────

  async createProject(
    userId: string,
    userLogin: string,
    accessToken: string | null,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    await this.assertWithinQuota(userId, 'projects', 1, null);
    // Settle the owning team BEFORE any GitHub call. The row is written long after
    // the repository exists and the workflow is pushed, so discovering there that
    // the caller named no resolvable team would leave a real repository behind
    // for a request that never had anywhere to put it.
    await this.workspaceGate.resolveWorkspaceIdForCreate(
      userId,
      dto.workspaceId,
    );
    const {
      repositoryCreationToken,
      provisioningToken,
      provisioningOwnerLogin,
    } = await this.tokens.resolveRepositoryProvisioning(
      userId,
      accessToken,
      dto,
    );

    // The catalog publishes the shape IDs 'mono' and 'multi'; normalize so
    // the flow dispatch never silently falls back to the standalone path.
    const repoShape = normalizeRepoShape(dto.repoShape);

    if (repoShape === 'microservices') {
      return this.createMicroservicesProject(
        userId,
        userLogin,
        repositoryCreationToken,
        provisioningToken,
        provisioningOwnerLogin,
        dto,
      );
    }

    if (repoShape === 'multi-repo') {
      return this.createMultiRepoProject(
        userId,
        userLogin,
        repositoryCreationToken,
        provisioningToken,
        provisioningOwnerLogin,
        dto,
      );
    }

    // 1. Resolve templateId from projectTypeId + workflowRecipeId
    const templateId = this.resolveTemplateId(
      dto.projectTypeId,
      dto.workflowRecipeId,
    );
    const effectiveDeploymentProvisioning =
      withDefaultCreateDeploymentProvisioning({
        request: dto.deploymentProvisioning,
        projectTypeId: dto.projectTypeId,
        serviceName: dto.serviceName,
        repoName: dto.repoName,
        servicePath: dto.servicePath,
      });

    // 2. Load template and build workflow YAML
    const { workflowFiles, outputFileName } = await this.buildWorkflowBundle({
      templateId,
      serviceName: dto.serviceName,
      servicePath: dto.servicePath,
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      customOutputFileName: dto.outputFileName,
      // The standalone scaffold ships tests/ at the repo root; the monorepo
      // keeps tests under packages/*, so the root-level guard stays off.
      hasTestsDirectory: repoShape === 'standalone',
      deploymentProvider: extractDeploymentProvider(
        effectiveDeploymentProvisioning,
        'backend',
      ),
      deploymentTargets: resolveDeploymentWorkflowTargets(
        effectiveDeploymentProvisioning,
        ['standalone', 'backend', 'frontend'],
        dto.servicePath,
        this.workflowFragmentRegistry,
      ),
    });

    // 3. Create the GitHub repository (auto_init: true creates main branch)
    const { repoUrl, ownerLogin, repoName } =
      await this.githubService.createRepo(
        repositoryCreationToken,
        {
          repoName: dto.repoName,
          private: dto.visibility === 'private',
        },
        provisioningOwnerLogin,
      );

    const repoFullName = `${ownerLogin}/${repoName}`;
    const workflowPath =
      workflowFiles[0]?.path ?? `.github/workflows/${outputFileName}`;

    // Once the repo exists, wrap the remaining steps so a mid-flow failure
    // compensates by deleting the half-created repo + DB row instead of leaving
    // an orphan that would 422 on the next attempt.
    let row: ProvisionedProjectRow | undefined;
    let provisioningComplete = false;
    try {
      // 3.5 Push scaffold + README to main so all downstream branches inherit them
      await this.pushStarterFiles(provisioningToken, ownerLogin, repoName, {
        projectName: dto.serviceName,
        stack: dto.projectTypeId,
        repoShape,
        ...(dto.tests?.['docker'] !== undefined && {
          includeDocker: dto.tests['docker'],
        }),
      });

      // 4. Persist the project, issue the CI token, and install the Actions
      // secrets BEFORE any workflow YAML exists. The access-gate workflow runs
      // the instant a workflow file is pushed (and again on branch creation),
      // so the secrets must already be present or that first run fails for lack
      // of ALPHACI_TOKEN. Secrets are installed strictly so a token without
      // `secrets:write` aborts provisioning here rather than producing a repo
      // whose pipelines can never authenticate.
      row = await this.createProjectRow({
        userId,
        workspaceId: await this.workspaceGate.resolveWorkspaceIdForCreate(
          userId,
          dto.workspaceId,
        ),
        repoFullName,
        templateId,
        serviceName: dto.serviceName,
        workflowPath,
        status: 'provisioned',
        repoUrl,
        visibility: dto.visibility,
        repoShape,
        projectTypeId: dto.projectTypeId,
        workflowRecipeId: dto.workflowRecipeId ?? null,
        projectOptions: {
          ...this.repositoryOwnershipMetadata(dto, ownerLogin),
          ...(dto.tests ? { tests: dto.tests } : {}),
          workflowFiles: workflowFileMetadata(workflowFiles),
        },
      });

      const ciToken = await this.ciService.issueProjectToken(row.id);
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.sonar.installSecrets(provisioningToken, ownerLogin, repoName);

      // 5. Push workflow YAML to main now that the secrets exist, then record
      // the resulting commit on the project row.
      const { commitSha, commitUrl } = await this.pushWorkflowFiles(
        provisioningToken,
        ownerLogin,
        repoName,
        workflowFiles,
      );
      await this.projectsRepository.updateStatus(
        row.id,
        'provisioned',
        commitSha,
        commitUrl,
      );

      // 6. Create develop and uat from main. `develop` is intentionally
      // unprotected and has no CI trigger; uat is the integration/test branch.
      for (const branch of ['develop', 'uat'] as const) {
        await this.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
          'main',
        );
      }

      // 7. Only uat and main are protected long-lived branches.
      for (const branch of ['uat', 'main'] as const) {
        await this.githubService.applyBranchProtection(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
        );
      }

      // Repo is now fully usable; failures past this point must not delete it.
      provisioningComplete = true;

      // Create the requested hosting targets on the centralized platform
      // accounts and install their Render/Vercel Actions secrets.
      const deploymentProvisioning = await this.provisionDeploymentTargets({
        projectId: row.id,
        userId,
        repoFullName,
        githubAccessToken: provisioningToken,
        request: effectiveDeploymentProvisioning,
        slots: resolveSingleRepoDeploymentSlots(
          effectiveDeploymentProvisioning,
        ),
      });

      await this.recordProductEvent({
        userId,
        projectId: row.id,
        eventCode: 'project_created',
        title: 'Project created',
        body: `${repoFullName} is now tracked by ALPHACI.`,
        metadata: {
          repoFullName,
          repoShape,
          projectTypeId: dto.projectTypeId,
        },
      });

      return {
        id: row.id,
        repoFullName,
        repoUrl,
        status: 'provisioned',
        workflowPath,
        workflowFiles: workflowFileMetadata(workflowFiles),
        githubCommitSha: commitSha,
        githubCommitUrl: commitUrl,
        projectTypeId: dto.projectTypeId,
        workflowRecipeId: dto.workflowRecipeId ?? '',
        deploymentProvisioning,
      };
    } catch (error) {
      if (!provisioningComplete) {
        await this.compensateFailedProvision(
          provisioningToken,
          ownerLogin,
          repoName,
          row?.id,
          userId,
        );
      }
      throw error;
    }
  }

  // ─── POST /projects (microservices shape) ─────────────────────────────────

  private async createMicroservicesProject(
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
      });

    // 1. Resolve template IDs for both slots
    const backendTemplateId = this.resolveTemplateId(
      backend.projectTypeId,
      backend.workflowRecipeId,
    );
    const frontendTemplateId = this.resolveTemplateId(
      frontend.projectTypeId,
      frontend.workflowRecipeId,
    );

    // 2. Build workflow YAML for both slots. Each slot gets a variant suffix
    // so the two pipelines coexist in one repo without overwriting each other,
    // and service paths default to the scaffold's backend/ and frontend/ dirs.
    const {
      workflowFiles: backendWorkflowFiles,
      outputFileName: backendOutputFileName,
    } = await this.buildWorkflowBundle({
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
        this.workflowFragmentRegistry,
      ),
    });

    const {
      workflowFiles: frontendWorkflowFiles,
      outputFileName: frontendOutputFileName,
    } = await this.buildWorkflowBundle({
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
        this.workflowFragmentRegistry,
      ),
    });

    // 3. Create the GitHub repository once
    const { repoUrl, ownerLogin, repoName } =
      await this.githubService.createRepo(
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
      await this.pushStarterFiles(provisioningToken, ownerLogin, repoName, {
        projectName: dto.repoName,
        stack: backend.projectTypeId,
        repoShape: 'microservices',
        ...(dto.tests?.['docker'] !== undefined && {
          includeDocker: dto.tests['docker'],
        }),
        backendServiceName: backend.serviceName,
        frontendStack: frontend.projectTypeId,
        frontendServiceName: frontend.serviceName,
      });

      // 5. Persist the backend row, issue the CI token, and install the shared
      // repo Actions secrets BEFORE pushing any workflow YAML — both pipeline
      // chains authenticate with the same repo-level ALPHACI_TOKEN, and the
      // access-gate runs as soon as a workflow file is pushed.
      backendRow = await this.createProjectRow({
        userId,
        workspaceId: await this.workspaceGate.resolveWorkspaceIdForCreate(
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
          ...this.repositoryOwnershipMetadata(dto, ownerLogin),
          ...(dto.tests ? { tests: dto.tests } : {}),
          workflowFiles: workflowFileMetadata(backendWorkflowFiles),
        },
      });

      const ciToken = await this.ciService.issueProjectToken(backendRow.id);
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.sonar.installSecrets(provisioningToken, ownerLogin, repoName);

      // 6. Push backend workflow file to main, then record the commit.
      const { commitSha: backendCommitSha, commitUrl: backendCommitUrl } =
        await this.pushWorkflowFiles(
          provisioningToken,
          ownerLogin,
          repoName,
          backendWorkflowFiles,
        );
      await this.projectsRepository.updateStatus(
        backendRow.id,
        'provisioned',
        backendCommitSha,
        backendCommitUrl,
      );

      // 7. Push frontend workflow file to main (wrapped: failure should not block backend)
      let frontendPushResult:
        { commitSha: string; commitUrl: string | null } | undefined;
      try {
        frontendPushResult = await this.pushWorkflowFiles(
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
        await this.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
          'main',
        );
      }

      // 9. Protect only the integration/test and production branches.
      for (const branch of ['uat', 'main'] as const) {
        await this.githubService.applyBranchProtection(
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
          await this.createProjectRow({
            userId,
            workspaceId: await this.workspaceGate.resolveWorkspaceIdForCreate(
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
              ...this.repositoryOwnershipMetadata(dto, ownerLogin),
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
      const deploymentProvisioning = await this.provisionDeploymentTargets({
        projectId: backendRow.id,
        userId,
        repoFullName,
        githubAccessToken: provisioningToken,
        request: effectiveDeploymentProvisioning,
        slots: ['backend', 'frontend'],
      });

      await this.recordProductEvent({
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
        await this.compensateFailedProvision(
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

  // ─── POST /projects/setup ──────────────────────────────────────────────────

  async setupProject(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse> {
    // Settle the owning team first - this path mutates an existing repository
    // (branches, secrets, a workflow commit) before the row is written, and none
    // of that should happen for a request with nowhere to put the project.
    await this.workspaceGate.resolveWorkspaceIdForCreate(
      userId,
      dto.workspaceId,
    );

    // 1. Build workflow YAML from the given templateId
    const { workflowFiles, outputFileName } = await this.buildWorkflowBundle({
      templateId: dto.templateId,
      serviceName: dto.serviceName,
      servicePath: dto.servicePath,
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      customOutputFileName: dto.outputFileName,
      enhancements: dto.enhancements,
      deploymentProvider: extractDeploymentProvider(
        dto.deploymentProvisioning,
        'backend',
      ),
      deploymentTargets: resolveDeploymentWorkflowTargets(
        dto.deploymentProvisioning,
        ['standalone', 'backend', 'frontend'],
        dto.servicePath,
        this.workflowFragmentRegistry,
      ),
    });

    // 2. Derive owner and repo from repoFullName (format: "owner/repo")
    const [owner, repo] = this.parseRepoFullName(dto.repoFullName);

    // Product decision: going forward, Setup-flow attachments are restricted
    // to the enforced org, same as brand-new repository creation. Already
    // attached external repos in the DB are untouched — this only blocks new
    // attachments. Enforced defense-in-depth: the FE repo picker is filtered
    // too, but the FE is not a trust boundary. Mirrors the `if (enforcedOrg)`
    // guard in resolveRepositoryProvisioning — an unconfigured/empty enforced
    // org means no restriction is active.
    const enforcedOrg = this.githubService.getEnforcedOrg();
    if (enforcedOrg && owner.toLowerCase() !== enforcedOrg.toLowerCase()) {
      throw new UnprocessableEntityException(
        `repoFullName must belong to the ${enforcedOrg} organization. '${owner}' is not allowed for new Setup-flow attachments.`,
      );
    }

    const accessToken = await this.tokens.resolveSetupProvisioningToken(
      userId,
      oauthAccessToken,
      dto.repoFullName,
    );

    /*
     * 2b. ASK THE REPOSITORY WHICH BRANCH IT LIVES ON.
     *
     * This used to be hardcoded to 'main' at the push, so every existing repo
     * on `master` or `develop` failed — after its secrets had already been
     * written. The repository is the authority on its own default branch.
     */
    const targetBranch = await this.setupBranch.resolveSetupBranch(
      accessToken,
      owner,
      repo,
    );

    // 3. Persist the project, issue the CI token, and install the Actions
    // secrets BEFORE pushing the workflow file so the access-gate's first run
    // on the existing repo can authenticate. Secrets are installed strictly so
    // a token without `secrets:write` aborts setup with a clear error.
    const workflowPath =
      workflowFiles[0]?.path ?? `.github/workflows/${outputFileName}`;

    const row = await this.createProjectRow({
      userId,
      workspaceId: await this.workspaceGate.resolveWorkspaceIdForCreate(
        userId,
        dto.workspaceId,
      ),
      repoFullName: dto.repoFullName,
      templateId: dto.templateId,
      serviceName: dto.serviceName,
      workflowPath,
      status: 'provisioned',
      projectOptions: {
        workflowFiles: workflowFileMetadata(workflowFiles),
      },
    });

    let commitSha = '';
    let commitUrl: string | null = null;
    try {
      const ciToken = await this.ciService.issueProjectToken(row.id);
      await this.githubService.setActionsSecretStrict(
        accessToken,
        owner,
        repo,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        accessToken,
        owner,
        repo,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      // preserveExisting: this is somebody's existing repository, and it may
      // already be wired to its own SonarCloud project.
      await this.sonar.installSecrets(accessToken, owner, repo, true);

      // 4. Push the workflow files to the repository's OWN default branch now
      // that the secrets exist, then record the commit.
      ({ commitSha, commitUrl } = await this.pushWorkflowFiles(
        accessToken,
        owner,
        repo,
        workflowFiles,
        targetBranch,
      ));

      /*
       * 5. Give the promotion model somewhere to run.
       *
       * The generated pipeline only knows `uat` and `main`: everything gated on
       * uat — the staging deploy and the promotion pull request — simply never
       * fires without that branch, and skipped jobs look identical to
       * not-applicable ones in the Actions UI. Creating it here is what stops
       * an onboarded repo from running at half power for reasons nobody can
       * see. Best-effort: a repo that cannot take the branch still has a
       * working main-branch pipeline, which is better than failing the setup.
       */
      await this.setupBranch.ensureUatBranch(
        accessToken,
        owner,
        repo,
        targetBranch,
      );
      await this.projectsRepository.updateStatus(
        row.id,
        'provisioned',
        commitSha,
        commitUrl,
      );
    } catch (error) {
      /*
       * The repo is the user's own existing repo — never delete it. Remove the
       * half-created tracking row AND the secrets we wrote, so a failed setup
       * leaves nothing behind.
       *
       * Previously only the row was removed, so a repo that rejected the push
       * (wrong default branch, protected branch) was left holding an
       * ALPHACI_TOKEN and report URL belonging to a project that no longer
       * existed — credentials with no owner, invisible from this UI.
       */
      try {
        await this.projectsRepository.deleteByIdAndUser(row.id, userId);
      } catch (cleanupError) {
        this.logger.warn(
          `setupProject: failed to delete project row ${row.id}: ${String(cleanupError)}`,
        );
      }
      await this.setupBranch.removeSetupSecrets(accessToken, owner, repo);
      throw error;
    }

    const deploymentProvisioning = await this.provisionDeploymentTargets({
      projectId: row.id,
      userId,
      repoFullName: dto.repoFullName,
      githubAccessToken: accessToken,
      request: dto.deploymentProvisioning,
      slots: resolveSingleRepoDeploymentSlots(dto.deploymentProvisioning),
    });

    await this.recordProductEvent({
      userId,
      projectId: row.id,
      eventCode: 'project_created',
      title: 'Project created',
      body: `${dto.repoFullName} is now tracked by ALPHACI.`,
      metadata: {
        repoFullName: dto.repoFullName,
        repoShape: 'existing',
        templateId: dto.templateId,
      },
    });

    return {
      id: row.id,
      repoFullName: dto.repoFullName,
      status: 'provisioned',
      workflowPath,
      workflowFiles: workflowFileMetadata(workflowFiles),
      githubCommitSha: commitSha,
      githubCommitUrl: commitUrl,
      deploymentProvisioning,
    };
  }

  // ─── GET /projects ─────────────────────────────────────────────────────────

  // ─── Private helpers ───────────────────────────────────────────────────────

  private repositoryOwnershipMetadata(
    dto: CreateProjectDto,
    ownerLogin: string,
  ): Record<string, unknown> {
    return {
      repositoryOwner: {
        type: dto.ownerType ?? 'personal',
        login: ownerLogin,
        installationId: dto.installationId ?? null,
      },
    };
  }

  private resolveTemplateId(
    projectTypeId: string,
    workflowRecipeId?: string,
  ): string {
    const { recipes } = this.catalogService.getProjectOptions();
    const recipeId = workflowRecipeId ?? 'standard';
    const recipe = recipes.find((r) => r.id === recipeId);

    if (recipe) {
      const mapped = recipe.templateByProjectType[projectTypeId];
      if (mapped) {
        return mapped;
      }
    }

    // Fallback: conventional naming that matches the YAML file names on disk
    return `${projectTypeId}-${recipeId}`;
  }

  /**
   * Create the requested hosting targets and install their Render/Vercel
   * GitHub Actions secrets as part of project creation. Provisioning is
   * best-effort: the repo is already fully usable, so a hosting failure is
   * reported in the response instead of failing the whole creation.
   */
  private async provisionDeploymentTargets(input: {
    projectId: string;
    userId: string;
    repoFullName: string;
    githubAccessToken: string;
    request: DeploymentProvisioningRequestDto | undefined;
    slots: DeploymentProvisioningTargetDto['slot'][];
  }): Promise<DeploymentProvisioningResult> {
    const request = filterDeploymentProvisioningRequest(
      forceManagedProvisioning(input.request),
      input.slots,
    );
    if (!request?.enabled || request.targets.length === 0) {
      return skippedDeploymentProvisioning();
    }

    try {
      return await this.projectDeploymentProvisioningService.provisionForProject(
        {
          projectId: input.projectId,
          userId: input.userId,
          repoFullName: input.repoFullName,
          githubAccessToken: input.githubAccessToken,
          request,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Deployment provisioning failed for ${input.repoFullName}: ${String(error)}`,
      );
      return {
        status: 'failed',
        targets: request.targets.map((target) => ({
          slot: target.slot,
          provider: target.provider,
          ownershipMode: 'flowci_managed',
          deploymentStrategy: null,
          status: 'failed',
          deploymentTargetId: null,
          providerProjectId: null,
          providerProjectName: null,
          providerMetadata: {},
          errorSummary: 'Deployment provisioning failed',
          env: [],
        })),
      };
    }
  }

  /**
   * Push a full project scaffold to the repository on main, then add README.md.
   * Called immediately after createRepo() so that all downstream branches
   * branch off a commit that already contains these files.
   *
   * The scaffold structure varies by repoShape:
   * - standalone/multi-repo: flat files at repo root
   * - monorepo: workspace root + packages/core with project references
   * - microservices: backend/ and frontend/ subdirectories
   */
  private async pushStarterFiles(
    accessToken: string,
    owner: string,
    repo: string,
    opts: {
      projectName: string;
      stack?: string;
      repoShape?: string;
      includeDocker?: boolean;
      frontendStack?: string;
      frontendServiceName?: string;
      backendServiceName?: string;
    },
  ): Promise<void> {
    const {
      projectName,
      stack = 'nodejs',
      repoShape,
      frontendStack,
      frontendServiceName,
      backendServiceName,
    } = opts;

    const scaffoldOptions = {
      serviceName: projectName,
      stack,
      includeDocker: opts.includeDocker ?? defaultIncludeDocker(stack),
      sonarProjectKey: sonarProjectKeyFor(owner, repo),
      ...(repoShape ? { repoShape } : {}),
      ...(frontendStack ? { frontendStack } : {}),
      ...(frontendServiceName ? { frontendServiceName } : {}),
      ...(backendServiceName ? { backendServiceName } : {}),
    };

    const scaffoldFiles = buildProjectScaffold(scaffoldOptions);

    // Scaffold pushes are strict on purpose: a repo missing package.json,
    // jest.config.ts, or eslint.config.mjs is born with permanently red
    // checks. Failing here lets the caller compensation path delete the
    // half-created repo so every repo that survives provisioning starts with
    // a fully green pipeline.
    for (const file of scaffoldFiles) {
      await this.pushWorkflowFile(
        accessToken,
        owner,
        repo,
        file.path,
        file.content,
        'chore: initialize project scaffold',
      );
    }

    // Always push README.md (.gitignore is included in the scaffold above)
    const readmeContent = buildGeneratedRepoReadme({
      projectName,
      stack,
      ...(repoShape ? { repoShape } : {}),
      ...(frontendStack ? { frontendStack } : {}),
      ...(frontendServiceName ? { frontendServiceName } : {}),
      ...(backendServiceName ? { backendServiceName } : {}),
    });

    await this.pushWorkflowFile(
      accessToken,
      owner,
      repo,
      'README.md',
      readmeContent,
      'chore: add project metadata',
    );
  }

  /**
   * Create two separate GitHub repositories (backend + frontend) each with
   * starter files, a workflow file, protected branches, and a DB row.
   */
  private async createMultiRepoProject(
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
      });

    // ── Backend repository ──────────────────────────────────────────────────

    const backendTemplateId = this.resolveTemplateId(
      backend.projectTypeId,
      backend.workflowRecipeId,
    );
    // Each repo carries a flat standalone scaffold, so the workflow always
    // runs at the repo root — slot servicePaths like 'backend/' only apply to
    // single-repo shapes and would point at a directory that does not exist.
    const {
      workflowFiles: backendWorkflowFiles,
      outputFileName: backendOutputFileName,
    } = await this.buildWorkflowBundle({
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
        this.workflowFragmentRegistry,
      ),
    });

    const {
      repoUrl: beRepoUrl,
      ownerLogin,
      repoName: actualBeRepoName,
    } = await this.githubService.createRepo(
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
      await this.pushStarterFiles(
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
      backendRow = await this.createProjectRow({
        userId,
        workspaceId: await this.workspaceGate.resolveWorkspaceIdForCreate(
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
          ...this.repositoryOwnershipMetadata(dto, ownerLogin),
          ...(dto.tests ? { tests: dto.tests } : {}),
          workflowFiles: workflowFileMetadata(backendWorkflowFiles),
        },
      });

      const backendCiToken = await this.ciService.issueProjectToken(
        backendRow.id,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
        'ALPHACI_TOKEN',
        backendCiToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.sonar.installSecrets(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
      );

      ({ commitSha: backendCommitSha, commitUrl: backendCommitUrl } =
        await this.pushWorkflowFiles(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          backendWorkflowFiles,
        ));
      await this.projectsRepository.updateStatus(
        backendRow.id,
        'provisioned',
        backendCommitSha,
        backendCommitUrl,
      );

      // `develop` remains available but unprotected and does not run CI.
      for (const branch of ['develop', 'uat'] as const) {
        await this.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          branch,
          'main',
        );
      }

      for (const branch of ['uat', 'main'] as const) {
        await this.githubService.applyBranchProtection(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          branch,
        );
      }

      backendProvisioningComplete = true;
    } catch (error) {
      if (!backendProvisioningComplete) {
        await this.compensateFailedProvision(
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
      const frontendTemplateId = this.resolveTemplateId(
        frontend.projectTypeId,
        frontend.workflowRecipeId,
      );
      const {
        workflowFiles: frontendWorkflowFiles,
        outputFileName: frontendOutputFileName,
      } = await this.buildWorkflowBundle({
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
          this.workflowFragmentRegistry,
        ),
      });

      const {
        repoUrl: resolvedFeRepoUrl,
        ownerLogin: feOwnerLogin,
        repoName: actualFeRepoName,
      } = await this.githubService.createRepo(
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

      await this.pushStarterFiles(
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

      feRow = await this.createProjectRow({
        userId,
        workspaceId: await this.workspaceGate.resolveWorkspaceIdForCreate(
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
          ...this.repositoryOwnershipMetadata(dto, feOwnerLogin),
          workflowFiles: workflowFileMetadata(frontendWorkflowFiles),
        },
      });

      const frontendCiToken = await this.ciService.issueProjectToken(feRow.id);
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
        'ALPHACI_TOKEN',
        frontendCiToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.sonar.installSecrets(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
      );

      const { commitSha: frontendCommitSha, commitUrl: frontendCommitUrl } =
        await this.pushWorkflowFiles(
          provisioningToken,
          feOwnerLogin,
          actualFeRepoName,
          frontendWorkflowFiles,
        );
      await this.projectsRepository.updateStatus(
        feRow.id,
        'provisioned',
        frontendCommitSha,
        frontendCommitUrl,
      );

      // `develop` remains available but unprotected and does not run CI.
      for (const branch of ['develop', 'uat'] as const) {
        await this.githubService.createBranch(
          provisioningToken,
          feOwnerLogin,
          actualFeRepoName,
          branch,
          'main',
        );
      }

      for (const branch of ['uat', 'main'] as const) {
        await this.githubService.applyBranchProtection(
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
        await this.compensateFailedProvision(
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
      await this.provisionDeploymentTargets({
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
        await this.provisionDeploymentTargets({
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
        await this.projectDeploymentProvisioningService.crossLinkServiceUrls({
          userId,
          request: effectiveDeploymentProvisioning,
          groups: [
            { projectId: backendRow.id, result: provisioningResults[0]! },
            { projectId: feRow.id, result: provisioningResults[1]! },
          ],
        });
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

  private parseRepoFullName(repoFullName: string): [string, string] {
    const parts = repoFullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnprocessableEntityException(
        `Invalid repoFullName '${repoFullName}'. Expected format: "owner/repo"`,
      );
    }

    return [parts[0], parts[1]];
  }

  private deriveOutputFileName(
    serviceName: string,
    templateId: string,
  ): string {
    const normalized = serviceName
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');

    return `${normalized || 'service'}-${templateId}.yml`;
  }

  private ensureObject(
    parent: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    const existing = parent[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      parent[key] = next;
      return next;
    }

    return existing as Record<string, unknown>;
  }

  private setInputDefault(
    inputs: Record<string, unknown>,
    key: string,
    value: string | number,
    type: 'string' | 'number',
  ): void {
    const existing = inputs[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      inputs[key] = {
        description: `Auto-generated default for ${key}`,
        required: false,
        type,
        default: value,
      };
    } else {
      const record = existing as Record<string, unknown>;
      record['default'] = value;
      if (!record['type']) {
        record['type'] = type;
      }
    }
  }

  private applyEnhancements(
    withConfig: Record<string, unknown>,
    enhancements: Array<
      | 'strictProductionApproval'
      | 'enableUatApproval'
      | 'disablePlaywright'
      | 'disableK6'
    >,
  ): void {
    for (const enhancement of enhancements) {
      switch (enhancement) {
        case 'disablePlaywright':
          withConfig['run-playwright'] = false;
          break;
        case 'disableK6':
          withConfig['run-k6'] = false;
          break;
        case 'enableUatApproval':
          withConfig['require-uat-approval'] = true;
          break;
        case 'strictProductionApproval':
          withConfig['require-production-approval'] = true;
          break;
        default:
          break;
      }
    }
  }

  /**
   * Single choke point for creating a provisioned_projects row.
   *
   * Wraps ProjectsRepository.create so every create path — single service,
   * microservices backend/frontend, multi-repo, and the existing-repo setup
   * flow — also gets its hierarchy link. Previously only repositories created
   * through the create-system path had a hierarchy.repositories row, which
   * meant a form-created group project could never have a developer assigned
   * to it (assignments reference hierarchy.repositories).
   *
   * The link is best-effort and never throws: the GitHub repo, branches, and
   * workflow commit have all already succeeded by this point, and failing here
   * would report a working project as a failure — and let the compensation
   * path delete it.
   */
  private async createProjectRow(
    input: Parameters<ProjectsRepository['create']>[0],
  ): Promise<Awaited<ReturnType<ProjectsRepository['create']>>> {
    const row = await this.projectsRepository.create(input);

    await this.hierarchyProjectLinkService?.ensureLink({
      projectId: row.id,
      workspaceId: input.workspaceId ?? null,
      name: input.serviceName,
      repoFullName: input.repoFullName,
      visibility: input.visibility ?? null,
      createdBy: input.userId,
      projectStatus: input.status ?? 'provisioning',
    });

    return row;
  }

  /**
   * Best-effort cleanup after a provisioning failure: removes the half-created
   * DB row and the orphaned GitHub repo so a retry with the same name can
   * succeed. Never throws — compensation failures are logged so they cannot
   * mask the original provisioning error.
   */
  private async compensateFailedProvision(
    accessToken: string,
    owner: string,
    repo: string,
    projectId: string | undefined,
    userId: string,
  ): Promise<void> {
    if (projectId) {
      try {
        await this.projectsRepository.deleteByIdAndUser(projectId, userId);
      } catch (error) {
        this.logger.warn(
          `Compensation: failed to delete project row ${projectId}: ${String(error)}`,
        );
      }
    }
    await this.githubService.deleteRepo(accessToken, owner, repo);
  }

  private async assertWithinQuota(
    userId: string,
    limitCode: UsageLimitCode,
    increment: number,
    projectId: string | null,
  ): Promise<void> {
    try {
      await this.usageQuotaService?.assertWithinLimit(
        userId,
        limitCode,
        increment,
      );
    } catch (error) {
      await this.recordProductEvent({
        userId,
        projectId,
        eventCode: 'quota_blocked',
        title: 'Quota blocked action',
        body: `Quota ${limitCode} blocked this action.`,
        metadata: {
          limitCode,
          increment,
        },
      });
      throw error;
    }
  }

  private async recordProductEvent(input: {
    userId: string;
    projectId: string | null;
    eventCode: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.productEvents.record(input);
  }
}
