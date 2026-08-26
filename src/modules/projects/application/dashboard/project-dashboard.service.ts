import { Injectable } from '@nestjs/common';

import {
  ProjectsService,
  type ProjectAuditEventsResponse,
  type ProjectOverviewResponse,
  type ProjectSyncSnapshotResponse,
  type ProvisionedProjectsResponse,
} from '../../projects.service';
import type { DeploymentProjectReference } from '#modules/runtime/index.js';

/** Read models and local snapshots for the project control-center screens. */
@Injectable()
export class ProjectDashboardService {
  constructor(private readonly projectsService: ProjectsService) {}

  listProjects(
    userId: string,
    limit = 25,
    workspaceId?: string | null,
  ): Promise<ProvisionedProjectsResponse> {
    return this.projectsService.listProjects(userId, limit, workspaceId);
  }

  getProjectOverview(
    projectId: string,
    userId: string,
  ): Promise<ProjectOverviewResponse> {
    return this.projectsService.getProjectOverview(projectId, userId);
  }

  syncProjectSnapshot(
    projectId: string,
    userId: string,
  ): Promise<ProjectSyncSnapshotResponse> {
    return this.projectsService.syncProjectSnapshot(projectId, userId);
  }

  listProjectAuditEvents(
    projectId: string,
    userId: string,
  ): Promise<ProjectAuditEventsResponse> {
    return this.projectsService.listProjectAuditEvents(projectId, userId);
  }

  getProjectReference(
    projectId: string,
    userId: string,
  ): Promise<DeploymentProjectReference> {
    return this.projectsService.getProjectReference(projectId, userId);
  }
}
