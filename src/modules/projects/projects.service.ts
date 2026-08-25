import { readFile } from 'node:fs/promises';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import yaml from 'js-yaml';

import type { AppConfig } from '../../config/app.config';
import {
  CiService,
  CI_TOKEN_STATUS_LOOKUP,
  type CiTokenStatusLookup,
  type ProjectTokenStatus,
} from '../ci/index.js';
import { AuditEventsService } from '../audit/index.js';
import {
  DEPLOYMENT_ENV_METADATA_QUERY,
  DEPLOYMENT_PROVISIONING_FACADE,
  DEPLOYMENT_TARGETS_QUERY,
  type DeploymentProvisioningFacade,
  type DeploymentProjectReference,
  type DeploymentProvisioningResult,
  type DeploymentEnvMetadataQuery,
  type DeploymentTargetsQuery,
  type DeploymentTargetSummary,
  type EnvVarMetadata,
} from '../deployments/index.js';
import {
  GithubRepoDeleteError,
  GithubService,
  REPOSITORY_DELETED_EVENT,
  type GithubRepoDeleteErrorCode,
  type RepositoryDeletedEvent,
} from '../github/index.js';
import { CatalogService } from '../catalog/index.js';
import { HierarchyProjectLinkService } from '../hierarchy/project-link/index.js';
import {
  WORKFLOW_HISTORY_QUERY,
  ALPHACI_REPORT_URL,
  type WorkflowHistoryQuery,
  type WorkflowHistoryEntry,
  buildStagedWorkflowBundle,
  resolveDefaultCentralWorkflowRef,
  type StagedWorkflowFile,
  type WorkflowFileMetadata,
  type DeploymentProvider,
  type DeploymentWorkflowTarget,
} from '../workflows/index.js';
import {
  ProjectsRepository,
  type ProvisionedProjectRow,
  type ProvisionedProjectStatus,
} from './projects.repository';
import {
  ProjectDashboardSnapshotsRepository,
  type ProjectDashboardSnapshot,
  type ProjectDashboardSnapshotFinding,
} from './project-dashboard-snapshots.repository';
import {
  ProjectWorkflowSettingsRepository,
  type ProjectWorkflowSettingsRowValue,
} from './project-workflow-settings.repository';
import {
  ProjectWorkflowUpdateRequestsRepository,
  type WorkflowUpdateRequestRecord,
} from './project-workflow-update-requests.repository';
import type { CreateProjectDto } from './dto/create-project.dto';
import { ProjectWorkflowsService } from './application/project-workflows.service';
import {
  combineDeploymentProvisioningResults,
  extractDeploymentProvider,
  filterDeploymentProvisioningRequest,
  forceManagedProvisioning,
  resolveSingleRepoDeploymentSlots,
  skippedDeploymentProvisioning,
  withDefaultCreateDeploymentProvisioning,
} from './application/deployment-provisioning.policy';
import { resolveDeploymentWorkflowTargets } from './application/deployment-workflow-targets';
import { buildGeneratedRepoReadme } from './application/generated-repo-readme';
import {
  SonarCloudSetupService,
  sonarProjectKeyFor,
} from './application/sonar-cloud-setup.service';
import { ProvisioningTokenService } from './application/provisioning-token.service';
import { SetupBranchService } from './application/setup-branch.service';
import { WorkspaceGateService } from './application/workspace-gate.service';
import { ProductEventsService } from './application/product-events.service';
import {
  buildLocalSnapshotFindings,
  buildOverviewHealth,
  toCiAuthOverview,
  toProvisionedProject,
  workflowFileMetadata,
} from './application/project-overview.view';
import { ProjectWorkflowFilesService } from './application/project-workflow-files.service';
import type { SetupProjectDto } from './dto/setup-project.dto';
import type { DisconnectProjectDto } from './dto/disconnect-project.dto';
import { UsageQuotaService, type UsageLimitCode } from '../usage/index.js';
import {
  WorkspacesService,
  WorkspaceAccessService,
  type WorkspaceRole,
} from '../workspaces/index.js';
import { NotificationEventsService } from '../notifications/index.js';
import {
  buildProjectScaffold,
  defaultIncludeDocker,
  normalizeProjectStack,
  normalizeRepoShape,
} from './scaffold.builder';
import type {
  DeploymentProvisioningRequestDto,
  DeploymentProvisioningTargetDto,
} from './dto/create-project.dto';
import type {
  CreateProjectResponse,
  DisconnectProjectResponse,
  ProjectAuditEventsResponse,
  ProvisionedProject,
  ProjectOverviewResponse,
  ProjectSyncSnapshotResponse,
  ProvisionedProjectsResponse,
  ReconcileDeletedReposResult,
  SetupProjectResponse,
  SyncProjectsResponse,
  WorkflowSettingsPreviewRequest,
  WorkflowSettingsPreviewResponse,
  WorkflowSettingsResponse,
  WorkflowUpdatePullRequestResponse,
} from './projects.service.types';

export type * from './projects.service.types';


interface GitHubContentsResponse {
  content: { html_url?: string };
  commit: { sha: string; html_url?: string };
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  /** Lazily-created SonarCloud delegate for direct constructions (tests). */
  private sonarSetupLazy?: SonarCloudSetupService;
  private get sonar(): SonarCloudSetupService {
    return (this.sonarSetupLazy ??= new SonarCloudSetupService(
      this.githubService,
      this.configService as ConfigService,
    ));
  }

  /** Lazily-created workflow delegate for direct constructions (tests). */
  private workflowsServiceLazy?: ProjectWorkflowsService;
  private get workflows(): ProjectWorkflowsService {
    return (this.workflowsServiceLazy ??= new ProjectWorkflowsService(
      this.projectsRepository,
      this.githubService,
      this.catalogService,
      this.configService,
      this.workflowSettingsRepository,
      this.workflowUpdateRequestsRepository,
      this.usageQuotaService,
      this.auditEventsService,
      this.notificationEventsService,
    ));
  }

  /** Lazily-created workflow-files delegate for direct constructions (tests). */
  private workflowFilesLazy?: ProjectWorkflowFilesService;
  private get workflowFiles(): ProjectWorkflowFilesService {
    return (this.workflowFilesLazy ??= new ProjectWorkflowFilesService(
      this.catalogService,
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
      this.auditEventsService,
      this.notificationEventsService,
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
    deploymentProvider?: 'render' | 'vercel' | undefined;
    deploymentTargets?: DeploymentWorkflowTarget[] | undefined;
    workflowVariant?: 'backend' | 'frontend' | undefined;
    centralWorkflowRef?: string | undefined;
    hasTestsDirectory?: boolean | undefined;
  }): Promise<{ workflowFiles: StagedWorkflowFile[]; outputFileName: string }> {
    return this.workflowFiles.buildWorkflowBundle(options);
  }

  /** Spy/seam for direct YAML building (see pushWorkflowFile note). */
  private async buildWorkflowYaml(
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
    return this.workflowFiles.buildWorkflowYaml(templateId, serviceName, servicePath, nodeVersion, coverageThreshold, customOutputFileName, enhancements);
  }


  constructor(
    private readonly catalogService: CatalogService,
    private readonly githubService: GithubService,
    private readonly projectsRepository: ProjectsRepository,
    private readonly ciService: CiService,
    @Inject(DEPLOYMENT_PROVISIONING_FACADE)
    private readonly projectDeploymentProvisioningService: DeploymentProvisioningFacade,
    @Optional()
    @Inject(CI_TOKEN_STATUS_LOOKUP)
    private readonly ciTokensRepository?: CiTokenStatusLookup,
    @Optional()
    @Inject(DEPLOYMENT_TARGETS_QUERY)
    private readonly deploymentTargetsRepository?: DeploymentTargetsQuery,
    @Optional()
    @Inject(DEPLOYMENT_ENV_METADATA_QUERY)
    private readonly envVarsRepository?: DeploymentEnvMetadataQuery,
    @Optional()
    @Inject(WORKFLOW_HISTORY_QUERY)
    private readonly workflowHistoryRepository?: WorkflowHistoryQuery,
    @Optional()
    private readonly dashboardSnapshotsRepository?: ProjectDashboardSnapshotsRepository,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly workflowSettingsRepository?: ProjectWorkflowSettingsRepository,
    @Optional()
    private readonly workflowUpdateRequestsRepository?: ProjectWorkflowUpdateRequestsRepository,
    @Optional()
    private readonly usageQuotaService?: UsageQuotaService,
    @Optional()
    private readonly auditEventsService?: AuditEventsService,
    @Optional()
    private readonly workspacesService?: WorkspacesService,
    @Optional()
    private readonly notificationEventsService?: NotificationEventsService,
    @Optional()
    private readonly workspaceAccessService?: WorkspaceAccessService,
    // Optional and last, like every collaborator above it: the existing specs
    // construct ProjectsService positionally, and an absent linker simply
    // means group projects are not linked (the migration backfill still is).
    @Optional()
    private readonly hierarchyProjectLinkService?: HierarchyProjectLinkService,
    @Optional()
    private readonly workflowsService?: ProjectWorkflowsService,
  ) {
    // GithubModule cannot import ProjectsModule (that would create a
    // Projects → Github → Projects cycle), so GithubService can't inject
    // ProjectsRepository/ProjectsService directly. Instead GithubService
    // emits a plain EventEmitter event when a `repository` `deleted`
    // webhook arrives, and — since ProjectsService already depends on
    // GithubService one-way — this subscribes here to react to it. Fire-and
    // -forget is intentional: handleWebhook() has already ack'd the
    // delivery to GitHub by the time this listener runs, so failures are
    // logged, not thrown.
    this.githubService.on(
      REPOSITORY_DELETED_EVENT,
      (event: RepositoryDeletedEvent) => {
        this.handleRepositoryDeleted(event).catch((error) => {
          this.logger.warn(
            `Failed to process repository.deleted webhook for ${event.repoFullName}: ${String(error)}`,
          );
        });
      },
    );
  }

  /**
   * Resolves the small, viewer-authorized project reference that deployment
   * queries are allowed to consume. Deployment services never receive the
   * Projects repository row or perform this authorization themselves.
   */
  async getProjectReference(
    projectId: string,
    userId: string,
  ): Promise<DeploymentProjectReference> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return {
      projectId: project.id,
      userId,
      repoFullName: project.repo_full_name,
      repoUrl: project.repo_url,
      workflowPath: project.workflow_path,
      projectOptions: project.project_options,
    };
  }

  /**
   * Reacts to GithubService's REPOSITORY_DELETED_EVENT (see constructor).
   * Hard-deletes every provisioned project matching the deleted repo —
   * matched by repo_full_name across all owners, since the GitHub webhook
   * carries no user context — and records a per-owner product event for
   * each row touched, so the deletion is still visible in audit/notification
   * history even though the row itself is gone.
   *
   * projectId is deliberately `null` on these events, NOT `row.id`: both
   * audit.audit_events.project_id and notifications.notifications.project_id
   * are `REFERENCES projects.provisioned_projects(id)`, and by the time this
   * runs that row has already been deleted — an INSERT referencing it would
   * fail its FK constraint (ON DELETE SET NULL only rewrites *existing*
   * rows, it doesn't permit new ones pointing at a since-deleted id). The
   * deleted project's id is preserved in metadata instead. This mirrors
   * disconnectProject(), which never emits a product event with a projectId
   * after the delete that removes that project.
   */
  private async handleRepositoryDeleted(
    event: RepositoryDeletedEvent,
  ): Promise<void> {
    const deletedRows = await this.projectsRepository.deleteByRepoFullName(
      event.repoFullName,
    );
    if (deletedRows.length === 0) {
      return;
    }

    this.logger.log(
      `Deleted ${deletedRows.length} project(s) after GitHub reported ${event.repoFullName} deleted`,
    );

    await Promise.all(
      deletedRows.map((row) =>
        this.recordProductEvent({
          userId: row.user_id,
          projectId: null,
          eventCode: 'project_deleted_webhook',
          title: 'Repository deleted on GitHub',
          body: `The GitHub repository ${event.repoFullName} was deleted, so this project has been deleted.`,
          metadata: {
            repoFullName: event.repoFullName,
            source: 'webhook',
            deletedProjectId: row.id,
          },
        }),
      ),
    );
  }

  // ─── POST /projects ────────────────────────────────────────────────────────

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
    await this.workspaceGate.resolveWorkspaceIdForCreate(userId, dto.workspaceId);
    const {
      repositoryCreationToken,
      provisioningToken,
      provisioningOwnerLogin,
    } = await this.tokens.resolveRepositoryProvisioning(userId, accessToken, dto);

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
    await this.workspaceGate.resolveWorkspaceIdForCreate(userId, dto.workspaceId);

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
      await this.setupBranch.ensureUatBranch(accessToken, owner, repo, targetBranch);
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

  async listProjects(
    userId: string,
    limit = 25,
    workspaceId?: string | null,
  ): Promise<ProvisionedProjectsResponse> {
    const rows = await this.projectsRepository.listByUser(
      userId,
      limit,
      workspaceId,
    );
    return {
      items: rows.map((row) => toProvisionedProject(row)),
    };
  }

  async getProjectOverview(
    projectId: string,
    userId: string,
  ): Promise<ProjectOverviewResponse> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }

    const [
      ciToken,
      deploymentTargets,
      envMetadata,
      workflowHistory,
      latestSnapshot,
      hierarchyRepositoryId,
    ] = await Promise.all([
      this.loadCiTokenStatus(projectId),
      this.deploymentTargetsRepository?.listDeploymentTargets(projectId) ??
        Promise.resolve([]),
      this.envVarsRepository?.listEnvMetadata(projectId) ?? Promise.resolve([]),
      this.workflowHistoryRepository?.listForProjectIdentity({
        userId,
        serviceName: row.service_name,
        templateId: row.template_id,
        limit: 5,
      }) ?? Promise.resolve([]),
      this.dashboardSnapshotsRepository?.findLatestByProject(projectId) ??
        Promise.resolve(null),
      this.hierarchyProjectLinkService?.getLinkedRepositoryId(projectId) ??
        Promise.resolve(null),
    ]);

    const project = toProvisionedProject(row);
    const workflowFiles = project.workflowFiles ?? [];
    const matchingHistory = workflowHistory;
    const ciAuth = toCiAuthOverview(ciToken);
    const failedEnvCount = envMetadata.filter(
      (metadata) => metadata.status === 'failed',
    ).length;

    return {
      project: {
        ...project,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      workflow: {
        path: row.workflow_path,
        files: workflowFiles,
        stageCount: workflowFiles.length,
        history: matchingHistory,
      },
      deploymentTargets: {
        items: deploymentTargets,
        count: deploymentTargets.length,
      },
      environment: {
        items: envMetadata,
        count: envMetadata.length,
        failedCount: failedEnvCount,
      },
      ciAuth,
      health: buildOverviewHealth({
        project,
        workflowFiles,
        ciAuth,
        deploymentTargets,
        envMetadata,
      }),
      syncSnapshot: {
        enabled: this.projectSyncSnapshotsEnabled(),
        mode: 'local_snapshot',
        latest: latestSnapshot,
      },
      capabilities: {
        envProvisioning: true,
        workflowSettings: this.workflowSettingsPreviewEnabled(),
        syncSnapshots: this.projectSyncSnapshotsEnabled(),
        ciRunTracking: this.ciRunTrackingEnabled(),
        deploymentHistory: this.deploymentHistoryEnabled(),
        driftDetection: this.driftDetectionEnabled(),
      },
      hierarchyRepositoryId,
    };
  }

  // ─── DELETE /projects/:id ──────────────────────────────────────────────────

  /**
   * Removes a provisioned_projects record from ALPHACI's database.
   * The GitHub repository, its workflow YAML files, and its GitHub Secrets
   * are NOT touched — this is an ALPHACI tracking disconnect only.
   * CASCADE deletes ci.project_ci_tokens automatically via the FK.
   */
  async syncProjectSnapshot(
    projectId: string,
    userId: string,
  ): Promise<ProjectSyncSnapshotResponse> {
    if (!this.projectSyncSnapshotsEnabled()) {
      throw new BadRequestException('Project sync snapshots are disabled');
    }

    if (!this.dashboardSnapshotsRepository) {
      throw new ServiceUnavailableException(
        'Project dashboard snapshots are not configured',
      );
    }

    const startedAt = new Date().toISOString();
    const overview = await this.getProjectOverview(projectId, userId);
    const findings = buildLocalSnapshotFindings(overview);
    const completedAt = new Date().toISOString();
    const snapshot = await this.dashboardSnapshotsRepository.createSnapshot({
      projectId,
      status: overview.health.summary,
      summary: {
        mode: 'local_snapshot',
        projectId,
        healthSummary: overview.health.summary,
        workflowStageCount: overview.workflow.stageCount,
        deploymentTargetCount: overview.deploymentTargets.count,
        envVarCount: overview.environment.count,
        failedEnvVarCount: overview.environment.failedCount,
        ciTokenStatus: overview.ciAuth.status,
      },
      findings,
      startedAt,
      completedAt,
      createdBy: userId,
    });

    await this.recordProductEvent({
      userId,
      projectId,
      eventCode: 'project_snapshot_synced',
      title: 'Project snapshot synced',
      body: `Project snapshot completed with ${findings.length} finding${findings.length === 1 ? '' : 's'}.`,
      metadata: {
        snapshotId: snapshot.id,
        status: snapshot.status,
        findingCount: findings.length,
      },
    });

    return {
      snapshot,
      overview: {
        ...overview,
        syncSnapshot: {
          enabled: true,
          mode: 'local_snapshot',
          latest: snapshot,
        },
      },
    };
  }

  async listProjectAuditEvents(
    projectId: string,
    userId: string,
  ): Promise<ProjectAuditEventsResponse> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return (
      (await this.auditEventsService?.listProjectEvents(projectId, userId)) ?? {
        enabled: this.auditEventsEnabled(),
        items: [],
      }
    );
  }

  /** Delegates to ProjectWorkflowsService (owns workflow settings behavior). */
  async getWorkflowSettings(
    projectId: string,
    userId: string,
  ): Promise<WorkflowSettingsResponse> {
    return this.workflows.getWorkflowSettings(projectId, userId);
  }

  /** Delegates to ProjectWorkflowsService. */
  async previewWorkflowSettings(
    projectId: string,
    userId: string,
    request: WorkflowSettingsPreviewRequest,
  ): Promise<WorkflowSettingsPreviewResponse> {
    return this.workflows.previewWorkflowSettings(
      projectId,
      userId,
      request,
    );
  }

  /** Delegates to ProjectWorkflowsService. */
  async createWorkflowUpdatePullRequest(
    projectId: string,
    userId: string,
    oauthAccessToken: string | null | undefined,
    request: WorkflowSettingsPreviewRequest,
  ): Promise<WorkflowUpdatePullRequestResponse> {
    return this.workflows.createWorkflowUpdatePullRequest(
      projectId,
      userId,
      oauthAccessToken,
      request,
    );
  }
  async disconnectProject(
    projectId: string,
    userId: string,
    options?: DisconnectProjectDto,
    githubAccessToken?: string | null,
  ): Promise<DisconnectProjectResponse> {
    const deleteGithubRepo = options?.deleteGithubRepo === true;
    // Single source of truth for the tightened role set, used both as the
    // app-layer fast-fail pre-check below AND passed down into the
    // repository so the SQL itself enforces it (see findByIdAndUser /
    // deleteByIdAndUser). The app-layer check alone is not sufficient: it
    // depends on workspaceAccessService being wired in (it's `@Optional()`
    // and no-ops via `?.` when absent), so it must not be the only gate for
    // a destructive, external-side-effecting action.
    const destructiveRoles: WorkspaceRole[] = ['admin', 'delegated_lead'];

    try {
      await this.assertProjectMutationAccess(
        projectId,
        userId,
        deleteGithubRepo ? destructiveRoles : undefined,
      );
    } catch (error) {
      if (deleteGithubRepo) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: 'Insufficient workspace role for deleteGithubRepo=true (owner/admin required).',
          metadata: { reason: 'insufficient_role' },
        });
      }
      throw error;
    }

    let githubRepoDeleted = false;
    let githubRepoDeleteError:
      { code: GithubRepoDeleteErrorCode; message: string } | undefined;

    if (deleteGithubRepo) {
      // Role-scoped fetch: this is the SQL-level enforcement point. If the
      // caller's workspace role isn't owner/admin, no row comes back — this
      // fails closed independent of whether the app-layer check above ran.
      const project = await this.projectsRepository.findByIdAndUser(
        projectId,
        userId,
        destructiveRoles,
      );
      if (!project) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: `Project '${projectId}' was not found, does not belong to the current user, or the current workspace role does not permit deleting its GitHub repository (owner/admin required).`,
          metadata: { reason: 'not_found_or_insufficient_role' },
        });
        throw new NotFoundException(
          `Project '${projectId}' not found or does not belong to the current user.`,
        );
      }

      const repoFullName = project.repo_full_name;
      // CRITICAL: re-validate the typed confirmation server-side against the
      // project's actual repo_full_name. Never trust client-side gating —
      // a modified or replayed request without this check would let a
      // caller delete the GitHub repo without ever having typed the
      // confirmation the UI showed them.
      if (options?.confirmRepoName !== repoFullName) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: `confirmRepoName did not match this project's repository name (${repoFullName}). The GitHub repository was not deleted.`,
          metadata: { reason: 'confirmation_mismatch', repoFullName },
        });
        throw new BadRequestException(
          "confirmRepoName does not match this project's repository name. The GitHub repository was not deleted.",
        );
      }

      if (!githubAccessToken) {
        githubRepoDeleteError = {
          code: 'missing_scope',
          message:
            'No GitHub access token on this session — reconnect your GitHub account to grant repository-deletion permission.',
        };
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_missing_scope',
          title: 'GitHub repository deletion needs reconnect',
          body: `Could not delete ${repoFullName} on GitHub: no GitHub access token on this session.`,
          metadata: { repoFullName, code: 'missing_scope' },
        });
      } else {
        const [owner, repo] = repoFullName.split('/');
        if (!owner || !repo) {
          githubRepoDeleteError = {
            code: 'other',
            message: `Could not derive an owner/repo from '${repoFullName}'.`,
          };
          await this.recordProductEvent({
            userId,
            projectId,
            eventCode: 'project_github_repo_delete_failed',
            title: 'GitHub repository deletion failed',
            body: `Could not derive an owner/repo from '${repoFullName}'.`,
            metadata: { repoFullName, code: 'other' },
          });
        } else {
          try {
            await this.githubService.deleteRepoForUser(
              githubAccessToken,
              owner,
              repo,
            );
            githubRepoDeleted = true;
            await this.recordProductEvent({
              userId,
              projectId,
              eventCode: 'project_github_repo_deleted',
              title: 'GitHub repository deleted',
              body: `${repoFullName} was deleted from GitHub.`,
              metadata: { repoFullName },
            });
          } catch (error) {
            const deleteError =
              error instanceof GithubRepoDeleteError
                ? { code: error.code, message: error.message }
                : { code: 'other' as const, message: (error as Error).message };
            githubRepoDeleteError = deleteError;
            await this.recordProductEvent({
              userId,
              projectId,
              eventCode:
                deleteError.code === 'missing_scope'
                  ? 'project_github_repo_delete_missing_scope'
                  : 'project_github_repo_delete_failed',
              title: 'GitHub repository deletion failed',
              body: `Could not delete ${repoFullName} on GitHub: ${deleteError.message}`,
              metadata: { repoFullName, code: deleteError.code },
            });
          }
        }
      }
    }

    const deleted = await this.projectsRepository.deleteByIdAndUser(
      projectId,
      userId,
      deleteGithubRepo ? destructiveRoles : undefined,
    );
    if (!deleted) {
      throw new NotFoundException(
        `Project '${projectId}' not found or does not belong to the current user.`,
      );
    }

    return {
      ok: true,
      githubRepoDeleted,
      ...(githubRepoDeleteError ? { githubRepoDeleteError } : {}),
    };
  }

  // ─── POST /projects/sync ───────────────────────────────────────────────────

  /**
   * Checks each provisioned project against the GitHub API to see if its
   * repository still exists. Projects whose repos have been deleted are marked
   * 'orphaned'; orphaned projects whose repos reappear are restored to
   * 'provisioned'. Requires a valid GitHub access token in session.
   */
  async syncProjects(
    userId: string,
    accessToken: string,
  ): Promise<SyncProjectsResponse> {
    const rows = await this.projectsRepository.listByUser(userId, 100);
    if (rows.length === 0) {
      await this.recordProductEvent({
        userId,
        projectId: null,
        eventCode: 'project_sync_completed',
        title: 'Project sync completed',
        body: 'Project repository sync found no tracked projects.',
        metadata: { orphaned: 0, reachable: 0, total: 0 },
      });
      return { orphaned: 0, reachable: 0, total: 0 };
    }

    const orphanedIds: string[] = [];
    const reachableIds: string[] = [];

    // Check repos concurrently — cap at 10 parallel requests to avoid GitHub
    // secondary rate-limit triggers on large project lists.
    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (row) => {
          try {
            const exists = await this.githubService.repoExists(
              accessToken,
              row.repo_full_name,
            );
            if (exists) {
              reachableIds.push(row.id);
            } else {
              orphanedIds.push(row.id);
            }
          } catch (err) {
            // repoExists throws on anything inconclusive — 401/403 (bad or
            // revoked token, rate limit) as well as 5xx/network errors. None
            // of those confirm the repo is gone, so skip rather than mark
            // orphaned; a batch full of these usually means the shared
            // session token is bad, not that every repo vanished at once.
            this.logger.warn(
              `Sync: GitHub check failed for ${row.repo_full_name}: ${String(err)}`,
            );
          }
        }),
      );
    }

    const [orphanedCount, reachableCount] = await Promise.all([
      this.projectsRepository.markOrphaned(orphanedIds, userId),
      this.projectsRepository.markReachable(reachableIds, userId),
    ]);

    await this.recordProductEvent({
      userId,
      projectId: null,
      eventCode: 'project_sync_completed',
      title: 'Project sync completed',
      body: `Project repository sync checked ${rows.length} tracked project${rows.length === 1 ? '' : 's'}.`,
      metadata: {
        orphaned: orphanedCount,
        reachable: reachableCount,
        total: rows.length,
      },
    });

    return {
      orphaned: orphanedCount,
      reachable: reachableCount,
      total: rows.length,
    };
  }

  // ─── Scheduled reconciliation (src/scripts/reconcile-deleted-repos.ts) ────

  /**
   * System-wide sweep that hard-deletes provisioned projects whose GitHub
   * repository is confirmed gone — catches the backlog of repos that were
   * deleted on GitHub before the repository.deleted webhook path
   * (handleRepositoryDeleted) existed. Driven by an external cron script,
   * NOT the live webhook.
   *
   * Uses a single org-level installation token (via
   * getOrganizationProvisioningContextByLogin(getEnforcedOrg())), not any
   * individual user's session token, since this runs unattended with no
   * signed-in user.
   *
   * SECOND non-negotiable safety rule, beyond the inconclusive-check one
   * below: this org-scoped installation token can only reliably vouch for
   * repos that actually belong to the enforced org. The "import an existing
   * repo" flow (ExistingReposService) lets a project point at ANY repo the
   * connecting user owns — personal account or a different org entirely —
   * so provisioned_projects can legitimately contain rows outside the
   * enforced org. GitHub's API returns a 404 both for "deleted" AND for "the
   * calling token has no access to this repo", and an org installation token
   * has no access to a repo it doesn't own — those two cases are
   * indistinguishable from repoExists()'s return value alone. Checking such
   * a row with the org token would therefore read as a false "confirmed
   * gone" and wrongly delete a project whose repo is perfectly fine. Rows
   * whose repo_full_name owner doesn't match the enforced org are skipped
   * entirely (outOfScope), never passed to repoExists().
   *
   * Same concurrency-capped batching as syncProjects() (CONCURRENCY = 10)
   * to avoid GitHub secondary rate limits, and the SAME non-negotiable
   * safety rule for the repos this job CAN check: repoExists() throws on
   * anything inconclusive (401/403/5xx/network errors) — those rows are
   * skipped, NEVER treated as "confirmed gone". Only a clean `false`
   * (confirmed 404 from a repo we know the token can see) qualifies a row
   * for deletion. A bad/expired org token or a transient GitHub outage must
   * never mass-delete every tracked project.
   */
  async reconcileDeletedRepos(): Promise<ReconcileDeletedReposResult> {
    const enforcedOrg = this.githubService.getEnforcedOrg();
    const { accessToken } =
      await this.githubService.getOrganizationProvisioningContextByLogin(
        enforcedOrg,
      );

    const allRows = await this.projectsRepository.listAllRepoFullNames();
    if (allRows.length === 0) {
      return { total: 0, checked: 0, deleted: 0, skipped: 0, outOfScope: 0 };
    }

    const normalizedOrg = enforcedOrg.toLowerCase();
    const rows = allRows.filter(
      (row) =>
        row.repo_full_name.split('/')[0]?.toLowerCase() === normalizedOrg,
    );
    const outOfScope = allRows.length - rows.length;
    if (outOfScope > 0) {
      this.logger.warn(
        `Reconcile: skipping ${String(outOfScope)} project(s) whose repo is outside the ${enforcedOrg} org — the org installation token cannot reliably verify them (see method doc).`,
      );
    }

    const confirmedGoneRepoFullNames: string[] = [];
    let skipped = 0;

    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (row) => {
          try {
            const exists = await this.githubService.repoExists(
              accessToken,
              row.repo_full_name,
            );
            if (!exists) {
              confirmedGoneRepoFullNames.push(row.repo_full_name);
            }
          } catch (err) {
            // See method doc: inconclusive checks are skipped, never
            // treated as confirmation the repo is gone.
            skipped += 1;
            this.logger.warn(
              `Reconcile: GitHub check failed for ${row.repo_full_name}: ${String(err)}`,
            );
          }
        }),
      );
    }

    const deletedByOwner = new Map<
      string,
      Array<{ id: string; user_id: string }>
    >();
    for (const repoFullName of confirmedGoneRepoFullNames) {
      const deletedRows =
        await this.projectsRepository.deleteByRepoFullName(repoFullName);
      if (deletedRows.length > 0) {
        deletedByOwner.set(repoFullName, deletedRows);
      }
    }

    const totalDeleted = [...deletedByOwner.values()].reduce(
      (sum, rowsForRepo) => sum + rowsForRepo.length,
      0,
    );

    this.logger.log(
      `Reconcile: checked ${rows.length} project(s) (${String(outOfScope)} out of scope), deleted ${totalDeleted}, skipped ${skipped} (inconclusive)`,
    );

    await Promise.all(
      [...deletedByOwner.entries()].flatMap(([repoFullName, deletedRows]) =>
        deletedRows.map((row) =>
          // projectId is `null`, not `row.id` — same FK reasoning as
          // handleRepositoryDeleted: the row is already gone by the time
          // this runs, and audit/notification project_id references would
          // fail their FK constraint. `source: 'reconciliation'` (vs.
          // 'webhook') keeps the two deletion paths distinguishable in
          // audit history.
          this.recordProductEvent({
            userId: row.user_id,
            projectId: null,
            eventCode: 'project_deleted_reconciliation',
            title: 'Repository deleted on GitHub',
            body: `The GitHub repository ${repoFullName} was found deleted during scheduled reconciliation, so this project has been deleted.`,
            metadata: {
              repoFullName,
              source: 'reconciliation',
              deletedProjectId: row.id,
            },
          }),
        ),
      ),
    );

    return {
      total: allRows.length,
      checked: rows.length,
      deleted: totalDeleted,
      skipped,
      outOfScope,
    };
  }

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
   * Install the centralized SonarCloud secrets the generated workflows expect
   * (the quality-scan job only runs when all three are present). Best-effort:
   * a missing central Sonar configuration or a secret-write hiccup must not
   * fail repository creation.
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

  private async loadCiTokenStatus(
    projectId: string,
  ): Promise<ProjectTokenStatus | null> {
    if (!this.ciTokensRepository) {
      return null;
    }

    return this.ciTokensRepository.findProjectTokenStatus(projectId);
  }

  private async loadOwnedProjectForWorkflowSettings(
    projectId: string,
    userId: string,
  ): Promise<{ row: ProvisionedProjectRow; project: ProvisionedProject }> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }

    return {
      row,
      project: toProvisionedProject(row),
    };
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

  /**
   * Role gate for project-mutating actions. Defaults to the existing
   * permissive set (lead/delegated_lead/member) when no override is given, so
   * plain callers are unaffected; pass a narrower `roles` list (e.g.
   * ['admin', 'delegated_lead']) for actions with real external side effects, such as
   * deleting the linked GitHub repository. Mirrors
   * DeploymentTargetsService.assertProjectMutationAccess. No-ops when
   * workspaceAccessService isn't wired in (e.g. some test doubles), matching
   * the optional-injection pattern used throughout this service.
   */
  private async assertProjectMutationAccess(
    projectId: string,
    userId: string,
    roles: WorkspaceRole[] = ['admin', 'delegated_lead', 'member'],
  ): Promise<void> {
    await this.workspaceAccessService?.assertProjectRole(
      projectId,
      userId,
      roles,
    );
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

  private projectSyncSnapshotsEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.projectSyncSnapshots.enabled ?? false;
  }

  private workflowSettingsPreviewEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.workflowSettingsPreview.enabled ?? false;
  }

  private workflowUpdatePrEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.workflowUpdatePr.enabled ?? false;
  }

  private ciRunTrackingEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.ciRunTracking?.enabled ?? false;
  }

  private deploymentHistoryEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.deploymentHistory?.enabled ?? false;
  }

  private driftDetectionEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.driftDetection?.enabled ?? false;
  }

  private auditEventsEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.auditEvents?.enabled ?? false;
  }

}
