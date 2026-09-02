import { Injectable } from '@nestjs/common';

import { ProjectPreviewsService } from './project-previews.query-service';
import type { ProjectPreviewsResponse } from './project-previews.types';
import type { DeploymentProjectReference } from '#kernel/ports/deployment-runtime.port';

/** Application boundary for the project preview read model. */
@Injectable()
export class ProjectPreviewsApplicationService {
  constructor(private readonly previewsService: ProjectPreviewsService) {}

  listPreviews(
    project: DeploymentProjectReference,
  ): Promise<ProjectPreviewsResponse> {
    return this.previewsService.listPreviews(project);
  }
}
