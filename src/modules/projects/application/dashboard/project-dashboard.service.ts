import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityKey,
  type CapabilityResolverPort,
} from '#kernel/composition/index.js';
import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  AUDIT_QUERY_PORT,
  type AuditQueryPort,
} from '#kernel/ports/audit.port';
import {
  CI_TOKEN_STATUS_LOOKUP,
  type CiTokenStatusLookup,
  type ProjectTokenStatus,
} from '#kernel/ports/ci-project.port';
import type { DeploymentProjectReference } from '#kernel/ports/deployment-runtime.port';
import {
  DEPLOYMENT_ENV_METADATA_QUERY,
  DEPLOYMENT_TARGETS_QUERY,
  type DeploymentEnvMetadataQuery,
  type DeploymentTargetsQuery,
} from '#kernel/ports/deployment-runtime.port';
import {
  PROJECT_LINK_PORT,
  type ProjectLinkPort,
} from '#kernel/ports/project-link.port';
import { ProjectDashboardSnapshotsRepository } from '../../infrastructure/project-dashboard-snapshots.repository';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import type {
  ProjectAuditEventsOptions,
  ProjectAuditEventsResponse,
  ProjectOverviewResponse,
  ProjectSyncSnapshotResponse,
  ProvisionedProjectsResponse,
} from '../lifecycle/projects.service.types';
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
  private readonly logger = new Logger(ProjectDashboardService.name);

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
    @Inject(PROJECT_LINK_PORT)
    private readonly hierarchyProjectLinkService?: ProjectLinkPort,
    @Optional()
    @Inject(AUDIT_QUERY_PORT)
    private readonly auditQueryPort?: AuditQueryPort,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
    @Optional()
    private readonly notificationEventPublisher?: NotificationEventPublisher,
    @Optional()
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver?: CapabilityResolverPort,
  ) {}

  listProjects(
    userId: string,
    limit = 25,
    workspaceId?: string | null,
  ): Promise<ProvisionedProjectsResponse> {
    return this.projectsRepository
      .listByUser(userId, limit, workspaceId)
      .then((rows) => ({
        items: rows.map((row) => toProvisionedProject(row)),
      }));
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
    const ciAuth = toCiAuthOverview(ciToken);
    const failedEnvCount = envMetadata.filter(
      (metadata) => metadata.status === 'failed',
    ).length;
    const capabilities =
      this.capabilityResolver?.deployment() ?? new Set<CapabilityKey>();

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
        history: workflowHistory,
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
        enabled: capabilities.has('projects.sync-snapshots'),
        mode: 'local_snapshot',
        latest: latestSnapshot,
      },
      capabilities: {
        envProvisioning: true,
        workflowSettings: capabilities.has(
          'projects.workflow-settings-preview',
        ),
        syncSnapshots: capabilities.has('projects.sync-snapshots'),
        ciRunTracking: capabilities.has('pipelines.ci-run-tracking'),
        deploymentHistory: capabilities.has('runtime.deployment-history'),
        driftDetection: capabilities.has('runtime.drift-detection'),
      },
      hierarchyRepositoryId,
    };
  }

  async syncProjectSnapshot(
    projectId: string,
    userId: string,
  ): Promise<ProjectSyncSnapshotResponse> {
    if (!this.capabilityEnabled('projects.sync-snapshots')) {
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

  /**
   * The repository Audit tab. Visibility is decided here, in the projects
   * module that owns the predicate: anyone who can see the repository (admin,
   * owner, team member, assignee) sees its events, not only its creator. A
   * caller who cannot see it gets 404, like every other project route.
   */
  async listProjectAuditEvents(
    projectId: string,
    userId: string,
    options: ProjectAuditEventsOptions = {},
  ): Promise<ProjectAuditEventsResponse> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (!this.auditQueryPort) {
      return {
        enabled: this.capabilityEnabled('platform.audit-events'),
        items: [],
        next: null,
      };
    }

    const page = await this.auditQueryPort.listProjectEvents({
      projectId,
      deliveryProjectId: await this.resolveDeliveryProjectId(projectId),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      before: options.before ?? null,
    });
    return {
      enabled: page.enabled,
      items: page.items.map((event) => ({
        id: event.id,
        eventCode: event.eventCode,
        message: event.message,
        actorUserId: event.actorUserId,
        actorLogin: event.actorLogin,
        metadata: event.metadata,
        createdAt: event.createdAt,
        scope: event.scope,
      })),
      next: page.next,
    };
  }

  /**
   * The Project (delivery project) a repository is filed under, so Project
   * level events can be shown on its Audit tab. Best effort: a failed lookup
   * must not take the whole tab down, it only hides the Project-level events.
   */
  private async resolveDeliveryProjectId(
    projectId: string,
  ): Promise<string | null> {
    try {
      return (
        (await this.hierarchyProjectLinkService?.getProjectFolder(projectId))
          ?.deliveryProjectId ?? null
      );
    } catch (error) {
      this.logger.warn(
        `Could not resolve the Project for audit of '${projectId}': ${String(error)}`,
      );
      return null;
    }
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

  private capabilityEnabled(key: CapabilityKey): boolean {
    return this.capabilityResolver?.deployment().has(key) ?? false;
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
