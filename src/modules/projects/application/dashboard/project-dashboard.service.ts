import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  CI_TOKEN_STATUS_LOOKUP,
  type CiTokenStatusLookup,
  type ProjectTokenStatus,
} from '#modules/pipelines/index.js';
import { AuditEventsService } from '#modules/platform-ops/index.js';
import type { DeploymentProjectReference } from '#modules/runtime/index.js';
import {
  DEPLOYMENT_ENV_METADATA_QUERY,
  DEPLOYMENT_TARGETS_QUERY,
  type DeploymentEnvMetadataQuery,
  type DeploymentTargetsQuery,
} from '#modules/runtime/index.js';
import { HierarchyProjectLinkService } from '#modules/identity-access/hierarchy/project-link/index.js';
import { ProjectDashboardSnapshotsRepository } from '../../project-dashboard-snapshots.repository';
import { ProjectsRepository } from '../../projects.repository';
import type {
  ProjectAuditEventsResponse,
  ProjectOverviewResponse,
  ProjectSyncSnapshotResponse,
  ProvisionedProjectsResponse,
} from '../../projects.service.types';
import {
  WORKFLOW_HISTORY_QUERY,
  type WorkflowHistoryQuery,
} from '../workflows/index';
import {
  buildLocalSnapshotFindings,
  buildOverviewHealth,
  toCiAuthOverview,
  toProvisionedProject,
} from './project-overview.view';

/**
 * Read models and local snapshots for the project control-center screens.
 *
 * This is a real application service rather than a compatibility wrapper: it
 * owns the projection queries and snapshot write. ProjectsService keeps only a
 * narrow forwarding facade for older direct callers while controllers use this
 * class as the production read boundary.
 */
@Injectable()
export class ProjectDashboardService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
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
    private readonly hierarchyProjectLinkService?: HierarchyProjectLinkService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly auditEventsService?: AuditEventsService,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
    @Optional()
    private readonly notificationEventPublisher?: NotificationEventPublisher,
  ) {}

  listProjects(
    userId: string,
    limit = 25,
    workspaceId?: string | null,
  ): Promise<ProvisionedProjectsResponse> {
    return this.projectsRepository
      .listByUser(userId, limit, workspaceId)
      .then((rows) => ({ items: rows.map((row) => toProvisionedProject(row)) }));
  }

  async getProjectOverview(
    projectId: string,
    userId: string,
  ): Promise<ProjectOverviewResponse> {
    const row = await this.projectsRepository.findByIdAndUser(projectId, userId);
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
        history: workflowHistory as ProjectOverviewResponse['workflow']['history'],
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

  private async loadCiTokenStatus(
    projectId: string,
  ): Promise<ProjectTokenStatus | null> {
    return this.ciTokensRepository?.findProjectTokenStatus(projectId) ?? null;
  }

  private projectSyncSnapshotsEnabled(): boolean {
    return this.readConfig()?.projectSyncSnapshots.enabled ?? false;
  }

  private workflowSettingsPreviewEnabled(): boolean {
    return this.readConfig()?.workflowSettingsPreview.enabled ?? false;
  }

  private ciRunTrackingEnabled(): boolean {
    return this.readConfig()?.ciRunTracking?.enabled ?? false;
  }

  private deploymentHistoryEnabled(): boolean {
    return this.readConfig()?.deploymentHistory?.enabled ?? false;
  }

  private driftDetectionEnabled(): boolean {
    return this.readConfig()?.driftDetection?.enabled ?? false;
  }

  private auditEventsEnabled(): boolean {
    return this.readConfig()?.auditEvents?.enabled ?? false;
  }

  private readConfig(): AppConfig | undefined {
    if (!this.configService) {
      return undefined;
    }

    const service = this.configService as ConfigService & {
      get?: <T = unknown>(propertyPath: string) => T | undefined;
    };
    return (
      service.get?.<AppConfig>('app') ??
      service.getOrThrow<AppConfig>('app')
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
    await Promise.all([
      this.auditEventPublisher?.recordProjectEvent({
        actorUserId: input.userId,
        projectId: input.projectId,
        eventCode: input.eventCode,
        message: input.body,
        metadata: input.metadata,
      }) ??
        this.auditEventsService?.recordProjectEvent({
          actorUserId: input.userId,
          projectId: input.projectId,
          eventCode: input.eventCode,
          message: input.body,
          metadata: input.metadata,
        }),
      this.notificationEventPublisher?.record({
        userId: input.userId,
        projectId: input.projectId,
        eventCode: input.eventCode,
        title: input.title,
        body: input.body,
      }),
    ]).then(() => undefined);
  }
}
