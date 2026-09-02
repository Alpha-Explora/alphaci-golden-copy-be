import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  AUDIT_QUERY_PORT,
  type AuditQueryPort,
} from '#kernel/ports/audit.port';
import {
  CI_PROJECT_PORT,
  CI_TOKEN_STATUS_LOOKUP,
  type CiProjectPort,
  type CiTokenStatusLookup,
} from '#kernel/ports/ci-project.port';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
  type GithubRepositoryDeletedEvent,
} from '#kernel/ports/github.port';
import {
  DEPLOYMENT_ENV_METADATA_QUERY,
  DEPLOYMENT_PROVISIONING_DEFAULTS,
  DEPLOYMENT_PROVISIONING_FACADE,
  DEPLOYMENT_TARGETS_QUERY,
  type DeploymentProvisioningFacade,
  type DeploymentProvisioningDefaultsPort,
  type DeploymentProjectReference,
  type DeploymentEnvMetadataQuery,
  type DeploymentTargetsQuery,
} from '#kernel/ports/deployment-runtime.port';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { CatalogService } from '../catalog/catalog.service';
import {
  PROJECT_LINK_PORT,
  type ProjectLinkPort,
} from '#kernel/ports/project-link.port';
import { ProjectsRepository } from '../../projects.repository';
import { ProjectDashboardSnapshotsRepository } from '../../project-dashboard-snapshots.repository';
import { ProjectWorkflowSettingsRepository } from '../../project-workflow-settings.repository';
import { ProjectWorkflowUpdateRequestsRepository } from '../../project-workflow-update-requests.repository';
import type { CreateProjectDto } from '../../dto/create-project.dto';
import { ProjectWorkflowsService } from '../workflows/project-workflows.service';
import { ProductEventsService } from './product-events.service';
import { ProjectDashboardService } from '../dashboard/project-dashboard.service';
import { ProjectWorkflowFilesService } from '../workflows/project-workflow-files.service';
import {
  WORKFLOW_HISTORY_QUERY,
  type WorkflowHistoryQuery,
} from '../workflows/index';
import { ProjectLifecycleService } from './project-lifecycle.service';
import { ProjectReconciliationService } from './project-reconciliation.service';
import { ProjectProvisioningApplicationService } from './project-provisioning-application.service';
import type { SetupProjectDto } from '../../dto/setup-project.dto';
import type { DisconnectProjectDto } from '../../dto/disconnect-project.dto';
import {
  USAGE_QUOTA,
  type UsageQuotaPort,
} from '#kernel/ports/usage-quota.port';
import {
  WORKSPACE_ACCESS_PORT,
  WORKSPACES_PORT,
  type WorkspaceAccessPort,
  type WorkspacesPort,
} from '#kernel/ports/workspaces.port';
import type {
  CreateProjectResponse,
  DisconnectProjectResponse,
  ProjectAuditEventsResponse,
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

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

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
      this.auditEventPublisher ?? this.auditEventsService,
      this.notificationEventPublisher,
      this.workflowFragmentRegistry,
    ));
  }

  /** Lazily-created workflow-file adapter used by the extracted provisioning slice. */
  private workflowFilesLazy?: ProjectWorkflowFilesService;
  private get workflowFiles(): ProjectWorkflowFilesService {
    return (this.workflowFilesLazy ??= new ProjectWorkflowFilesService(
      this.catalogService,
      this.workflowFragmentRegistry,
    ));
  }

  /**
   * Compatibility seam for callers/tests that stub workflow writes on the
   * legacy facade. The provisioning application service receives a dynamic
   * callback, so replacing this method continues to affect the extracted
   * workflow without putting creation logic back in ProjectsService.
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

  /** Compatibility read seam for the extracted workflow builder. */
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
    return this.provisioning.buildWorkflowYaml(
      templateId,
      serviceName,
      servicePath,
      nodeVersion,
      coverageThreshold,
      customOutputFileName,
      enhancements,
    );
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
   * Compatibility read facade for direct callers that still construct this
   * class instead of using ProjectDashboardService from the module graph.
   * The implementation lives in the dashboard application service.
   */
  private dashboardServiceLazy?: ProjectDashboardService;
  private get dashboard(): ProjectDashboardService {
    return (this.dashboardServiceLazy ??= new ProjectDashboardService(
      this.projectsRepository,
      this.ciTokensRepository,
      this.deploymentTargetsRepository,
      this.envVarsRepository,
      this.workflowHistoryRepository,
      this.dashboardSnapshotsRepository,
      this.hierarchyProjectLinkService,
      this.configService,
      this.auditQueryPort ??
        (this.auditEventsService as unknown as AuditQueryPort),
      this.auditEventPublisher ?? this.auditEventsService,
      this.notificationEventPublisher,
    ));
  }

  /**
   * Compatibility facade for lifecycle callers that still construct
   * ProjectsService directly in tests or older integrations. The destructive
   * disconnect and repository-sync implementations live in the lifecycle
   * application service; provisioning is passed through the narrow port until
   * that workflow is extracted as its own slice.
   */
  private lifecycleServiceLazy?: ProjectLifecycleService;
  private get lifecycle(): ProjectLifecycleService {
    return (this.lifecycleServiceLazy ??= new ProjectLifecycleService(
      this,
      this.projectsRepository,
      this.githubService,
      this.workspaceAccessService,
      this.auditEventsService,
      this.notificationEventPublisher,
      this.auditEventPublisher,
    ));
  }

  /** Compatibility facade for the scheduled repository cleanup use case. */
  private reconciliationServiceLazy?: ProjectReconciliationService;
  private get reconciliation(): ProjectReconciliationService {
    return (this.reconciliationServiceLazy ??=
      this.reconciliationService ??
      new ProjectReconciliationService(
        this.projectsRepository,
        this.githubService,
        this.auditEventsService,
        this.notificationEventPublisher,
        this.auditEventPublisher,
      ));
  }

  /** Compatibility facade for project creation/setup; the workflow lives in
   * ProjectProvisioningApplicationService. */
  private provisioningServiceLazy?: ProjectProvisioningApplicationService;
  private get provisioning(): ProjectProvisioningApplicationService {
    return (this.provisioningServiceLazy ??=
      this.provisioningApplicationService ??
      new ProjectProvisioningApplicationService(
        this.catalogService,
        this.githubService,
        this.projectsRepository,
        this.ciService,
        this.projectDeploymentProvisioningService,
        this.configService,
        this.usageQuotaService,
        this.auditEventsService,
        this.workspacesService,
        this.notificationEventPublisher,
        this.auditEventPublisher,
        this.hierarchyProjectLinkService,
        (...args) => this.pushWorkflowFile(...args),
        this.workflowFragmentRegistry,
        this.deploymentProvisioningDefaults,
      ));
  }

  constructor(
    private readonly catalogService: CatalogService,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    private readonly projectsRepository: ProjectsRepository,
    @Inject(CI_PROJECT_PORT)
    private readonly ciService: CiProjectPort,
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
    @Inject(USAGE_QUOTA)
    private readonly usageQuotaService?: UsageQuotaPort,
    @Optional()
    private readonly auditEventsService?: AuditEventPublisher,
    @Optional()
    @Inject(WORKSPACES_PORT)
    private readonly workspacesService?: WorkspacesPort,
    @Optional()
    private readonly notificationEventPublisher?: NotificationEventPublisher,
    @Optional()
    @Inject(WORKSPACE_ACCESS_PORT)
    private readonly workspaceAccessService?: WorkspaceAccessPort,
    // Optional and last, like every collaborator above it: the existing specs
    // construct ProjectsService positionally, and an absent linker simply
    // means group projects are not linked (the migration backfill still is).
    @Optional()
    @Inject(PROJECT_LINK_PORT)
    private readonly hierarchyProjectLinkService?: ProjectLinkPort,
    @Optional()
    private readonly workflowsService?: ProjectWorkflowsService,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
    @Optional()
    private readonly reconciliationService?: ProjectReconciliationService,
    @Optional()
    private readonly provisioningApplicationService?: ProjectProvisioningApplicationService,
    @Optional()
    private readonly workflowFragmentRegistry?: WorkflowFragmentRegistry,
    @Optional()
    @Inject(AUDIT_QUERY_PORT)
    private readonly auditQueryPort?: AuditQueryPort,
    @Optional()
    @Inject(DEPLOYMENT_PROVISIONING_DEFAULTS)
    private readonly deploymentProvisioningDefaults?: DeploymentProvisioningDefaultsPort,
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
    const repositoryDeletedListener = (event: GithubRepositoryDeletedEvent) => {
      this.handleRepositoryDeleted(event).catch((error) => {
        this.logger.warn(
          `Failed to process repository.deleted webhook for ${event.repoFullName}: ${String(error)}`,
        );
      });
    };
    if (this.githubService.onRepositoryDeleted) {
      this.githubService.onRepositoryDeleted(repositoryDeletedListener);
    } else {
      // Keep older direct adapters working while the named port subscription
      // is adopted. The fallback is deliberately limited to this event and
      // does not expose the EventEmitter to the rest of Projects.
      this.githubService.on?.('repository.deleted', repositoryDeletedListener);
    }
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
    return this.dashboard.getProjectReference(projectId, userId);
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
    event: GithubRepositoryDeletedEvent,
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

  // ─── Project provisioning facade ───────────────────────────────────────────

  async createProject(
    userId: string,
    userLogin: string,
    accessToken: string | null,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    return this.provisioning.createProject(userId, userLogin, accessToken, dto);
  }

  async setupProject(
    userId: string,
    accessToken: string | null,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse> {
    return this.provisioning.setupProject(userId, accessToken, dto);
  }
  async listProjects(
    userId: string,
    limit = 25,
    workspaceId?: string | null,
  ): Promise<ProvisionedProjectsResponse> {
    return this.dashboard.listProjects(userId, limit, workspaceId);
  }

  async getProjectOverview(
    projectId: string,
    userId: string,
  ): Promise<ProjectOverviewResponse> {
    return this.dashboard.getProjectOverview(projectId, userId);
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
    return this.dashboard.syncProjectSnapshot(projectId, userId);
  }

  async listProjectAuditEvents(
    projectId: string,
    userId: string,
  ): Promise<ProjectAuditEventsResponse> {
    return this.dashboard.listProjectAuditEvents(projectId, userId);
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
    return this.workflows.previewWorkflowSettings(projectId, userId, request);
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
    return this.lifecycle.disconnectProject(
      projectId,
      userId,
      options,
      githubAccessToken,
    );
  }

  // ─── POST /projects/sync ───────────────────────────────────────────────────

  async syncProjects(
    userId: string,
    accessToken: string,
  ): Promise<SyncProjectsResponse> {
    return this.lifecycle.syncProjects(userId, accessToken);
  }
  // ─── Scheduled reconciliation (src/scripts/reconcile-deleted-repos.ts) ────

  /** Delegates the unattended, fail-closed repository sweep to its own use case. */
  async reconcileDeletedRepos(): Promise<ReconcileDeletedReposResult> {
    return this.reconciliation.reconcileDeletedRepos();
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
