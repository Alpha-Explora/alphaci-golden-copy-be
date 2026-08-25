import { Injectable } from '@nestjs/common';

import {
  ProjectsService,
  type WorkflowSettingsPreviewRequest,
  type WorkflowSettingsPreviewResponse,
  type WorkflowSettingsResponse,
  type WorkflowUpdatePullRequestResponse,
} from '../projects.service';

/** Workflow settings reads, previews and pull-request orchestration. */
@Injectable()
export class ProjectWorkflowsService {
  constructor(private readonly projectsService: ProjectsService) {}

  getWorkflowSettings(
    projectId: string,
    userId: string,
  ): Promise<WorkflowSettingsResponse> {
    return this.projectsService.getWorkflowSettings(projectId, userId);
  }

  previewWorkflowSettings(
    projectId: string,
    userId: string,
    request: WorkflowSettingsPreviewRequest,
  ): Promise<WorkflowSettingsPreviewResponse> {
    return this.projectsService.previewWorkflowSettings(
      projectId,
      userId,
      request,
    );
  }

  createWorkflowUpdatePullRequest(
    projectId: string,
    userId: string,
    oauthAccessToken: string | null | undefined,
    request: WorkflowSettingsPreviewRequest,
  ): Promise<WorkflowUpdatePullRequestResponse> {
    return this.projectsService.createWorkflowUpdatePullRequest(
      projectId,
      userId,
      oauthAccessToken,
      request,
    );
  }
}
